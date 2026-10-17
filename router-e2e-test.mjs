// End-to-end test: router plugin against the LIVE laya server (127.0.0.1:8081)
// with a stub DSH context whose restrict()/dispose() emit tools/change
// SYNCHRONOUSLY — the worst case that produced the boot stack overflow and the
// ~970x feedback loop in service_direct.log.
const failures = [];
const assert = (cond, msg) => {
  if (cond) console.log('PASS:', msg);
  else { failures.push(msg); console.log('FAIL:', msg); }
};

const registry = new Map();
const denied = new Set();
const listeners = new Map();
let restrictCalls = 0;
let disposeCalls = 0;

const on = (n, fn) => { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(fn); };
const off = (n, fn) => { const l = listeners.get(n) ?? []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
const emit = (n, payload) => { for (const fn of [...(listeners.get(n) ?? [])]) fn(payload); };

const defs = [
  ['bash', 'Run a shell command on the device'],
  ['read', 'Read the contents of a text file from disk'],
  ['write', 'Write a file to disk'],
  ['edit', 'Edit a file on disk'],
  ['read_image', 'Read an image file'],
  ['grep', 'Search file contents with a pattern'],
  ['glob', 'Find files by glob pattern'],
  ['web_search', 'Search the web'],
  ['web_fetch', 'Fetch a web page'],
  ['todo_write', 'Update the todo list'],
  ['present', 'Present content to the user'],
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
  // Device semantics: tools.get(name, agent) resolves restricted tools to
  // undefined and revealed/unrestricted ones to their definition. probe()
  // in index.js uses this exact shape (tools.schemas(agent) hangs on device).
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
    emit('tools/change', {}); // SYNCHRONOUS — this used to recurse to stack overflow
    return () => {
      disposeCalls++;
      for (const n of deny) denied.delete(n);
      emit('tools/change', {});
    };
  },
};

const ctx = {
  effect(fn) { return fn(); },
  on,
  off,
  tools: toolsService,
};

const mod = await import('./index.js');
assert(typeof mod.apply === 'function', 'module exports apply');
mod.apply(ctx);
assert(registry.has('find_tool'), 'find_tool registered at mount');

const agent = { id: 'session-e2etest001', ctx: { tools: toolsService } };
emit('agent/created', { agent });

assert(restrictCalls === 1, `armed exactly once on adopt (restrictCalls=${restrictCalls})`);
assert(denied.size === 11, `11 preset tools denied (denied=${denied.size})`);
assert(!denied.has('find_tool'), 'find_tool itself never denied');
if (failures.length) { console.log('EARLY-FAIL'); process.exit(1); }

// Duplicate events — this is exactly what looped ~970x before the fix.
emit('tools/change', {});
emit('tools/change', {});
assert(restrictCalls === 1, `unchanged deny is a no-op (restrictCalls=${restrictCalls})`);

// A tool registering late must re-arm exactly once.
defs.push(['extra_tool', 'An extra late-registered tool']);
emit('tools/change', {});
assert(restrictCalls === 2, `late registration re-arms once (restrictCalls=${restrictCalls})`);
assert(denied.has('extra_tool'), 'late-registered tool is denied');

// Stage 1+2 — real Laya call, reveal, re-arm with the smaller deny.
const def = registry.get('find_tool');
assert(def.parameters?.type === 'object'
  && def.parameters?.required?.includes('request')
  && !!def.parameters?.properties?.request,
`parameters are standard JSON Schema with required request`);
const out = await def.execute(
  { request: 'read the contents of a text file from disk' },
  { agent },
);
console.log('find_tool result:', JSON.stringify(out));
assert(!!out?.selected && !!out?.schema, `find_tool revealed a tool (selected=${out?.selected})`);
if (out?.selected) {
  assert(!denied.has(out.selected), `${out.selected} removed from deny list`);
  assert(denied.size === 11, `remaining denied after reveal=${denied.size}`);
}
assert(restrictCalls === 3, `reveal re-armed once (restrictCalls=${restrictCalls})`);

// Final duplicate — must stay quiet forever.
emit('tools/change', {});
assert(restrictCalls === 3, `no post-reveal churn (restrictCalls=${restrictCalls})`);

// Empty request must NOT throw — structured catalog hint instead.
const empty = await def.execute({}, { agent });
assert(empty?.selected === null && Array.isArray(empty?.available) && empty.available.length > 0,
  `empty request returns catalog hint (available=${empty?.available?.length})`);
assert(restrictCalls === 3, `empty request does not re-arm (restrictCalls=${restrictCalls})`);

// Exact tool-name request skips Laya and reveals instantly.
const fast = await def.execute({ request: 'grep' }, { agent });
assert(fast?.selected === 'grep' && !!fast?.schema, `exact name fast path reveals (selected=${fast?.selected})`);
assert(!denied.has('grep'), 'grep removed from deny list by fast path');
assert(restrictCalls === 4, `fast path reveal re-armed once (restrictCalls=${restrictCalls})`);

// Case-insensitive exact match.
const fast2 = await def.execute({ request: 'Read' }, { agent });
assert(fast2?.selected === 'read', `case-insensitive exact match (selected=${fast2?.selected})`);
assert(restrictCalls === 4, `repeat exact match is quiet (restrictCalls=${restrictCalls})`);

console.log(`SUMMARY restrict=${restrictCalls} dispose=${disposeCalls} denied=${denied.size} failures=${failures.length}`);
console.log(failures.length === 0 ? 'ALL_PASS' : 'HAS_FAILURES');
process.exit(failures.length === 0 ? 0 : 1);
