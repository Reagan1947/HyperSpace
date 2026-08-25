import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import {
  BlockNoteSchema,
  combineByGroup,
  createCodeBlockSpec,
  createExtension,
  createStyleSpec,
  defaultBlockSpecs,
} from "@blocknote/core";
import { zh } from "@blocknote/core/locales";
import {
  filterSuggestionItems,
  insertOrUpdateBlockForSlashMenu,
} from "@blocknote/core/extensions";
import { codeBlockOptions, syntaxHighlighter } from "@blocknote/code-block";
import {
  createReactInlineMathSpec,
  createReactMathBlockSpec,
  getMathBlockTypeSelectItems,
  getMathSlashMenuItems,
  locales as mathLocales,
  MathInlineInputRulesExtension,
} from "@blocknote/math-block";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { Extension, markInputRule, markPasteRule } from "@tiptap/core";
import {
  FormattingToolbar,
  FormattingToolbarController,
  SuggestionMenuController,
  blockTypeSelectItems,
  createReactBlockSpec,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  useBlockNoteEditor,
  useCreateBlockNote,
  useComponentsContext,
  useEditorState,
} from "@blocknote/react";
import {
  FileText,
  FolderOpen,
  Highlighter,
  MoreHorizontal,
  Sigma,
  Subscript,
  Superscript,
} from "lucide-react";
import type { ContentNode, NoteBlock } from "./types";

const WorkspaceNodesContext = createContext<ContentNode[]>([]);
const TEXT_HIGHLIGHT_COLOR = "yellow";

const superscriptStyle = createStyleSpec(
  { type: "superscript", propSchema: "boolean" },
  {
    render: () => {
      const sup = document.createElement("sup");
      return { dom: sup, contentDOM: sup };
    },
    parse: (element) => element.tagName === "SUP" ? true : undefined,
  },
);

const subscriptStyle = createStyleSpec(
  { type: "subscript", propSchema: "boolean" },
  {
    render: () => {
      const sub = document.createElement("sub");
      return { dom: sub, contentDOM: sub };
    },
    parse: (element) => element.tagName === "SUB" ? true : undefined,
  },
);

const textHighlightSyntax = createExtension({
  key: "textHighlightSyntax",
  tiptapExtensions: [
    Extension.create({
      name: "textHighlightSyntax",
      addInputRules() {
        const backgroundColor = this.editor.schema.marks.backgroundColor;
        if (!backgroundColor) return [];

        return [
          markInputRule({
            find: /(?:^|\s)((?:==)((?:[^~=]+))(?:==))$/,
            type: backgroundColor,
            getAttributes: { stringValue: TEXT_HIGHLIGHT_COLOR },
          }),
        ];
      },
      addPasteRules() {
        const backgroundColor = this.editor.schema.marks.backgroundColor;
        if (!backgroundColor) return [];

        return [
          markPasteRule({
            find: /(?:^|\s)((?:==)((?:[^~=]+))(?:==))/g,
            type: backgroundColor,
            getAttributes: { stringValue: TEXT_HIGHLIGHT_COLOR },
          }),
        ];
      },
    }),
  ],
});

function TextHighlightButton() {
  const editor = useBlockNoteEditor<any, any, any>();
  const Components = useComponentsContext()!;
  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (
        !editor.isEditable ||
        !(
          editor.getSelection()?.blocks || [
            editor.getTextCursorPosition().block,
          ]
        ).some((block) => block.content !== undefined)
      ) {
        return undefined;
      }

      return {
        active: editor.getActiveStyles().backgroundColor === TEXT_HIGHLIGHT_COLOR,
      };
    },
  });

  if (state === undefined) return null;

  return (
    <Components.FormattingToolbar.Button
      className="bn-button hyperspace-highlight-button"
      label="文本高亮"
      mainTooltip="文本高亮"
      secondaryTooltip="==文字=="
      isSelected={state.active}
      icon={<Highlighter size={17} />}
      onClick={() => {
        editor.focus();
        if (state.active) {
          editor.removeStyles({ backgroundColor: TEXT_HIGHLIGHT_COLOR });
        } else {
          editor.addStyles({ backgroundColor: TEXT_HIGHLIGHT_COLOR });
        }
      }}
    />
  );
}

