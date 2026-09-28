// Driving REAL Studio windows over the debugging port (#751). Shared by the U4 runner; the U2/U3 runners keep the copies they
// were accepted with. Every learner control is pressed with real mouse input at its on-screen position after checking that it
// is visible and not covered — a node in the DOM is not a control a learner can use.
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from '@playwright/test';

export function macWindow({ debugPort, realFetch, out }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let cdp = null;
  const wait = async (fn, label, ms = 60000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(300); } throw Error('timed out: ' + label + (last instanceof Error ? ' — ' + last.message : '')); };
  const workbenches = () => cdp.contexts().flatMap((c) => c.pages()).filter((p) => p.url().includes('workbench'));
  async function attach() { cdp = null; for (let i = 0; i < 90 && !cdp; i++) { try { cdp = await chromium.connectOverCDP('http://127.0.0.1:' + debugPort); } catch { await sleep(1000); } } assert.ok(cdp, 'the Studio copy did not open its debugging port'); const w = await wait(() => workbenches()[0], 'workbench window', 90000); await w.waitForTimeout(6000); return w; }
  const toasts = (w) => w.evaluate(() => [...document.querySelectorAll('.notifications-toasts .notification-list-item-message, .notifications-center .notification-list-item-message')].map((e) => e.textContent));
  const palette = async (w, title, typed) => { await w.bringToFront(); await w.keyboard.press('F1'); await w.waitForSelector('.quick-input-widget input', { state: 'visible' }); await w.keyboard.type(title, { delay: 15 }); await wait(() => w.evaluate((t) => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((r) => r.textContent.includes(t)), title), 'command ' + title); await w.keyboard.press('Enter');
    if (typed !== undefined) { await wait(() => w.evaluate(() => document.querySelector('.quick-input-widget')?.textContent.includes('수업 연결 코드')), 'ticket prompt'); await w.keyboard.type(typed, { delay: 10 }); await w.keyboard.press('Enter'); } };
  /** A webview of this extension that contains `selector` and satisfies `where`. Returns an evaluator AND the raw input channel of that webview, and its
   * debugger target `id`; `skip` (target ids) leaves out webviews already known to belong to another window. */
  const frame = (selector, where = 'true', ms = 60000, skip = null) => wait(async () => { for (const t of (await (await realFetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).filter((x) => x.type === 'iframe' && x.url.includes('hypeproof-chat') && !skip?.has(x.id))) { const sock = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; }); let id = 0; const pending = new Map();
      sock.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { const [r, j] = pending.get(m.id); pending.delete(m.id); m.error ? j(Error(m.error.message)) : r(m.result); } }; const send = (method, params = {}) => new Promise((r, j) => { const n = ++id; pending.set(n, [r, j]); sock.send(JSON.stringify({ id: n, method, params })); });
      await send('Page.enable'); const { frameTree } = await send('Page.getFrameTree'); for (const f of [frameTree, ...(frameTree.childFrames || [])]) { const contextId = (await send('Page.createIsolatedWorld', { frameId: f.frame.id, worldName: 'hps-mac-window' })).executionContextId; const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true })).result?.value;
        if (await evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')&&!!(' + where + ')')) return { evaluate, send, id: t.id }; } sock.close(); } return null; }, 'webview ' + selector + ' where ' + where, ms);
  const TEXTAREA = '.hps-input textarea', hasText = (t) => 'document.body.textContent.includes(' + JSON.stringify(t) + ')';
  /**
   * What a learner does: look at the control, move the mouse there, press. The control must have a size, be inside the webview's
   * viewport after scrolling to it, be the topmost element at its centre, be enabled and visible — a node in the DOM that fails
   * any of these is not something a learner can use, and the run fails instead of calling .click() on it.
   */
  async function press(chat, selector, label) {
    const r = await chat.evaluate(`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,250));const b=e.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2,hit=document.elementFromPoint(x,y),cs=getComputedStyle(e);return {x,y,w:Math.round(b.width),h:Math.round(b.height),in_view:b.top>=0&&b.bottom<=innerHeight&&b.left>=0&&b.right<=innerWidth,topmost:!!hit&&(hit===e||e.contains(hit)),disabled:!!e.disabled,visible:cs.visibility==='visible'&&cs.display!=='none'&&Number(cs.opacity)>0,text:e.textContent.trim().slice(0,40)};})()`);
    assert.ok(r && r.w > 0 && r.h > 0 && r.in_view && r.topmost && !r.disabled && r.visible, label + ' is not a visible control a learner can press: ' + JSON.stringify(r));
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await chat.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await sleep(350); return r; }
  const setDraft = (chat, text) => chat.evaluate(`(()=>{const e=document.querySelector('${TEXTAREA}');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.focus();})()`);
  const pressEnter = (chat) => chat.evaluate(`(()=>{const e=document.querySelector('${TEXTAREA}');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));})()`);
  const draftOf = (chat) => chat.evaluate(`document.querySelector('${TEXTAREA}').value`), attachments = (chat) => chat.evaluate("document.querySelectorAll('.hps-attachment').length"), parkedOf = (chat) => chat.evaluate("document.querySelector('.hps-queued-text')?.textContent ?? null");
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const pasteImage = (chat, name) => chat.evaluate(`(()=>{const e=document.querySelector('${TEXTAREA}'),b=Uint8Array.from(atob('${PNG}'),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([b,${JSON.stringify(name)}],${JSON.stringify(name)},{type:'image/png'}));e.focus();e.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));})()`);
  const enterWork = async (where, skip = null) => { const e = await frame('.studio-primary, ' + TEXTAREA, where, 120000, skip); if (await e.evaluate("!!document.querySelector('.studio-primary')")) await press(e, '.studio-primary', 'the entry screen\'s Primary'); return frame(TEXTAREA, where, 60000, skip); };
  const shot = async (w, name) => { try { await w.screenshot({ path: path.join(out, name) }); } catch (e) { console.log('screenshot skipped: ' + e.message); } };
  const answers = (chat) => chat.evaluate(`(document.body.textContent.match(/로컬 시험 응답/g)||[]).length`), answered = (chat, count) => wait(async () => (await answers(chat)) >= count, count + ' answers on screen', 120000);
  const idle = (chat) => wait(() => chat.evaluate("![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Stop')"), 'the turn ended on screen', 120000);
  return { sleep, wait, workbenches, attach, toasts, palette, frame, TEXTAREA, hasText, press, setDraft, pressEnter, draftOf, attachments, parkedOf, pasteImage, enterWork, shot, answers, answered, idle };
}
