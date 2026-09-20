export type NodeKind = "page" | "folder" | "file";

export type MarkerColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";

export interface TagDefinition {
  id: string;
  name: string;
}

export interface ContentNode {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  title: string;
  fileType?: string;
  size?: string;
  updatedAt: string;
  favorite?: boolean;
  markerColor?: MarkerColor;
  tagIds?: string[];
  localPath?: string;
  /** Stable filesystem identity used to retain metadata across external renames. */
  fileIdentity?: string;
  contentHash?: string;
  lfsTracked?: boolean;
}

export type BlockKind =
  | "text"
  | "heading1"
  | "heading"
  | "heading3"
  | "bullet"
  | "ordered"
  | "quote"
  | "code"
  | "callout"
  | "folder"
  | "file";

export interface NoteBlock {
  id: string;
  kind: BlockKind;
  content?: string;
  targetNodeId?: string;
  language?: string;
}

export interface WorkspaceState {
  nodes: ContentNode[];
  tags?: TagDefinition[];
  /** Legacy import input only. Markdown is the writable note body after Vditor migration. */
  blocks?: Record<string, NoteBlock[]>;
  /** Canonical note body. Sidecars store formatVersion alongside this Markdown. */
  noteMarkdown: Record<string, string>;
  selectedNodeId: string;
  lastSavedAt?: string;
}