function InlineMathButton() {
  const editor = useBlockNoteEditor<any, any, any>();
  const Components = useComponentsContext()!;
  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor.isEditable || !("math" in editor.schema.inlineContentSchema)) {
        return undefined;
      }

      const selectedBlocks = editor.getSelection()?.blocks || [
        editor.getTextCursorPosition().block,
      ];
      if (selectedBlocks.length !== 1 || selectedBlocks[0].content === undefined) {
        return undefined;
      }

      return {
        source: editor.getSelectedText(),
        range: {
          from: editor.prosemirrorState.selection.from,
          to: editor.prosemirrorState.selection.to,
        },
      };
    },
  });

  if (state === undefined) return null;

  return (
    <Components.FormattingToolbar.Button
      className="bn-button hyperspace-inline-math-button"
      label="行内公式"
      mainTooltip="转换为行内公式"
      secondaryTooltip="$...$"
      icon={<Sigma size={17} />}
      onClick={() => {
        const { source, range } = state;
        const insertPos = range.from;
        editor._tiptapEditor.commands.setTextSelection(range);
        editor.insertInlineContent([{ type: "math", content: source }]);

        requestAnimationFrame(() => {
          const sourceEnd = insertPos + source.length + 1;
          editor._tiptapEditor.commands.setTextSelection(sourceEnd);
          editor.focus();
        });
      }}
    />
  );
}

function ScriptStyleButton({ type }: { type: "superscript" | "subscript" }) {
  const editor = useBlockNoteEditor<any, any, any>();
  const Components = useComponentsContext()!;
  const isSuperscript = type === "superscript";
  const oppositeType = isSuperscript ? "subscript" : "superscript";
  const label = isSuperscript ? "上标" : "下标";
  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (
        !editor.isEditable ||
        !(
          editor.getSelection()?.blocks || [
            editor.getTextCursorPosition().block,
          ]
        ).some((block) => block.content !== undefined)
      ) {
        return undefined;
      }

      return { active: editor.getActiveStyles()[type] === true };
    },
  });

  if (state === undefined) return null;

  return (
    <Components.FormattingToolbar.Button
      className={`bn-button hyperspace-${type}-button`}
      label={label}
      mainTooltip={label}
      isSelected={state.active}
      icon={isSuperscript ? <Superscript size={17} /> : <Subscript size={17} />}
      onClick={() => {
        editor.focus();
        if (state.active) {
          editor.removeStyles({ [type]: true });
        } else {
          // A character cannot be both superscript and subscript. Removing the
          // opposite mark also keeps the stored style at an empty cursor sane.
          editor.removeStyles({ [oppositeType]: true });
          editor.addStyles({ [type]: true });
        }
      }}
    />
  );
}

function HyperSpaceFormattingToolbar() {
  const editor = useBlockNoteEditor<any, any, any>();
  const defaultItems = getFormattingToolbarItems([
    ...blockTypeSelectItems(editor.dictionary),
    ...getMathBlockTypeSelectItems(editor),
  ]);
  const insertAt = defaultItems.findIndex((item) => item.key === "textAlignLeftButton");
  const customItems = [
    <TextHighlightButton key="textHighlightButton" />,
    <ScriptStyleButton key="superscriptButton" type="superscript" />,
    <ScriptStyleButton key="subscriptButton" type="subscript" />,
    <InlineMathButton key="inlineMathButton" />,
  ];
  const items = insertAt < 0
    ? [...defaultItems, ...customItems]
    : [
        ...defaultItems.slice(0, insertAt),
        ...customItems,
        ...defaultItems.slice(insertAt),
      ];

  return <FormattingToolbar>{items}</FormattingToolbar>;
}

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
}).extend({
  inlineContentSpecs: {
    math: createReactInlineMathSpec(),
  },
  styleSpecs: {
    superscript: superscriptStyle,
    subscript: subscriptStyle,
  },
  blockSpecs: {
    mathBlock: createReactMathBlockSpec(),
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
    dictionary: { ...zh, math: mathLocales.zh },
    extensions: [
      syntaxHighlighter,
      textHighlightSyntax,
      // BlockNote 0.54 does not auto-register extensions declared by inline
      // content specs, so register the $...$ input rule explicitly.
      MathInlineInputRulesExtension,
    ],
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
        formattingToolbar={false}
        slashMenu={false}
        onChange={() => onChange(editor.document as unknown[])}
      >
        <FormattingToolbarController formattingToolbar={HyperSpaceFormattingToolbar} />
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
            const items = combineByGroup(
              getDefaultReactSlashMenuItems(editor),
              getMathSlashMenuItems(editor),
              customItems,
            );
            return filterSuggestionItems(items, query);
          }}
        />
      </BlockNoteView>
    </WorkspaceNodesContext.Provider>
  );
}
