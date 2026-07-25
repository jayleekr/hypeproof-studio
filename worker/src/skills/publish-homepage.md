# 스킬: 홈페이지를 인터넷에 올리기

참가자의 홈페이지를 **실제로 열리는 주소**로 만든다. 큐시트 최종 결과물 2번.

## 절대 규칙 — 주소를 지어내지 마라

**열리는 것을 확인하기 전에는 주소를 말하지 마라.** 배포했다고 쓰고 URL을
덧붙이는 것이 최악의 실패다. 참가자는 그 주소를 받아적고 집에 가서 404를 본다.

주소를 말하기 전에 반드시:

```
curl -sIL -o /dev/null -w "%{http_code}\n" <주소>
```

200이 아니면 아직 배포된 게 아니다. 그렇게 말해라. GitHub Pages는 첫 배포에
1~2분 걸리니 **"지금 만들어지는 중, 1분 뒤 다시 확인할게요"가 정직한 답이다.**

## 0. 정적인가 동적인가 — 여기서 갈린다

- **정적** — HTML/CSS/JS/이미지뿐. 브라우저만으로 돈다. 치과 홈페이지는 거의
  항상 여기다 → **1번 경로 (GitHub Pages)**
- **동적** — 서버가 필요하다. 폼 접수를 어딘가 저장, DB, 예약 API, 서버사이드
  렌더링 → **2번 경로 (빠른 터널)**

애매하면 정적으로 본다. 참가자에게 물어볼 것은 "무엇을 하고 싶은지"지
"정적이냐 동적이냐"가 아니다.

## 1. 정적 → GitHub Pages (집에 가져가는 주소)

저장소가 먼저 있어야 한다. 없으면 **`github-repo` 스킬을 먼저 수행한다** —
`gh` 준비·로그인·저장소 생성·파일 업로드가 거기 있다. 이미 올라가 있으면 바로
아래로 간다.

### Pages 켜기 — 반드시 Actions 방식으로

**브랜치 소스(legacy)를 쓰지 마라.** 새 저장소에서 빌드가 시작조차 못 하고
(`startup_failure`) 상태가 `building`에 영구 고착된다. 2026-07-25 실측: 두 번
시도해 두 번 다 실패했고, 재빌드 요청도 같은 결과였다. GitHub이 Actions 기반으로
이관 중이라 레거시 빌더가 신규 저장소에서 뜨지 않는다.

되는 방법은 이것이다. 먼저 빌드 방식을 바꾸고:

```
gh api -X PUT repos/{owner}/<이름>/pages -f build_type=workflow
```

그다음 워크플로 파일을 올린다(내용을 base64로 감싸 Contents API로):

```yaml
name: pages
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .
      - id: deployment
        uses: actions/deploy-pages@v4
```

```
gh api -X PUT repos/{owner}/<이름>/contents/.github/workflows/pages.yml \
  -f message="Pages 배포 설정" -f content="$(base64 -i <워크플로파일>)"
```

파일이 올라가면 push 이벤트로 워크플로가 돌고 1~2분 뒤 주소가 열린다.

주소는 `https://<아이디>.github.io/<이름>/` 이다. **여기서 바로 말하지 말고**
위의 `curl -sIL`로 200을 확인한 뒤에 말해라.

### 기다리는 동안 — 지킬 수 없는 약속을 하지 마라

**"완료되면 알려드릴게요"라고 하지 마라.** 당신은 턴이 끝나면 돌아올 수 없다.
참가자는 오지 않을 알림을 기다리며 앉아 있게 된다. 2026-07-25 실측에서 실제로
그렇게 끝났다.

대신 이렇게 한다:

1. 상한을 정해 기다린다 — `for i in $(seq 1 12); do ... sleep 10; done` 처럼
   **끝나는 루프**로. 끝나지 않는 `until`은 쓰지 마라
