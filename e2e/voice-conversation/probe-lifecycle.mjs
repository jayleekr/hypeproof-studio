// Independent source-execution probe; synthetic timers/devices, not an App test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = readFileSync(new URL('../../extensions/hypeproof-chat/webview-ui/src/voiceProbe.ts', import.meta.url), 'utf8');
const executable = stripTypeScriptTypes(source).replace('export async function', 'async function');
async function observe(mode) {
  let grant;
  const pending = new Promise(resolve => { grant = resolve; });
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const timers = new Map();
  let next = 0;
  const context = vm.createContext({
    window: {},
    navigator: { userAgent: 'synthetic-lifecycle-control', mediaDevices: {
      getUserMedia: () => mode === 'immediate' ? Promise.resolve(stream) : pending,
    } },
    document: { querySelector: () => null, createElement() {
      const listeners = {};
      return { addEventListener(name, fn) { listeners[name] = fn; },
        set src(value) { if (value) queueMicrotask(() => listeners.loadedmetadata()); } };
    } },
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(executable, context);
  const resultPromise = vm.runInContext('runVoiceCapabilityProbe()', context);
  // Flush Promise continuations, without wall-clock sleeps or real capture.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  if (mode === 'late') {
    const timeout = [...timers.values()].find(t => t.ms === 4000);
    assert.ok(timeout, 'actual probe must schedule its microphone timeout');
    timeout.fn();
  }
  const report = await resultPromise;
  if (mode === 'late') {
    assert.equal(report.getUserMedia.outcome, 'timeout');
    grant(stream);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  } else assert.equal(report.getUserMedia.outcome, 'granted');
  return { mode, outcome: report.getUserMedia.outcome, trackReadyState: track.readyState };
}
const immediate = await observe('immediate');
assert.equal(immediate.trackReadyState, 'ended', 'positive control: granted stream released');
const late = await observe('late');
console.log(JSON.stringify({ source: 'webview-ui/src/voiceProbe.ts', layer: 'synthetic source execution', observations: [immediate, late] }, null, 2));
assert.equal(late.trackReadyState, 'ended', 'late permission grant must release tracks after timeout');
