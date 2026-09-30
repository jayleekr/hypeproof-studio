// Kiosk-practice fixture behaviour. See index.html for the planted modes.
(function () {
  var plant = new URLSearchParams(location.search).get("plant") || "";
  var $ = function (id) { return document.getElementById(id); };
  var qty = 1;
  var cart = 0;

  if (plant === "errors") {
    console.error("planted-console-error");
    setTimeout(function () { throw new Error("planted-throw"); }, 0);
    fetch("missing-404.json").catch(function () {});
  }
  if (plant === "disabled-step4") $("add").disabled = true;
  if (plant === "chatty") {
    document.addEventListener("click", function (e) {
      console.log("clicked", e.target && e.target.id);
      console.info("state ok");
    });
  }
  if (plant === "clone") {
    var clone = document.createElement("button");
    clone.type = "button";
    clone.id = "clone";
    clone.textContent = "주문 시작";
    document.body.appendChild(clone);
  }

  $("begin").addEventListener("click", function () {
    $("start").hidden = true;
    $("menu").hidden = false;
  });
  $("large").addEventListener("click", function () {
    document.body.style.fontSize = "28px";
  });
  $("drink").addEventListener("change", function (e) {
    var o = e.target.selectedOptions[0];
    $("chosen").textContent = "고른 음료: " + (o && o.value ? o.textContent : "없음");
  });
  $("plus").addEventListener("click", function () {
    qty += 1;
    $("qty").textContent = "수량: " + qty;
    if (plant === "console-step3") console.error("planted-step3-error: 수량 계산 실패");
  });
  $("add").addEventListener("click", function () {
    cart += qty;
    $("cart").textContent = "장바구니: " + cart + "개";
  });
  $("pay").addEventListener("click", function () {
    if (cart < 1) return;
    $("menu").hidden = true;
    $("done").hidden = false;
  });

  // An element no markup defines: its source is "unmapped" (CR-T09 negative).
  var tip = document.createElement("button");
  tip.type = "button";
  tip.id = "tip";
  tip.textContent = "도움말 보기";
  document.body.appendChild(tip);
})();
