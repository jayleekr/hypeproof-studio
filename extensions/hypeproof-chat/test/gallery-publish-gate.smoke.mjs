// #748 — 갤러리 발행은 프로필이 허가한 좌석에서만 일어난다.
//
// 고치기 전 상태: 이 판단을 하는 곳이 웹뷰의 버튼 하나뿐이었고, 그마저도
// `publishing.strategy` 만 봤다. `publishing.enabled` 는 워커가 실어 보내기만
// 하고 아무도 읽지 않는 값이었다. 그리고 버튼은 유일한 도달 수단이 아니다 —
// 발행은 웹뷰 메시지 `publishToGallery` 로 시작하므로 버튼을 거치지 않고도
// 호스트에 도달한다.
//
// 오늘 실제 노출은 없다(등록 프로필 다섯 개 전부 두 값이 일치한다). 그래서 이
// 파일이 잠그는 것은 "구멍을 막았다"가 아니라 **두 값이 갈라지는 날의 방향**이다.
//
// Run: node --experimental-strip-types test/gallery-publish-gate.smoke.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { galleryPublishAllowed, GALLERY_NOT_ALLOWED, resolveSiteBase } =
  await import('../src/galleryPublish.ts');

// ─── 허용되는 유일한 모양 ───────────────────────────────────────────────────
{
  assert.deepEqual(
    galleryPublishAllowed({ enabled: true, strategy: 'hypeproof_gallery' }),
    { ok: true },
    '켜져 있고 목적지가 갤러리인 좌석은 올릴 수 있다',
  );
}

// ─── 거절되는 모양들 — 없음은 허용이 아니다 ────────────────────────────────
{
  const refused = [
    [undefined, '프로필을 아직 못 받았다'],
    [null, '프로필이 없다'],
    [{}, '두 값 모두 없다'],
    [{ enabled: false, strategy: 'local_only' }, '오늘의 닫힌 코호트'],
    [{ enabled: false, strategy: 'hypeproof_gallery' }, '목적지는 갤러리인데 꺼져 있다'],
    [{ strategy: 'hypeproof_gallery' }, 'enabled 가 아예 없다'],
    [{ enabled: true, strategy: 'local_only' }, '켜져 있지만 목적지가 갤러리가 아니다'],
    [{ enabled: true, strategy: 'per_user_github_pages' }, '켜져 있지만 다른 발행 경로다'],
    [{ enabled: true }, 'strategy 가 아예 없다'],
    [{ enabled: 'true', strategy: 'hypeproof_gallery' }, '문자열 true 는 true 가 아니다'],
    [{ enabled: 1, strategy: 'hypeproof_gallery' }, 'truthy 는 true 가 아니다'],
  ];
  for (const [publishing, why] of refused) {
    const verdict = galleryPublishAllowed(publishing);
    assert.equal(verdict.ok, false, `거절해야 한다: ${why}`);
    assert.equal(verdict.message, GALLERY_NOT_ALLOWED, `문구는 하나다: ${why}`);
  }
}

// ─── 아이에게 나가는 문구 ──────────────────────────────────────────────────
{
  // 오류가 아니라 이 수업의 범위다. 실패처럼 읽히면 아이가 자기가 뭘 잘못했다고
  // 생각한다.
  assert.match(GALLERY_NOT_ALLOWED, /이 수업에서는/);
  assert.doesNotMatch(GALLERY_NOT_ALLOWED, /오류|실패|권한|에러/, '사고처럼 말하지 않는다');
  // 정책 필드 이름을 화면에 흘리지 않는다.
  assert.doesNotMatch(GALLERY_NOT_ALLOWED, /publishing|enabled|strategy|profile/i);
}

