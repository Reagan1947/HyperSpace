import type { ContentNode, WorkspaceState } from "./types";

function nodeSignature(node: ContentNode) {
  return [
    node.id,
    node.parentId ?? "",
    node.kind,
    node.title,
    node.localPath ?? "",
    node.fileType ?? "",
    node.fileIdentity ?? "",
    node.size ?? "",
    node.markerColor ?? "",
    (node.tagIds ?? []).join(","),
  ].join("\0");
}

function sameNodes(left: ContentNode[], right: ContentNode[]) {
  if (left.length !== right.length) return false;
  return left.every((node, index) => nodeSignature(node) === nodeSignature(right[index]));
}

function sameMarkdown(left: Record<string, string>, right: Record<string, string>) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] ?? "") !== (right[key] ?? "")) return false;
  }
  return true;
}

export function markdownEquals(left: string, right: string) {
  const normalize = (value: string) => value.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return left === right || normalize(left) === normalize(right);
}

export function dirtyMarkdownNodeIds(
  noteMarkdown: Record<string, string>,
  syncedMarkdown: Record<string, string>,
) {
  const ids = new Set([...Object.keys(noteMarkdown), ...Object.keys(syncedMarkdown)]);
  return [...ids].filter((id) => !markdownEquals(noteMarkdown[id] ?? "", syncedMarkdown[id] ?? ""));
}

export function mergeScannedWorkspace(
  current: WorkspaceState,
  scanned: WorkspaceState,
  dirtyNodeIds: Iterable<string> = [],
): WorkspaceState {
  const scannedIds = new Set(scanned.nodes.map((node) => node.id));
  const selectedNodeId = scannedIds.has(current.selectedNodeId)
    ? current.selectedNodeId
    : scanned.selectedNodeId || scanned.nodes[0]?.id || "";

  const dirty = new Set(dirtyNodeIds);
  const noteMarkdown = { ...scanned.noteMarkdown };
  for (const id of dirty) {
    if (!scannedIds.has(id)) continue;
    const currentMarkdown = current.noteMarkdown[id];
    const scannedMarkdown = scanned.noteMarkdown[id] ?? "";
    if (typeof currentMarkdown === "string" && !markdownEquals(currentMarkdown, scannedMarkdown)) {
      noteMarkdown[id] = currentMarkdown;
    }
  }

  const next: WorkspaceState = {
    ...current,
    nodes: scanned.nodes,
    noteMarkdown,
    selectedNodeId,
  };

  if (
    next.selectedNodeId === current.selectedNodeId
    && sameNodes(current.nodes, next.nodes)
    && sameMarkdown(current.noteMarkdown, next.noteMarkdown)
  ) {
    return current;
  }
  return next;
}

export const WORKSPACE_TREE_CHANGED_EVENT = "workspace-tree-changed";

export function opensInWorkspace(node: ContentNode | undefined | null): node is ContentNode {
  return Boolean(node && node.kind !== "folder");
}

export function pruneOpenTabs(openTabIds: string[], nodes: ContentNode[]) {
  const ids = new Set(nodes.filter(opensInWorkspace).map((node) => node.id));
  return openTabIds.filter((id) => ids.has(id));
}

export function resolveMoveDestination(nodes: ContentNode[], parentId: string | null) {
  if (!parentId) return { parentId: null, parentPath: "" };
  const parent = nodes.find((node) => node.id === parentId);
  if (!parent) return { parentId: null, parentPath: "" };
  if (parent.kind === "folder") {
    return { parentId: parent.id, parentPath: parent.localPath ?? "" };
  }
  const folder = parent.parentId ? nodes.find((node) => node.id === parent.parentId) : undefined;
  if (folder?.kind === "folder") {
    return { parentId: folder.id, parentPath: folder.localPath ?? "" };
  }
  return {
    parentId: parent.parentId,
    parentPath: parent.localPath?.includes("/")
      ? parent.localPath.slice(0, parent.localPath.lastIndexOf("/"))
      : "",
  };
}
