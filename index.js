/**
 * Laya Tool Router — lazy tool discovery for the DeepSeek Harness.
 *
 * Prefill problem: in `native` presentation EVERY visible tool schema is paid on
 * EVERY request. DSH: "Restrictions that hide tools remove their entire schema
 * cost for that agent." The composed web profile carries ~302 rows, of which
 * ~25 are host-level tool providers (tool-bash, tool-pwsh, tool-fs,
 * tool-fs-search, tool-web, tool-todo, tool-skill, tool-goal, tool-ralph,
 * tool-jobs, tool-subagent*, tool-workflow, plugin-manager/tools …), and every
 * agent inherits them. This plugin makes exactly one tool visible — find_tool —
 * and reveals a second only after Laya names it.
 *
 *   Stage 0  lexical rank -> top <= MAX_CHOICES          (free, bounded)
 *   Stage 1  ONE Laya POST /v1/systemone, two questions:
 *              bestTool : choice over <=8 candidates  (no none_of_the_above)
 *              usable   : noul companion              (no-match signal)
 *            ~150 tokens, ~13.7 s on the Moto G8
 *   Stage 2  accept iff p(noul) <= NOUL_MAX && confidence >= CONF_MIN
 *              yes -> return the winner's JSON Schema, expose exactly that one
 *              no  -> return a shortlist, expose nothing
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

// --- measured tuning (laya-acceptance-rule-probe.py, laya-routing-envelope-probe.py)
const LAYA_BASE = 'http://127.0.0.1:8081';
const LAYA_PATH = '/v1/systemone';
const CHOICE_INSTR = 'Best matching tool for the request.';
const NOUL_INSTR = 'Is this request NOT handled by any of the listed tools?';
const MAX_CHOICES = 8;   // >=10 saturates confidence to 1.000
const DESC_CHARS = 56;   // ~14 tokens; fits the 19-token budget at N=8
const CONF_MIN = 0.30;   // rejects every unmatched request in the test set
const NOUL_MAX = 0.30;   // matched p(noul) 0.11-0.32 | unmatched 0.20-0.72
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
  console.error('[laya-router] label registry unavailable:', e?.message ?? e);
}

const log = (...a) => console.error('[laya-router]', ...a);

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

/** Stage 0 — cheap lexical rank so the Laya call stays bounded. */
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

/** Stage 1 — one bounded Laya call carrying a choice AND a noul. */
async function askLaya(request, candidates, signal) {
  // No none_of_the_above here — it competes with the real tools.
  const criteria = {};
  for (const { name } of candidates) {
    const rec = LABELS[name] || {};
    criteria[name] = ((rec.short || '') || name).slice(0, DESC_CHARS) || name;
  }

  const body = JSON.stringify({
    state: {
      agentRequest: String(request).slice(0, 800),
      context: 'Harness tool discovery.',
      routingStage: 'discovery',
    },
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

  const res = await fetch(LAYA_BASE + LAYA_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: combined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Laya HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const answers = json?.answers ?? {};
  const choice = answers.bestTool ?? {};
  const usable = answers.usable ?? {};
  return {
    choice: choice.choice ?? null,
    confidence: Number(choice.confidence ?? 0),
    pNone: Number(usable.noul ?? 1),
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

  /** Deny everything except find_tool and anything already revealed. */
  const recompute = (agent) => {
    const rec = byAgent.get(agent);
    if (!rec) return false;
    // DSH emits tools/change from INSIDE restrict()/dispose(). Without this
    // guard, onChange re-enters recompute -> restrict -> onChange -> ... until
    // "Maximum call stack size exceeded" (observed at boot, service_direct.log).
    // The pending async copy of the same event is harmless: the dedup below
    // makes it a no-op instead of another restrict round-trip.
    if (rec.busy) return true;
    rec.busy = true;
    try { return armMask(agent, rec); } finally { rec.busy = false; }
  };

  /** Core arming logic; runs only while rec.busy is held by recompute(). */
  const armMask = (agent, rec) => {
    let live = [];
    // SCOPE MATTERS: schemas() with no argument returns the GLOBAL layer, and
    // every host tool row is `disabled: true`, so that view is always empty.
    // The agent itself is the scope key — `ctx.tools.schemas(agent)` is exactly
    // what dsh-cordis-host-runner does — and yields what this agent inherits.
    try { live = ctx.tools.schemas(agent); } catch (e) {
      log('schemas(agent) failed:', e?.message ?? e);
      return false;
    }

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

    // DEDUP: restrict()/dispose() themselves fire tools/change, so re-arming
    // with an identical deny list would re-fire the event forever (the boot
    // log looped "armed mask hiding 11 tool(s)" ~970 times). Only touch the
    // restriction when the deny set actually moved (new registration or a
    // reveal).
    const key = deny.slice().sort().join('\n');
    if (rec.dispose && rec.armedKey === key) return true;

    try {
      if (rec.dispose) rec.dispose();          // lift, then re-arm fresh
      rec.dispose = agent.ctx.tools.restrict({ deny });
      rec.armedKey = key;
    } catch (e) {
      log('restrict failed:', e?.message ?? e);
      return false;
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
    const t = setTimeout(() => {
      timers.delete(t);
      const rec = byAgent.get(agent);
      if (!rec || rec.dispose) return;         // already armed or gone
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

    let schemas = [];
    // The agent is the scope key; the no-arg call would be the empty global layer.
    try { schemas = ctx.tools.schemas(agent); } catch (e) {
      log('schemas(agent) failed for new agent:', e?.message ?? e);
      return false;
    }
    byAgent.set(agent, {
      agent, schemas, revealed: new Set(),
      dispose: null, busy: false, armedKey: null,
    });

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
      // STANDARD JSON Schema, not the author-style {name: schema} map.
      // defineTool() compiles author-style for built-in tools; a raw register()
      // does not, and a malformed parameters object reaches the LLM verbatim
      // (pi-ai passes it through), leaving the grammar unconstrained — which is
      // how the model ended up calling find_tool with {}.
      parameters: {
        type: 'object',
        properties: {
          request: {
            type: 'string',
            description:
              'REQUIRED, must not be empty. Short plain-language description of '
              + 'the capability needed, e.g. "read a file" or "search code for a '
              + 'pattern", or an exact tool name.',
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
        const source = rec?.schemas
          ?? (agent ? ctx.tools.schemas(agent) : ctx.tools.schemas());
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

        // Exact tool-name match (case-insensitive) skips Laya: the name can
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

        // Stage 0 — bound the candidate set before touching Laya.
        const ranked = rank(request, names);
        const candidates = ranked.slice(0, Math.max(2, Math.min(MAX_CHOICES, names.length)));

        let answer = null;
        let error = null;
        try {
          answer = await askLaya(request, candidates, exec.signal);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }

        if (error) {
          log('Laya call failed:', error);
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

        // Acceptance: 12/13 correct decisions, zero wrong accepts. Below either
        // floor we return a shortlist instead of forcing a bad tool.
        if (!chosen || confidence < CONF_MIN || pNone > NOUL_MAX) {
          log(`reject "${request.slice(0, 48)}" conf=${confidence.toFixed(3)} `
            + `pNone=${pNone.toFixed(3)}`);
          return {
            selected: null, confidence, pNone, probabilities,
            shortlist: candidates.slice(0, 5).map((c) => c.name),
            reason: pNone > NOUL_MAX
              ? `No listed tool fits (p(noul)=${pNone.toFixed(3)} > ${NOUL_MAX}).`
              : `Confidence ${confidence.toFixed(2)} below ${CONF_MIN}.`,
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
