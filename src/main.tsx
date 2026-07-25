import React from "react";
import ReactDOM from "react-dom/client";
import "@arco-design/web-react/dist/css/arco.css";
import { isTauri } from "@tauri-apps/api/core";
import App from "./App";
import ShortcutGuideWindow from "./components/ShortcutGuideWindow";
import SettingsWindow from "./components/SettingsWindow";
import { installGlobalDiagnostics } from "./diagnostics";
import { installSelectAllShortcuts } from "./select-all-shortcut";

installGlobalDiagnostics();
installSelectAllShortcuts();

if (isTauri()) {
  document.addEventListener("contextmenu", (event) => event.preventDefault());
}

const view = new URLSearchParams(window.location.search).get("view");
const RootView =
  view === "settings"
    ? SettingsWindow
    : view === "shortcuts"
      ? ShortcutGuideWindow
      : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootView />
  </React.StrictMode>,
);
