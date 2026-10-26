// Regression for the LOCAL PATCH in index.js recompute().
// DSH's tools.restrict() validates every deny name against the GLOBAL registry
// and throws the whole call if any single name is unknown there.
//
// Scenario 1: agent-scoped tools (send_message/list_agents/interrupt_agent) are
//             in the deny set -> one rejection, self-heal, then ARM.
// Scenario 2: the global registry is only partially populated at agent creation
//             -> whatever arms early must CONVERGE once the registry fills and
//             tools/change fires (the real 07:44:40 -> 07:44:57 sequence).
import { apply } from "./index.js";

const params = { type: "object", properties: { request: { type: "string" } }, required: ["request"] };
const failures = [];
const ok = (c, m) => { if (!c) failures.push(m); console.log((c ? "PASS: " : "FAIL: ") + m); };
const tick = () => new Promise((r) => setTimeout(r, 25));

const GLOBAL = [
  "bash", "create_worktree", "dsh_im_group_file", "dsh_im_group_history",
  "dsh_im_return_file", "edit", "find_tool", "glob", "grep",
  "load_workspace_dependencies", "present", "read", "read_image", "read_page",
  "session_event_read", "session_event_search", "session_event_trace",
  "session_search", "session_trace", "todo_write", "web_fetch", "web_search",
  "working_directory", "write", "x_search",
];
const AGENT_SCOPED = ["interrupt_agent", "list_agents", "send_message"];

function harness(readyRef) {
  const registry = new Map();
  const denied = new Set();
  const listeners = new Map();
  let restrictCalls = 0;
  let rejects = 0;
  const known = (n) => readyRef.list.includes(n);
  const defOf = (n) => {
    if (registry.has(n)) return registry.get(n);
    if (known(n) || GLOBAL.includes(n) || AGENT_SCOPED.includes(n)) {
      return { name: n, description: n + " tool", parameters: params };
    }
    return undefined;
  };
  const tools = {
    register(d) { registry.set(d.name, d); },
    schemas() { return readyRef.list.map((n) => defOf(n)).filter(Boolean); },
    get(n) { return denied.has(n) ? undefined : defOf(n); },
    restrict({ deny }) {
      if (!Array.isArray(deny) || deny.length === 0) throw new Error("restrict called with bad deny");
      const unknown = deny.filter((n) => !known(n));
      if (unknown.length > 0) {
        rejects += 1;
        throw new Error('tools.restrict() names unknown global tools '
          + unknown.map((n) => '"' + n + '"').join(", ")
          + "; known global tools: " + readyRef.list.join(", "));
      }
      restrictCalls += 1;
      for (const n of deny) denied.add(n);
      // DEVICE SEMANTICS: restrict() fires tools/change synchronously, which
      // re-enters recompute(). Without the surface memo this re-entry restarts
      // from the un-reconciled set and storms (~2800 arm cycles/s on device).
      emitChange();
      return () => { for (const n of deny) denied.delete(n); };
    },
  };
  const ctx = {
    tools,
    on(e, f) { if (!listeners.has(e)) listeners.set(e, []); listeners.get(e).push(f); },
    off() {},
    effect(fn) { return fn(); },
  };
  const agent = { id: "session-test", ctx: { tools } };
  // DEVICE SEMANTICS: restrict() fires tools/change synchronously.
  const emitChange = () => { for (const fn of (listeners.get("tools/change") ?? [])) fn({}); };
  const fire = (e, p) => { for (const f of (listeners.get(e) ?? [])) f(p ?? {}); };
  return { ctx, agent, denied, fire, stats: () => ({ restrictCalls, rejects }) };
}

const main = async () => {
  console.log("--- scenario 1: agent-scoped tools in the deny set ---");
  {
    const h = harness({ list: GLOBAL.slice() });
    apply(h.ctx);
    h.fire("agent/created", { agent: h.agent });
    await tick();
    const st = h.stats();
    console.log("restrictCalls=" + st.restrictCalls + " rejects=" + st.rejects + " denied=" + h.denied.size);
    ok(st.restrictCalls === 1, "mask armed exactly once (restrictCalls=" + st.restrictCalls + ")");
    ok(st.rejects === 1, "exactly one rejection before self-healing (rejects=" + st.rejects + ")");
    ok(!h.denied.has("find_tool"), "find_tool itself never denied");
    for (const n of AGENT_SCOPED) ok(!h.denied.has(n), n + " stays visible (cannot be denied)");
    for (const n of ["bash", "read", "write", "edit", "grep", "web_search"]) {
      ok(h.denied.has(n), n + " denied");
    }
  }

  console.log("--- scenario 2: registry partially populated, then fills ---");
  {
    const readyRef = { list: ["find_tool", "read_image"] };
    const h = harness(readyRef);
    apply(h.ctx);
    h.fire("agent/created", { agent: h.agent });
    await tick();
    console.log("after partial mount: denied=" + h.denied.size);
    // tool plugins finish mounting
    readyRef.list = GLOBAL.slice();
    h.fire("tools/change", {});
    await tick();
    h.fire("tools/change", {});
    await tick();
    const st = h.stats();
    console.log("after registry ready: restrictCalls=" + st.restrictCalls + " denied=" + h.denied.size);
    ok(h.denied.has("bash"), "bash denied after convergence");
    ok(h.denied.has("read"), "read denied after convergence");
    ok(h.denied.has("grep"), "grep denied after convergence");
    ok(h.denied.size >= 20, "deny set converged to the full surface (denied=" + h.denied.size + ")");
    ok(!h.denied.has("find_tool"), "find_tool still visible after convergence");
  }

  console.log("--- scenario 3: restrict() re-enters synchronously (device semantics) ---");
  {
    const h = harness({ list: GLOBAL.slice() });
    apply(h.ctx);
    h.fire("agent/created", { agent: h.agent });
    await tick();
    const st = h.stats();
    console.log("restrictCalls=" + st.restrictCalls + " rejects=" + st.rejects + " denied=" + h.denied.size);
    ok(st.restrictCalls <= 4, "no arm/disarm storm from synchronous tools/change (restrictCalls=" + st.restrictCalls + ")");
    ok(st.rejects <= 2, "rejection not paid repeatedly (rejects=" + st.rejects + ")");
    ok(h.denied.size >= 20, "mask actually armed after re-entry (denied=" + h.denied.size + ")");
  }

  console.log(failures.length === 0 ? "ALL_PASS" : "HAS_FAILURES: " + failures.join(" | "));
  process.exit(failures.length === 0 ? 0 : 1);
};
main();