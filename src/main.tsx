import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "katex/dist/katex.min.css";
import "./styles.css";
import "./themes.css";
import "./shanlan-preview.css";
import "./shelf-preview.css";
import "./shelf-layout.css";
// Local visual study only: no saved theme, vault or desktop preference changes.
if (new URLSearchParams(window.location.search).get("visual") === "shanlan") {
  document.documentElement.dataset.preview = "shanlan";
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
