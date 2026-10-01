# Curriculum Runtime — trying it on the dev host

Status: active, 2026-10-01. Owner: jayleekr. One section per `cr-*` item, appended by the item that ships it. Row definitions: [curriculum-runtime.md](curriculum-runtime.md); run records: `curriculum-runtime-<date>-evidence.md`.

Every CR behaviour sits behind the switch `curriculum_runtime.enabled` on the cohort profile (CR-02). The Worker serves it only to an adult, workshop-tier cohort (`curriculumRuntimeAllowed`: not a minor cohort, audience lower age bound 18 or more), and the App mirrors it to the context key `hypeproof-chat.curriculumRuntimeEnabled`. No shipped profile turns it on.

## `cr-browser` — Experiment Browser (#1391)

**Flag:** `curriculum_runtime: { enabled: true }` on the profile, plus `browser_control.enabled` and `observation.format` (the validator refuses the switch without a recorder) and `input.image_paste` for the element crop.

**Fastest check (one command, scripted agent, no model key).** Screen unlocked; an app copy with this branch's extension injected (`e2e/README.md`, "Driving a different .app", or `node e2e/classroom/mac-devhost.mjs`):

```bash
plutil -replace LSUIElement -bool true "<app copy>/Contents/Info.plist"   # once per copy: no Dock icon, never takes focus
codesign --force --deep -s - "<app copy>"
cd e2e
HPS_APP_PATH="<app copy>" npx playwright test -c curriculum-runtime/playwright.config.ts
```

The run stays in the background: quiet mode is the default (`e2e/README.md`, "Quiet mode"), so the window sits off-screen, is shown inactive and is hidden once the workbench is ready, and the `LSUIElement` copy never activates. It still needs an **unlocked** screen (the integrated browser paints no frames on a locked one, recon F7), so `scripts/e2e-quiet.sh`, which waits for the lock, cannot run it; start it when you step away without locking. `HPS_QUIET=0` shows the window for debugging and takes focus. Never point `HPS_APP_PATH` at `/Applications/HypeProof Studio.app`.

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
| 2 | Sends `[cr:flow:console-step3] 다시 해봐` | The answer names the planted error once, at the turn's fourth action ("4단계", the opening navigate is action 1, so flow step 3) |
| 3 | Sends `[cr:flow:disabled-step4] 다시 해봐` | "4단계에서 멈췄어요" |
| 4 | Runs "HypeProof: 화면에서 요소 골라 코치에게 묻기" and clicks "주문 시작" in the preview | A chip "함께 보낼 요소 <button> “주문 시작” · 소스 위치: index.html:23" with a crop; ✕ removes it and nothing of it is sent |
| 5 | Runs "HypeProof: 실험 브라우저 결과 기록 보기" | Each result is listed as "현재 버전 · sha256:…"; after `index.html` changes the same results read "이전 버전". Picking one with a screenshot attaches that stored screenshot to the next message |
| 6 | Restarts `app-service.mjs` with `off` and reloads the window | Neither command is in the palette and the coach is offered none of the five CR tools |

**Where the data is.** Browser results are `tool_result` events tagged `hps-browser-result/1` on the seat's measurement-core record, with the CR-10 keys `artifact_version`, `screenshot_digest` and `trace_digest`; the bytes are `blobs/` entries of the same record under the app's `User/globalStorage/<extension>/local-review-v1/`. The Service's `/__cr/state` shows what reached the scripted agent.