// ─── 호스트가 실제로 물어보는가 ────────────────────────────────────────────
// 순수 판정기가 맞아도 호출하지 않으면 아무 소용이 없다. chatPanelProvider.ts 는
// vscode 결합이라 단독 import 가 안 되므로 소스로 확인한다.
{
  const host = readFileSync(join(here, '..', 'src', 'chatPanelProvider.ts'), 'utf8');
  const body = host.slice(host.indexOf('private async publishToGallery('));
  assert.ok(body.length > 0, 'publishToGallery 를 찾지 못했다');

  const gateAt = body.indexOf('galleryPublishAllowed(');
  assert.ok(gateAt > 0, '호스트가 발행 전에 프로필 허가를 묻는다');

  // 허가 검사는 세상·토큰·폴더 검사보다 **먼저** 와야 한다. 뒤에 있으면 허용되지
  // 않은 좌석이 "먼저 친구를 눌러 세상을 열어주세요" 를 먼저 보게 되고, 그건
  // 하면 되는 일처럼 읽힌다.
  const worldAt = body.indexOf('this.lastPrebuiltWorld');
  const tokenAt = body.indexOf('secrets.get(TOKEN_KEY)');
  assert.ok(gateAt < worldAt, '허가 검사가 세상 검사보다 먼저다');
  assert.ok(gateAt < tokenAt, '허가 검사가 토큰 검사보다 먼저다');

  // 그리고 실제로 프로필에서 읽는다 — 상수 true 를 넘기면 통과하는 배선 금지.
  assert.match(
    body.slice(gateAt, gateAt + 120),
    /galleryPublishAllowed\(this\.cachedProfile\?\.publishing\)/,
    '판정 입력은 캐시된 프로필의 publishing 이다',
  );
}

// ─── 발행 목적지는 워크스페이스가 바꿀 수 없다 ─────────────────────────────
// 아이 작품이 실제로 올라가는 곳이다. 프로젝트 폴더의 .vscode/settings.json 이
// 이걸 바꿀 수 있으면, 좌석이 허가돼 있는 한 목적지는 아무 데나 될 수 있다.
// proxyUrl 은 이미 machine 인데 siteBase 만 window 로 남아 있었다.
{
  const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  const props = manifest.contributes.configuration.properties;
  assert.equal(props['hypeproofChat.siteBase'].scope, 'machine');
  assert.equal(props['hypeproofChat.proxyUrl'].scope, 'machine', '대조군 — 채팅 목적지는 이미 machine 이다');

  // 기본값은 프로덕션 사이트 그대로. 범위를 좁히면서 목적지를 바꾸지 않았다.
  assert.equal(props['hypeproofChat.siteBase'].default, 'https://hypeproof-ai.xyz');
  assert.equal(resolveSiteBase(undefined), 'https://hypeproof-ai.xyz', '설정이 없으면 프로덕션');
  assert.equal(resolveSiteBase('   '), 'https://hypeproof-ai.xyz', '빈 값도 프로덕션');
  assert.equal(resolveSiteBase('http://localhost:3000'), 'http://localhost:3000', '로컬 dev 는 그대로 쓴다');
}

// ─── 웹뷰가 같은 두 값을 같은 방향으로 보는가 (드리프트 락) ───────────────
// 웹뷰는 별도 vite 앱이라 확장 호스트 모듈을 import 하지 않는다(REQ-M33 과 같은
// 이유). 손으로 미러링한 조건이 갈라지면 버튼은 보이는데 호스트가 거절하거나,
// 더 나쁘게는 버튼이 안 보이는 좌석이 메시지로는 올릴 수 있게 된다.
{
  const panel = readFileSync(join(here, '..', 'webview-ui', 'src', 'ChatPanel.tsx'), 'utf8');
  assert.match(
    panel,
    /publishing\?\.enabled === true && publishing\?\.strategy === "hypeproof_gallery"/,
    '웹뷰 버튼 조건이 호스트 판정기와 같은 두 값을 본다',
  );
  // 고치기 전의 조건이 남아 있으면 안 된다 — strategy 만 보는 판단.
  assert.doesNotMatch(
    panel,
    /const galleryEnabled = config\?\.profile\?\.publishing\?\.strategy === "hypeproof_gallery";/,
    'strategy 만 보던 옛 조건이 남아 있다',
  );
}

console.log('gallery-publish-gate smoke OK');
