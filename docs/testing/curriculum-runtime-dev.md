# Curriculum Runtime — trying it on the dev host

Status: active, 2026-10-01. Owner: jayleekr. One section per `cr-*` item, appended by the item that ships it. Row definitions: [curriculum-runtime.md](curriculum-runtime.md); run records: `curriculum-runtime-<date>-evidence.md`.

Every CR behaviour sits behind the switch `curriculum_runtime.enabled` on the cohort profile (CR-02). The Worker serves it only to an adult, workshop-tier cohort (`curriculumRuntimeAllowed`: not a minor cohort, audience lower age bound 18 or more), and the App mirrors it to the context key `hypeproof-chat.curriculumRuntimeEnabled`. No shipped profile turns it on.

## `cr-browser` — Experiment Browser (#1391)

**Flag:** `curriculum_runtime: { enabled: true }` on the profile, plus `browser_control.enabled` and `observation.format` (the validator refuses the switch without a recorder) and `input.image_paste` for the element crop.

**Fastest check (one command, in the background, scripted agent, no model key).** An app copy with this branch's extension injected (`e2e/README.md`, "Driving a different .app", or `node e2e/classroom/mac-devhost.mjs`), prepared once so it never takes focus:

```bash
bash scripts/prep-test-app.sh "<app copy>"     # once per copy: LSUIElement=1, ad-hoc re-sign
GATE=idle HPS_APP_PATH="<app copy>" bash scripts/e2e-quiet.sh npx playwright test -c curriculum-runtime/playwright.config.ts
```

`GATE=idle` starts the run only after 5 minutes without keyboard or mouse input with the screen **unlocked**, and stops it (exit 75, "retry later", not a failure) the moment you touch the Mac, so you can keep working and it waits for you to step away. The run itself is quiet: the window sits off-screen, is shown inactive and is never focusable, and the prepared copy never activates (`e2e/README.md`, "Quiet mode"). This config sets `HPS_QUIET_NO_HIDE=1` because a hidden app's integrated browser paints no frames; for the same reason the screen must stay unlocked (recon F7), so the default `GATE=lock` cannot run it. `HPS_QUIET=0` shows the window for debugging and takes focus. Never point `HPS_APP_PATH` at `/Applications/HypeProof Studio.app`.

**What runs while you work, and what waits.** No framework change is needed for either.

| Layer | Command | While you work |
|---|---|---|
| Unit, smoke, headless Chromium (CR-T03..T11 halves, `test:cr-browser`) | `cd extensions/hypeproof-chat && npm test`, `cd worker && npm test`, `cd e2e && npm run test:cr-browser` | Runs in the background. No window, no focus change |
| In-app Electron (this Playwright config) | `GATE=idle ... e2e-quiet.sh` above | Quiet (no focus, no Dock icon), but it **waits** until you have been idle for 5 minutes and **stops** when you come back, so it effectively runs while you are away |

It starts its own local Service (`e2e/curriculum-runtime/app-service.mjs`: the real Service router, the `canary-sdk-contract` profile with the switch set in that process only, a scripted agent as the model) and writes `e2e/test-results/cr-app/result.json`.

**By hand, in the dev app.** The local Service must answer on port 8787, so stop `scripts/dev-stack.sh`'s wrangler first, then:

```bash
STATE="$HOME/Library/Application Support/HypeProof Studio Development/cr-browser"
python3 scripts/studio-dev.py --state-dir "$STATE" --provider service prepare   # claims the state dir first
node --experimental-strip-types --experimental-sqlite e2e/curriculum-runtime/app-service.mjs 8787 "$STATE/local-participant-token.txt" on &
python3 scripts/studio-dev.py --state-dir "$STATE" --provider service run --service local
```

`--provider service` keeps the coach on the Service, where the scripted agent answers; the default `claude` provider would route it to a local CLI instead. This by-hand path was written from the scripts, not executed end to end; the Playwright run above is the executed one.

Copy `e2e/curriculum-runtime/fixtures/kiosk-practice/` into the workspace, open `index.html` and run "HypeProof: HTML 미리보기 (옆 패널)". The scripted agent acts only on messages that start with a scenario tag; anything else gets "[로컬 시험 응답] 받았어요."

