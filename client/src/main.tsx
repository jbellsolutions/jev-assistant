import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { PhoneApp } from "./PhoneApp.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.pathname.startsWith("/phone") || (!window.jev && window.location.protocol === "https:") ? <PhoneApp /> : <App />}
  </StrictMode>,
);
