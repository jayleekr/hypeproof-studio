// 강사 코드를 화면마다 다시 묻지 않는다 (#1145 A-3).
//
// 세션 콘솔·라이브 보드·토큰 발급 셋은 이미 sessionStorage 의 같은 열쇠
// "hps_issuer_token" 을 쓰고 있었다. 강사 관리·수업 AI 예산 둘만 자기 메모리에
// 들고 있어서, 화면을 옮길 때마다 같은 코드를 다시 붙여넣어야 했다.
// **새로 만드는 것이 아니라 갈라진 것을 모으는 일이다.**
//
// 경계:
//   • sessionStorage 다 — 탭을 닫으면 사라진다. localStorage 가 아니다.
//   • URL·파일·주소창에 넣지 않는다. 화면이 지키던 원칙을 그대로 둔다.
//   • 값을 어디로도 보내지 않는다. 이 파일에는 fetch 가 없다.
//   • 칸을 비우면 저장분도 지운다 — 「연결 해제」가 흔적을 남기지 않게.
//
// authoring.html 은 이 파일을 아직 쓰지 않는다 (이번 주 시연). 그래서 저작
// 화면에서는 여전히 한 번 더 붙여넣어야 한다 — 강사 홈에 그렇게 적혀 있다.
(function () {
  var KEY = "hps_issuer_token";
  function store(v) {
    try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch (_) {}
  }
  function bind() {
    var el = document.getElementById("token");
    if (!el) return;
    if (!el.value) {
      try { el.value = sessionStorage.getItem(KEY) || ""; } catch (_) {}
    }
    el.addEventListener("change", function () { store(el.value.trim()); });
    // 「연결 해제」가 칸을 비우는 경우를 잡는다. change 는 사람이 고칠 때만 뜬다.
    var last = el.value;
    setInterval(function () {
      if (el.value === last) return;
      last = el.value;
      store(el.value.trim());
    }, 500);
  }
  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", bind)
    : bind();
})();