| Step | What the student does | Expected (in student terms) |
|---|---|---|
| 1 | Sends `[cr:flow] 주문 시작부터 주문 완료까지 눌러보고 오류가 있으면 몇 번째 단계였는지 알려줘` | The preview gets an orange outline while each step runs and loses it after; the chat shows one tool line per step that goes from running to done; the answer is "다섯 단계를 모두 마쳤어요. 오류: 없음" |
| 2 | Sends `[cr:flow:console-step3] 다시 해봐` | The answer names the planted error once, at flow step 3 ("3단계 planted-step3-error"). The tool result itself says "단계 4": the browser counts the request's actions and the opening navigate is action 1 |
| 2a | Right after step 2, sends `[cr:again] 지금 화면 다시 보고 도움말 보기 눌러봐` (this request does not navigate) | The tool results list the planted error as "이전 요청 planted-step3-error…", never with a step number, and the answer reports "오류: 없음" |
| 3 | Sends `[cr:flow:disabled-step4] 다시 해봐` | "4단계에서 멈췄어요" |
| 4 | Runs "HypeProof: 화면에서 요소 골라 코치에게 묻기" and clicks "주문 시작" in the preview | A chip "함께 보낼 요소 <button> “주문 시작” · 소스 위치: index.html:23" with a crop; ✕ removes it and nothing of it is sent |
| 5 | Runs "HypeProof: 실험 브라우저 결과 기록 보기" | Each result is listed as "현재 버전 · 버전 1" (versions numbered per page in the order they were seen); after `index.html` changes the same results read "이전 버전". Picking one with a screenshot attaches that stored screenshot to the next message |
| 5a | In the same list, picks "저장된 화면·동작 기록 지우기" and confirms | "저장된 화면·동작 기록 N개를 지웠어요." The results stay listed; picking one now says "기록된 화면을 찾지 못했어요." |
| 6 | Restarts `app-service.mjs` with `off` and reloads the window | Neither CR command is in the palette and the coach is offered none of the five CR tools. If screens are still stored (skip 5a to see this), "HypeProof: 저장된 실험 브라우저 화면 지우기" is in the palette: it shows the count, asks ("내가 저장한 실험 브라우저 화면과 동작 기록 N개를 지울까요? 되돌릴 수 없어요."), and deletes them. It disappears once nothing is stored. Signed in as another student on the same computer, it is not there: each student sees and deletes only the screens they stored |

**Where the data is.** Two places. Browser results are `tool_result` events tagged `hps-browser-result/1` in the workspace's native observation batch (VS Code `workspaceState`, the `NativeObservationRecorder` batch), with the CR-10 keys `artifact_version`, `screenshot_digest` and `trace_digest`. The bytes those digests name are `blobs/` entries of the local measurement-core record under the app's `User/globalStorage/<extension>/local-review-v1/`, the directory the local review uses. Bytes are stored only when the turn has a recorder with room for the result's event, and are bounded at 64 MB of their own (oldest removed first, silently, never counted against the local review's 256 MB). Each stored blob also has an owner marker (`blob-owners/<owner>/<digest>`, the owner a digest of the signed-in account or cohort-local user, never the identity), so one student's count and delete never reach another student's screens on a shared PC; whether to show the delete command is read from the app's `globalState` (`hypeproof-chat.crBytesOwners`), not from disk. The student deletes them with the results command (step 5a) or, whatever the CR switch says, with "HypeProof: 저장된 실험 브라우저 화면 지우기" (step 6). Deleting a local-review task does not remove them today: no local-review observation names these digests (the local review imports only user and coach turns), so `deleteTask`'s byte removal is defence in depth for a future import of the native batch, not a path the student can use. The Service's `/__cr/state` shows what reached the scripted agent.

## `cr-verify` — AI Verify (#1392)

**Flag:** the same `curriculum_runtime: { enabled: true }` (with `browser_control.enabled` and an `observation.format` of `hps-observation/2`, which learning events need). Nothing else; no setting, environment variable or build flag.

**Fastest check (background, scripted agent, no model key).** The same prepared app copy as `cr-browser` with this branch's extension injected:

```bash
GATE=idle HPS_APP_PATH="<app copy>" bash scripts/e2e-quiet.sh npx playwright test -c curriculum-runtime/playwright.config.ts verify-app
```

It writes `e2e/test-results/cr-app/verify-result.json`. The unit and smoke halves run with `cd worker && npm test` and `cd extensions/hypeproof-chat && npm test` (`cr-verify.test.mjs`, `cr-verify.smoke.mjs`, `verify-panel.smoke.mjs`).

**By hand** (same setup as `cr-browser` above: `app-service.mjs` on 8787 with `on`, the kiosk fixture in the workspace, its preview open). The scripted agent answers a test run with one `verify_criterion` per criterion, choosing a plan by words in the criterion: "음료 고르기" (press 주문 시작), "주문이 완료" (the five-step order), "결제 완료" (the order, expecting text the fixture lacks), "오류" (the order, no errors), "흔들" (the order on the planted flaky page), "바깥" (a step to an external site).

