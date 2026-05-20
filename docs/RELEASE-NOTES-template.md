# HypeProof Studio v0.1.0

> First public release — SK바이오팜 워크숍 1회차 가족 배포용.

## What it is

VS Code 기반의 AI 코딩 환경. 자녀와 함께 4시간 안에 자기 게임을 만들어볼 수 있도록 설계됨.

## Install (one-liner)

**Mac:**
```bash
curl -fsSL https://raw.githubusercontent.com/jayleekr/hypeproof-studio-releases/main/install-mac.sh | bash
```

**Windows (PowerShell 관리자):**
```powershell
iwr -useb https://raw.githubusercontent.com/jayleekr/hypeproof-studio/main/scripts/install-win.ps1 | iex
```

자세한 가이드: [docs/INSTALL.md](./docs/INSTALL.md)

## What's inside

- VSCodium 기반 (텔레메트리 제거된 VS Code)
- 사전 번들된 **HypeProof Chat** 패널 (Anthropic 모델 via HypeProof Proxy)
- 파일 쓰기 / 셸 실행은 항상 모달 확인 후 진행
- Workshop token으로 사용량 게이팅

## Known limitations

- Mac 빌드: 미서명. 처음 실행 시 시스템 설정에서 "확인 없이 열기" 필요.
- Windows 빌드: 미서명. SmartScreen 경고 → "추가 정보" → "실행".
- Workshop token은 운영진에게 받아야 함 (이번 회차 수동 발급).

## Attribution

Built on [VSCodium](https://github.com/VSCodium/vscodium) (MIT) which is built on [Visual Studio Code](https://github.com/microsoft/vscode) (MIT). License notices preserved in About dialog.

## Feedback

GitHub Issues: https://github.com/jayleekr/hypeproof-studio/issues
워크숍 단톡방 또는 jayleekr0125@gmail.com
