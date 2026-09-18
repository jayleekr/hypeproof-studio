// #607 — 상시 "기록 보내기" 진입점.
//
// 고치기 전 상태: 업로드 트리거가 팔레트 커맨드 + 배너 2종뿐이었다(#596,
// REQ-Q9). 배너를 지나친 학생의 재진입점은 명령 팔레트 하나인데, 초등학생
// 코호트는 팔레트를 쓰지 못한다 — opt-in 을 켠 수업에서도 **도달 수단이
// 없는 기능**이었다.
//
// 이 파일이 잠그는 것은 셋이다:
//   1. 웹뷰 버튼이 opt-in 을 **호스트와 같은 한 값, 같은 방향**으로 본다
//   2. 호스트는 업로드 로직을 다시 쓰지 않고 기존 커맨드를 부른다
//   3. 그 커맨드의 fail-closed 게이트가 그대로 있다 — 버튼을 안 보는 좌석이
//      메시지를 직접 보내도 결과가 같아야 진입점 추가가 정책 변경이 아니다
//
// 웹뷰는 별도 vite 앱이라 호스트 모듈을 import 하지 않는다(갤러리 게이트와
// 같은 이유, REQ-M33). 그래서 미러링 드리프트는 소스로 확인한다.
//
// Run: node --experimental-strip-types test/session-upload-entrypoint.smoke.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8');

const panel = read('webview-ui', 'src', 'ChatPanel.tsx');
const app = read('webview-ui', 'src', 'App.tsx');
const protocol = read('src', 'protocol.ts');
const provider = read('src', 'chatPanelProvider.ts');
const extension = read('src', 'extension.ts');

// ─── 1. 웹뷰 게이트 — opt-in 한 수업에서만 렌더 ────────────────────────────
{
  assert.match(
    panel,
    /const uploadLogsEnabled =\s*config\?\.profile\?\.analytics\?\.upload_session_logs === true;/,
    '버튼 조건은 프로필의 opt-in 한 값이고, truthy 가 아니라 === true 다',
  );

  // 렌더가 실제로 그 조건 뒤에 있는가. 상수로 켜 두고 조건만 선언해 두는
  // 배선이면 위 검사는 통과하면서 OFF 코호트에 버튼이 뜬다.
  assert.match(
    panel,
    /\{uploadLogsEnabled && \(\s*<button\s+className="hps-upload-btn"/,
    '버튼 렌더가 그 조건에 걸려 있다',
  );

  // 버튼은 헤더 액션 줄 안에 있다 — 스크롤해야 보이는 자리는 "상시 진입점"이
  // 아니다. 헤더는 메시지 목록 위에 항상 떠 있는 유일한 줄이다.
  const actionsAt = panel.indexOf('<div className="hps-actions">');
  const headerEndAt = panel.indexOf('</header>');
  const buttonAt = panel.indexOf('className="hps-upload-btn"');
  assert.ok(actionsAt > 0 && headerEndAt > actionsAt, '헤더 액션 줄을 찾지 못했다');
  assert.ok(
    buttonAt > actionsAt && buttonAt < headerEndAt,
    '버튼이 헤더 액션 줄 안에 있다 (항상 보이는 자리)',
  );
}

// ─── 2. 웹뷰는 판단하지 않고 메시지 한 줄만 보낸다 ─────────────────────────
{
  assert.match(
    protocol,
    /\|\s*\{ type: "uploadSessionLogs" \}/,
    '웹뷰→호스트 메시지가 프로토콜에 있다',
  );
  assert.match(
    app,
    /onUploadLogs=\{\(\) => postToHost\(\{ type: "uploadSessionLogs" \}\)\}/,
    '클릭은 메시지 한 줄이다 — 웹뷰에 업로드 로직이 없다',
  );
  // 업로드 자체를 웹뷰가 하려 들면 토큰이 웹뷰로 내려와야 한다. 그런 일이
  // 시작되는 신호를 여기서 막는다.
  assert.doesNotMatch(app, /\/v1\/logs/, '웹뷰가 업로드 엔드포인트를 직접 부르지 않는다');
  assert.doesNotMatch(panel, /\/v1\/logs/, '웹뷰가 업로드 엔드포인트를 직접 부르지 않는다');
}

// ─── 3. 호스트는 기존 커맨드를 부른다 (락·게이트를 한 군데로) ──────────────
{
  const caseAt = provider.indexOf('case "uploadSessionLogs":');
  assert.ok(caseAt > 0, '호스트 스위치에 케이스가 있다');
  const body = provider.slice(caseAt, caseAt + 220);
  assert.match(
    body,
    /executeCommand\("hypeproof-chat\.uploadSessionLogs"\)/,
    '팔레트와 같은 커맨드를 부른다 — 재진입 락을 공유한다',
  );
}

// ─── 4. 커맨드의 fail-closed 게이트가 그대로다 ─────────────────────────────
// 진입점이 하나 늘었을 뿐 정책은 그대로여야 한다. 이 셋 중 하나라도 사라지면
// 새 버튼이 정책 변경이 된다.
{
  const cmdAt = extension.indexOf('registerCommand("hypeproof-chat.uploadSessionLogs"');
  assert.ok(cmdAt > 0, '커맨드 등록을 찾지 못했다');
  const cmd = extension.slice(cmdAt, cmdAt + 4000);

  assert.match(cmd, /if \(uploadInFlight\)/, '재진입 락이 있다');
  assert.match(
    cmd,
    /profile\.analytics\?\.upload_session_logs !== true/,
    'opt-in 이 아닌 좌석은 커맨드가 거절한다 (버튼을 우회한 메시지도 여기서 막힌다)',
  );
  // 프로필 확인 실패와 "기능 꺼짐"을 합치면 꺼져 있다는 오보가 된다(#381).
  assert.match(cmd, /profileFailure\(\)/, '확인 실패는 opt-in 꺼짐과 다른 문구다');

  // 락은 게이트 **직후** 잡혀야 한다 — await 사이에 두 번째 호출이 끼면
  // 락이 장식이 된다(2회차 리뷰 N4). 버튼은 아이가 연타하는 표면이라
  // 팔레트보다 이 순서가 실제로 걸린다.
  assert.ok(
    cmd.indexOf('uploadInFlight = true') < cmd.indexOf('await this.context') ||
      cmd.indexOf('uploadInFlight = true') < cmd.indexOf('secrets.get(TOKEN_KEY)'),
    '락은 첫 await 앞에서 잡힌다',
  );
}

console.log('session-upload-entrypoint smoke OK');
