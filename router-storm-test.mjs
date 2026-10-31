// Regression test for the 2026-10-28 host crash: the tools/change feedback loop.
//
// Stub semantics are the worst case measured on device:
//   - restrict() emits tools/change SYNCHRONOUSLY, re-entering any listener
//   - disposing that restriction emits tools/change too
// A second party (the shipped tool-subagent standing path) does the same, so
// this stub plays that role too: foreign tools/change events keep arriving.
// Before the fix the router re-armed inside them and the pair ping-ponged until
// the host died. The fix is structural: the router listens to NOTHING there.
//
// No decision endpoint needed here: this covers the mask lifecycle and the
// exact-name fast path; router-e2e-test.mjs covers the full stage-1/2 flow.
const failures = [];
const assert = (cond, msg) => {
  if (cond) console.log('PASS:', msg);
  else { failures.push(msg); console.log('FAIL:', msg); }
};

const registry = new Map();
const denied = new Set();
const listeners = new Map();
let restrictCalls = 0;

const on = (n, fn) => { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(fn); };
const off = (n, fn) => { const l = listeners.get(n) ?? []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
// Count synchronous emissions so a loop shows up as a number, not a hang.
let emits = 0;
const emit = (n, payload) => {
  emits++;
  if (emits > 5000) throw new Error(`runaway: ${emits} emissions (feedback loop is back)`);
  for (const fn of [...(listeners.get(n) ?? [])]) fn(payload);
};

const defs = [
  ['bash', 'Run a shell command on the device'],
  ['read', 'Read the contents of a text file from disk'],
  ['write', 'Write a file to disk'],
  ['grep', 'Search file contents with a pattern'],
];

const baseParams = {
  type: 'object',
  properties: { request: { type: 'string', description: 'What to do.' } },
  required: ['request'],
};

const schemasFor = () => {
  const out = [];
  const seen = new Set();
  for (const [name, description] of defs) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!denied.has(name)) out.push({ name, description, parameters: baseParams });
  }
  for (const [name, def] of registry) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!denied.has(name)) out.push({ name, description: def.description, parameters: def.parameters ?? null });
  }
  return out;
};

const toolsService = {
  register(def) {
    registry.set(def.name, def);
    emit('tools/change', {});
  },
  schemas() { return schemasFor(); },
  get(name) {
    if (denied.has(name)) return undefined;
    const reg = registry.get(name);
    if (reg) return { name, description: reg.description, parameters: reg.parameters ?? null };
    const d = defs.find((x) => x[0] === name);
    if (d) return { name: d[0], description: d[1], parameters: baseParams };
    return undefined;
  },
  restrict({ deny }) {
    if (!Array.isArray(deny) || deny.length === 0) throw new Error('restrict called with bad deny');
    restrictCalls++;
    for (const n of deny) denied.add(n);
    emit('tools/change', {});          // SYNCHRONOUS on device
    return () => {
      for (const n of deny) denied.delete(n);
      emit('tools/change', {});        // SYNCHRONOUS on device
    };
  },
};

// Session-log stub: lets a test agent claim which tools it already called.
// The plugin must rebuild `revealed` from these events after any re-mount.
const sessionEvents = new Map();
const sessionsService = {
  get(id) {
    const ev = sessionEvents.get(String(id));
    return ev ? { snapshotEvents: () => ev } : undefined;
  },
};

const ctx = {
  effect(fn) { return fn(); }, on, off, tools: toolsService,
  get(name) { return name === 'sessions' ? sessionsService : undefined; },
};

const mod = await import('./index.js');
assert(typeof mod.apply === 'function', 'module exports apply');
const disposePlugin = mod.apply(ctx);

// (1) THE FIX: the plugin must hold no tools/change listener at all.
const changeListeners = (listeners.get('tools/change') ?? []).length;
assert(changeListeners === 0, `no tools/change listener after mount (found ${changeListeners})`);
assert((listeners.get('agent/pre-step') ?? []).length === 1, 'one agent/pre-step listener installed');

// (2) Adopt arms once at agent/created.
const agent = { id: 'session-stormtest01', ctx: { tools: toolsService } };
emits = 0;
emit('agent/created', { agent });
assert(restrictCalls === 1, `armed exactly once on adopt (restrictCalls=${restrictCalls})`);
assert(denied.size === 4, `all 4 stub tools denied (denied=${denied.size})`);
assert(!denied.has('find_tool'), 'find_tool never denied');
assert(emits <= 4, `adopt emitted only ${emits} event(s): no storm`);

// (3) The other party's churn must be IGNORED, not amplified.
emits = 0;
const before = restrictCalls;
for (let i = 0; i < 200; i += 1) emit('tools/change', {});
assert(restrictCalls === before, `200 tools/change events caused 0 restricts (was ${before}, now ${restrictCalls})`);
console.log(`INFO: 200 foreign events -> ${emits} total emissions, restrictCalls=${restrictCalls}`);

// (4) A step boundary with an unchanged surface is quiet.
const preStep = (listeners.get('agent/pre-step') ?? [])[0];
const next = () => Promise.resolve({ kind: 'enter', messages: [] });
emits = 0;
const decision = await preStep({ agent, messages: [], turn: 1, step: 1 }, next);
assert(decision?.kind === 'enter', 'pre-step passes next() decision through unchanged');
assert(restrictCalls === before, `unchanged step boundary makes no registry write (restrictCalls=${restrictCalls})`);

