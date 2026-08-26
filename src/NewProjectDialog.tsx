import { useEffect, useId, useState, type FormEvent } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { createBlankWorkspace, createGuidedWorkspace } from "./data";
import { createProject, getDefaultProjectsDirectory } from "./storage";
import type { WorkspaceState } from "./types";

export const PROJECT_CREATED_EVENT = "project-created";

export type ProjectCreatedPayload = {
  workspace: WorkspaceState;
  path: string;
};

function isTauri() {
  return "__TAURI_INTERNALS__" in window;
}

function joinPath(parent: string, name: string) {
  const trimmedParent = parent.replace(/[/\\]+$/, "");
  const trimmedName = name.trim();
  if (!trimmedParent) return trimmedName;
  if (!trimmedName) return trimmedParent;
  return `${trimmedParent}/${trimmedName}`;
}

async function closeWindow() {
  if (!isTauri()) return;
  try {
    await getCurrentWindow().close();
  } catch (error) {
    console.warn("Failed to close New Project window", error);
  }
}

export function NewProjectWindow() {
  const titleId = useId();
  const [projectName, setProjectName] = useState("Untitled");
  const [location, setLocation] = useState("");
  const [enableGit, setEnableGit] = useState(true);
  const [createGuideNote, setCreateGuideNote] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("new-project-window");
    document.body.classList.add("new-project-window");
    return () => {
      document.documentElement.classList.remove("new-project-window");
      document.body.classList.remove("new-project-window");
    };
  }, []);

  useEffect(() => {
    void getDefaultProjectsDirectory()
      .then((directory) => setLocation(directory || ""))
      .catch(() => setLocation(""));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        void closeWindow();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [submitting]);

  const projectPath = joinPath(location, projectName);
  const canSubmit = Boolean(location.trim() && projectName.trim()) && !submitting;

  const browseLocation = async () => {
    if (!isTauri()) {
      setError("请在桌面应用中选择项目位置");
      return;
    }

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: location || undefined,
        title: "选择项目位置",
      });
      if (typeof selected === "string" && selected) {
        setLocation(selected);
        setError(null);
      }
    } catch (browseError) {
      setError(browseError instanceof Error ? browseError.message : "无法打开文件夹选择器");
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    const name = projectName.trim();
    const workspace = createGuideNote
      ? createGuidedWorkspace(name)
      : createBlankWorkspace(name);

    try {
      const createdPath = await createProject({
        path: projectPath,
        enableGit,
        workspace,
      });
      const payload: ProjectCreatedPayload = {
        workspace,
        path: createdPath || projectPath,
      };
      if (isTauri()) {
        await emit(PROJECT_CREATED_EVENT, payload);
      }
      await closeWindow();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
      setSubmitting(false);
    }
  };

  return (
    <form
      className="new-project-window-shell"
      aria-labelledby={titleId}
      onSubmit={(event) => void handleSubmit(event)}
    >
      <header className="modal-header">
        <div>
          <h2 id={titleId}>新建项目</h2>
          <p>选择本地位置，并配置 Git 与起始指引笔记。</p>
        </div>
      </header>

      <div className="modal-body">
        <label className="modal-field">
          <span>项目名称</span>
          <input
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            placeholder="Untitled"
            autoFocus
            disabled={submitting}
          />
        </label>

        <label className="modal-field">
          <span>项目位置</span>
          <div className="modal-path-field">
            <input
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="选择或输入父文件夹路径"
              disabled={submitting}
            />
            <button
              type="button"
              className="modal-path-folder"
              onClick={() => void browseLocation()}
              disabled={submitting}
              aria-label="选择文件夹"
              title="选择文件夹"
            >
              <FolderOpen size={15} strokeWidth={1.8} />
            </button>
          </div>
          <small className="modal-path-preview">将创建于：{projectPath || "—"}</small>
        </label>

        <label className="modal-check">
          <input
            type="checkbox"
            checked={enableGit}
            onChange={(event) => setEnableGit(event.target.checked)}
            disabled={submitting}
          />
          <span>
            <strong>启用 Git 管理</strong>
            <small>在项目目录执行 git init，便于后续版本控制</small>
          </span>
        </label>

        <label className="modal-check">
          <input
            type="checkbox"
            checked={createGuideNote}
            onChange={(event) => setCreateGuideNote(event.target.checked)}
            disabled={submitting}
          />
          <span>
            <strong>生成新项目指引笔记</strong>
            <small>创建「新项目指引」页面，帮助快速上手</small>
          </span>
        </label>

        {error && <p className="modal-error" role="alert">{error}</p>}
      </div>

      <footer className="modal-footer">
        <button type="button" className="modal-secondary" onClick={() => void closeWindow()} disabled={submitting}>
          取消
        </button>
        <button type="submit" className="modal-primary" disabled={!canSubmit}>
          {submitting ? "创建中…" : "创建项目"}
        </button>
      </footer>
    </form>
  );
}
