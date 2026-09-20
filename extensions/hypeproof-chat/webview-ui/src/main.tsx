// 토큰이 가장 먼저 와야 한다(SX-49). 이 아래의 import 들이 CSS 를 끌고 들어오는
// 순서가 곧 스타일시트 순서다: tokens.css → localReview.css(LocalReview) →
// start.css(StartPage) → styles.css(마지막, 명시 import).
import "./tokens.css";
import { LocalReview } from "./LocalReview";
import { createRoot } from "react-dom/client";
import { StartPage } from "./StartPage";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");
createRoot(container).render(document.documentElement.dataset.surface === "local-review" ? <LocalReview /> : document.documentElement.dataset.surface === "start" ? <StartPage /> : <App />);
