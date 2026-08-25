import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import "highlight.js/styles/github.css";
import folderMenuIcon from "./assets/icons/folder-menu.svg";
import {
  Bookmark,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Cloud,
  Code2,
  Command,
  File,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Hash,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  ListTree,
  Lock,
  LockOpen,
  MessageSquareText,
  Minus,
  MoreHorizontal,
  Paperclip,
  Plus,
  Quote,
  Search,
  Server,
  SlidersHorizontal,
  Sparkles,
  Star,
  TerminalSquare,
  Text,
  Users,
  X,
} from "lucide-react";
import { initialWorkspace } from "./data";
import { FileTree } from "./FileTree";
import { loadWorkspace, saveWorkspace } from "./storage";
import type { ContentNode, NoteBlock, WorkspaceState } from "./types";

type SyncStatus = "loading" | "saved" | "saving" | "offline";
type PrimaryLeftTool = "project" | "commit" | "pullRequests";
type SecondaryLeftTool = "structure" | "bookmarks";
type BottomTool = "search";
type SecondaryBottomTool = "git" | "terminal" | "todo" | "services";

const HyperSpaceBlockEditor = lazy(() => import("./BlockEditor").then((module) => ({ default: module.HyperSpaceBlockEditor })));

hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("sql", sql);

const cloneInitial = () => structuredClone(initialWorkspace);

function NodeIcon({ node, size = 16 }: { node: ContentNode; size?: number }) {
  if (node.kind === "folder") return <Folder size={size} strokeWidth={1.8} />;
  if (node.fileType === "XLSX") return <FileSpreadsheet size={size} strokeWidth={1.8} />;
  if (node.kind === "file") return <FileText size={size} strokeWidth={1.8} />;
  return <File size={size} strokeWidth={1.8} />;
}

type BlockCommand = {
  id: string;
  label: string;
  description: string;
  kind: NoteBlock["kind"];
  targetNodeId?: string;
  language?: string;
  icon: React.ReactNode;
  keywords: string;
};

function getBlockCommands(nodes: ContentNode[]): BlockCommand[] {
  const commands: BlockCommand[] = [
    { id: "text", label: "正文", description: "普通文本段落", kind: "text", icon: <Text size={16} />, keywords: "text paragraph zhengwen wenben" },
    { id: "heading1", label: "一级标题", description: "输入 # 后按空格", kind: "heading1", icon: <Heading1 size={16} />, keywords: "heading 1 h1 title biaoti" },
    { id: "heading", label: "二级标题", description: "输入 ## 后按空格", kind: "heading", icon: <Heading2 size={16} />, keywords: "heading 2 h2 title biaoti" },
    { id: "heading3", label: "三级标题", description: "输入 ### 后按空格", kind: "heading3", icon: <Heading3 size={16} />, keywords: "heading 3 h3 title biaoti" },
    { id: "bullet", label: "无序列表", description: "输入 - 或 * 后按空格", kind: "bullet", icon: <List size={16} />, keywords: "bullet list unordered liebiao" },
    { id: "ordered", label: "有序列表", description: "输入 1. 后按空格", kind: "ordered", icon: <ListOrdered size={16} />, keywords: "ordered numbered list liebiao" },
    { id: "quote", label: "引用", description: "输入 > 后按空格", kind: "quote", icon: <Quote size={16} />, keywords: "quote blockquote yinyong" },
    { id: "code", label: "代码块", description: "输入 ```语言 后按 Enter", kind: "code", language: "plaintext", icon: <Code2 size={16} />, keywords: "code block daima python javascript typescript" },
    { id: "callout", label: "提示块", description: "突出显示重要信息", kind: "callout", icon: <MessageSquareText size={16} />, keywords: "callout tip tishi" },
  ];

  for (const node of nodes) {
    if (node.kind === "folder") {
      commands.push({ id: `folder-${node.id}`, label: `嵌入文件夹：${node.title}`, description: "在笔记中显示文件夹内容", kind: "folder", targetNodeId: node.id, icon: <FolderOpen size={16} />, keywords: `folder wenjianjia ${node.title}` });
    } else if (node.kind === "file") {
      commands.push({ id: `file-${node.id}`, label: `嵌入文件：${node.title}`, description: "在笔记中添加文件卡片", kind: "file", targetNodeId: node.id, icon: <Paperclip size={16} />, keywords: `file attachment wenjian ${node.title}` });
    }
  }

  return commands;
}

const markdownShortcuts: Record<string, NoteBlock["kind"]> = {
  "# ": "heading1",
  "## ": "heading",
  "### ": "heading3",
  "- ": "bullet",
  "* ": "bullet",
  "1. ": "ordered",
  "> ": "quote",
  "``` ": "code",
};

function splitEditableContent(editable: HTMLElement): [string, string] {
  const content = editable.textContent ?? "";
  const selection = window.getSelection();
  if (!selection?.rangeCount) return [content, ""];
  const selectedRange = selection.getRangeAt(0);
  if (!editable.contains(selectedRange.startContainer) || !editable.contains(selectedRange.endContainer)) return [content, ""];

  const leadingRange = document.createRange();
  leadingRange.selectNodeContents(editable);
  leadingRange.setEnd(selectedRange.startContainer, selectedRange.startOffset);
  const start = leadingRange.toString().length;
  const end = start + selectedRange.toString().length;
  return [content.slice(0, start), content.slice(end)];
}

