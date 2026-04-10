import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../soundbound.jsx";

const container = document.getElementById("root");

if (!container) {
  throw new Error(
    "[main.jsx] Could not find #root element. " +
    "Make sure index.html contains <div id=\"root\"></div>."
  );
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