2. 그 안에 200이 되면 주소를 말한다
3. 안 되면 **솔직히 말하고 참가자에게 공을 넘긴다**:

   > 아직 빌드 중이에요. 1~2분 뒤에 "확인해줘"라고 말씀해주시면 바로 볼게요.
   > 주소는 https://… 가 될 예정인데, 열리는 걸 확인하기 전엔 확정이 아니에요.

빌드 상태는 이렇게 본다:

```
gh api repos/{owner}/<이름>/actions/runs --jq '.workflow_runs[0].conclusion'
```

`startup_failure` 가 보이면 위의 Actions 방식이 아니라 레거시로 켜진 것이다.

### 열리면

- 브라우저로 열어 보여준다
- 폰으로도 열어보게 한다 — **"직접 확인했을 때만 성공"**
- 이 주소는 **영구적**이고 노트북을 꺼도 살아 있다고 알려준다
- 고치려면 같은 저장소에 파일을 다시 올리면 된다고 알려준다

## 2. 동적이거나 1번이 막힐 때 → Cloudflare 빠른 터널

로그인이 필요 없다. 지금 도는 화면을 그대로 인터넷에 노출한다.

### cloudflared 준비

`gh`와 같은 방식이다. **파일명을 조립하지 말고** 릴리스 API를 쓴다:

```
curl -sL https://api.github.com/repos/cloudflare/cloudflared/releases/latest \
  | grep -o '"browser_download_url": *"[^"]*darwin-arm64\.tgz"' \
  | head -1 | cut -d'"' -f4
```

받아서 `tar -xzf`로 풀고 `~/Library/Application Support/HypeProof-Studio/bin/`에
둔다. 18MB 정도다. 받기 전에 뭘 왜 받는지 설명하고 승인을 받아라.

### 터널 열기

Studio의 미리보기 서버가 이미 `http://127.0.0.1:<포트>`로 돌고 있다. 그 포트에
붙인다:

```
cloudflared tunnel --url http://127.0.0.1:<포트>
```

출력에 `https://<무작위>.trycloudflare.com`이 나온다. 이것도 `curl -sIL`로 200을
확인하고 말해라.

### 반드시 알려줄 것

이 주소는 **임시다.** 터널을 닫거나 노트북을 덮으면 죽는다. 참가자가 "집에
가져가는 주소"로 오해하면 결과물이 사라진다. 정확히 이렇게 말해라:

> 지금 바로 폰으로 열어볼 수 있는 주소예요. 다만 노트북을 덮으면 꺼집니다.
> 계속 살아있는 주소가 필요하면 GitHub Pages로 올려드릴게요.

정적 사이트인데 이 경로로 왔다면(예: 로그인이 안 풀렸다) **수업이 끝나기 전에
1번 경로를 한 번 더 시도해서 영구 주소를 만들어 준다.**

## 막혔을 때

**막힌 것을 막혔다고 말해라.** 우회해서 성공한 척하는 것이 가장 나쁘다.

| 증상 | 대응 |
|---|---|
| Pages 가 `building` 에서 안 넘어감 | **레거시로 켜진 것이다.** `actions/runs` 에서 `startup_failure` 를 확인하고 위의 Actions 방식으로 다시 켠다. 재빌드 요청(`POST /pages/builds`)은 소용없다 — 실측으로 확인됨 |
| Pages 주소가 404 (빌드는 success) | 1~2분 더 기다린다. 워크플로가 success면 곧 열린다 |
| 저장소는 됐는데 Pages API 실패 | Settings▸Pages 를 브라우저로 열어 참가자와 같이 본다 |
| 다운로드가 느림/실패 | 행사장 와이파이일 수 있다. 터널(18MB)이 `gh`보다 가볍다 |
| 어느 것도 안 됨 | 정직하게 말해라. 파일은 워크스페이스에 안전하게 있고, 저장소까지 됐다면 나중에 Pages만 켜면 된다 |

## 이 스킬이 가르치는 것

**Verification reflex.** 배포했다는 말은 주소가 200을 돌려줄 때만 한다.
"됐어요"와 "확인했어요"는 다른 말이고, 참가자도 그 차이를 배워야 한다.
