/**
 * DSH Tool Router — lazy tool discovery for the DeepSeek Harness.
 *
 * Prefill problem: in `native` presentation EVERY visible tool schema is paid on
 * EVERY request. DSH: "Restrictions that hide tools remove their entire schema
 * cost for that agent." The composed web profile carries ~302 rows, of which
 * ~25 are host-level tool providers (tool-bash, tool-pwsh, tool-fs,
 * tool-fs-search, tool-web, tool-todo, tool-skill, tool-goal, tool-ralph,
 * tool-jobs, tool-subagent*, tool-workflow, plugin-manager/tools …), and every
 * agent inherits them. This plugin makes exactly one tool visible — find_tool —
 * and reveals a second only after the decision model names it.
 *
 *   Stage 0  full-surface send: every mounted tool (<= MAX_CHOICES) carries
 *            rich criteria; the lexical rank only bounds pathological mounts
 *   Stage 1  ONE POST /v1/systemone to the decision model API, two questions:
 *              bestTool : choice over the whole mounted surface
 *              usable   : noul companion (telemetry only — see NOUL_INSTR)
 *            ~235-500 tokens, ~6-7 s (d1-omni-600M, full surface, 160-char criteria)
 *   Stage 2  accept iff confidence >= CONF_MIN
 *              yes -> return the winner's JSON Schema, expose exactly that one
 *              no  -> probability-ordered shortlist + exact-name retry hint
 *
 * Why no none_of_the_above: rl_agent_config.json sets
 * temperature_by_options["choice:11+"] = 0.1006 (logits x10), so that option
 * wins almost always — measured 0/8 correct with it present vs 7/8 without.
 *
 * Restriction lifecycle (why `tools/change` matters): `restrict({deny})` snapshots
 * a name list. Host tool plugins can register AFTER this one mounts, and a
 * snapshot would let them into prefill unnoticed. `tools/change` fires on every
 * registration/unregistration and on restriction changes, so the deny list is
 * recomputed whenever the surface moves. Tools already revealed are re-armed as
 * visible, never re-hidden.
 *
 * Diagnostics go to stderr, which DSH captures in service_direct.log.
 */

export const inject = ['tools'];

// --- measured tuning (decision-endpoint probes; re-calibrated for llama.cpp
//     b11609 + a d1-omni-600M-Q8_0 decision model)
const ROUTER_BASE = 'http://127.0.0.1:8081';
const ROUTER_PATH = '/v1/systemone';
const CHOICE_INSTR = 'Best matching tool for the request.';
// Asked for TELEMETRY ONLY. d1-omni's noul head proved unreliable in both
// phrasings: the NOT form pinned pNone=0.841 on a bash-conf=1.000 match, the
// YES form answered 0.886 "unhandled" on a read-conf=0.99 match. Confidence
// alone decided every recorded probe correctly (matched 0.72-1.00 revealed,
// unmatched <=0.71 rejected), so the noul value is logged but never gates.
const NOUL_INSTR = 'Is this request handled by any of the listed tools?';
const MAX_CHOICES = 24;   // full-surface send; cap only for pathological mounts (d1 window = 16,384 tokens)
const DESC_CHARS = 160;   // ~40 tokens/criterion; d1-omni has room for rich descriptions (was 56, an earlier tighter budget)
// Full-surface + rich-criteria calibration (2026-10-17 probes over the real
// mounted surface): matched conf 0.72-1.00, unmatched <=0.71 (poem 0.246,
// flight 0.165, translate 0.559). 0.85 bounced the 0.722 config-read match;
// 0.70 splits the sets with margin. Recheck when criteria text changes again.
const CONF_MIN = 0.70;
const NOUL_MAX = 0.20;   // telemetry only — kept in logs/payloads, not enforced
const FETCH_TIMEOUT_MS = 60000;
const SELF = 'find_tool';

