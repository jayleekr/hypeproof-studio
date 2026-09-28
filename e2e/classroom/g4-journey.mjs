// G4 continuation of mac-curriculum: the authored/rehearsed lesson is used for
// one whole local class, including restart, help, distribution, recovery and wrap-up.
// Real Mac window and HTTP; synthetic people, recorder model and delivery adapter.
import assert from 'node:assert/strict';
import path from 'node:path';
export async function journey(x) {
  const {local,course,VA,seats,teacherToken,browser,boardPort,prefix,launch,attach,enterWork,palette,toasts,wait,ask,idle,quit,ws,shot,out,press,setValue,step,workFiles,A,waitHeader}=x;
  const rowRevision=local.db.prepare('SELECT roster_revision FROM class_run_ops WHERE class_run_id=?').get(local.run).roster_revision;
  const configured=await local.configure(seats,rowRevision,{lesson:{course_id:course,version:VA},flags:{ops_observe:true,ops_commands:true,ops_distribute:true,ops_lesson_settings:true,ops_collect:true,ops_reports:true,ops_delivery:true}});
  assert.equal(configured.status,200,configured.raw);
  const revision=configured.json.roster_revision;
  const issued=await local.request(`/admin/cohorts/${local.cohort}/authoring/${course}/versions/${VA}/participants`,'POST',{user:seats[0].student_id,hours:12},teacherToken);assert.equal(issued.status,200,issued.raw);
  const pair=async win=>{const ticket=(await local.request(local.base+'/pairings','POST',{seat_id:'A1',roster_revision:revision},teacherToken)).json.ticket;await palette(win,'수업 연결 (강사가 준 코드 입력)',ticket);await wait(async()=>(await toasts(win)).some(t=>t.includes('수업에 연결했습니다')),'G4 connected');};
  const dialog=(w,label)=>wait(()=>w.evaluate(t=>{const b=[...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find(b=>b.textContent.trim()===t);if(!b)return false;b.click();return true;},label),'dialog '+label);
  launch('g4',issued.json.token,ws);let win=await attach(),chat=await enterWork();await pair(win);
  await palette(win,'수업 기록 보내기 동의·철회');await dialog(win,'동의하고 보내기 허용');await wait(async()=>(await toasts(win)).some(t=>t.includes('동의를 기록했습니다')),'G4 consent');
  await ask(chat,'Q-G41 모바일에서 예약 버튼을 확인하겠습니다','Q-G41');await idle(chat);await waitHeader(chat,A.mission,'G4 mission');await shot(win,'g4-01-learner-mission.png');
  await quit();launch('g4',issued.json.token,ws);win=await attach();chat=await enterWork();await pair(win);
  await ask(chat,'Q-G42 다시 열어 같은 기준으로 확인했습니다','Q-G42');await idle(chat);await waitHeader(chat,A.mission,'G4 restart');step('G4 authored lesson used across restart');
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  await page.goto('http://127.0.0.1:'+boardPort+'/manage');await page.locator('#token').fill(teacherToken);await page.locator('#cohort').fill(local.cohort);await page.locator('#prefix').fill(prefix);await page.locator('#connect button').first().click();await page.locator('#status').filter({hasText:'연결됨'}).waitFor();
  const row=id=>page.locator(`#ops-seats .ops-seat[data-seat="${id}"]`);await row('A1').waitFor();
  // Help is voluntary and goes to the assigned teacher; the teacher responds in the same board.
  await press(chat,'.hp-help summary','help entry');await wait(()=>chat.evaluate("!!document.querySelector('[data-help-question]')"),'help form');
  await setValue(chat,'[data-help-question]','G4 예약 버튼 확인 위치를 알려주세요');await press(chat,'[data-help-preview]','help preview');await wait(()=>chat.evaluate("!!document.querySelector('[data-help-consent]')"),'consent preview');await press(chat,'[data-help-consent]','help consent');await press(chat,'[data-help-send]','send help');
  await wait(()=>local.db.prepare('SELECT id FROM classroom_shares WHERE student_id=?').get(seats[0].student_id),'help stored');
  await page.locator('#refresh').click();await page.locator('#ops-help-toggle').filter({hasText:'펼치기'}).click();
  await page.locator('#ops-help-list li').filter({hasText:seats[0].student_id}).getByRole('button',{name:'요청 열기'}).click();
  await page.locator('#review-state').selectOption('answered');await page.locator('#feedback-text').fill('G4 버튼을 누르고 화면 변화를 확인해 보세요');await page.locator('#next-action').fill('직접 확인하고 결과 남기기');await page.locator('#feedback button').click();
  await page.screenshot({path:path.join(out,'g4-02-help-feedback.png')});step('G4 help and instructor feedback');
  // A bounded diagnostic, through the actual instructor controls, returns a device result.
  await page.locator('#ops-check').click();await row('A1').getByRole('button',{name:'근거·조치'}).click();
  await page.locator('#ops-actions').getByRole('button',{name:'진단 다시 실행',exact:true}).click();
  await wait(()=>local.db.prepare("SELECT t.state FROM ops_command_targets t JOIN ops_commands c ON c.id=t.command_id WHERE c.action='retry_diagnostics' AND t.seat_id='A1' ORDER BY c.created_at DESC LIMIT 1").get()?.state==='succeeded','G4 device diagnostic receipt',90000);
  await page.screenshot({path:path.join(out,'g4-03-diagnostic.png')});
  // Existing notice distribution, selected seat only, and an explicit receipt.
  if(!(await page.locator('#ops-dist').evaluate(e=>e.open)))await page.locator('#ops-dist-summary').click();
  await page.locator('#ops-dist-new').click();await page.locator('#ops-dist-kind').selectOption('notice');await page.locator('#ops-dist-title').fill('G4 다음 확인');await page.locator('#ops-dist-body').fill('예약 버튼을 확인하고 마무리합니다');await page.locator('#ops-dist-save').click();await page.locator('#ops-dist-saved').filter({hasText:'저장했습니다'}).waitFor();
  await page.locator('#ops-select-none').click();await row('A1').getByLabel('선택').check();await page.locator('#ops-dist-preview').click();await page.locator('#ops-dist-go').click();
  await wait(async()=>{await page.locator('#ops-dist-refresh').click();return /A1 · .*보관함/.test(await page.locator('#ops-dist-items').innerText());},'G4 notice applied',90000);
  assert.equal(local.db.prepare("SELECT count(*) n FROM classroom_distribution_targets WHERE seat_id<>'A1'").get().n,0);
  // Evaluation and external delivery seams are synthetic. They do not exercise credentials or send mail.
  const {setEvaluatorTransport}=await import('../../worker/src/routes/classroom-reports.ts');
  local.env.HPS_CLASSROOM_EVALUATOR='service-anthropic';
  setEvaluatorTransport(async req=>{const qs=JSON.parse(req.messages[0].content).evidence_catalog.filter(q=>q.basis&&/Q-G4/.test(q.quote));return Response.json({content:[{type:'text',text:JSON.stringify({findings:[{capability:'VERIFY',status:'observed',claim:'확인할 기준을 정하고 다시 확인했다',evidence:qs.map(q=>({quote_id:q.quote_id})),assistance:'assisted'}],next_experiment:'다음에는 다른 화면 크기에서도 확인하기'})}]});});
  const {registerDeliveryAdapter}=await import('../../worker/src/routes/classroom-delivery.ts');let sent=0;
  registerDeliveryAdapter({id:'sandbox',external:true,send:async()=>{sent++;return{status:'accepted',provider_message_id:'g4-message'};}});local.env.HPS_DELIVERY_PROVIDER='sandbox';
  const admin={authorization:'Basic '+Buffer.from('x:pw').toString('base64')};assert.equal((await local.request('/admin/classroom/recipients','POST',{class_run_id:local.run,source_ref:'synthetic-g4',recipients:[{student_id:seats[0].student_id,recipient_ref:'guardian-g4',channel:'email',address:'guardian@example.test',viewer_check:{kind:'phone_last4',value:'4821'}}]},null,admin)).status,201);
  await page.locator('#ops-finish-dry').uncheck();await page.locator('#ops-finish-go').click();
  await wait(async()=>{await page.locator('#ops-jobs-go').click();return local.db.prepare("SELECT id FROM classroom_report_jobs WHERE student_id=? AND state IN ('partial','review_required')").get(seats[0].student_id);},'G4 native records to report',120000);
  await page.locator('#ops-reports-refresh').click();await page.locator('#ops-reports-list').getByRole('button',{name:'초안 열기'}).first().click();
  await page.locator('#ops-report-view').getByText('이 보고서에 포함된 기록',{exact:true}).waitFor();const reportText=await page.locator('#ops-report-view').innerText();assert.match(reportText,/Q-G41/);assert.match(reportText,/Q-G42/);
  await page.locator('#ops-report-view').screenshot({path:path.join(out,'g4-04-report-review.png')});await page.locator('#ops-report-view').getByRole('button',{name:'근거 확인하고 내용 승인'}).click();
  await page.locator('#ops-recipients-go').click();await page.locator('#ops-approve-go').click();await page.locator('#ops-send-go').click();
  // The final confirmation is discovered from the actual form, not an assumed API mutation.
  await page.locator('#ops-send-confirm button').filter({hasText:/발송/}).click();
  await wait(()=>sent===1,'sandbox provider receipt');assert.equal(local.db.prepare('SELECT state FROM classroom_report_deliveries').get().state,'provider_accepted');
  await local.request('/admin/classroom/delivery-events','POST',{provider_event_id:'g4-delivered',provider_message_id:'g4-message',kind:'delivered'},null,admin);
  await page.locator('#ops-deliveries-go').click();await page.screenshot({path:path.join(out,'g4-05-delivery.png'),fullPage:true});
  assert.deepEqual(workFiles(),{changed:[],added:[]});setEvaluatorTransport(undefined);
  step('G4 approved report and sandbox delivery completed');
  return {source:'mac-curriculum continuation',report_text:reportText,work_files:workFiles(),sandbox_messages:sent,not_run:['real learners','real model quality','real recipient','multiple physical PCs','Windows','school network','hosted D1/R2','installed Keychain','TJ unassisted operation']};
}
