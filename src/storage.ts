import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceState } from "./types";

export interface GitChange {
  status: string;
  path: string;
}

export interface GitCommit {
  id: string;
  shortId: string;
  author: string;
  authoredAt: string;
  subject: string;
}

export interface GitRepositoryInfo {
  gitAvailable: boolean;
  isRepository: boolean;
  lfsAvailable: boolean;
  branch: string;
  changes: GitChange[];
  history: GitCommit[];
  error?: string | null;
}

export interface WorkspaceSearchResult {
  nodeId: string;
  title: string;
  kind: "page" | "folder" | "file";
  fileType?: string;
  path: string;
  snippet: string;
  score: number;
}

export interface ImportedFile {
  id: string;
  title: string;
  relativePath: string;
  size: number;
  contentHash: string;
  lfsTracked: boolean;
}

const STORAGE_KEY = "hyperspace.workspace.v1";
const LEGACY_WORKSPACE_FOLDER_ID = "folder-work";

function isTauri() {
  return "__TAURI_INTERNALS__" in window;
}

function migrateWorkspace(workspace: WorkspaceState): WorkspaceState {
  const legacyWorkspaceFolder = workspace.nodes.find((node) =>
    node.id === LEGACY_WORKSPACE_FOLDER_ID && node.parentId === null && node.kind === "folder"
  );

  if (!legacyWorkspaceFolder) return workspace;

  const nodes = workspace.nodes
    .filter((node) => node.id !== LEGACY_WORKSPACE_FOLDER_ID)
    .map((node) => node.parentId === LEGACY_WORKSPACE_FOLDER_ID ? { ...node, parentId: null } : node);
  const firstPromotedNode = nodes.find((node) => node.parentId === null);

  return {
    ...workspace,
    nodes,
    selectedNodeId: workspace.selectedNodeId === LEGACY_WORKSPACE_FOLDER_ID
      ? firstPromotedNode?.id ?? ""
      : workspace.selectedNodeId,
  };
}

export async function loadWorkspace(): Promise<WorkspaceState | null> {
  try {
    if (isTauri()) {
      const raw = await invoke<string | null>("load_workspace");
      return raw ? migrateWorkspace(JSON.parse(raw) as WorkspaceState) : null;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? migrateWorkspace(JSON.parse(raw) as WorkspaceState) : null;
  } catch (error) {
    console.warn("Failed to load workspace", error);
    return null;
  }
}

export async function saveWorkspace(workspace: WorkspaceState): Promise<void> {
  const serialized = JSON.stringify(workspace);
  if (isTauri()) {
    await invoke("save_workspace", { payload: serialized });
    return;
  }
  localStorage.setItem(STORAGE_KEY, serialized);
}

export async function getDefaultProjectsDirectory(): Promise<string> {
  if (!isTauri()) {
    return "";
  }
  return invoke<string>("default_projects_directory");
}

export async function getCurrentProject(): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }
  return invoke<string | null>("get_current_project");
}

export async function openProject(path: string): Promise<WorkspaceState | null> {
  if (!isTauri()) return null;
  const raw = await invoke<string | null>("open_project", { path });
  return raw ? migrateWorkspace(JSON.parse(raw) as WorkspaceState) : null;
}

export function projectNameFromPath(path: string | null | undefined): string {
  return path?.split(/[/\\]/).filter(Boolean).at(-1)?.trim() || "HyperSpace";
}

export async function createProject(options: {
  path: string;
  enableGit: boolean;
  workspace: WorkspaceState;
}): Promise<string> {
  if (!isTauri()) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options.workspace));
    return options.path;
  }

  return invoke<string>("create_project", {
    path: options.path,
    enableGit: options.enableGit,
    workspacePayload: JSON.stringify(options.workspace),
  });
}

export async function getGitRepositoryInfo(): Promise<GitRepositoryInfo> {
  if (!isTauri()) {
    return {
      gitAvailable: false,
      isRepository: false,
      lfsAvailable: false,
      branch: "",
      changes: [],
      history: [],
    };
  }
  return invoke<GitRepositoryInfo>("git_repository_info");
}

export async function commitAll(message: string): Promise<GitRepositoryInfo> {
  if (!isTauri()) throw new Error("Git 提交仅在桌面应用中可用");
  return invoke<GitRepositoryInfo>("git_commit_all", { message });
}

export async function searchWorkspace(query: string, limit = 20): Promise<WorkspaceSearchResult[]> {
  if (!isTauri()) return [];
  return invoke<WorkspaceSearchResult[]>("search_workspace", { query, limit });
}

export async function importPdf(sourcePath: string): Promise<ImportedFile> {
  if (!isTauri()) throw new Error("PDF 导入仅在桌面应用中可用");
  return invoke<ImportedFile>("import_pdf", { sourcePath });
}
