export type NodeKind = "page" | "folder" | "file";

export interface ContentNode {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  title: string;
  fileType?: string;
  size?: string;
  updatedAt: string;
  favorite?: boolean;
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
  blocks: Record<string, NoteBlock[]>;
  editorDocuments?: Record<string, unknown[]>;
  selectedNodeId: string;
  lastSavedAt?: string;
}
