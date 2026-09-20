import { invoke } from "@tauri-apps/api/core";
import { initialWorkspace } from "./data";
import type { ContentNode, NoteBlock, WorkspaceState } from "./types";

type LegacyWorkspaceState = WorkspaceState & {
  editorDocuments?: Record<string, unknown[]>;
};

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

export interface CreatedWorkspaceEntry {
  id: string;
  title: string;
  kind: "file" | "folder";
  relativePath: string;
  fileType?: string | null;
  size?: string | null;
  fileIdentity?: string | null;
}

const STORAGE_KEY = "hyperspace.workspace.v1";
const LEGACY_WORKSPACE_FOLDER_ID = "folder-work";

function isTauri() {
  return "__TAURI_INTERNALS__" in window;
}

function legacyBlocksToMarkdown(blocks: NoteBlock[]) {
  return blocks.map((block) => {
    const content = block.content ?? "";
    switch (block.kind) {
      case "heading1": return `# ${content}`;
      case "heading": return `## ${content}`;
      case "heading3": return `### ${content}`;
      case "bullet": return `- ${content}`;
      case "ordered": return `1. ${content}`;
      case "quote":
      case "callout": return `> ${content}`;
      case "code": return `\`\`\`${block.language ?? "text"}\n${content}\n\`\`\``;
      case "folder":
      case "file": return `\`\`\`hyperspace\n${JSON.stringify({
        version: 1,
        kind: block.kind,
        targetNodeId: block.targetNodeId ?? "missing",
        blockId: block.id,
      })}\n\`\`\``;
      default: return content;
    }
  }).join("\n\n");
}

function fallbackMarkdownForNode(node: ContentNode) {
  const byId = initialWorkspace.noteMarkdown[node.id];
  if (byId?.trim()) return byId;
  const stem = node.localPath?.split(/[/\\]/).pop()?.replace(/\.(md|markdown)$/i, "");
  if (stem && initialWorkspace.noteMarkdown[stem]?.trim()) return initialWorkspace.noteMarkdown[stem];
  const match = initialWorkspace.nodes.find((item) => item.title === node.title || item.title === stem);
  if (match && initialWorkspace.noteMarkdown[match.id]?.trim()) return initialWorkspace.noteMarkdown[match.id];
  return "";
}

function migrateWorkspace(workspace: LegacyWorkspaceState): WorkspaceState {
  const noteMarkdown = { ...(workspace.noteMarkdown ?? {}) };
  for (const node of workspace.nodes) {
    const isMarkdown = node.kind === "page" || (node.kind === "file" && ["md", "markdown"].includes(node.fileType?.toLowerCase() ?? ""));
    if (!isMarkdown) continue;
    const existing = noteMarkdown[node.id];
    if (typeof existing === "string" && existing.trim()) continue;
    const migrated = legacyBlocksToMarkdown(workspace.blocks?.[node.id] ?? []);
    noteMarkdown[node.id] = migrated || fallbackMarkdownForNode(node) || existing || "";
  }
  const { blocks: _blocks, editorDocuments: _editorDocuments, ...current } = workspace;
  const legacyWorkspaceFolder = workspace.nodes.find((node) =>
    node.id === LEGACY_WORKSPACE_FOLDER_ID && node.parentId === null && node.kind === "folder"
  );

  if (!legacyWorkspaceFolder) return { ...current, noteMarkdown };

  const nodes = workspace.nodes
    .filter((node) => node.id !== LEGACY_WORKSPACE_FOLDER_ID)
    .map((node) => node.parentId === LEGACY_WORKSPACE_FOLDER_ID ? { ...node, parentId: null } : node);
  const firstPromotedNode = nodes.find((node) => node.parentId === null);

  return {
    ...current,
    noteMarkdown,
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
      return raw ? migrateWorkspace(JSON.parse(raw) as LegacyWorkspaceState) : null;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? migrateWorkspace(JSON.parse(raw) as LegacyWorkspaceState) : null;
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
  return raw ? migrateWorkspace(JSON.parse(raw) as LegacyWorkspaceState) : null;
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

export async function createWorkspaceEntry(
  parentPath: string,
  kind: "file" | "folder",
): Promise<CreatedWorkspaceEntry> {
  if (!isTauri()) throw new Error("新建文件仅在桌面应用中可用");
  return invoke<CreatedWorkspaceEntry>("create_workspace_entry", { parentPath, kind });
}

export async function renameWorkspaceEntry(localPath: string, newName: string): Promise<string> {
  if (!isTauri()) throw new Error("文件重命名仅在桌面应用中可用");
  return invoke<string>("rename_workspace_entry", { localPath, newName });
}

export async function deleteWorkspaceEntries(localPaths: string[]): Promise<void> {
  if (!isTauri()) throw new Error("文件删除仅在桌面应用中可用");
  await invoke("delete_workspace_entries", { localPaths });
}

export async function moveWorkspaceEntry(localPath: string, destinationParent: string): Promise<string> {
  if (!isTauri()) throw new Error("文件移动仅在桌面应用中可用");
  return invoke<string>("move_workspace_entry", { localPath, destinationParent });
}

export async function revealInFinder(localPath = ""): Promise<void> {
  if (!isTauri()) throw new Error("在 Finder 中打开仅在桌面应用中可用");
  await invoke("reveal_in_finder", { localPath });
}

export async function openInTerminal(localPath = ""): Promise<void> {
  if (!isTauri()) throw new Error("在终端打开仅在桌面应用中可用");
  await invoke("open_in_terminal", { localPath });
}
