# Chalk MVP Intent

이 문서는 에픽 [#1280](https://github.com/jayleekr/hypeproof-studio/issues/1280)·[#1281](https://github.com/jayleekr/hypeproof-studio/issues/1281)·[#1282](https://github.com/jayleekr/hypeproof-studio/issues/1282)·[#1283](https://github.com/jayleekr/hypeproof-studio/issues/1283)·[#1284](https://github.com/jayleekr/hypeproof-studio/issues/1284)·[#1285](https://github.com/jayleekr/hypeproof-studio/issues/1285)의 "문제 (Intent)" 절을 한 곳에 모은 것이다.
기능 요구사항: [docs/requirements/chalk-mvp.md](../requirements/chalk-mvp.md).

---

## [#1280](https://github.com/jayleekr/hypeproof-studio/issues/1280) Chalk 제품 지식과 계획서 규격 — 생성기가 딛고 설 땅

생성기가 근거 등급이 붙은 수업 모형과 교육 기준을 읽으려면, 그 지식이 제품 안에 버전으로 있어야 하고 닫힌 어휘로 지켜져야 한다. 계획서도 사람과 기계가 같이 읽는 규격 하나가 있어야 검사·단계 목록·리허설 점검표가 한 원본에서 나온다. 지금은 둘 다 없다. 지식은 볼트에만 있고, 계획서는 형식 없는 산문이다.

## [#1281](https://github.com/jayleekr/hypeproof-studio/issues/1281) Chalk 생성기와 검사 고리 — 초안이 나오고, 고칠 때마다 검사가 돈다

강사가 다섯 가지(대상 · 전하고자 하는 에셋 · 수업 방식 · 요구사항 · 형식)를 넣으면, 근거를 보이는 수업 모형 추천과 계획서 초안이 나와야 한다. 초안이 바뀔 때마다 교육 기준 검사가 돌아 걸린 자리를 짚어야 한다. 지금 검사는 확정할 때 한 번만 돌고, 생성기는 없다. PRD 가 권한 순서대로 가장 먼저 착수하는 기능 에픽이다.

## [#1282](https://github.com/jayleekr/hypeproof-studio/issues/1282) Chalk 강의 계획안 — 그날 어떻게 굴리나

지도안만으로는 강사가 수업 날 들고 갈 문서가 없다. 바이오팜 원본은 운영 계획안·진행자 런북·참가자 안내문을 사람이 따로 만들었고, 당일에는 설계보다 10~20분 밀리고 블록이 둘 늘었다. 같은 원본에서 이 문서들을 만들어야 하고, 형식(1회성 워크숍 / 여러 회차 트랙)에 맞는 시간 규격을 골라야 한다.

## [#1283](https://github.com/jayleekr/hypeproof-studio/issues/1283) Chalk 강사 면과 강사 채팅 — Studio 안에서 대화로 Chalk 전부

강사는 Studio 안에서 강사 토큰으로 Chalk 면을 열고, 학생 채팅창과 같은 자리의 채팅으로 자기 구독이나 서버를 통해 Chalk 기능을 모두 써야 한다. 지금 앱에는 강사 면이 없다(닫힌 브랜치에만 있다). 구독 실행은 개발판에서만 켜지고, 그 대화는 서버에 기록이 남지 않는다.

## [#1284](https://github.com/jayleekr/hypeproof-studio/issues/1284) Chalk 강의 만들기 — 계획서에서 학생이 실제로 도는 강의로

계획서를 원본으로 단계 목록과 코치 지시문을 함께 만들어야, 코드 배포 없이 강의가 나가고 검사·리허설이 판정할 구조도 생긴다. 지금은 둘을 사람이 따로 만들고, 바이오팜 아동 수업은 코치 지시문을 코드에 넣어 배포했다. 9월 데모에서는 교사용 문장이 학생 힌트로 새어 나갔다.

## [#1285](https://github.com/jayleekr/hypeproof-studio/issues/1285) Chalk 리허설 — 강사 면에서 학생 조건으로 넣어 보고, 구독 리허설로 확정한다

강사가 학생 조건으로 예상 막힘마다 학생 말을 넣어 코치 응답을 판정하고, 그 기록으로 강의를 확정해야 한다. 강사 구독으로 돌린 리허설도 확정 근거가 된다. 열린 원격 수업 PR 스택(G2)에 학생 조건 리허설과 확정 서명이 들어 있지만, 웹 화면만 그것을 쓰고 확정에는 서버를 거친 요청 기록을 요구한다. 그래서 Studio 강사 면에서는 쓸 수 없고, 구독 리허설로는 확정할 수 없다. 앱을 닫으면 학생 자리에 갇힌다.
