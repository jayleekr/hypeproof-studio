import { createRoot } from "react-dom/client";
import { StartPage } from "./StartPage";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");
createRoot(container).render(document.documentElement.dataset.surface === "start" ? <StartPage /> : <App />);
