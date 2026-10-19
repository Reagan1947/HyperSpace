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

/** Fields that a full workspace save rewrites. Typing and the open tab are not included. */
export function workspaceStructureSignature(workspace: WorkspaceState) {
  const nodes = workspace.nodes.map(nodeSignature).join("\n");
  const tags = (workspace.tags ?? []).map((tag) => `${tag.id}\0${tag.name}`).join("\n");
  return `${nodes}\n\n${tags}`;
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
  // A save round-trip trims trailing newlines. Keep the editor's exact string
  // so that echo does not look like a new document and re-parse the IR DOM.
  for (const id of Object.keys(noteMarkdown)) {
    const currentMarkdown = current.noteMarkdown[id];
    if (typeof currentMarkdown === "string" && markdownEquals(currentMarkdown, noteMarkdown[id] ?? "")) {
      noteMarkdown[id] = currentMarkdown;
    }
  }
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

function treeOrderKey(node: ContentNode) {
  return `${node.kind === "file" ? "1" : "0"}\0${(node.title || "").toLowerCase()}`;
}

function isDescendantOf(nodes: ContentNode[], nodeId: string, ancestorId: string) {
  let current = nodes.find((item) => item.id === nodeId);
  while (current?.parentId) {
    if (current.parentId === ancestorId) return true;
    const parentId = current.parentId;
    current = nodes.find((item) => item.id === parentId);
  }
  return false;
}

function subtreeEndIndex(nodes: ContentNode[], id: string) {
  const start = nodes.findIndex((item) => item.id === id);
  if (start === -1) return nodes.length;
  let end = start + 1;
  while (end < nodes.length && isDescendantOf(nodes, nodes[end].id, id)) {
    end += 1;
  }
  return end;
}

export function uniqueWorkspaceNodeId(id: string, nodes: ContentNode[]): string {
  if (!id || !nodes.some((node) => node.id === id)) return id;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${id}-${index}`;
    if (!nodes.some((node) => node.id === candidate)) return candidate;
  }
  return `${id}-new`;
}

export function insertWorkspaceNode(nodes: ContentNode[], node: ContentNode): ContentNode[] {
  const siblings = nodes.filter((item) => item.parentId === node.parentId);
  const insertBefore = siblings.find((sibling) => treeOrderKey(node) < treeOrderKey(sibling));
  if (insertBefore) {
    const index = nodes.findIndex((item) => item.id === insertBefore.id);
    if (index === -1) return [...nodes, node];
    return [...nodes.slice(0, index), node, ...nodes.slice(index)];
  }

  if (siblings.length === 0) {
    if (!node.parentId) return [...nodes, node];
    const parentIndex = nodes.findIndex((item) => item.id === node.parentId);
    if (parentIndex === -1) return [...nodes, node];
    return [...nodes.slice(0, parentIndex + 1), node, ...nodes.slice(parentIndex + 1)];
  }

  const lastSibling = siblings[siblings.length - 1];
  const insertAt = subtreeEndIndex(nodes, lastSibling.id);
  return [...nodes.slice(0, insertAt), node, ...nodes.slice(insertAt)];
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
