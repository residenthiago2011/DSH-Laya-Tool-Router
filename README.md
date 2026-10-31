# DSH Tool Router

Lazy tool discovery for DSH: hides every tool schema from the model's prefill
and reveals exactly one tool on demand through a **decision model API**.

- **Prefill cost:** one small `find_tool` schema instead of every mounted tool
  (26 schemas on a default Standard profile — see [Why?](#why)).
- **Stage 0** — full-surface send: every mounted tool (≤ 24) carries a
  160-char criterion, ordered by a stopword-filtered lexical rank (the rank
  only bounds pathological mounts — d1-omni does not saturate as the choice
  count grows; see [Why?](#why)).
- **Stage 1** — one `POST /v1/systemone` to the decision model API: a
  `bestTool` choice plus a `usable` question kept as telemetry only
  (~235–500 tokens, ~6–7 s on-device).
- **Stage 2** — accept iff `confidence >= 0.70`: return the winner's JSON
  Schema and reveal exactly that one tool; otherwise return a
  **probability-ordered shortlist** whose reason names the closest match, so
  the model can retry with that exact tool name (or send an empty request to
  get the whole catalog). Exact tool-name requests skip the decision call and
  reveal instantly.

## Why?

Fresh session, first message, server-reported `usage.prompt_tokens` —
the DSH **Standard preset** (the platform default) versus this plugin's
`no-prefill` preset:

| Cost before the first word | Standard | no-prefill |
|---|---:|---:|
| Prefill tokens | **6,559** | **283** |
| System prompt | 5,816 chars | 372 chars |
| Tool schemas shipped up front | **26 schemas (21,417 B)** | 1 schema (697 B) |

Standard makes the model ingest a 5.8k-character system prompt plus **every**
mounted tool schema — 6,559 tokens — before it emits a single word, and pays
it again on every subsequent turn. `no-prefill` ingests 283 tokens (**23×
less**, 96% smaller prefill): a slim persona plus the single `find_tool`
schema. On the measured backend that difference was ~40 s versus ~14 min of
prompt evaluation for the first reply.

What that buys you:

- **Latency** — time-to-first-word scales with the whole tool shelf today.
  Reveal-on-demand makes it scale with the tool you actually call.
- **Context budget** — 6.5k tokens of standing preamble is 6.5k tokens you
  don't have for code, conversation, and results. On a 32k window that's ~20%
  of the model's world spent before work starts.
- **Reliability on small models** — a model reading 26 schemas behaves like a
  model reading 26 instructions it must never violate. One schema at a time is
  one schema to follow; the rest of the shelf doesn't exist for it.
- **Pay for what you use** — a turn that calls no tool costs 283 tokens
  instead of 6,559. A turn that calls one tool reveals that one schema once;
  the other 25 are never sent.

If a session ends up using most tools anyway, the gap narrows — but the unused
half of the shelf is exactly what a default profile charges for from word one.

## What the bundle patch declares

`cordis.patch.yml` (applied when the bundle is selected):

1. **`preset-no-prefill`** — an agent preset whose composition is only
   `persona` + `dsh-tool-router`. The persona tells the model: no tools are
   declared; call `find_tool` first — and if a result carries no schema,
   retry with an exact tool name or an empty request instead of giving up.
   It also states the reveal rule from PR #2: every tool already used in the
   session stays available for the rest of it (including after a host
   restart), so an answer carrying `"already_available": true` means *call it
   directly, do not ask again*.
2. **Host tool rows enabled** — `tool-bash`, `tool-fs`, `tool-fs-search`,
   `tool-todo`, `tool-web` flipped to `disabled: false`, plus a `present`
   row inserted. Discovery needs the tools to exist somewhere; preset-scoped
   registrations shadow host ones, so other presets keep their own behavior.
   The slim preset keeps the Agent Presets page showing only `find_tool`.

## Prerequisites

- DSH with the bundle mechanism (`dsh.bundle.patch`) — available since
  `0.1.1-rc.2`; verified against `0.2.1-rc.3`.
- A running **decision model API** that speaks `POST /v1/systemone`
  (the router defaults to `http://127.0.0.1:8081/v1/systemone`; edit
  `ROUTER_BASE` in `index.js` to point at another host or port).
- `pnpm` on PATH of the host running DSH (the plugin manager installs
  through pnpm; the CLI forwards pnpm arguments).

## Install

**From GitHub (recommended):** Plugins → install → spec

```
git+https://github.com/residenthiago2011/DSH-Tool-Router.git
```

or via the CLI:

```sh
dsh plugin --profile <profile> add git+https://github.com/residenthiago2011/DSH-Tool-Router.git
```

**From a prebuilt tarball:** download
[`dsh-tool-router.tgz`](https://github.com/residenthiago2011/DSH-Tool-Router/releases/latest/download/dsh-tool-router.tgz)
from Releases, then install from the local path (also accepted: absolute
path, git URL, or an npm registry name after publishing):

```sh
dsh plugin --profile <profile> add /path/to/dsh-tool-router.tgz
```

Then select the bundle on the Plugins page (installation enables it by
default) and restart DSH if the profile runs without HMR.

## Uninstall

Deselect/remove the bundle on the Plugins page. The preset row and the host
tool flips vanish with the bundle patch; other presets are untouched.

## Files

| File | Purpose |
|---|---|
| `index.js` | The router plugin: registers `find_tool`, masks every other tool per agent, runs the 3-stage decision. |
| `cordis.patch.yml` | The bundle patch: preset declaration + host tool enablement. |
| `tool-registry.json` | Stage-0 labels and Stage-1 criteria (25 tools, both shells incl. `bash`). |
| `router-import-test.mjs`, `rank-sim.mjs`, `router-e2e-test.mjs`, `restrict-scope-test.mjs`, `router-storm-test.mjs` | The five test suites (see [Tests](#tests)). |

## Tests

```sh
node router-import-test.mjs    # module shape (no dependencies)
node rank-sim.mjs              # Stage-0 ranking on sample queries (needs tool-registry.json)
node router-e2e-test.mjs       # full flow: arm/deny-set/live reveal — needs the decision endpoint at 127.0.0.1:8081
node restrict-scope-test.mjs   # deny-set vs the global registry (agent-scoped + empty-deny cases)
node router-storm-test.mjs     # mask lifecycle, no endpoint: no tools/change listener, step-boundary reconcile
```

`router-e2e-test.mjs` uses a stub DSH context that emits `tools/change`
synchronously (the worst case that once caused a ~970x feedback loop), then
drives the real `find_tool` against a live decision endpoint: armed-once,
deny-set dedup, late registration **at the step boundary** (the `tools/change`
event itself must no longer write to the registry), reveal re-arm,
empty-request catalog hint, and the exact-name fast path. `ALL_PASS` is
expected.

`restrict-scope-test.mjs` runs without an endpoint and pins the deny-set
reconciliation: one rejection self-heals against the admission list the error
reports, convergence happens through `agent/pre-step` (firing `tools/change`
alone must NOT reconcile any more), and a surface where every visible name is
agent-scoped stays **pending** instead of calling `restrict({ deny: [] })` —
real DSH accepts an empty deny as a silent no-op, which would report
`armed mask hiding 0 tool(s)` and stop the retry loop with nothing masked.

`router-storm-test.mjs` needs no endpoint. It pins the three properties that
matter for survival: (1) no `tools/change` listener exists after mount, so a
foreign event storm cannot re-enter the plugin — 200 injected events must
produce 0 `restrict()` calls; (2) an agent that existed before the plugin
mounted is adopted at its first step boundary; (3) a re-mount rebuilds
`revealed` from the session log, so tools the conversation already used are not
hidden again, and asking for one of them answers `already_available: true`
without a registry write.

## Notes

- `find_tool` registers with a standard JSON Schema
  (`type/properties/required/additionalProperties`). A raw register with
  author-style parameters reaches the LLM unconstrained — the model then
  calls with `{}`. Always compile.
- The empty-request catalog hint and the exact-name fast path exist for
  small models; see `execute()` in `index.js`.
- Diagnostics go to stderr and are mirrored to `~/.dsh/tool-router.log`
  (`DSH_TOOL_ROUTER_LOG` overrides the path, `DSH_TOOL_ROUTER_LOG=0` disables
  the mirror). The mirror needs `~/.dsh` to exist — where it does not, the same
  lines still reach stderr, which a host may capture (some service managers
  redirect it into a file such as `service_direct.log`). The log is what made
  the two host-killing incidents below diagnosable after the fact.

## Reconcile at the agent step boundary, never inside `tools/change`

This is the load-bearing design rule, learned from two hosts that died.

`tools.restrict()` and `tools.register()` publish `tools/change` **synchronously**,
so a listener that reacts to `tools/change` by changing the registry re-enters
itself. Two such plugins form a publication/withdrawal feedback loop. Measured:
532 events in two seconds, then 136 in one second, then `crash-*-host.log`
(`~/.dsh/tool-router.log`, 2026-10-26 and 2026-10-28; the 10-26 storm grew the
log to 130.5 MB). In the second incident the router was *inert* — every line was
`1 armed, 0 pending`, zero re-arms — because the other half of the loop was a
different plugin that also reconciles on `tools/change`.

The fix is structural, not a guard: **the router subscribes to nothing in that
event.** Late registrations are picked up at `agent/pre-step`, and `recompute()`
still dedups on the deny-set key, so an unchanged surface performs no registry
write at all. The trade-off is bounded and cheap: a tool registered in the
middle of a step stays visible until the next step boundary.

## Rebuild `revealed` from the session log, not from plugin memory

`revealed` (the set of tools already handed to the model) is derived state. It
must survive a host restart, because the *conversation* survives: the model keeps
calling tools it used before the restart.

Measured on 2026-10-28 (session `35a5fef0`, turn 17): the host restarted, the
fresh plugin instance armed its mask with `revealed=0`, and `bash` / `read` /
`edit` — used 19 / 5 / 9 times in the previous turn — became invisible. The model
kept calling them, got `Error: unknown tool "bash"`, called `find_tool`, retried.
Each retry resent the whole context: **419,672 input tokens, 98.9% of that
turn**, for three tool calls that the model already knew how to make.

`adopt()` therefore seeds the set from the session log itself:
`ctx.get('sessions').get(agent.id)` resolves the `Session`, and the events are
read from **`session.events`** — the array `@deepseek-ai/dsh-session` exposes
(it is the same property the store's own `_forkSeed()` reads). Every
`tool/call` name found there joins `revealed`. Re-mounting after this change
restores 8 tools on that same session and produces zero `unknown tool` errors.

> Historical note: PR #2 called `snapshotEvents()` / `ownEvents()` — methods
> that exist in **no** installed DSH build, so on a real host the seed silently
> returned `[]` while the stub-invented API passed its test. The method-shaped
> forms are still tried first as forward-compatible fallbacks; the property is
> what actually works today — a live run logs `seeded N already-used tool(s)
> from session log: ...`.

`find_tool` answers `already_available: true` when the requested tool was already
visible, and a seeded tool asked for again makes **no** registry write — measured
`restrict()` call count unchanged, and the log line reads
`"bash" was already available via exact name match (no re-arm)`.

## An agent that predates the plugin

`agent/created` does not fire for an agent that already exists when the plugin
mounts (a live bundle enable, an HMR reload, a resumed session). `agent/pre-step`
adopts such an agent on its first step; without that it stays untracked and never
gets a mask — every schema stays in prefill, silently.