/** Terse labels for Stage-1 criteria; schemas come from the live registry. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let LABELS = {};
try {
  const raw = JSON.parse(readFileSync(
    fileURLToPath(new URL('./tool-registry.json', import.meta.url)), 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.tools ?? []);
  for (const entry of list) {
    if (entry && entry.name) LABELS[entry.name] = entry;
  }
} catch (e) {
  console.error('[dsh-tool-router] label registry unavailable:', e?.message ?? e);
}

const log = (...a) => console.error('[dsh-tool-router]', ...a);

const CANDIDATES = [...new Set([...Object.keys(LABELS), 'bash', 'present'])];

const tokenise = (s) => String(s ?? '')
  .toLowerCase()
  .split(/[^a-z0-9_]+/)
  .filter((t) => t.length > 1);

// Function words that match almost every label ("to" scored todo_write +5 via
// substring and pushed bash out of the candidate window).
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'are',
  'but', 'not', 'can', 'all', 'any', 'use', 'via', 'how', 'what', 'when',
  'need', 'make', 'some', 'please', 'just', 'also', 'then', 'than', 'will',
  'would', 'should', 'could', 'been', 'being', 'does', 'done',
]);

/** Stage 0 — ordering for the full send; a bound only above MAX_CHOICES. */
function rank(query, names) {
  const terms = [...new Set(tokenise(query))]
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const scored = names.map((name) => {
    const rec = LABELS[name] || {};
    const hay = new Set(tokenise([
      name, rec.short, (rec.router_labels || []).join(' '), rec.description,
    ].join(' ')));
    const nameTokens = new Set(tokenise(name));
    let score = 0;
    for (const t of terms) {
      if (hay.has(t)) score += 1;
      // Prefix match so "read" also scores read_image.
      if ([...nameTokens].some((n) => n === t || n.startsWith(t))) score += 3;
      if ((rec.router_labels || []).some((l) => l.toLowerCase().includes(t))) score += 2;
    }
    return { name, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Stage 1 — one bounded decision-model call carrying a choice AND a noul. */
async function askDecision(request, candidates, signal) {
  // No none_of_the_above here — it competes with the real tools.
  const criteria = {};
  for (const { name } of candidates) {
    const rec = LABELS[name] || {};
    // Rich criteria: d1-omni reads descriptions as the option definitions.
    // e.g. bash's "checking processes" is exactly what a memory query needs.
    criteria[name] = ((rec.description || '') || rec.short || name).slice(0, DESC_CHARS);
  }

  const body = JSON.stringify({
    // d1-omni (llama.cpp): a bare STRING state calibrates the companion noul
    // and the choice confidence; an earlier object form made unmatched
    // requests score conf>=0.92 AND p(noul)<=0.02, so no threshold could ever
    // reject them (measured: 0/13 zero-wrong-accept params with the object).
    state: String(request).slice(0, 800),
    questions: {
      bestTool: { type: 'choice', instructions: CHOICE_INSTR, criteria },
      usable: { type: 'noul', instructions: NOUL_INSTR },
    },
  });

  // Bound the call: ~12-14 s on-device; a dead endpoint must not hang a turn.
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeout].filter(Boolean))
    : timeout;

  const res = await fetch(ROUTER_BASE + ROUTER_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: combined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`decision endpoint HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const answers = json?.answers ?? {};
  const choice = answers.bestTool ?? {};
  const usable = answers.usable ?? {};
  return {
    choice: choice.choice ?? null,
    confidence: Number(choice.confidence ?? 0),
    // Positive phrasing: usable.noul = P(handled). pNone is its complement.
    pNone: 1 - Number(usable.noul ?? 0),
    probabilities: choice.probabilities ?? {},
  };
}

export function apply(ctx) {
  /**
   * Per-agent bookkeeping.
   *   schemas  : last known inherited surface (union of what we have seen)
   *   revealed : tools already handed over — these must stay visible
   *   dispose  : the active restriction disposer
   */
  const byAgent = new Map();
  /** Pending mask-arming retries; cleared on dispose. */
  const timers = new Set();

  /**
   * Re-entrancy control for mask arming. DSH fires tools/change (and even
   * agent/created) synchronously from inside tools.restrict(), which used to
   * recurse until "Maximum call stack size exceeded" and leave a 500 ms
   * arm/disarm storm that eventually took the harness down. Rules:
   *   - one re-arm in flight per agent (rec.arming);
   *   - change events arriving while any arming is in flight are deferred to
   *     a macrotask (pendingFlush) instead of running nested;
   *   - an armed mask whose deny set did not change is left untouched, so
   *     deferred drains converge instead of re-restricting forever.
   */
  let pendingFlush = false;
  let drainScheduled = false;
  /** onChange lives inside effect(); set there, used here for the drain. */
  let onChangeRef = null;

  /** Deny everything except find_tool and anything already revealed. */
  /**
   * What this agent can currently see, resolved with `tools.get(name, agent)` —
   * the exact form DSH's own execution path uses (`tools.get(exec.name,
   * exec.agent)`). `tools.schemas(agent)` never returned on device (idle CPU, no
   * further log output after the call), so it is deliberately avoided.
   * Restricted tools resolve to undefined here, which is why callers keep a
   * grow-only memory of everything already seen.
   */
  const probe = (agent) => {
    const found = new Map();
    // (1) Registry names via tools.get(name, agent) — the restricted-safe form.
    for (const n of CANDIDATES) {
      if (n === SELF) continue;
      let def = null;
      try { def = ctx.tools.get(n, agent); } catch { def = null; }
      if (def) {
        found.set(def.name || n, {
          name: def.name || n,
          description: def.description || '',
          parameters: def.parameters || null,
        });
      }
    }
    // (2) No-arg enumeration as a safety net: catches a tool registering
    // AFTER arming whose name is NOT in the registry (schemas() is bounded —
    // adopt already calls it every boot — and the WITH-AGENT form, which
    // hangs on device, is deliberately avoided).
    try {
      for (const s of ctx.tools.schemas() ?? []) {
        if (s?.name && s.name !== SELF && !found.has(s.name)) {
          found.set(s.name, {
            name: s.name,
            description: s.description || '',
            parameters: s.parameters || null,
          });
        }
      }
    } catch { /* enumeration unavailable — registry scan stands */ }
    return [...found.values()];
  };

  const recompute = (agent) => {
    const rec = byAgent.get(agent);
    if (!rec) return false;
    if (rec.arming) { pendingFlush = true; return false; } // in flight, deferred

    const live = probe(agent);

    // GROW-ONLY memory of the full surface. Once a mask is armed, `live` comes
    // back restricted (only find_tool + revealed tools), so overwriting
    // rec.schemas with it would erase the very schemas discovery needs. Union by
    // name instead. A tool registered AFTER arming is not yet in the deny list,
    // so it does surface in `live` here and is denied on this same pass.
    const merged = new Map();
    for (const s of [...rec.schemas, ...live]) {
      if (s?.name && !merged.has(s.name)) merged.set(s.name, s);
    }
    const all = [...merged.values()];

    const deny = all
      .filter((s) => s.name !== SELF && !rec.revealed.has(s.name))
      .map((s) => s.name);
    if (deny.length === 0) {
      // NOTHING TO HIDE YET. At agent creation the preset's tool plugins have
      // often not mounted. Returning success here would arm an empty mask and
      // let every later-registered tool into prefill — signal pending instead.
      log(`agent ${short(agent)}: 0 tools to hide yet (armed=false)`);
      return false;
    }

    deny.sort();
    const key = deny.join(',');
    if (rec.dispose && rec.key === key) return true; // armed for exactly this set

    try {
      rec.arming = true;
      if (rec.dispose) rec.dispose();          // lift, then re-arm fresh
      rec.dispose = agent.ctx.tools.restrict({ deny });
      rec.key = key;
    } catch (e) {
      log('restrict failed:', e?.message ?? e);
      return false;
    } finally {
      rec.arming = false;
      if (pendingFlush) {
        pendingFlush = false;
        if (!drainScheduled) {
          drainScheduled = true;
          setTimeout(() => { drainScheduled = false; onChangeRef?.(); }, 0);
        }
      }
    }
    rec.schemas = all;                         // grow-only
    log(`agent ${short(agent)}: armed mask hiding ${deny.length} tool(s); `
      + `revealed=${rec.revealed.size}`);
    return true;
  };

  const short = (agent) => String(agent?.id ?? '?').replace(/^session-/, '').slice(0, 8);

  /**
   * Retry arming the mask until tools actually exist. The preset's tool
   * plugins mount asynchronously after `agent/created`, so a single attempt at
   * that instant sees an empty surface. Bounded so a broken config cannot spin.
   */
  const scheduleRetry = (agent, attempt = 0) => {
    if (attempt >= 20) { log(`agent ${short(agent)}: gave up arming mask`); return; }
    const start = byAgent.get(agent);
    if (!start) return;
    if (attempt === 0) {
      if (start.retryScheduled) return;        // one pending retry per agent
      start.retryScheduled = true;
    }
    const t = setTimeout(() => {
      timers.delete(t);
      const rec = byAgent.get(agent);
      if (!rec || rec.dispose) { if (rec) rec.retryScheduled = false; return; }
      rec.retryScheduled = false;
      if (recompute(agent)) return;
      scheduleRetry(agent, attempt + 1);
    }, 500);
    timers.add(t);
  };

  /**
   * `agent/created` can arrive before the agent's `ctx.tools` service exists
   * (observed on device: the event fires, `agent.ctx.tools` is still unset).
   * Retry adoption so the mask is never silently skipped.
   */
  const scheduleAdopt = (agent, attempt = 0) => {
    if (attempt >= 40) { log(`agent ${short(agent)}: gave up adopting`); return; }
    const t = setTimeout(() => {
      timers.delete(t);
      if (byAgent.has(agent)) return;           // adopted meanwhile
      if (agent?.ctx?.tools) { adopt(agent); return; }
      scheduleAdopt(agent, attempt + 1);
    }, 500);
    timers.add(t);
  };

  const adopt = (agent) => {
    const ready = !!agent?.ctx?.tools;
    const already = byAgent.has(agent);
    log(`adopt entry ${short(agent)}: ctx.tools=${ready} alreadyTracked=${already}`);
    if (!ready || already) return false;

    // Initial surface via tools.get(...), not tools.schemas(agent) — the latter
    // never returned on device. Empty here is normal: preset tool plugins mount
    // asynchronously, so recompute() returns pending and we retry.
    const schemas = probe(agent);
    byAgent.set(agent, { agent, schemas, revealed: new Set(), dispose: null });

    let ok = false;
    try { ok = recompute(agent); } catch (e) {
      // A throw here used to escape adopt() and swallow the "adopted" log,
      // hiding the real failure. Contain it so the retry path still runs.
      log('recompute threw during adopt:', e?.message ?? e);
    }

    // globalView is the no-arg call (always ~0 here); agentSurface is the real
    // inherited tool set for this agent and is what gets masked.
    let globalView = -1;
    try { globalView = ctx.tools.schemas().length; } catch { /* ignore */ }
    log(`adopted ${short(agent)}: globalView=${globalView} `
      + `agentSurface=${schemas.length} -> ${ok ? 'MASK ARMED' : 'PENDING'}`);
    if (!ok) scheduleRetry(agent);
    return ok;
  };

  const effect = ctx.effect(() => {
    ctx.tools.register({
      name: SELF,
      description:
        'Discover a harness tool: pass the capability you need as the required '
        + '"request" string. Example arguments: {"request": "run a shell command"}. '
        + 'Returns the matching tool name and its full JSON Schema, and makes that '
        + 'one tool callable. Call this BEFORE any other tool - no other tools are '
        + 'exposed to you until you do.',
      // Wire-level JSON Schema: this definition is registered RAW (no defineTool
      // wrapper), and the DSL form {request:{type,...}} reached the model
      // unconverted (top-level type:"string"), so the model sent {} and execute
      // threw. Raw registrations must therefore carry the JsonSchemaNode form.
      parameters: {
        type: 'object',
        properties: {
          request: {
            type: 'string',
            description: 'REQUIRED, must not be empty. Short plain-language '
              + 'description of the capability needed, e.g. "read a file" or '
              + '"search code for a pattern", or an exact tool name. If a '
              + 'result carries no schema, retry with an exact tool name '
              + '(e.g. "bash"), or send an empty request to list all names.',
          },
        },
        required: ['request'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const request = String(
          args?.request ?? args?.query ?? args?.description ?? '',
        ).trim();

        const agent = exec.agent;
        // Self-heal: if agent/created was missed, adopt on first use.
        if (agent && !byAgent.has(agent)) adopt(agent);
        const rec = agent ? byAgent.get(agent) : undefined;

        // rec.schemas is the grow-only FULL surface (hidden tools included);
        // a live query would only return the un-masked remainder.
        const source = rec?.schemas ?? (agent ? probe(agent) : []);
        const byName = new Map(source.map((s) => [s?.name, s]));
        const names = [...byName.keys()].filter((n) => n && n !== SELF);

        if (names.length === 0) {
          return {
            selected: null, confidence: 0, pNone: 1,
            hint: 'No tools are mounted.', schema: null,
          };
        }

        // Small models sometimes omit the required argument. Answer with the
        // catalog instead of throwing — a structured reply recovers faster
        // than a tool error.
        if (!request) {
          log('empty request — returning tool catalog hint');
          return {
            selected: null, confidence: 0, pNone: 1,
            hint: 'The "request" argument was empty. Call find_tool again with '
              + 'request set to a short description of the capability you need '
              + '(e.g. request: "read a file"), or set it to a tool name from '
              + '"available".',
            available: names,
            schema: null,
          };
        }

        // Exact tool-name match (case-insensitive) skips the decision call: the name can
        // only have come from our own shortlist, so the choice is certain.
        const hit = byName.get(request) ?? byName.get(request.toLowerCase());
        if (hit && hit.name !== SELF) {
          if (agent) {
            const r = byAgent.get(agent);
            if (r) {
              r.revealed.add(hit.name);
              try { recompute(agent); } catch (e) { log('reveal failed:', e?.message ?? e); }
            }
          }
          log(`revealed "${hit.name}" via exact name match`);
          return {
            selected: hit.name, confidence: 1, pNone: 0,
            tool: { name: hit.name, description: hit.description },
            schema: hit.parameters ?? null,
            candidates: [hit.name],
            note: 'The selected tool is now available. Call it with the schema above.',
          };
        }

        // Stage 0/1 — full-surface send: rank only ORDERs the batch; the cap
        // bites only above MAX_CHOICES (pathological mounts).
        const ranked = rank(request, names);
        const candidates = ranked.slice(0, Math.max(2, Math.min(MAX_CHOICES, names.length)));

        let answer = null;
        let error = null;
        try {
          answer = await askDecision(request, candidates, exec.signal);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }

        if (error) {
          log('decision call failed:', error);
          return {
            selected: null, confidence: 0, pNone: 1, error,
            shortlist: candidates.slice(0, 5).map((c) => c.name),
            schema: null,
          };
        }

        const chosen = answer.choice;
        const confidence = answer.confidence;
        const pNone = answer.pNone;
        const probabilities = answer.probabilities;

        // Acceptance: confidence alone decides (see NOUL_INSTR — noul is
        // telemetry only). On reject, order the shortlist by the decision model's own
        // probabilities and name the closest match so the model can retry
        // with an exact name instead of giving up.
        if (!chosen || confidence < CONF_MIN) {
          const byProb = Object.entries(probabilities || {})
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .map(([n]) => n)
            .filter((n) => byName.has(n) && n !== SELF);
          const shortlist = [
            ...new Set([...byProb, ...candidates.map((c) => c.name)]),
          ].slice(0, 5);
          const closest = byProb[0] ?? null;
          const topProb = closest ? probabilities?.[closest] : undefined;
          log(`reject "${request.slice(0, 48)}" conf=${confidence.toFixed(3)} `
            + `pNone=${pNone.toFixed(3)} `
            + (closest ? `closest=${closest}${topProb !== undefined ? ` p=${Number(topProb).toFixed(3)}` : ''}` : ''));
          return {
            selected: null, confidence, pNone, probabilities,
            shortlist,
            reason: closest
              ? `Confidence ${confidence.toFixed(2)} below ${CONF_MIN}. `
                + `Closest match: ${closest}. Call find_tool again with `
                + `"${closest}" as the exact request, or with an empty request `
                + `to list every tool name.`
              : `Confidence ${confidence.toFixed(2)} below ${CONF_MIN}. `
                + 'Call find_tool with an empty request to list every tool name.',
            schema: null,
          };
        }

        const schema = byName.get(chosen);
        if (!schema) {
          return {
            selected: null, confidence, probabilities,
            error: 'Chosen tool is not visible.', schema: null,
          };
        }

        // Stage 2 — deliver the schema AND expose exactly that one tool.
        if (agent) {
          const r = byAgent.get(agent);
          if (r) {
            r.revealed.add(chosen);
            try { recompute(agent); } catch (e) { log('reveal failed:', e?.message ?? e); }
          }
        }
        log(`revealed "${chosen}" conf=${confidence.toFixed(3)} pNone=${pNone.toFixed(3)} `
          + `over ${candidates.length} candidates`);

        return {
          selected: chosen, confidence, pNone, probabilities,
          tool: { name: schema.name, description: schema.description },
          schema: schema.parameters ?? null,
          candidates: candidates.map((c) => c.name),
          note: 'The selected tool is now available. Call it with the schema above.',
        };
      },
    });
    log('registered', SELF, '| label entries =', Object.keys(LABELS).length);

    // --- agent lifecycle ----------------------------------------------------
    const onCreated = (payload) => {
      const agent = payload?.agent ?? payload;
      if (!agent) { log('agent/created: NO AGENT IN PAYLOAD'); return; }
      const ready = !!agent.ctx?.tools;
      log(`agent/created ${short(agent)}: ctx.tools ${ready ? 'ready' : 'NOT READY -> deferring'}`);
      if (ready) adopt(agent);
      else scheduleAdopt(agent);
    };
    ctx.on('agent/created', onCreated);

    // --- surface changes ----------------------------------------------------
    // Preset/host tools can register after we mount (and after an agent is
    // created, as the boot log showed). A snapshot deny list would let them
    // into prefill, so re-arm on every registry change.
    const onChange = () => {
      if (byAgent.size === 0) return;          // nothing to protect yet
      for (const r of byAgent.values()) {
        if (r.arming) { pendingFlush = true; return; } // defer to drain
      }
      let armed = 0;
      let pending = 0;
      for (const agent of byAgent.keys()) {
        try {
          if (recompute(agent)) armed++;
          else { pending++; scheduleRetry(agent); }
        } catch (e) { log('recompute failed:', e?.message ?? e); }
      }
      log(`tools/change -> ${armed} armed, ${pending} pending`);
    };
    ctx.on('tools/change', onChange);
    onChangeRef = onChange;

    log('subscribed to agent/created + tools/change');

    return () => {
      try { ctx.off('agent/created', onCreated); } catch { /* disposed */ }
      try { ctx.off('tools/change', onChange); } catch { /* disposed */ }
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const rec of byAgent.values()) {
        if (rec.dispose) { try { rec.dispose(); } catch { /* noop */ } }
      }
      byAgent.clear();
    };
  });

  return effect;
}