| Step | What the student does | Expected (in student terms) |
|---|---|---|
| 1 | Runs "HypeProof: 내 제품 테스트하기" | A "내 제품 테스트" box opens in the chat: "이 버전은 아직 테스트하지 않았어요" |
| 2 | Removes the empty row and presses "테스트 시작" | "기대 조건은 1개에서 5개까지 적을 수 있어요." Nothing is sent |
| 3 | Sends `[cr:propose] 조건 하나 제안해 줘`, clicks the proposal, presses "테스트 시작" without "이대로 쓰기" | The row says "코치 제안 · 확인 필요"; the start is refused ("코치가 제안한 조건은 내가 확인해야 쓸 수 있어요…") |
| 4 | Types "주문 시작을 누르면 음료 고르기가 보인다", "주문하면 주문이 완료되었어요가 보인다", "주문하는 동안 오류가 없다" and presses "테스트 시작" | My sentence goes to the coach; "🧪 테스트 중" shows and the preview gets the orange outline while each step runs; then three "통과" rows and "검증됨 · 이 버전에서 기대 조건을 모두 통과했어요" |
| 5 | Presses "같은 조건으로 다시 테스트" | The same three "통과"; the coach is not asked again |
| 6 | Tests "주문하면 결제 완료가 보인다" | "실패 주문하면 결제 완료가 보인다", the state "통과하지 못한 조건이 있어요", a box to write what to fix |
| 7 | Writes "결제 완료 문구도 보이게 고쳐 주세요" and presses "고쳐 달라고 하기" | That sentence goes to the coach with the failed steps and evidence attached (not shown in the bubble) |
| 8 | Adds `<p>결제 완료</p>` after the done heading in `index.html` (what the coach would do), reopens the box | "파일이 바뀌었어요 · 다시 테스트해 주세요 (이전 결과는 남아 있어요)", the old result labelled "이전 버전의 테스트 결과" |
| 9 | Presses "같은 조건으로 다시 테스트" | Both rows "통과" and "검증됨" again; the fixed criterion is recorded as a re-test after the fix |
| 10 | Tests "흔들리는 화면에서도 주문이 완료된다", then re-tests | "결과가 매번 달라요" — never "통과" |
| 11 | Tests "바깥 사이트로 가도 주문이 된다" | "확인 안 됨" with "…범위 밖이라 거절했어요"; the browser never leaves the preview |
| 12 | Restarts `app-service.mjs` with `off` and reloads | "내 제품 테스트하기" is not in the palette; the coach is offered neither verify tool |

**Where the data is.** Everything is on the workspace's native observation batch (VS Code `workspaceState`, the `hps-observation/2` batch): `criterion_set` (the student's words), an `artifact` event tagged `hps-artifact-version/1` per tested version, the `verify_criterion` `tool_request` / `tool_result` pair (`hps-verify-result/1`: plan, steps, citations, verdict), and `test_observed` / `retest_confirmed` (actor `ai`) and `change_requested`. The report is recomputed from them each time the box opens. A stored screenshot of a verdict is a `blobs/` entry of the local record, as in `cr-browser`, deletable with the same command.

## `cr-publish` — Publish for User Test (#1393)

**Flag:** the same `curriculum_runtime: { enabled: true }`. The Service also needs `HPS_TEST_ORIGIN`, where published test versions are served: unset (the default) means no test can be started and no link can be made. Nothing else.

**Fastest check (background, no app, no phone).** Real Chromium as a 390 px phone against the real Service router:

```bash
cd worker && node --experimental-strip-types --experimental-sqlite test/cr-publish.test.mjs    # Service + App session, SQLite
cd worker && npm run test:cr-publish:d1                                                         # the same on local workerd D1
cd e2e && npm run test:cr-publish                                                                # the phone checks in Chromium
```

On local workerd D1 (`--d1`) every query is a new loopback TCP connection, and macOS keeps closed ones in TIME_WAIT for a while out of a 16,384-port range. The `--d1` run therefore opens 60 visits in the classroom-scale check instead of the SQLite run's 500 (the per-visit R2 cost is still compared first against last). If a second `--d1` run right after another fails with `EADDRNOTAVAIL` or `fetch failed`, wait about a minute and run it again; that is the Mac, not the change.

**In the app (background, scripted agent).** The same prepared copy as `cr-browser`:

```bash
GATE=idle HPS_APP_PATH="<app copy>" bash scripts/e2e-quiet.sh npx playwright test -c curriculum-runtime/playwright.config.ts publish-app
```

It writes `e2e/test-results/cr-app/publish-result.json`. Its local Service is `app-service.mjs` with a fourth argument `publish`: SQLite D1, an in-memory R2 and `HPS_TEST_ORIGIN=http://{project}.test.invalid:<port>`.

**By hand, with a phone.** Same setup as `cr-browser` above, but start the Service with `publish` and a public test origin from ngrok (a dev-only shared origin: every project shares it, which the Service refuses in production):

