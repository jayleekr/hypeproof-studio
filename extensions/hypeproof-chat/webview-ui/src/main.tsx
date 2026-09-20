// The tokens have to come first (SX-49). The order in which the imports below pull CSS in
// is exactly the stylesheet order: tokens.css → localReview.css (LocalReview) →
// start.css (StartPage) → styles.css (last, explicit import).
import "./tokens.css";
import { LocalReview } from "./LocalReview";
import { createRoot } from "react-dom/client";
import { StartPage } from "./StartPage";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");
createRoot(container).render(document.documentElement.dataset.surface === "local-review" ? <LocalReview /> : document.documentElement.dataset.surface === "start" ? <StartPage /> : <App />);