function focusEditorBlock(blockId: string, position: "start" | "end" = "start") {
  window.requestAnimationFrame(() => {
    const editable = document.querySelector<HTMLElement>(`[data-editor-block-id="${blockId}"]`);
    if (!editable) return;
    editable.focus();
    if (editable instanceof HTMLTextAreaElement) {
      const offset = position === "start" ? 0 : editable.value.length;
      editable.setSelectionRange(offset, offset);
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(position === "start");
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

function ProjectSidebar({
  workspace,
  onSelect,
  onCreatePage,
  onCreateNode,
  onRenameNode,
  onMoveNodes,
  onDeleteNodes,
  onClose,
}: {
  workspace: WorkspaceState;
  onSelect: (id: string) => void;
  onCreatePage: () => void;
  onCreateNode: (kind: "page" | "folder", parentId: string | null) => void;
  onRenameNode: (id: string, title: string) => void;
  onMoveNodes: (ids: string[], parentId: string | null, index: number) => void;
  onDeleteNodes: (ids: string[]) => void;
  onClose: () => void;
}) {
  return (
    <section className="sidebar-pane primary">
      <div className="panel-header">
        <FolderTree size={18} strokeWidth={1.7} />
        <strong>Project</strong>
        <ChevronDown size={14} />
        <div className="panel-header-actions">
          <button aria-label="新建页面" onClick={onCreatePage}><Plus size={15} /></button>
          <button aria-label="收起 Project 窗口" title="收起窗口" onClick={onClose}><Minus size={15} /></button>
        </div>
      </div>
      <FileTree
        nodes={workspace.nodes}
        selectedId={workspace.selectedNodeId}
        onSelect={onSelect}
        onCreate={onCreateNode}
        onRename={onRenameNode}
        onMove={onMoveNodes}
        onDelete={onDeleteNodes}
      />
    </section>
  );
}

function ToolSidebar({ tool, outlineItems, bookmarks, onSelectNode, onClose }: {
  tool: Exclude<PrimaryLeftTool, "project"> | SecondaryLeftTool;
  outlineItems: { id: string; content: string }[];
  bookmarks: ContentNode[];
  onSelectNode: (id: string) => void;
  onClose: () => void;
}) {
  const config = tool === "commit"
    ? { title: "Commit", icon: <GitCommitHorizontal size={18} strokeWidth={1.7} />, emptyIcon: <GitCommitHorizontal size={24} strokeWidth={1.5} />, empty: "暂无待提交的更改" }
    : tool === "pullRequests"
      ? { title: "PullRequests", icon: <GitPullRequest size={18} strokeWidth={1.7} />, emptyIcon: <GitPullRequest size={24} strokeWidth={1.5} />, empty: "暂无 Pull Requests" }
      : tool === "structure"
        ? { title: "Structure", icon: <ListTree size={18} strokeWidth={1.7} />, emptyIcon: <ListTree size={24} strokeWidth={1.5} />, empty: "当前页面没有结构" }
        : { title: "Bookmarks", icon: <Bookmark size={18} strokeWidth={1.7} />, emptyIcon: <Bookmark size={24} strokeWidth={1.5} />, empty: "暂无书签" };

  const hasStructure = tool === "structure" && outlineItems.length > 0;
  const hasBookmarks = tool === "bookmarks" && bookmarks.length > 0;
  const panePosition = tool === "structure" || tool === "bookmarks" ? "secondary" : "primary";
  return (
    <section className={`sidebar-pane ${panePosition}`}>
      <div className="panel-header">
        {config.icon}
        <strong>{config.title}</strong>
        <button aria-label={`收起 ${config.title} 窗口`} title="收起窗口" onClick={onClose}><Minus size={15} /></button>
      </div>
      {hasStructure ? (
        <div className="sidebar-tool-list">
          {outlineItems.map((item) => <button key={item.id}><Hash size={14} /><span>{item.content}</span></button>)}
        </div>
      ) : hasBookmarks ? (
        <div className="sidebar-tool-list">
          {bookmarks.map((node) => <button key={node.id} onClick={() => onSelectNode(node.id)}><NodeIcon node={node} size={15} /><span>{node.title}</span></button>)}
        </div>
      ) : (
        <div className="git-sidebar-content">
          {config.emptyIcon}
          <span>{config.empty}</span>
        </div>
      )}
    </section>
  );
}

function LeftActivityRail({
  primaryActive,
  secondaryActive,
  onPrimarySelect,
  onSecondarySelect,
}: {
  primaryActive: PrimaryLeftTool | null;
  secondaryActive: SecondaryLeftTool | null;
  onPrimarySelect: (tool: PrimaryLeftTool) => void;
  onSecondarySelect: (tool: SecondaryLeftTool) => void;
}) {
  return (
    <nav className="activity-rail left" aria-label="主工具栏">
      <button className={primaryActive === "project" ? "active" : ""} onClick={() => onPrimarySelect("project")} aria-label="Project" aria-pressed={primaryActive === "project"}>
        <span>Project</span><img className="activity-menu-icon" src={folderMenuIcon} alt="" aria-hidden="true" />
      </button>
      <button className={primaryActive === "commit" ? "active" : ""} onClick={() => onPrimarySelect("commit")} aria-label="Commit" aria-pressed={primaryActive === "commit"}>
        <span>Commit</span><GitCommitHorizontal size={18} strokeWidth={1.5} />
      </button>
      <button className={primaryActive === "pullRequests" ? "active" : ""} onClick={() => onPrimarySelect("pullRequests")} aria-label="PullRequests" aria-pressed={primaryActive === "pullRequests"}>
        <span>PullRequests</span><GitPullRequest size={18} strokeWidth={1.5} />
      </button>
      <div className="activity-rail-bottom">
        <button className={secondaryActive === "structure" ? "active" : ""} onClick={() => onSecondarySelect("structure")} aria-label="Structure" aria-pressed={secondaryActive === "structure"}>
          <span>Structure</span><ListTree size={18} strokeWidth={1.5} />
        </button>
        <button className={secondaryActive === "bookmarks" ? "active" : ""} onClick={() => onSecondarySelect("bookmarks")} aria-label="Bookmarks" aria-pressed={secondaryActive === "bookmarks"}>
          <span>Bookmarks</span><Bookmark size={18} strokeWidth={1.5} />
        </button>
      </div>
    </nav>
  );
}

function RightActivityRail({
  active,
  onSelect,
}: {
  active: "info" | "outline" | "ai" | null;
  onSelect: (tool: "info" | "outline" | "ai") => void;
}) {
  return (
    <nav className="activity-rail right" aria-label="辅助工具栏">
      <button className={active === "info" ? "active" : ""} onClick={() => onSelect("info")} aria-label="Page Info">
        <span>Info</span><SlidersHorizontal size={18} strokeWidth={1.5} />
      </button>
      <button className={active === "outline" ? "active" : ""} onClick={() => onSelect("outline")} aria-label="Outline">
        <span>Outline</span><ListTree size={18} strokeWidth={1.5} />
      </button>
      <button className={active === "ai" ? "active" : ""} onClick={() => onSelect("ai")} aria-label="AI Assistant">
        <span>AI</span><Bot size={18} strokeWidth={1.5} />
      </button>
    </nav>
  );
}

function EmbeddedNode({ target, children }: { target?: ContentNode; children?: ContentNode[] }) {
  if (!target) return null;

  if (target.kind === "folder") {
    return (
      <section className="embedded-folder">
        <div className="embedded-heading">
          <span className="folder-badge"><FolderOpen size={17} /></span>
          <div><strong>{target.title}</strong><span>{children?.length ?? 0} 个项目</span></div>
          <button><MoreHorizontal size={17} /></button>
        </div>
        <div className="file-list">
          {children?.map((child) => (
            <button className="file-row" key={child.id}>
              <span className={`file-type ${child.fileType?.toLowerCase() ?? "note"}`}><NodeIcon node={child} size={17} /></span>
              <span className="file-main"><strong>{child.title}</strong><small>{child.fileType ?? "笔记"} · {child.size ?? child.updatedAt}</small></span>
              <span className="file-time">{child.updatedAt}</span>
              <MoreHorizontal size={16} />
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <button className="embedded-file">
      <span className="pdf-mark">PDF</span>
      <span><strong>{target.title}</strong><small>{target.size} · {target.updatedAt}更新</small></span>
      <span className="open-label">在桌面打开</span>
      <MoreHorizontal size={17} />
    </button>
  );
}

const codeLanguages = [
  ["plaintext", "纯文本"],
  ["python", "Python"],
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["json", "JSON"],
  ["bash", "Shell"],
  ["xml", "HTML / XML"],
  ["css", "CSS"],
  ["sql", "SQL"],
] as const;

const languageAliases: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  html: "xml",
};

function normalizeCodeLanguage(language?: string) {
  const normalized = (language || "plaintext").trim().toLowerCase();
  const resolved = languageAliases[normalized] ?? normalized;
  return hljs.getLanguage(resolved) ? resolved : "plaintext";
}

function CodeBlockEditor({ block, onChange, onLanguageChange }: {
  block: NoteBlock;
  onChange: (id: string, content: string) => void;
  onLanguageChange: (id: string, language: string) => void;
}) {
  const [draft, setDraft] = useState(block.content ?? "");
  const highlightRef = useRef<HTMLPreElement>(null);
  const language = normalizeCodeLanguage(block.language);
  const highlighted = useMemo(
    () => hljs.highlight(draft, { language, ignoreIllegals: true }).value,
    [draft, language],
  );

  useEffect(() => setDraft(block.content ?? ""), [block.content]);

  return (
    <div className="code-block-editor">
      <div className="code-block-toolbar">
        <Code2 size={14} />
        <select
          aria-label="代码高亮语言"
          value={language}
          onChange={(event) => onLanguageChange(block.id, event.currentTarget.value)}
        >
          {codeLanguages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <div className="code-editor-body">
        <pre ref={highlightRef} aria-hidden="true"><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
        <textarea
          data-editor-block-id={block.id}
          aria-label={`${codeLanguages.find(([value]) => value === language)?.[1] ?? language} 代码`}
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={() => onChange(block.id, draft)}
          onScroll={(event) => {
            if (!highlightRef.current) return;
            highlightRef.current.scrollTop = event.currentTarget.scrollTop;
            highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
          }}
        />
      </div>
    </div>
  );
}

function EditableTextBlock({
  block,
  nodes,
  onChange,
  onCommand,
  onSplit,
  onDelete,
  deleteFocusTarget,
}: {
  block: NoteBlock;
  nodes: ContentNode[];
  onChange: (id: string, content: string) => void;
  onCommand: (id: string, command: BlockCommand, content: string, source: "plus" | "slash") => void;
  onSplit: (id: string, nextId: string, content: string, nextContent: string, nextKind: NoteBlock["kind"]) => void;
  onDelete: (id: string) => void;
  deleteFocusTarget?: { id: string; position: "start" | "end" };
}) {
  const Tag = block.kind === "heading1"
    ? "h1"
    : block.kind === "heading"
      ? "h2"
      : block.kind === "heading3"
        ? "h3"
        : block.kind === "quote"
          ? "blockquote"
          : block.kind === "code"
            ? "pre"
            : "p";
  const [menuSource, setMenuSource] = useState<"plus" | "slash" | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const editableRef = useRef<HTMLHeadingElement & HTMLParagraphElement & HTMLQuoteElement & HTMLPreElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const commands = useMemo(() => getBlockCommands(nodes), [nodes]);
  const filteredCommands = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? commands.filter((command) => `${command.label} ${command.keywords}`.toLowerCase().includes(normalized))
      : commands;
  }, [commands, query]);

  useEffect(() => setActiveIndex(0), [query]);

  useEffect(() => {
    if (!menuSource) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as globalThis.Node) && event.target !== editableRef.current) setMenuSource(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuSource]);

  const restoreEditorFocus = () => {
    window.requestAnimationFrame(() => {
      const editable = editableRef.current;
      if (!editable) {
        focusEditorBlock(block.id, "end");
        return;
      }
      editable.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editable);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  };

  const chooseCommand = (command: BlockCommand) => {
    const rawContent = editableRef.current?.textContent ?? block.content ?? "";
    const content = menuSource === "slash" ? rawContent.replace(/\/[\w\u4e00-\u9fff-]*$/, "").trimEnd() : rawContent;
    const source = menuSource ?? "plus";
    setMenuSource(null);
    onCommand(block.id, command, content, source);
    restoreEditorFocus();
  };

  return (
    <div className={`editable-row ${block.kind}`}>
      <button
        className="block-handle"
        aria-label="插入内容块"
        aria-expanded={menuSource === "plus"}
        onClick={() => {
          setQuery("");
          setMenuSource((current) => current === "plus" ? null : "plus");
        }}
      ><Plus size={13} /></button>
      <Tag
        ref={editableRef}
        data-editor-block-id={block.id}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={block.kind === "heading1" ? "一级标题" : block.kind === "heading" ? "二级标题" : block.kind === "heading3" ? "三级标题" : block.kind === "code" ? "输入代码" : "输入文字，或按 / 插入内容"}
        onBlur={(event) => onChange(block.id, event.currentTarget.textContent ?? "")}
        onInput={(event) => {
          const content = (event.currentTarget.textContent ?? "").replace(/\u00a0/g, " ");
          const shortcutKind = markdownShortcuts[content];
          if (shortcutKind) {
            const shortcutCommand = commands.find((command) => command.kind === shortcutKind);
            if (shortcutCommand) {
              onCommand(block.id, shortcutCommand, "", "slash");
              restoreEditorFocus();
            }
            return;
          }
          const match = content.match(/\/([\w\u4e00-\u9fff-]*)$/);
          if (match) {
            setQuery(match[1]);
            setMenuSource("slash");
          } else if (menuSource === "slash") {
            setMenuSource(null);
          }
        }}
        onKeyDown={(event) => {
          const isHeading = block.kind === "heading1" || block.kind === "heading" || block.kind === "heading3";
          if (event.key === "Backspace" && isHeading && !(event.currentTarget.textContent ?? "").length) {
            const textCommand = commands.find((command) => command.kind === "text");
            if (textCommand) {
              event.preventDefault();
              setMenuSource(null);
              onCommand(block.id, textCommand, "", "slash");
              restoreEditorFocus();
            }
            return;
          }
          if (event.key === "Backspace" && block.kind === "text" && !(event.currentTarget.textContent ?? "").length && deleteFocusTarget) {
            event.preventDefault();
            onDelete(block.id);
            focusEditorBlock(deleteFocusTarget.id, deleteFocusTarget.position);
            return;
          }
          const codeFence = (event.currentTarget.textContent ?? "").trim().match(/^```([a-zA-Z0-9_+-]+)$/);
          if (event.key === "Enter" && !event.shiftKey && !menuSource && !event.nativeEvent.isComposing && codeFence) {
            event.preventDefault();
            const codeCommand = commands.find((command) => command.kind === "code");
            if (codeCommand) {
              const requestedLanguage = normalizeCodeLanguage(codeFence[1]);
              onCommand(block.id, { ...codeCommand, language: requestedLanguage }, "", "slash");
              focusEditorBlock(block.id);
            }
            return;
          }
          if (event.key === "Enter" && !event.shiftKey && !menuSource && !event.nativeEvent.isComposing) {
            event.preventDefault();
            const [content, nextContent] = splitEditableContent(event.currentTarget);
            const nextId = `block-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const nextKind = block.kind === "bullet" || block.kind === "ordered" ? block.kind : "text";
            onSplit(block.id, nextId, content, nextContent, nextKind);
            focusEditorBlock(nextId);
            return;
          }
          if (!menuSource) return;
          if (event.key === "Escape") {
            event.preventDefault();
            setMenuSource(null);
          } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && filteredCommands.length > 0) {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            setActiveIndex((current) => (current + direction + filteredCommands.length) % filteredCommands.length);
          } else if (event.key === "Enter" && filteredCommands[activeIndex]) {
            event.preventDefault();
            chooseCommand(filteredCommands[activeIndex]);
          }
        }}
      >
        {block.content}
      </Tag>
      {menuSource && (
        <div className="block-command-menu" ref={menuRef} role="listbox" aria-label="插入内容">
          <div className="block-command-heading">基础块</div>
          {filteredCommands.length > 0 ? filteredCommands.map((command, index) => (
            <button
              key={command.id}
              className={index === activeIndex ? "active" : ""}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseCommand(command)}
            >
              <span>{command.icon}</span>
              <span><strong>{command.label}</strong><small>{command.description}</small></span>
            </button>
          )) : <p className="block-command-empty">没有匹配的内容块</p>}
        </div>
      )}
    </div>
  );
}

function EditorBlock({ block, nodes, onChange, onLanguageChange, onCommand, onSplit, onDelete, deleteFocusTarget }: {
  block: NoteBlock;
  nodes: ContentNode[];
  onChange: (id: string, content: string) => void;
  onLanguageChange: (id: string, language: string) => void;
  onCommand: (id: string, command: BlockCommand, content: string, source: "plus" | "slash") => void;
  onSplit: (id: string, nextId: string, content: string, nextContent: string, nextKind: NoteBlock["kind"]) => void;
  onDelete: (id: string) => void;
  deleteFocusTarget?: { id: string; position: "start" | "end" };
}) {
  if (block.kind === "folder" || block.kind === "file") {
    const target = nodes.find((node) => node.id === block.targetNodeId);
    const children = nodes.filter((node) => node.parentId === target?.id);
    return <EmbeddedNode target={target} children={children} />;
  }

  if (block.kind === "code") {
    return <CodeBlockEditor block={block} onChange={onChange} onLanguageChange={onLanguageChange} />;
  }

  if (block.kind === "callout") {
    return (
      <div className="callout-block">
        <Sparkles size={18} />
        <div
          contentEditable
          suppressContentEditableWarning
          data-editor-block-id={block.id}
          onBlur={(event) => onChange(block.id, event.currentTarget.textContent ?? "")}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            const [content, nextContent] = splitEditableContent(event.currentTarget);
            const nextId = `block-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            onSplit(block.id, nextId, content, nextContent, "text");
            focusEditorBlock(nextId);
          }}
        >{block.content}</div>
      </div>
    );
  }

  return <EditableTextBlock block={block} nodes={nodes} onChange={onChange} onCommand={onCommand} onSplit={onSplit} onDelete={onDelete} deleteFocusTarget={deleteFocusTarget} />;
}

function NoteView({
  node,
  workspace,
  readOnly,
  onTitleChange,
  onDocumentChange,
}: {
  node: ContentNode;
  workspace: WorkspaceState;
  readOnly: boolean;
  onTitleChange: (title: string) => void;
  onDocumentChange: (document: unknown[]) => void;
}) {
  return (
    <article className={`note-page ${readOnly ? "read-only" : ""}`}>
      <div className="note-meta"><span>产品设计</span><ChevronRight size={13} /><span>探索</span></div>
      <div className="note-title-row">
        <h1
          contentEditable={!readOnly}
          aria-readonly={readOnly}
          suppressContentEditableWarning
          onBlur={(event) => onTitleChange(event.currentTarget.textContent?.trim() || "未命名")}
        >{node.title}</h1>
      </div>
      <div className="author-line">
        <span className="mini-avatar">JL</span>
        <span>Johli 创建</span>
        <span className="dot">·</span>
        <span>今天 10:24</span>
      </div>
      <div className="editor">
        <Suspense fallback={<div className="editor-loading">正在加载编辑器…</div>}>
          <HyperSpaceBlockEditor
            key={node.id}
            pageId={node.id}
            nodes={workspace.nodes}
            initialDocument={workspace.editorDocuments?.[node.id]}
            legacyBlocks={workspace.blocks[node.id] ?? []}
            readOnly={readOnly}
            onChange={onDocumentChange}
          />
        </Suspense>
      </div>
    </article>
  );
}

function EmptyView({ node }: { node: ContentNode }) {
  return (
    <div className="empty-view">
      <span><NodeIcon node={node} size={30} /></span>
      <h1>{node.title}</h1>
      <p>{node.kind === "folder" ? "在这个文件夹中创建笔记或添加文件。" : "该文件将在桌面端安全打开。"}</p>
      <button><Plus size={16} /> 新建内容</button>
    </div>
  );
}

function getDocumentOutline(document: unknown[] | undefined) {
  if (!document) return [];
  const items: { id: string; content: string }[] = [];
  const visit = (blocks: unknown[]) => {
    for (const value of blocks) {
      if (!value || typeof value !== "object") continue;
      const block = value as { id?: unknown; type?: unknown; content?: unknown; children?: unknown };
      if (block.type === "heading") {
        const content = Array.isArray(block.content)
          ? block.content.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "").join("")
          : typeof block.content === "string" ? block.content : "";
        if (content) items.push({ id: typeof block.id === "string" ? block.id : `heading-${items.length}`, content });
      }
      if (Array.isArray(block.children)) visit(block.children);
    }
  };
  visit(document);
  return items;
}

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(cloneInitial);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("loading");
  const [rightTool, setRightTool] = useState<"info" | "outline" | "ai" | null>(null);
  const [bottomTool, setBottomTool] = useState<BottomTool | null>(null);
  const [secondaryBottomTool, setSecondaryBottomTool] = useState<SecondaryBottomTool | null>(null);
  const [query, setQuery] = useState("");
  const [lockedNodeIds, setLockedNodeIds] = useState<string[]>([]);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [primaryLeftTool, setPrimaryLeftTool] = useState<PrimaryLeftTool | null>("project");
  const [secondaryLeftTool, setSecondaryLeftTool] = useState<SecondaryLeftTool | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(316);
  const [openTabIds, setOpenTabIds] = useState<string[]>([initialWorkspace.selectedNodeId]);
  const hydrated = useRef(false);

  useEffect(() => {
    void loadWorkspace().then((stored) => {
      if (stored) setWorkspace(stored);
      hydrated.current = true;
      setSyncStatus(navigator.onLine ? "saved" : "offline");
    });
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    setSyncStatus(navigator.onLine ? "saving" : "offline");
    const timer = window.setTimeout(() => {
      void saveWorkspace({ ...workspace, lastSavedAt: new Date().toISOString() })
        .then(() => setSyncStatus(navigator.onLine ? "saved" : "offline"))
        .catch(() => setSyncStatus("offline"));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [workspace]);

  const selected = workspace.nodes.find((node) => node.id === workspace.selectedNodeId) ?? workspace.nodes[0];
  const selectedReadOnly = lockedNodeIds.includes(selected.id);
  const openTabs = openTabIds
    .map((id) => workspace.nodes.find((node) => node.id === id))
    .filter((node): node is ContentNode => Boolean(node));
  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return workspace.nodes.filter((node) => node.title.toLowerCase().includes(normalized)).slice(0, 12);
  }, [query, workspace.nodes]);
  const outlineItems = workspace.editorDocuments?.[selected.id]
    ? getDocumentOutline(workspace.editorDocuments[selected.id])
    : (workspace.blocks[selected.id] ?? []).filter((block) =>
        (block.kind === "heading1" || block.kind === "heading" || block.kind === "heading3") && block.content
      ).map((block) => ({ id: block.id, content: block.content ?? "" }));

  useEffect(() => {
    setCursorPosition({ line: 1, column: 1 });
  }, [selected.id]);

  useEffect(() => {
    const updateCursorPosition = () => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLTextAreaElement && activeElement.closest(".note-page")) {
        const beforeCursor = activeElement.value.slice(0, activeElement.selectionStart ?? 0);
        const lines = beforeCursor.split("\n");
        setCursorPosition({ line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 });
        return;
      }

      const selection = window.getSelection();
      if (!selection?.rangeCount || !selection.focusNode) return;
      const focusElement = selection.focusNode instanceof Element ? selection.focusNode : selection.focusNode.parentElement;
      const editable = focusElement?.closest<HTMLElement>('[contenteditable="true"]');
      if (!editable?.closest(".note-page")) return;

      const range = document.createRange();
      range.selectNodeContents(editable);
      try {
        range.setEnd(selection.focusNode, selection.focusOffset);
      } catch {
        return;
      }
      const lines = range.toString().split("\n");
      setCursorPosition({ line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 });
    };

    document.addEventListener("selectionchange", updateCursorPosition);
    document.addEventListener("keyup", updateCursorPosition, true);
    document.addEventListener("click", updateCursorPosition, true);
    return () => {
      document.removeEventListener("selectionchange", updateCursorPosition);
      document.removeEventListener("keyup", updateCursorPosition, true);
      document.removeEventListener("click", updateCursorPosition, true);
    };
  }, []);

  function toggleRightTool(tool: "info" | "outline" | "ai") {
    setRightTool((current) => current === tool ? null : tool);
  }

  function selectNode(id: string) {
    setWorkspace((current) => ({ ...current, selectedNodeId: id }));
    setOpenTabIds((current) => current.includes(id) ? current : [...current, id]);
  }

  function closeTab(id: string) {
    setOpenTabIds((current) => {
      const next = current.filter((tabId) => tabId !== id);
      if (workspace.selectedNodeId === id) {
        const nextSelected = next.at(-1) ?? workspace.nodes[0]?.id;
        if (nextSelected) setWorkspace((value) => ({ ...value, selectedNodeId: nextSelected }));
      }
      return next;
    });
  }

  function beginSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    document.body.classList.add("is-resizing");

    const handleMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(Math.min(480, Math.max(240, startWidth + moveEvent.clientX - startX)));
    };
    const handleUp = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  function updateSelectedNode(patch: Partial<ContentNode>) {
    setWorkspace((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === current.selectedNodeId ? { ...node, ...patch, updatedAt: "刚刚" } : node),
    }));
  }

  function updateBlock(blockId: string, content: string) {
    setWorkspace((current) => ({
      ...current,
      blocks: {
        ...current.blocks,
        [current.selectedNodeId]: (current.blocks[current.selectedNodeId] ?? []).map((block) =>
          block.id === blockId ? { ...block, content } : block,
        ),
      },
    }));
  }

  function updateDocument(pageId: string, document: unknown[]) {
    setWorkspace((current) => ({
      ...current,
      editorDocuments: { ...current.editorDocuments, [pageId]: document },
    }));
  }

  function updateBlockLanguage(blockId: string, language: string) {
    setWorkspace((current) => ({
      ...current,
      blocks: {
        ...current.blocks,
        [current.selectedNodeId]: (current.blocks[current.selectedNodeId] ?? []).map((block) =>
          block.id === blockId ? { ...block, language: normalizeCodeLanguage(language) } : block,
        ),
      },
    }));
  }

  function applyBlockCommand(blockId: string, command: BlockCommand, content: string, source: "plus" | "slash") {
    setWorkspace((current) => {
      const pageId = current.selectedNodeId;
      const blocks = [...(current.blocks[pageId] ?? [])];
      const index = blocks.findIndex((block) => block.id === blockId);
      if (index < 0) return current;

      const isEmbedded = command.kind === "folder" || command.kind === "file";
      const shouldInsert = (source === "plus" && content.trim().length > 0) || (isEmbedded && content.trim().length > 0);
      const newId = () => `block-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const nextBlock: NoteBlock = isEmbedded
        ? { id: shouldInsert ? newId() : blockId, kind: command.kind, targetNodeId: command.targetNodeId }
        : { id: shouldInsert ? newId() : blockId, kind: command.kind, content, ...(command.kind === "code" ? { language: command.language ?? "plaintext" } : {}) };

      if (shouldInsert) blocks.splice(index + 1, 0, nextBlock);
      else blocks[index] = nextBlock;

      if (isEmbedded) {
        blocks.splice(shouldInsert ? index + 2 : index + 1, 0, { id: newId(), kind: "text", content: "" });
      }

      return { ...current, blocks: { ...current.blocks, [pageId]: blocks } };
    });
  }

  function splitBlock(blockId: string, nextId: string, content: string, nextContent: string, nextKind: NoteBlock["kind"]) {
    setWorkspace((current) => {
      const pageId = current.selectedNodeId;
      const blocks = [...(current.blocks[pageId] ?? [])];
      const index = blocks.findIndex((block) => block.id === blockId);
      if (index < 0) return current;
      blocks[index] = { ...blocks[index], content };
      blocks.splice(index + 1, 0, { id: nextId, kind: nextKind, content: nextContent });
      return { ...current, blocks: { ...current.blocks, [pageId]: blocks } };
    });
  }

  function deleteBlock(blockId: string) {
    setWorkspace((current) => {
      const pageId = current.selectedNodeId;
      const blocks = current.blocks[pageId] ?? [];
      if (blocks.length <= 1) return current;
      return {
        ...current,
        blocks: { ...current.blocks, [pageId]: blocks.filter((block) => block.id !== blockId) },
      };
    });
  }

  function createPage() {
    const parentId = selected.kind === "folder" ? selected.id : selected.parentId;
    createNode("page", parentId);
  }

  function createNode(kind: "page" | "folder", parentId: string | null) {
    const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setWorkspace((current) => ({
      ...current,
      selectedNodeId: id,
      nodes: [...current.nodes, {
        id,
        parentId,
        kind,
        title: kind === "folder" ? "新建文件夹" : "未命名页面",
        updatedAt: "刚刚",
      }],
      blocks: kind === "page" ? { ...current.blocks, [id]: [{ id: `${id}-block`, kind: "text", content: "" }] } : current.blocks,
    }));
    setOpenTabIds((current) => [...current, id]);
  }

  function renameNode(id: string, title: string) {
    if (!title) return;
    setWorkspace((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === id ? { ...node, title, updatedAt: "刚刚" } : node),
    }));
  }

  function moveNodes(ids: string[], parentId: string | null, index: number) {
    setWorkspace((current) => {
      const movingIds = new Set(ids);
      const moving = ids
        .map((id) => current.nodes.find((node) => node.id === id))
        .filter((node): node is ContentNode => Boolean(node))
        .map((node) => ({ ...node, parentId, updatedAt: "刚刚" }));
      const remaining = current.nodes.filter((node) => !movingIds.has(node.id));
      const siblings = remaining.filter((node) => node.parentId === parentId);
      const anchor = siblings[index];
      const insertionPoint = anchor
        ? remaining.findIndex((node) => node.id === anchor.id)
        : siblings.length > 0
          ? remaining.findIndex((node) => node.id === siblings.at(-1)?.id) + 1
          : parentId
            ? remaining.findIndex((node) => node.id === parentId) + 1
            : remaining.length;
      const nextNodes = [...remaining];
      nextNodes.splice(Math.max(0, insertionPoint), 0, ...moving);
      return { ...current, nodes: nextNodes };
    });
  }

  function deleteNodes(ids: string[]) {
    const roots = new Set(ids);
    const allIds = new Set(ids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of workspace.nodes) {
        if (node.parentId && allIds.has(node.parentId) && !allIds.has(node.id)) {
          allIds.add(node.id);
          changed = true;
        }
      }
    }
    const names = workspace.nodes.filter((node) => roots.has(node.id)).map((node) => `“${node.title}”`).join("、");
    if (!window.confirm(`确定删除 ${names} 吗？文件夹内的内容也会被删除。`)) return;
    const fallbackId = `page-${Date.now()}-fallback`;
    const leavesWorkspaceEmpty = workspace.nodes.every((node) => allIds.has(node.id));

    setWorkspace((current) => {
      const remainingNodes = current.nodes.filter((node) => !allIds.has(node.id));
      const nodes = remainingNodes.length > 0 ? remainingNodes : [{
        id: fallbackId,
        parentId: null,
        kind: "page" as const,
        title: "未命名页面",
        updatedAt: "刚刚",
      }];
      const remainingBlocks = Object.fromEntries(Object.entries(current.blocks).filter(([id]) => !allIds.has(id)));
      const editorDocuments = Object.fromEntries(Object.entries(current.editorDocuments ?? {}).filter(([id]) => !allIds.has(id)));
      const blocks = remainingNodes.length > 0 ? remainingBlocks : {
        ...remainingBlocks,
        [fallbackId]: [{ id: `${fallbackId}-block`, kind: "text" as const, content: "" }],
      };
      const selectedNodeId = allIds.has(current.selectedNodeId) ? nodes[0]?.id ?? "" : current.selectedNodeId;
      return { ...current, nodes, blocks, editorDocuments, selectedNodeId };
    });
    setOpenTabIds((current) => {
      const remaining = current.filter((id) => !allIds.has(id));
      return leavesWorkspaceEmpty ? [fallbackId] : remaining;
    });
  }

  const syncCopy = syncStatus === "loading" ? "读取本地数据" : syncStatus === "saving" ? "正在保存" : syncStatus === "offline" ? "离线模式" : "已保存到本地";

  return (
    <div className="app-shell" style={{
      "--sidebar-width": primaryLeftTool || secondaryLeftTool ? `${sidebarWidth}px` : "0px",
      "--secondary-bottom-panel-height": secondaryBottomTool ? "220px" : "0px",
    } as React.CSSProperties}>
      <header className="window-titlebar" aria-label="窗口标题栏">
        <div className="titlebar-main" data-tauri-drag-region>
          <strong data-tauri-drag-region>HyperSpace - {selected.title}</strong>
        </div>
        <div className="ide-toolbar">
          <div className="breadcrumbs" aria-label="当前位置">
            <strong>HyperSpace</strong><ChevronRight size={13} /><span>{selected.kind === "page" ? "笔记" : selected.kind === "folder" ? "文件夹" : "文件"}</span><ChevronRight size={13} /><span>{selected.title}</span>
          </div>
          <div className="command-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} onFocus={() => setBottomTool("search")} placeholder="搜索工作空间" />
            <kbd><Command size={11} /> K</kbd>
          </div>
          <div className={`toolbar-sync ${syncStatus}`}><Cloud size={15} /><span>{syncCopy}</span></div>
          <button className="toolbar-primary" onClick={createPage}><Plus size={15} /> 新建页面</button>
          <button className="toolbar-icon" aria-label="更多操作"><MoreHorizontal size={18} /></button>
        </div>
      </header>

      <LeftActivityRail
        primaryActive={primaryLeftTool}
        secondaryActive={secondaryLeftTool}
        onPrimarySelect={setPrimaryLeftTool}
        onSecondarySelect={(tool) => setSecondaryLeftTool((current) => current === tool ? null : tool)}
      />

      {(primaryLeftTool || secondaryLeftTool) && (
        <aside className={`project-sidebar ${primaryLeftTool && secondaryLeftTool ? "with-secondary" : ""}`} style={{ width: sidebarWidth }}>
          {primaryLeftTool === "project" ? (
            <ProjectSidebar
              workspace={workspace}
              onSelect={selectNode}
              onCreatePage={createPage}
              onCreateNode={createNode}
              onRenameNode={renameNode}
              onMoveNodes={moveNodes}
              onDeleteNodes={deleteNodes}
              onClose={() => setPrimaryLeftTool(null)}
            />
          ) : primaryLeftTool ? (
            <ToolSidebar
              tool={primaryLeftTool}
              outlineItems={outlineItems}
              bookmarks={workspace.nodes.filter((node) => node.favorite)}
              onSelectNode={selectNode}
              onClose={() => setPrimaryLeftTool(null)}
            />
          ) : null}
          {secondaryLeftTool && (
            <ToolSidebar
              tool={secondaryLeftTool}
              outlineItems={outlineItems}
              bookmarks={workspace.nodes.filter((node) => node.favorite)}
              onSelectNode={selectNode}
              onClose={() => setSecondaryLeftTool(null)}
            />
          )}
          <div className="sidebar-resizer" onPointerDown={beginSidebarResize} title="拖拽调整宽度" />
        </aside>
      )}

      <main className="workspace">
        <div className="workspace-tabs" role="tablist" aria-label="打开的页面">
          {openTabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={tab.id === selected.id}
              className={`document-tab ${tab.id === selected.id ? "active" : ""}`}
              onClick={() => selectNode(tab.id)}
            >
              <NodeIcon node={tab} size={17} />
              <span>{tab.title}</span>
              <i
                role="button"
                aria-label={`关闭 ${tab.title}`}
                tabIndex={0}
                onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    closeTab(tab.id);
                  }
                }}
              ><X size={14} /></i>
            </button>
          ))}
          <div className="tabbar-spacer" data-tauri-drag-region />
          <button className="tabbar-action" aria-label="打开页面信息" onClick={() => toggleRightTool("info")}>
            <SlidersHorizontal size={16} />
          </button>
        </div>

        <div className={`workspace-content ${rightTool ? "with-details" : ""}`}>
          <section className="workspace-canvas" role="tabpanel">
            {openTabs.length === 0 ? (
              <div className="blank-workspace"><FileText size={34} /><p>从项目列表中选择一个页面</p></div>
            ) : selected.kind === "page" ? (
              <NoteView
                node={selected}
                workspace={workspace}
                readOnly={selectedReadOnly}
                onTitleChange={(title) => { if (!selectedReadOnly) updateSelectedNode({ title }); }}
                onDocumentChange={(document) => { if (!selectedReadOnly) updateDocument(selected.id, document); }}
              />
            ) : <EmptyView node={selected} />}
          </section>

          {rightTool && (
            <aside className="details-panel">
              <div className="details-header"><strong>{rightTool === "info" ? "页面信息" : rightTool === "outline" ? "页面大纲" : "AI 助手"}</strong><button onClick={() => setRightTool(null)} aria-label="关闭辅助面板"><X size={16} /></button></div>
              {rightTool === "info" && (
                <>
                  <dl className="property-list">
                    <div><dt><Hash size={14} /> 类型</dt><dd>{selected.kind === "page" ? "笔记" : selected.kind === "folder" ? "文件夹" : "文件"}</dd></div>
                    <div><dt><Clock3 size={14} /> 更新</dt><dd>{selected.updatedAt}</dd></div>
                    <div><dt><Users size={14} /> 访问</dt><dd>仅自己</dd></div>
                    <div><dt><Star size={14} /> 收藏</dt><dd><button className={selected.favorite ? "is-favorite" : ""} onClick={() => updateSelectedNode({ favorite: !selected.favorite })}>{selected.favorite ? "已收藏" : "添加"}</button></dd></div>
                  </dl>
                  <div className="activity-section">
                    <h3>动态</h3>
                    <div className="activity-item"><span className="mini-avatar">JL</span><p><strong>你</strong> 更新了此页面<small>刚刚</small></p></div>
                    <div className="activity-item system"><span><Cloud size={14} /></span><p>内容已保存到本地<small>自动保存</small></p></div>
                  </div>
                  <button className="help-link"><CircleHelp size={15} /> 本地数据如何工作？</button>
                </>
              )}
              {rightTool === "outline" && (
                <div className="outline-list">
                  {outlineItems.length > 0 ? outlineItems.map((item, index) => <button key={item.id}><Hash size={13} /><span>{item.content}</span><small>{index + 1}</small></button>) : <p>当前页面没有标题结构。</p>}
                </div>
              )}
              {rightTool === "ai" && (
                <div className="ai-card expanded">
                  <span className="ai-icon"><Sparkles size={17} /></span>
                  <div><strong>询问当前工作空间</strong><p>继续写作、总结当前页面，或从全部笔记和文件中寻找答案。</p></div>
                  <div className="ai-suggestions"><button>总结当前页面</button><button>提取待办事项</button><button>寻找相关内容</button></div>
                  <button className="ai-start">开始对话</button>
                </div>
              )}
            </aside>
          )}
        </div>

        {bottomTool && (
          <section className="bottom-panel" aria-label="底部工具窗口">
            <div className="bottom-panel-header">
              <strong>全局搜索</strong>
              <span>{searchResults.length} 个结果</span>
              <button onClick={() => setBottomTool(null)} aria-label="收起底部工具窗口" title="收起窗口"><Minus size={15} /></button>
            </div>
            <div className="bottom-panel-content">
              {query.trim() ? searchResults.map((node) => <button key={node.id} onClick={() => selectNode(node.id)}><NodeIcon node={node} /><span><strong>{node.title}</strong><small>{node.kind === "page" ? "笔记" : node.kind === "folder" ? "文件夹" : node.fileType}</small></span><ChevronRight size={14} /></button>) : <div className="tool-empty"><Search size={20} /><span>在顶部输入关键词搜索页面和文件</span></div>}
            </div>
          </section>
        )}
      </main>

      <RightActivityRail active={rightTool} onSelect={toggleRightTool} />

      {secondaryBottomTool && (
        <section className="secondary-bottom-panel" aria-label={`${secondaryBottomTool} 工具窗口`}>
          <div className="secondary-bottom-panel-header">
            {secondaryBottomTool === "git" ? <GitBranch size={15} /> : secondaryBottomTool === "terminal" ? <TerminalSquare size={15} /> : secondaryBottomTool === "todo" ? <ListTodo size={15} /> : <Server size={15} />}
            <strong>{secondaryBottomTool}</strong>
            <button type="button" onClick={() => setSecondaryBottomTool(null)} aria-label="收起扩展底部工具窗口" title="收起窗口"><Minus size={15} /></button>
          </div>
          <div className="secondary-bottom-panel-content">
            {secondaryBottomTool === "git" ? <GitBranch size={26} /> : secondaryBottomTool === "terminal" ? <TerminalSquare size={26} /> : secondaryBottomTool === "todo" ? <ListTodo size={26} /> : <Server size={26} />}
            <span>{secondaryBottomTool === "git" ? "暂无 Git 输出" : secondaryBottomTool === "terminal" ? "Terminal 已就绪" : secondaryBottomTool === "todo" ? "暂无待办事项" : "暂无运行中的服务"}</span>
          </div>
        </section>
      )}

      <nav className="bottom-secondary-tabs" aria-label="扩展底部工具">
        <button className={secondaryBottomTool === "git" ? "active" : ""} onClick={() => setSecondaryBottomTool((current) => current === "git" ? null : "git")} aria-pressed={secondaryBottomTool === "git"}><GitBranch size={14} /> git</button>
        <button className={secondaryBottomTool === "terminal" ? "active" : ""} onClick={() => setSecondaryBottomTool((current) => current === "terminal" ? null : "terminal")} aria-pressed={secondaryBottomTool === "terminal"}><TerminalSquare size={14} /> terminal</button>
        <button className={secondaryBottomTool === "todo" ? "active" : ""} onClick={() => setSecondaryBottomTool((current) => current === "todo" ? null : "todo")} aria-pressed={secondaryBottomTool === "todo"}><ListTodo size={14} /> todo</button>
        <button className={secondaryBottomTool === "services" ? "active" : ""} onClick={() => setSecondaryBottomTool((current) => current === "services" ? null : "services")} aria-pressed={secondaryBottomTool === "services"}><Server size={14} /> services</button>
        <span />
      </nav>

      <footer className="statusbar">
        <span className={`status-dot ${syncStatus}`} />
        <span>{syncCopy}</span>
        <span>HyperSpace</span>
        <span className="statusbar-spacer" />
        <span>{selected.kind === "page" ? "笔记" : selected.kind === "folder" ? "文件夹" : selected.fileType ?? "文件"}</span>
        <span>UTF-8</span>
        <span>行 {cursorPosition.line}, 字符 {cursorPosition.column}</span>
        <span>LF</span>
        <span className="statusbar-branch"><GitBranch size={13} /> master</span>
        <button
          className={`statusbar-lock ${selectedReadOnly ? "locked" : ""}`}
          type="button"
          disabled={selected.kind !== "page"}
          aria-label={selectedReadOnly ? "解除当前内容只读" : "将当前内容设为只读"}
          aria-pressed={selectedReadOnly}
          title={selectedReadOnly ? "解除只读" : "设为只读"}
          onClick={() => setLockedNodeIds((current) => selectedReadOnly ? current.filter((id) => id !== selected.id) : [...current, selected.id])}
        >
          {selectedReadOnly ? <Lock size={13} /> : <LockOpen size={13} />}
        </button>
      </footer>
    </div>
  );
}

export default App;
