import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { NewProjectWindow } from "./NewProjectDialog";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const isNewProjectWindow = params.get("window") === "new-project";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isNewProjectWindow ? <NewProjectWindow /> : <App />}
  </StrictMode>,
);
