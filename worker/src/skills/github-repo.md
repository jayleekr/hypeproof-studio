# 스킬: GitHub 저장소에 내 것으로 올리기

참가자의 작업을 **참가자 계정의 저장소**로 올린다. 큐시트 최종 결과물 3번.

참가자는 git을 모른다. **GitHub 아이디만 있으면 된다** — 나머지는 당신이 하고,
참가자가 눌러야 하는 것만 짚어준다. 저장소는 참가자 것이고, 당신은 대신 갖지
않는다.

## git 을 쓰지 마라

macOS의 `/usr/bin/git`은 껍데기다(CLT stub). 부르는 순간 참가자 화면에 **"명령어
라인 개발자 도구 설치" 창이 뜨고 2GB를 받는다.** 수업 중에 절대 하지 마라.

대신 `gh` 하나로 GitHub API를 통해 전부 처리한다. 저장소 생성·파일 업로드·설정
모두 git 없이 된다.

## 1. gh 준비

이미 있으면 건너뛴다:

```
command -v gh || ls ~/Library/Application\ Support/HypeProof-Studio/bin/gh
```

없으면 받는다. **파일 이름을 직접 조립하지 마라** — 버전이 올라가면 404가 난다.
릴리스 API가 주는 `browser_download_url`을 그대로 쓴다:

```
curl -sL https://api.github.com/repos/cli/cli/releases/latest \
  | grep -o '"browser_download_url": *"[^"]*macOS_arm64\.zip"' \
  | head -1 | cut -d'"' -f4
```

나온 주소로 `curl -L -o /tmp/gh.zip <주소>` → `unzip` → `gh_*/bin/gh`를
`~/Library/Application Support/HypeProof-Studio/bin/` 으로 옮긴다.
`curl`·`unzip`·`tar`는 모든 맥에 있으니 따로 설치할 것이 없고 sudo도 필요 없다.

인터넷에서 실행 파일을 받는 일이다. **뭘 왜 받는지 한 줄로 설명하고 승인을
받아라.** 조용히 지나가면 안 된다.

## 2. 로그인 — 참가자는 여덟 글자만 친다

```
gh auth login --hostname github.com --git-protocol https --web
```

코드가 나온다(예: `A1B2-C3D4`). 브라우저는 당신이 열어주고, 참가자에게:

> 브라우저에 이 여덟 글자를 넣어주세요: **A1B2-C3D4**

참가자는 이미 GitHub에 로그인돼 있으니 코드만 넣으면 끝난다. 비밀번호도 토큰도
만들 필요 없다. 확인:

```
gh api user --jq .login
```

## 3. 저장소 만들기

이름을 **제안하고 동의를 받는다**. 이름은 나중에 주소에 그대로 들어간다고
알려줘라(예: `boa-dental` → `.../boa-dental/`).

```
gh repo create <이름> --public
```

이름이 이미 있으면 다른 이름을 제안한다. 참가자 동의 없이 임의로 바꾸지 마라 —
참가자의 저장소다.

## 4. 파일 올리기

Contents API로 올린다. 각 파일마다:

```
gh api -X PUT repos/{owner}/<이름>/contents/<파일명> \
  -f message="홈페이지 올리기" \
  -f content="$(base64 -i <파일경로>)"
```

`index.html` 먼저, 그다음 이미지들. base64라서 이미지 같은 바이너리도 그대로
올라간다.

올린 뒤 **실제로 올라갔는지 확인하고 말해라**:

```
gh api repos/{owner}/<이름>/contents --jq '.[].name'
```

## 5. 참가자에게 남기기

- 저장소 주소를 브라우저로 열어 보여준다
- **참가자 계정의, 참가자 것**이라고 분명히 말한다
- 나중에 고치려면 같은 저장소에 파일을 다시 올리면 된다고 알려준다
- 배포까지 하려면 `publish-homepage` 스킬로 이어간다

## 막혔을 때

**막힌 것을 막혔다고 말해라.** 우회해서 성공한 척하는 것이 가장 나쁘다.

| 증상 | 대응 |
|---|---|
| 로그인 코드 입력이 안 끝남 | 브라우저에서 GitHub 로그인 여부부터 확인. 다시 시도 |
| 저장소 이름 중복 | 다른 이름을 **제안**하고 동의를 받아라 |
| 다운로드가 느림/실패 | 행사장 와이파이일 수 있다. 아래 수동 폴백으로 |
| 어느 것도 안 됨 | 정직하게 말해라. 파일은 워크스페이스에 안전하게 있다 |

**수동 폴백** — `gh`가 안 되면 참가자가 직접 한다. 브라우저와 폴더는 당신이
열어주고 한 번에 한 단계씩 같이 간다:
① github.com → New repository (Public)
② "uploading an existing file" 로 파일 끌어다 놓기 + Commit
③ 올라간 것을 같이 확인

## 이 스킬이 가르치는 것

**Ownership.** 결과물이 참가자 계정에 참가자 이름으로 남는다. 오늘 수업이
끝나도 참가자 것이고, 다른 도구로 이어서 할 수 있다.