```bash
/opt/homebrew/bin/ngrok http 8787                       # note the https://….ngrok-free.app address
HPS_TEST_ORIGIN="https://<that host>" node --experimental-strip-types --experimental-sqlite e2e/curriculum-runtime/app-service.mjs 8787 "$STATE/local-participant-token.txt" on publish &
python3 scripts/studio-dev.py --state-dir "$STATE" --provider service run --service local
```

On this shared origin one part of CR-11 does not hold: "another project's published test version is refused". Every project's links are served from the one ngrok host, and the App allows the Experiment Browser by origin, so the agent and the test runner may act on another team's `/l/<link>/` there too. Check that case on the dedicated `http://{project}.test.invalid:<port>` origin (the Playwright runs above), never on the ngrok path.

With `scripts/dev-stack.sh` (wrangler dev) instead: apply the migration to the local D1 once (`cd worker && npx wrangler d1 execute hypeproof-studio --local --file=migrations/0032-curriculum-runtime-publish.sql`), put `HPS_TEST_ORIGIN=https://<ngrok host>` in `worker/.dev.vars`, and use an adult workshop cohort whose profile has the switch on locally (no shipped profile does, and the kids default never gets it). ngrok's free plan shows its own "You are about to visit" page on the phone's first open; that page is ngrok's, not a HypeProof login. These by-hand paths were written from the scripts, not executed end to end; the Playwright and Chromium runs above are the executed ones.

| Step | What the student does | Expected (in student terms) |
|---|---|---|
| 1 | Opens `index.html` of the kiosk fixture in the preview, runs "HypeProof: 사용자 테스트용으로 공개하기" | A "사용자 테스트용으로 공개" box: "검증 안 됨 · 이 버전은 아직 테스트하지 않았어요", "공개할 버전 7187b0db · 파일 3개", the file list (no `.env`, no file the page does not use) |
| 2 | Runs "내 제품 테스트하기" with "주문 시작을 누르면 음료 고르기가 보인다" until it passes (the first run on a fresh preview may say "확인 안 됨"; "같은 조건으로 다시 테스트"), then reopens the publish box | "검증됨 · 이 버전은 기대 조건을 모두 통과했어요" |
| 3 | Writes a hypothesis, a question, one success criterion, "학교 게시판" as the channel; tries "공개하고 테스트 시작" without a link period | The button stays off until a period (1·3·7·14일) is chosen; nothing is preselected |
| 4 | Chooses 3일 and presses "공개하고 테스트 시작" | "공개했어요: <주소>"; under the experiment, the link with its QR and "링크 끄기" |
| 5 | Scans the QR with a phone | The kiosk opens without any HypeProof login, sized for the phone |
| 6 | Adds `const k = "AIza…"` (any Gemini-shaped key) to `app.js` and publishes again | "app.js: 비밀값처럼 보이는 내용이 있어 공개하지 않았어요" with "app.js <그 줄>번째 줄 (gemini_key)"; nothing is uploaded |
| 7 | Removes the key, changes the heading, opens the box | "검증 안 됨 · 파일이 바뀐 뒤 아직 다시 테스트하지 않았어요"; the running experiment says "이전 버전 · 이 실험은 계속 이 버전을 보여 줘요" and its link still shows the old heading |
| 8 | Makes another link for the same experiment labelled "1:1 메시지", opens both links once on the phone, then reloads the "학교 게시판" page and goes back to its first page | "링크를 연 횟수: 학교 게시판 1 · 1:1 메시지 1 · 채널 이름 없음 0 · 알 수 없음 0" and "연 횟수예요. 원한다는 뜻은 아니에요." A reload or a return in the same tab is the same visit and does not add one; pasting the link into a chat app that only shows a preview does not add one either |
| 9 | Presses "링크 끄기" on "학교 게시판" and reloads it on the phone | The phone shows the browser's own error page (410), no kiosk; the "1:1 메시지" link still opens |
| 10 | Restarts the Service with `off` and reloads the window | The command is not in the palette; the share link answers like an unknown address |

**Where the data is.** On the Service: the D1 tables `cr_projects`, `cr_hypotheses`, `cr_product_versions`, `cr_experiments` and `cr_test_links` (one `hps-venture/1` document per row); the published files as R2 objects `test-versions/<digest>/<path>` of `HPS_TRACES`; each participant session as the per-session key `curriculum/<cohort>/<project>/sessions/published/<session id>` of the measurement-core record on the same bucket, with its `attribution` (project, experiment, product version, link, channel), written once per visit when the page's script opens it (`POST /l/<link>/__hp/session`); the per-link count in `cr_test_links.sessions_opened`, which the panel's counts read. In the App: the Project id and its test origin per signed-in person in `workspaceState` (`hypeproof-chat.crProjects`). With the in-memory fixtures (`app-service.mjs publish`, the tests), all of it is gone when the process ends.
