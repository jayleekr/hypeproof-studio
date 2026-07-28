const PORT = process.env.HPS_CDP_PORT ?? "9333";
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find((x) => x.type === "iframe" && x.url.includes("hypeproof-chat"));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, [res, rej]); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const [r, j] = pend.get(m.id); pend.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); } };
await new Promise((r) => (ws.onopen = r));
await send("Page.enable"); await send("Runtime.enable");
const { frameTree } = await send("Page.getFrameTree");
const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: frameTree.childFrames[0].frame.id, worldName: "peek" });
const r = await send("Runtime.evaluate", {
  expression: `(() => { const m=[...document.querySelectorAll('.hps-msg-assistant')]; const e=m[m.length-1]; return ((e&&(e.querySelector('.hps-msg-body')||e).textContent)||'').trim(); })()`,
  contextId: executionContextId, returnByValue: true,
});
console.log(r.result.value);
ws.close();
