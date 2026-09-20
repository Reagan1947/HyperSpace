import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { NewProjectWindow } from "./NewProjectDialog";
import { SettingsWindow } from "./SettingsWindow";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const windowType = params.get("window");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {windowType === "new-project" ? (
      <NewProjectWindow />
    ) : windowType === "settings" ? (
      <SettingsWindow />
    ) : (
      <App />
    )}
  </StrictMode>,
);
