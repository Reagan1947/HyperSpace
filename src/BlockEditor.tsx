import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import {
  BlockNoteSchema,
  createCodeBlockSpec,
  defaultBlockSpecs,
} from "@blocknote/core";
import { zh } from "@blocknote/core/locales";
import {
  filterSuggestionItems,
  insertOrUpdateBlockForSlashMenu,
} from "@blocknote/core/extensions";
import { codeBlockOptions, syntaxHighlighter } from "@blocknote/code-block";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import {
  SuggestionMenuController,
  createReactBlockSpec,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
} from "@blocknote/react";
import { FileText, FolderOpen, MoreHorizontal } from "lucide-react";
import type { ContentNode, NoteBlock } from "./types";

const WorkspaceNodesContext = createContext<ContentNode[]>([]);

function FolderEmbedCard({ targetId }: { targetId: string }) {
  const nodes = useContext(WorkspaceNodesContext);
  const target = nodes.find((node) => node.id === targetId);
  const children = nodes.filter((node) => node.parentId === targetId);
  return (
    <section className="embedded-folder blocknote-embed" contentEditable={false}>
      <div className="embedded-heading">
        <span className="folder-badge"><FolderOpen size={17} /></span>
        <div><strong>{target?.title ?? "已删除的文件夹"}</strong><span>{children.length} 个项目</span></div>
        <button type="button" aria-label="文件夹操作"><MoreHorizontal size={17} /></button>
      </div>
      <div className="file-list">
        {children.map((child) => (
          <div className="file-row" key={child.id}>
            <span className={`file-type ${child.fileType?.toLowerCase() ?? "note"}`}><FileText size={17} /></span>
            <span className="file-main"><strong>{child.title}</strong><small>{child.fileType ?? "笔记"} · {child.size ?? child.updatedAt}</small></span>
            <span className="file-time">{child.updatedAt}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function FileEmbedCard({ targetId }: { targetId: string }) {
  const nodes = useContext(WorkspaceNodesContext);
  const target = nodes.find((node) => node.id === targetId);
  return (
    <div className="embedded-file blocknote-embed" contentEditable={false}>
      <span className="pdf-mark">{target?.fileType ?? "FILE"}</span>
      <span><strong>{target?.title ?? "已删除的文件"}</strong><small>{target?.size ?? ""} · {target?.updatedAt ?? ""}</small></span>
      <span className="open-label">在桌面打开</span>
      <MoreHorizontal size={17} />
    </div>
  );
}

const folderEmbed = createReactBlockSpec(
  {
    type: "folderEmbed",
    propSchema: { targetNodeId: { default: "" } },
    content: "none",
  },
  {
    render: ({ block }) => <FolderEmbedCard targetId={block.props.targetNodeId} />,
    toExternalHTML: ({ block }) => <div data-folder-id={block.props.targetNodeId}>嵌入文件夹</div>,
  },
);

const fileEmbed = createReactBlockSpec(
  {
    type: "fileEmbed",
    propSchema: { targetNodeId: { default: "" } },
    content: "none",
  },
  {
    render: ({ block }) => <FileEmbedCard targetId={block.props.targetNodeId} />,
    toExternalHTML: ({ block }) => <div data-file-id={block.props.targetNodeId}>嵌入文件</div>,
  },
);

const hyperSpaceSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    folderEmbed: folderEmbed(),
    fileEmbed: fileEmbed(),
  },
});

type HyperSpaceEditor = typeof hyperSpaceSchema.BlockNoteEditor;
type HyperSpacePartialBlock = Parameters<HyperSpaceEditor["insertBlocks"]>[0][number];

function legacyBlockToBlockNote(block: NoteBlock): HyperSpacePartialBlock {
  const content = block.content ?? "";
  switch (block.kind) {
    case "heading1":
      return { id: block.id, type: "heading", props: { level: 1 }, content };
    case "heading":
      return { id: block.id, type: "heading", props: { level: 2 }, content };
    case "heading3":
      return { id: block.id, type: "heading", props: { level: 3 }, content };
    case "bullet":
      return { id: block.id, type: "bulletListItem", content };
    case "ordered":
      return { id: block.id, type: "numberedListItem", content };
    case "quote":
    case "callout":
      return { id: block.id, type: "quote", content };
    case "code":
      return {
        id: block.id,
        type: "codeBlock",
        props: {
          language: block.language === "plaintext"
            ? "text"
            : block.language === "xml"
              ? "html"
              : block.language === "bash"
                ? "shellscript"
                : block.language ?? "text",
        },
        content,
      };
    case "folder":
      return { id: block.id, type: "folderEmbed", props: { targetNodeId: block.targetNodeId ?? "" } };
    case "file":
      return { id: block.id, type: "fileEmbed", props: { targetNodeId: block.targetNodeId ?? "" } };
    default:
      return { id: block.id, type: "paragraph", content };
  }
}

function migrateLegacyBlocks(blocks: NoteBlock[]): unknown[] {
  const migrated = blocks.map(legacyBlockToBlockNote);
  return migrated.length > 0 ? migrated : [{ type: "paragraph" }];
}

export function HyperSpaceBlockEditor({
  pageId,
  nodes,
  initialDocument,
  legacyBlocks,
  readOnly,
  onChange,
}: {
  pageId: string;
  nodes: ContentNode[];
  initialDocument?: unknown[];
  legacyBlocks: NoteBlock[];
  readOnly: boolean;
  onChange: (document: unknown[]) => void;
}) {
  const initialContent = useMemo(
    () => (initialDocument?.length ? initialDocument : migrateLegacyBlocks(legacyBlocks)),
    [initialDocument, legacyBlocks],
  );
  const editor = useCreateBlockNote({
    schema: hyperSpaceSchema,
    dictionary: zh,
    extensions: [syntaxHighlighter],
    initialContent: initialContent as HyperSpacePartialBlock[],
  }, [pageId]);
  const migratedPageRef = useRef<string | null>(null);

  useEffect(() => {
    if (!initialDocument && migratedPageRef.current !== pageId) {
      migratedPageRef.current = pageId;
      onChange(editor.document as unknown[]);
    }
  }, [editor, initialDocument, onChange, pageId]);

  return (
    <WorkspaceNodesContext.Provider value={nodes}>
      <BlockNoteView
        className="hyperspace-blocknote"
        editor={editor}
        editable={!readOnly}
        theme="light"
        slashMenu={false}
        onChange={() => onChange(editor.document as unknown[])}
      >
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) => {
            const customItems = nodes.flatMap((node) => {
              if (node.kind === "folder") {
                return [{
                  title: `嵌入文件夹：${node.title}`,
                  subtext: "在笔记中显示文件夹内容",
                  aliases: ["folder", "文件夹", node.title],
                  group: "工作空间",
                  icon: <FolderOpen size={18} />,
                  onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "folderEmbed", props: { targetNodeId: node.id } }),
                }];
              }
              if (node.kind === "file") {
                return [{
                  title: `嵌入文件：${node.title}`,
                  subtext: "在笔记中添加文件卡片",
                  aliases: ["file", "文件", node.title],
                  group: "工作空间",
                  icon: <FileText size={18} />,
                  onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "fileEmbed", props: { targetNodeId: node.id } }),
                }];
              }
              return [];
            });
            return filterSuggestionItems([...getDefaultReactSlashMenuItems(editor), ...customItems], query);
          }}
        />
      </BlockNoteView>
    </WorkspaceNodesContext.Provider>
  );
}
