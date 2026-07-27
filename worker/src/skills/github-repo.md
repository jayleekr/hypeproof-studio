# 스킬: 홈페이지를 GitHub 에 올리기

**참가자는 10분 전에 GitHub 에 가입했다.** 아이디와 비밀번호만 안다. 터미널이
없고 git 도 gh 도 모른다. 브라우저는 가입 직후라 GitHub 에 로그인돼 있다.
`gh` 는 이미 깔려 있다.

**참가자가 할 일은 딱 하나 — 여덟 글자 입력이다.** 나머지는 전부 당신이 한다.
설명하지 말고 하고 나서 알려줘라.

## 1. 로그인됐는지 본다

```
gh api user --jq .login
```

아이디가 나오면 **2번을 건너뛰고 3번으로 간다.** 실패하면 2번.

**"GitHub 계정 있으세요?" 를 묻지 마라.** 방금 가입한 사람은 자기가 "계정이
있는" 상태인지도 모르고, 아이디·로그인·가입이 뭐가 다른지도 모른다. 답할 수 없는
질문이다. 확인은 위 명령이 해준다.

## 2. 로그인시킨다 — 여기만 까다롭다

`gh auth login --web` 은 **참가자가 승인할 때까지 반환하지 않고, 여덟 글자가 그
명령의 출력(stderr)에 갇힌다.** 그냥 실행하면 당신은 멈춰 있고 참가자는 뭘 눌러야
하는지도 모른다. 백그라운드로 보내고 **출력을 파일로 받아라** — `&` 만 붙이면
코드가 사라진다. (Windows 는 아래 "Windows" 절의 PowerShell 판을 쓴다.)

```
nohup gh auth login --web --hostname github.com \
      --git-protocol https --scopes repo,workflow \
      < /dev/null > /tmp/hps-ghlogin.log 2>&1 &
sleep 3
grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}' /tmp/hps-ghlogin.log | head -1
```

여덟 글자를 **크게 보여주고** `https://github.com/login/device` 를 열어준다.

> 브라우저에 이 여덟 글자만 넣어주세요: **4C2A-9BE1**
> 그다음 초록색 Authorize 버튼이요.

비밀번호도 토큰도 새로 만들 필요 없다. 참가자가 눌렀으면 확인한다:

```
gh api user --jq .login
```

여기서 나온 아이디가 **아래에서 계속 쓰는 `<아이디>`** 다.

## 3. 저장소를 만든다

이름은 **그대로 주소가 된다.** 제안하고 동의를 받아라.

```
gh repo create <이름> --public
```

> `boa-dental` 로 만들까요? 주소가 `<아이디>.github.io/boa-dental/` 이 됩니다.

갓 만든 계정은 **이메일 인증 전에 막힐 수 있다.** 그런 에러가 나오면 메일함에서
GitHub 확인 메일을 눌러달라고 하고 다시 시도한다.

## 4. 파일을 올린다

`index.html` 먼저, 그다음 나머지. base64 라 이미지도 그대로 올라간다.

```
gh api -X PUT repos/<아이디>/<이름>/contents/index.html \
  -f message="홈페이지 올리기" \
  -f content="$(base64 -i <작업폴더>/index.html)"
```

`-f message` 가 커밋 메시지다. **git 은 필요 없다** — 커밋은 GitHub 쪽에서 생긴다.

같은 파일을 **다시** 올릴 때는 `sha` 가 있어야 한다(없으면 409):

```
gh api repos/<아이디>/<이름>/contents/index.html --jq .sha
# 그 값을 -f sha="<값>" 로 같이 넘긴다
```

## 5. 올라갔는지 확인한다

```
gh api repos/<아이디>/<이름>/contents --jq '.[].name'
```

**확인하고 나서 말해라.** 올렸다고 말하기 전에 이걸 본다.

## 6. 보여준다

저장소 주소를 브라우저로 열어주고, **참가자 계정의 참가자 것**이라고 분명히
말한다. 인터넷 주소까지 만들려면 `publish-homepage` 로 이어간다.

---

## 하지 말 것

- **git 을 부르지 마라.** macOS 의 `/usr/bin/git` 은 껍데기라 부르는 순간 2GB
  설치창이 뜬다. GitHub 이 새 저장소 화면에 보여주는 `git remote add …` 도 같다.
  위 4번이면 git 없이 다 된다.
- **브라우저를 클릭해서 저장소를 만들지 마라.** 느리고 실패해도 흔적이 안 남는다.
  브라우저는 로그인 코드 화면 · 결과 보여주기 · 아래 폴백에만 쓴다.
- **명령을 참가자에게 붙여넣으라고 시키지 마라.** 참가자에게는 터미널이 없다.

## Windows — 기본 셸이 PowerShell 이다

`uname -s` 가 실패하면 Windows 고, **거기 셸은 bash 가 아니라 PowerShell 이다.**
위 명령을 그대로 쓰면 안 되는 것들이 있다. `gh api` 자체는 똑같다.

| | macOS (bash) | Windows (PowerShell) |
|---|---|---|
| gh 있나 | `command -v gh` | `Get-Command gh` — **`where gh` 는 안 된다** (`Where-Object` 별칭이다) |
| 기다리기 | `sleep 3` | `Start-Sleep 3` |
| 찾기 | `grep -oE` | `Select-String -Pattern` |
| 임시 폴더 | `/tmp` | `$env:TEMP` |
| 폴더 열기 | `open <폴더>` | `explorer <폴더>` |
| `$(...)` 로 값 끼워넣기 | 된다 | **변수에 먼저 담아라** (아래) |

**2번 로그인 (PowerShell).** `gh` 는 코드를 **stderr 로 내보낸다** — stdout 을
받으면 빈 파일이 나온다:

```powershell
Start-Process gh -NoNewWindow -ArgumentList `
  'auth','login','--web','--hostname','github.com','--git-protocol','https','--scopes','repo,workflow' `
  -RedirectStandardError "$env:TEMP\hps-ghlogin.log"
Start-Sleep 3
(Select-String -Path "$env:TEMP\hps-ghlogin.log" -Pattern '[A-Z0-9]{4}-[A-Z0-9]{4}').Matches[0].Value
```

**4번 업로드 (PowerShell).** `base64` 명령이 없다. `certutil -encode` 는 머리말이
붙어 그대로 넘기면 깨진다. 변수에 담아서 넘겨라:

```powershell
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("<작업폴더>\index.html"))
gh api -X PUT repos/<아이디>/<이름>/contents/index.html -f message="홈페이지 올리기" -f content="$b64"
```

**Windows 는 실기기 미검증이다(#451).** 한 번에 안 되면 붙잡지 말고 아래로 가라.
참가자를 명령줄 디버깅에 끌고 들어가는 것이 수업에서 가장 비싼 실패다.

## 막히면 — 브라우저로 직접

**이 경로는 gh 도 로그인도 필요 없다.** 참가자 브라우저는 이미 GitHub 에 로그인돼
있다. 부끄러운 우회가 아니라 정식 경로다. 한 번에 한 단계씩 같이 간다:

① `github.com/new` → 이름 → **Public** → Create repository
② 빈 저장소 화면의 **"uploading an existing file"**
③ 작업 폴더를 열어주고(`open` / `explorer`) 파일을 끌어다 놓기
④ **Commit changes** → 새로고침해서 같이 확인

막힌 것은 막혔다고 말해라. 우회해서 성공한 척하는 것이 가장 나쁘다. 파일은
워크스페이스에 안전하게 있다.

**Ownership.** 결과물이 참가자 계정에 참가자 이름으로 남는다.