// (5) A late registration is picked up at the NEXT step boundary, exactly once.
defs.push(['extra_tool', 'An extra late-registered tool']);
const afterLate = restrictCalls;
await preStep({ agent, messages: [], turn: 1, step: 2 }, next);
assert(restrictCalls === afterLate + 1, `late tool re-armed once at step boundary (restrictCalls=${restrictCalls})`);
assert(denied.has('extra_tool'), 'late-registered tool is denied before the next request');
await preStep({ agent, messages: [], turn: 1, step: 3 }, next);
assert(restrictCalls === afterLate + 1, `converged: repeat step boundary is a no-op (restrictCalls=${restrictCalls})`);

// (6) Exact-name reveal still works and re-arms through the step path only.
const findTool = registry.get('find_tool');
const fast = await findTool.execute({ request: 'grep' }, { agent });
assert(fast?.selected === 'grep' && !!fast?.schema, `exact-name fast path reveals (selected=${fast?.selected})`);
assert(!denied.has('grep'), 'revealed tool left the deny set');
await preStep({ agent, messages: [], turn: 1, step: 4 }, next);
assert(restrictCalls === afterLate + 2, `reveal re-armed once (restrictCalls=${restrictCalls})`);

// (7) Teardown removes both listeners.
disposePlugin();
assert((listeners.get('agent/pre-step') ?? []).length === 0, 'pre-step listener removed on dispose');
assert((listeners.get('tools/change') ?? []).length === 0, 'still no tools/change listener after dispose');

// (8) An Agent that already existed BEFORE the plugin mounted must be adopted
// at its first step boundary. Measured on device 2026-10-28 19:36: the plugin
// mounted live, no agent/created arrived for the running Agent, and no mask was
// ever armed — every schema stayed in prefill. No other listener can fix that.
denied.clear();
const disposeSecond = mod.apply(ctx);
const lateAgent = { id: 'session-lateadopt1', ctx: { tools: toolsService } };
const preStep2 = (listeners.get('agent/pre-step') ?? [])[0];
const beforeAdopt = restrictCalls;
await preStep2({ agent: lateAgent, messages: [], turn: 1, step: 1 }, next);
assert(restrictCalls === beforeAdopt + 1, `pre-existing agent adopted+masked at its first step (restrictCalls=${restrictCalls})`);
assert(denied.size === 5, `late-adopted agent denies the whole surface (denied=${denied.size})`);
disposeSecond();

// (9) THE 2026-10-28 REGRESSION: a re-mounted plugin must NOT re-hide tools the
// conversation already used. Session 35a5fef0 turn 17: host restart re-armed the
// mask with revealed=0, the model kept calling bash/read/edit, got
// `unknown tool`, retried via find_tool, and each retry resent ~110k tokens
// (419,672 total = 98.9% of that turn). `revealed` must come from the log.
denied.clear();
sessionEvents.set('session-restart01', [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
  { type: 'tool/result', data: {} },
  { type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: '{}' } },
  { type: 'tool/call', data: { turn: 1, step: 3, callId: 'c3', name: 'find_tool', arguments: '{}' } },
]);
const disposeThird = mod.apply(ctx);
const restarted = { id: 'session-restart01', ctx: { tools: toolsService } };
const preStep3 = (listeners.get('agent/pre-step') ?? [])[0];
await preStep3({ agent: restarted, messages: [], turn: 2, step: 1 }, next);
assert(!denied.has('bash'), 'tool already called in the session stays visible after re-mount (bash)');
assert(!denied.has('read'), 'tool already called in the session stays visible after re-mount (read)');
assert(!denied.has('find_tool'), 'find_tool is never denied');
assert(denied.has('write') && denied.has('grep'), 'never-used tools are still hidden (write, grep)');
assert(denied.has('extra_tool'), 'late-registered unused tool is hidden');
console.log(`INFO: seeded reveal -> denied=${[...denied].join(',')} (expect write,grep,extra_tool)`);

// (10) A seeded tool asked for again must answer already_available:true and make
// NO registry write. Device evidence 2026-10-29 02:37-02:41: six find_tool calls
// for read/edit that were already visible, each a full-context round trip.
const seededFind = registry.get('find_tool');
const beforeSeedAsk = restrictCalls;
const seedAsk = await seededFind.execute({ request: 'bash' }, { agent: restarted });
assert(seedAsk?.selected === 'bash', `seeded tool answered by exact name (selected=${seedAsk?.selected})`);
assert(seedAsk?.already_available === true, 'seeded tool reports already_available=true');
assert(restrictCalls === beforeSeedAsk, `asking for a seeded tool makes no registry write (restrictCalls=${restrictCalls})`);

// (11) First-time reveal of a never-used tool still reports already_available
// false, and the second ask flips to true without re-arming.
const firstAsk = await seededFind.execute({ request: 'write' }, { agent: restarted });
assert(firstAsk?.already_available === false, 'first reveal reports already_available=false');
const secondAsk = await seededFind.execute({ request: 'write' }, { agent: restarted });
assert(secondAsk?.already_available === true, 'repeat reveal reports already_available=true');
disposeThird();
sessionEvents.delete('session-restart01');

console.log(`SUMMARY restrict=${restrictCalls} emissions=${emits} failures=${failures.length}`);
console.log(failures.length === 0 ? 'ALL_PASS' : 'HAS_FAILURES');
process.exit(failures.length === 0 ? 0 : 1);
