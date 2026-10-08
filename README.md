# Laya Tool Router

Lazy tool discovery for DSH: hides every tool schema from the model's prefill
and reveals exactly one tool on demand through the **Laya** decision endpoint.

- **Prefill cost:** one small `find_tool` schema instead of every mounted tool
  (~11 full schemas on a default profile).
- **Stage 0** — lexical rank picks ≤ 8 candidates (stopword-filtered).
- **Stage 1** — one `POST /v1/systemone` to Laya: a `bestTool` choice plus a
  `usable` noul question (~150 tokens).
- **Stage 2** — accept iff `confidence >= 0.30` and `p(noul) <= 0.30`: return
  the winner's JSON Schema and reveal exactly that one tool; otherwise return
  a shortlist. Exact tool-name requests skip Laya and reveal instantly.

## What the bundle patch declares

`cordis.patch.yml` (applied when the bundle is selected):

1. **`preset-no-prefill`** — an agent preset whose composition is only
   `persona` + `laya-tool-router`. The persona tells the model: no tools are
   declared; call `find_tool` first.
2. **Host tool rows enabled** — `tool-bash`, `tool-fs`, `tool-fs-search`,
   `tool-todo`, `tool-web` flipped to `disabled: false`, plus a `present`
   row inserted. Discovery needs the tools to exist somewhere; preset-scoped
   registrations shadow host ones, so other presets keep their own behavior.
   The slim preset keeps the Agent Presets page showing only `find_tool`.

## Prerequisites

- DSH 0.2.0-rc.2 (bundles mechanism with `dsh.bundle.patch`).
- A running **Laya** endpoint at `http://127.0.0.1:8081/v1/systemone`
  (edit `LAYA_BASE` in `index.js` to change; default port 8081).
- `pnpm` on PATH of the host running DSH (the plugin manager installs
  through pnpm; the CLI forwards pnpm arguments).

## Install

**Plugins page (Web sidebar):** Plugins → install → spec
`/path/to/laya-tool-router-1.0.0.tgz` (tarball, absolute path, git URL, or
an npm registry name after publishing).

**CLI:**

```sh
dsh plugin --profile <profile> add /path/to/laya-tool-router-1.0.0.tgz
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
| `tool-registry.json` | Stage-0 labels (25 tools, including `bash`) and Stage-1 short criteria. |

## Tests

```sh
node router-import-test.mjs   # module shape (no dependencies)
node rank-sim.mjs             # Stage-0 ranking on sample queries (needs tool-registry.json)
node router-e2e-test.mjs      # full flow: arm/deny-set/live reveal — requires Laya at 127.0.0.1:8081
```

`router-e2e-test.mjs` uses a stub DSH context that emits `tools/change`
synchronously (the worst case that once caused a ~970x feedback loop), then
drives the real `find_tool` against a live Laya endpoint: armed-once,
deny-set dedup, late registration, reveal re-arm, empty-request catalog hint,
and the exact-name fast path. `ALL_PASS` is expected.

## Notes

- `find_tool` registers with a standard JSON Schema
  (`type/properties/required/additionalProperties`). A raw register with
  author-style parameters reaches the LLM unconstrained — the model then
  calls with `{}`. Always compile.
- The empty-request catalog hint and the exact-name fast path exist for
  small models; see `execute()` in `index.js`.
