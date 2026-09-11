// Actual React/CSS in Chromium with synthetic session props; no microphone or App.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
const repo = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const webRequire = createRequire(`${repo}/extensions/hypeproof-chat/webview-ui/package.json`);
const output = `${repo}/e2e/test-results/voice-popup`;
await fs.mkdir(output, { recursive: true });
const source=`import React from 'react';import {createRoot} from 'react-dom/client';
import {VoicePanel} from '${repo}/extensions/hypeproof-chat/webview-ui/src/VoicePanel.tsx';
import {initialPopupState,meterView} from '${repo}/extensions/hypeproof-chat/src/voicePopupHelpers.ts';
import {initialVoiceSession} from '${repo}/extensions/hypeproof-chat/src/voiceSessionHelpers.ts';
const root=createRoot(document.getElementById('root'));window.actions=[];
let popup={...initialPopupState(),presentation:'expanded'},long=false,reduce=false,level=.4;
const session={...initialVoiceSession(),state:'listening',captureOpen:true,listeningSessions:1};
function render(){root.render(<VoicePanel coachName="발표 도우미" session={session} popup={popup} meter={meterView(session,{inputLevel:level,outputPlaying:false,outputLevel:null},{reduceMotion:reduce})} reference={{title:'발표자료',revision:'r1'}} info={[{label:'이용',value:'강의 포함',certainty:'known'}]} finalTranscript={long?'작업 내용을 함께 검토합니다. '.repeat(150):'첫 장을 간단하게 바꾸고 싶어요.'} partialTranscript="제목부터…" failure={null} onMinimize={()=>{popup={...popup,presentation:'compact'};render()}} onExpand={()=>{popup={...popup,presentation:'expanded'};render()}} onToggleMute={()=>window.actions.push('mute')} onResume={()=>window.actions.push('resume')} onStopSpeaking={()=>window.actions.push('stop-speaking')} onDismiss={kind=>window.actions.push(kind)} onRetry={()=>window.actions.push('retry')}/>)}
window.fixture=(p)=>{if(p.long!==undefined)long=p.long;if(p.reduce!==undefined)reduce=p.reduce;if(p.level!==undefined)level=p.level;if(p.presentation)popup={...popup,presentation:p.presentation};render()};render();`;
const result = await build({stdin:{contents:source,loader:'tsx',resolveDir:repo},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',alias:{react:path.dirname(webRequire.resolve('react/package.json')),'react-dom':path.dirname(webRequire.resolve('react-dom/package.json'))}});
const browser = await chromium.launch({headless:true});
const checks = {};
const errors = [];
const observations = {};
try {
  const page = await browser.newPage({viewport:{width:900,height:800}});
  page.on('pageerror', e => errors.push(e.message));
  await page.setContent('<!doctype html><html><body><p>합성 UI 인수 · 실제 마이크/설치앱 아님</p><div id="root"></div></body></html>');
  await page.addStyleTag({content:await fs.readFile(`${repo}/extensions/hypeproof-chat/webview-ui/src/styles.css`,'utf8')});
  await page.addScriptTag({content:result.outputFiles[0].text});
  await page.getByRole('dialog').waitFor();
  await page.screenshot({path:`${output}/expanded.png`});
  await page.getByRole('button',{name:'음성 대화 축소'}).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('region').waitFor();
  checks.compactFocusRetained = await page.getByRole('region').evaluate(e => e.contains(document.activeElement));
  await page.keyboard.press('Escape');
  checks.compactEscape = await page.evaluate(() => window.actions.includes('escape'));
  await page.screenshot({path:`${output}/compact.png`});
  await page.evaluate(() => { window.actions = []; });
  await page.getByRole('button',{name:'펼치기',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  checks.expandedFocusRetained = await page.getByRole('dialog').evaluate(e => e.contains(document.activeElement));
  await page.keyboard.press('Escape');
  checks.expandedEscape = await page.evaluate(() => window.actions.includes('escape'));
  // Match the host's media-derived reduceMotion prop. Test live, reduced, and unobserved inputs.
  for (const reduce of [false,true]) {
    await page.emulateMedia({reducedMotion:reduce?'reduce':'no-preference'});
    const heights = [];
    for (const level of [.1,.9,null]) {
      await page.evaluate(p => window.fixture(p),{reduce,level});
      await page.waitForTimeout(200); // CSS height transition is 100 ms.
      heights.push(await page.locator('.hps-voice-bar').evaluateAll(es => es.map(e=>e.getBoundingClientRect().height)));
    }
    observations[reduce?'reducedMotion':'ordinaryMotion'] = heights;
    checks[reduce?'reducedMotionStatic':'observedAudioMoves'] = reduce
      ? JSON.stringify(heights[0])===JSON.stringify(heights[1])
      : heights[1][2]>heights[0][2];
    checks[reduce?'reducedUnobservedStatic':'unobservedStatic'] = heights[2].every(h=>h===12);
  }
  await page.setViewportSize({width:320,height:640});
  await page.evaluate(() => window.fixture({long:true}));
  await page.waitForTimeout(100);
  const scroll = page.locator('.hps-voice-body');
  // The original implementation scrolls the whole panel; retain it as a failing baseline.
  const scroller = await scroll.count() ? scroll : page.locator('.hps-voice-panel');
  checks.longTranscriptScrollable = await scroller.evaluate(e=>e.scrollHeight>e.clientHeight);
  await scroller.evaluate(e=>{e.scrollTop=e.scrollHeight;});
  observations.narrow = await page.locator('.hps-voice-panel').evaluate(panel => {
    const box=panel.getBoundingClientRect();
    return [...panel.querySelectorAll('.hps-voice-status,button')].map(e=>{
      const r=e.getBoundingClientRect();
      return {name:e.getAttribute('aria-label')||e.textContent,visible:r.top>=box.top&&r.bottom<=box.bottom&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth};
    });
  });
  checks.essentialControlsVisibleAfterScroll = observations.narrow.filter(c=>['음성 대화 종료','음소거','텍스트로 전환'].includes(c.name)).every(c=>c.visible);
  checks.statusVisibleAfterScroll = observations.narrow.find(c=>c.name.includes('듣고'))?.visible===true;
  await page.screenshot({path:`${output}/narrow-bottom.png`});
  await page.getByRole('button',{name:'음소거',exact:true}).click();
  await page.getByRole('button',{name:'텍스트로 전환',exact:true}).click();
  await page.getByRole('button',{name:'음성 대화 종료',exact:true}).click();
  checks.controlCallbacks = await page.evaluate(()=>['mute','switch_to_text','panel_close'].every(x=>window.actions.includes(x)));
  checks.noBrowserErrors = errors.length===0;
} finally {
  await browser.close();
  const evidence={layer:'Chromium actual component with synthetic props; no audio/App',checks,observations,errors};
  await fs.writeFile(`${output}/observations.json`,JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
}
if (Object.values(checks).some(passed=>!passed)) process.exitCode=1;
