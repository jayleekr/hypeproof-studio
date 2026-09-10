# ADR 0008 — 활동 연결 준비와 확정 경계

2026-09-10 · #917 · 상태: 구현 중. US-07~10/18.

## 확인한 기존 구현

- `StartPage.connectCourse`는 profile 응답 확인 후 공용 SecretStorage의
  `hypeproofChat.workshopToken`을 교체한다. workspace 준비는 나중의 begin에서 실행한다.
- `openWorkspaceFolder`는 폴더 생성 실패를 false로 반환하며 호출자는 현재 창의
  채팅을 연다. 따라서 새 활동 코드가 이전 활동 폴더에서 실행될 수 있다.
- `ChatPanelProvider`는 진행 중 스트림을 추적하고 `connectionChanging`으로 새 전송을
  막는다. native/account 기록은 scope를 사용하고 일반 수업은 cohort 기준이다.
- SDK는 현재 resume 세션을 사용하지 않고 매 요청에 history transcript를 구성한다.
  UI에 기록을 숨기는 것만으로 payload 분리를 증명할 수 없다.
- SecretStorage는 앱 공용, history는 workspaceState, 일부 설정은 globalState에 있다.
  새 활동 UI만 추가하면 창 간 토큰 교체 및 같은 폴더의 문맥 혼합이 남는다.

## 결정

첫 단계는 새 코드를 **확인 중인 후보**로 유지하고, 작업 위치 준비와 실행 가능 상태가
확인된 뒤 확정한다. 취소·검증 실패·폴더 준비 실패는 기존 연결을 보존한다.
후보가 검증된 Service 주소도 함께 묶어 확인 도중 origin이 바뀌면 전송을 거부한다.
후보 credential은 host 메모리에만 두며 webview/URL/로그에 반환하지 않는다.
입력은 기존 SecretStorage를 사용하며 새 인증 또는 사용량 원장은 추가하지 않는다.

후속 창/활동 저장은 원래 SecretStorage와 workspaceState를 확장한다. origin 및 활동별
credential 참조와 창의 활성 연결을 분리한다. legacy 공용 credential의 origin은 알 수
없으므로 로컬 credential을 공개 서버용으로 자동 승격하지 않는다. 신규 목록은 저장된
연결 목록일 뿐 서버가 재검증하기 전 실행 권한으로 보지 않는다.

## 인수 경계

후보 취소/저장 오류/폴더 준비 실패, A 스트림 완료 전 B 시작 거부를 양·음성 대조한다.
창별 선택/동일 폴더 충돌/재시작/history payload 검사까지 완료해야 US-2 전체를 닫는다.
아래 첫 단계 구현만으로 전체 전환이나 공개 배포 완료를 주장하지 않는다.
