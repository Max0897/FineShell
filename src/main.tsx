import React from "react";
import ReactDOM from "react-dom/client";
import "@arco-design/web-react/dist/css/arco.css";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import ApplicationErrorBoundary from "./components/ApplicationErrorBoundary";
import ShortcutGuideWindow from "./components/ShortcutGuideWindow";
import SettingsWindow from "./components/SettingsWindow";
import { installGlobalDiagnostics } from "./diagnostics";
import { installSelectAllShortcuts } from "./select-all-shortcut";
import { windowViewFromContext } from "./window-view";

installGlobalDiagnostics();
installSelectAllShortcuts();

if (isTauri()) {
  document.addEventListener("contextmenu", (event) => event.preventDefault());
}

const view = windowViewFromContext({
  windowLabel: isTauri() ? getCurrentWindow().label : null,
});
const RootView =
  view === "settings"
    ? SettingsWindow
    : view === "shortcuts"
      ? ShortcutGuideWindow
      : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ApplicationErrorBoundary>
      <RootView />
    </ApplicationErrorBoundary>
  </React.StrictMode>,
);
