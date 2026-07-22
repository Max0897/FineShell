import React from "react";
import ReactDOM from "react-dom/client";
import "@arco-design/web-react/dist/css/arco.css";
import App from "./App";
import HostManagerWindow from "./components/HostManagerWindow";

const view = new URLSearchParams(window.location.search).get("view");
const RootView = view === "host-manager" ? HostManagerWindow : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootView />
  </React.StrictMode>,
);
