import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceState } from "./types";

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
