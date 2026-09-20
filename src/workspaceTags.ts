import type { ContentNode, TagDefinition, WorkspaceState } from "./types";

export const WORKSPACE_TAGS_MUTATE_EVENT = "workspace-tags-mutate";
export const WORKSPACE_TAGS_CHANGED_EVENT = "workspace-tags-changed";
export const WORKSPACE_TAGS_REQUEST_EVENT = "workspace-tags-request";
export const SETTINGS_NAVIGATE_EVENT = "settings-navigate";
export const TAG_NAME_MAX_LENGTH = 20;

export type WorkspaceTagsMutation = {
  tags: TagDefinition[];
  removedTagIds?: string[];
};

export type WorkspaceTagsSnapshot = {
  tags: TagDefinition[];
  usage: Record<string, number>;
};

export function normalizeTagName(name: string) {
  return name.trim();
}

export function findTagByName(tags: TagDefinition[], name: string) {
  const normalized = normalizeTagName(name);
  if (!normalized) return undefined;
  return tags.find((tag) => tag.name.localeCompare(normalized, undefined, { sensitivity: "accent" }) === 0);
}

export function createTagDefinition(name: string): TagDefinition {
  return {
    id: `tag-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: normalizeTagName(name),
  };
}

export function tagUsageMap(nodes: ContentNode[], tags: TagDefinition[]): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const tag of tags) usage[tag.id] = 0;
  for (const node of nodes) {
    for (const tagId of node.tagIds ?? []) {
      usage[tagId] = (usage[tagId] ?? 0) + 1;
    }
  }
  return usage;
}

export function workspaceTagsSnapshot(workspace: WorkspaceState): WorkspaceTagsSnapshot {
  const tags = workspace.tags ?? [];
  return { tags, usage: tagUsageMap(workspace.nodes, tags) };
}

export function applyTagCatalog(
  workspace: WorkspaceState,
  tags: TagDefinition[],
  removedTagIds: string[] = [],
): WorkspaceState {
  const removed = new Set(removedTagIds);
  const validIds = new Set(tags.map((tag) => tag.id));
  return {
    ...workspace,
    tags,
    nodes: workspace.nodes.map((node) => {
      if (!node.tagIds?.length) return node;
      const nextIds = node.tagIds.filter((id) => validIds.has(id) && !removed.has(id));
      if (nextIds.length === node.tagIds.length) return node;
      return { ...node, tagIds: nextIds, updatedAt: "刚刚" };
    }),
  };
}
