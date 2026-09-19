import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import projectIcon from "./assets/icons/project.svg";
import structureOverviewIcon from "./assets/icons/structure-overview.svg";
import {
  Bell,
  Bookmark,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Cloud,
  Code2,
  File,
  Files,
  FileSpreadsheet,
  FileText,
  FileUp,
  Folder,
  FolderOpen,
  FoldVertical,
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
  LocateFixed,
  Lock,
  LockOpen,
  MessageSquareText,
  Minus,
  MoreHorizontal,
  MoreVertical,
  Paperclip,
  Plus,
  Quote,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tag,
  TerminalSquare,
  Text,
  UnfoldVertical,
  Users,
  X,
} from "lucide-react";
import { createBlankWorkspace, initialWorkspace } from "./data";
import { FileTree } from "./FileTree";
import type { FileTreeHandle } from "./FileTree";
import { TerminalPanel } from "./TerminalPanel";
import { PROJECT_CREATED_EVENT, type ProjectCreatedPayload } from "./NewProjectDialog";
import {
  commitAll,
  getCurrentProject,
  getGitRepositoryInfo,
  importPdf,
  loadWorkspace,
  openProject,
  projectNameFromPath,
  saveWorkspace,
  searchWorkspace,
  type GitRepositoryInfo,
  type WorkspaceSearchResult,
} from "./storage";
import type { ContentNode, MarkerColor, NoteBlock, TagDefinition, WorkspaceState } from "./types";

type SyncStatus = "loading" | "saved" | "saving" | "offline";
type PrimaryLeftTool = "project" | "commit" | "pullRequests";
type SecondaryLeftTool = "structure" | "bookmarks";
type BottomTool = "search";
type SecondaryBottomTool = "git" | "terminal" | "todo" | "services";
type RightTool = "notifications" | "references" | "ai";

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

const emptyGitInfo: GitRepositoryInfo = {
  gitAvailable: false,
  isRepository: false,
  lfsAvailable: false,
  branch: "",
  changes: [],
  history: [],
};

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

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
  treeSelectedId,
  activeNodeId,
  projectName,
  projectPath,
  onSelect,
  onRevealActive,
  onCreatePage,
  onCreateNode,
  onRenameNode,
  onSetNodeMarkerColor,
  onSetNodeTags,
  onCreateTag,
  onDeleteTag,
  onMoveNodes,
  onDeleteNodes,
  onClose,
}: {
  workspace: WorkspaceState;
  treeSelectedId: string;
  activeNodeId: string;
  projectName: string;
  projectPath: string | null;
  onSelect: (id: string) => void;
  onRevealActive: () => void;
  onCreatePage: () => void;
  onCreateNode: (kind: "page" | "folder", parentId: string | null) => void;
  onRenameNode: (id: string, title: string) => void;
  onSetNodeMarkerColor: (id: string, color?: MarkerColor) => void;
  onSetNodeTags: (id: string, tagIds: string[]) => void;
  onCreateTag: (nodeId: string, name: string) => void;
  onDeleteTag: (tagId: string) => void;
  onMoveNodes: (ids: string[], parentId: string | null, index: number) => void;
  onDeleteNodes: (ids: string[]) => void;
  onClose: () => void;
}) {
  const fileTreeRef = useRef<FileTreeHandle>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [treeFilter, setTreeFilter] = useState<"notes" | "files" | null>(null);
  const [tagFilterIds, setTagFilterIds] = useState<string[]>([]);

  useEffect(() => {
    if (!filterMenuOpen) return;

    const closeMenu = (event: MouseEvent) => {
      if (filterMenuRef.current?.contains(event.target as Node)) return;
      setFilterMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterMenuOpen(false);
    };

    window.addEventListener("mousedown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [filterMenuOpen]);

  function toggleTreeFilter(filter: Exclude<typeof treeFilter, null>) {
    setTreeFilter((current) => current === filter ? null : filter);
    setFilterMenuOpen(false);
  }

  function toggleTagFilter(tagId: string) {
    setTagFilterIds((current) => current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId]);
  }

  useEffect(() => {
    const availableTagIds = new Set((workspace.tags ?? []).map((tag) => tag.id));
    setTagFilterIds((current) => current.filter((id) => availableTagIds.has(id)));
  }, [workspace.tags]);

  return (
    <section className="sidebar-pane primary">
      <div className="panel-header project-panel-header">
        <div className="project-filter-control" ref={filterMenuRef}>
          <button
            className={`project-filter-trigger ${filterMenuOpen ? "open" : ""}`}
            type="button"
            aria-label="筛选 Project 文件树"
            aria-haspopup="menu"
            aria-expanded={filterMenuOpen}
            onClick={() => setFilterMenuOpen((open) => !open)}
          >
            <img className="project-panel-icon" src={projectIcon} alt="" aria-hidden="true" />
            <strong>Project</strong>
            {tagFilterIds.length > 0 && <span className="project-filter-count">{tagFilterIds.length}</span>}
            <ChevronDown size={14} />
          </button>
          {filterMenuOpen && (
            <div className="project-filter-menu" role="menu" aria-label="Project 展示筛选">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={treeFilter === "notes"}
                onClick={() => toggleTreeFilter("notes")}
              >
                <span className="project-filter-check">{treeFilter === "notes" && <Check size={13} />}</span>
                <FileText size={14} />
                仅展示笔记
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={treeFilter === "files"}
                onClick={() => toggleTreeFilter("files")}
              >
                <span className="project-filter-check">{treeFilter === "files" && <Check size={13} />}</span>
                <File size={14} />
                仅展示文件
              </button>
              {(workspace.tags?.length ?? 0) > 0 && (
                <>
                  <span className="project-filter-separator" />
                  <div className="project-filter-section-title"><Tag size={12} />按标签筛选</div>
                  <div className="project-tag-filters">
                    {workspace.tags?.map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={tagFilterIds.includes(tag.id)}
                        onClick={() => toggleTagFilter(tag.id)}
                      >
                        <span className="project-filter-check">{tagFilterIds.includes(tag.id) && <Check size={13} />}</span>
                        <span>{tag.name}</span>
                      </button>
                    ))}
                  </div>
                  {tagFilterIds.length > 0 && (
                    <button className="project-filter-clear" type="button" onClick={() => setTagFilterIds([])}>
                      <X size={12} />清除标签筛选
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        <div className="panel-header-actions">
          <button
            aria-label="选中打开的文件"
            title="选中打开的文件"
            onClick={() => {
              onRevealActive();
              fileTreeRef.current?.revealNode(activeNodeId);
            }}
          ><LocateFixed size={15} /></button>
          <button aria-label="展开所有目录" title="展开所有目录" onClick={() => fileTreeRef.current?.expandAll()}><UnfoldVertical size={15} /></button>
          <button aria-label="收起所有目录" title="收起所有目录" onClick={() => fileTreeRef.current?.collapseAll()}><FoldVertical size={15} /></button>
          <button aria-label="新建页面" onClick={onCreatePage}><Plus size={15} /></button>
          <button aria-label="收起 Project 窗口" title="收起窗口" onClick={onClose}><Minus size={15} /></button>
        </div>
      </div>
      <FileTree
        ref={fileTreeRef}
        nodes={workspace.nodes}
        selectedId={treeSelectedId}
        projectName={projectName}
        projectPath={projectPath}
        filter={treeFilter}
        tagFilterIds={tagFilterIds}
        tags={workspace.tags ?? []}
        onSelect={onSelect}
        onCreate={onCreateNode}
        onRename={onRenameNode}
        onSetMarkerColor={onSetNodeMarkerColor}
        onSetTags={onSetNodeTags}
        onCreateTag={onCreateTag}
        onDeleteTag={onDeleteTag}
        onMove={onMoveNodes}
        onDelete={onDeleteNodes}
      />
    </section>
  );
}

function ToolSidebar({ tool, outlineItems, bookmarks, gitInfo, gitLoading, onRefreshGit, onSelectNode, onClose }: {
  tool: Exclude<PrimaryLeftTool, "project"> | SecondaryLeftTool;
  outlineItems: { id: string; content: string }[];
  bookmarks: ContentNode[];
  gitInfo?: GitRepositoryInfo;
  gitLoading?: boolean;
  onRefreshGit?: () => void;
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
  const isCommit = tool === "commit";
  const panePosition = tool === "structure" || tool === "bookmarks" ? "secondary" : "primary";
  return (
    <section className={`sidebar-pane ${panePosition}`}>
      <div className="panel-header">
        {config.icon}
        <strong>{config.title}</strong>
        <button aria-label={`收起 ${config.title} 窗口`} title="收起窗口" onClick={onClose}><Minus size={15} /></button>
      </div>
      {isCommit ? (
        <div className="git-sidebar-details">
          <div className="git-capability-row">
            <span>{gitInfo?.isRepository ? gitInfo.branch || "HEAD" : "未启用 Git"}</span>
            <button type="button" onClick={onRefreshGit} disabled={gitLoading} title="刷新 Git 状态"><RefreshCw size={13} /></button>
          </div>
          {!gitInfo?.gitAvailable ? (
            <div className="git-sidebar-content"><GitBranch size={24} /><span>未检测到 Git</span></div>
          ) : !gitInfo.isRepository ? (
            <div className="git-sidebar-content"><GitBranch size={24} /><span>当前项目尚未启用 Git</span></div>
          ) : gitInfo.changes.length > 0 ? (
            <div className="git-change-list">
              {gitInfo.changes.map((change, index) => (
                <div key={`${change.path}-${index}`}><code>{change.status}</code><span>{change.path}</span></div>
              ))}
            </div>
          ) : (
            <div className="git-sidebar-content"><Check size={24} /><span>工作树干净</span></div>
          )}
        </div>
      ) : hasStructure ? (
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
      <button className={`pull-requests-button ${primaryActive === "pullRequests" ? "active" : ""}`} onClick={() => onPrimarySelect("pullRequests")} aria-label="PullRequests" aria-pressed={primaryActive === "pullRequests"}>
        <span>PullRequests</span><GitPullRequest size={18} strokeWidth={1.5} />
      </button>
      <div className="activity-rail-bottom">
        <button className={secondaryActive === "structure" ? "active" : ""} onClick={() => onSecondarySelect("structure")} aria-label="Structure" aria-pressed={secondaryActive === "structure"}>
          <span>Structure</span><img className="activity-menu-icon structure-menu-icon" src={structureOverviewIcon} alt="" aria-hidden="true" />
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
  active: RightTool | null;
  onSelect: (tool: RightTool) => void;
}) {
  return (
    <nav className="activity-rail right" aria-label="辅助工具栏">
      <button className={active === "notifications" ? "active" : ""} onClick={() => onSelect("notifications")} aria-label="Notification" aria-pressed={active === "notifications"}>
        <Bell size={18} strokeWidth={1.5} /><span>Notification</span>
      </button>
      <button className={`referenced-files-button ${active === "references" ? "active" : ""}`} onClick={() => onSelect("references")} aria-label="Referenced Files" aria-pressed={active === "references"}>
        <Files size={18} strokeWidth={1.5} /><span>Referenced Files</span>
      </button>
      <button className={active === "ai" ? "active" : ""} onClick={() => onSelect("ai")} aria-label="AI Chat" aria-pressed={active === "ai"}>
        <Bot size={18} strokeWidth={1.5} /><span>AI Chat</span>
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
  onActiveBlockChange,
}: {
  node: ContentNode;
  workspace: WorkspaceState;
  readOnly: boolean;
  onTitleChange: (title: string) => void;
  onDocumentChange: (document: unknown[], markdown: string) => void;
  onActiveBlockChange?: (blockId: string | null) => void;
}) {
  return (
    <article className={`note-page ${readOnly ? "read-only" : ""}`}>
      <div className="note-title-row">
        <h1
          contentEditable={!readOnly}
          aria-readonly={readOnly}
          suppressContentEditableWarning
          onBlur={(event) => onTitleChange(event.currentTarget.textContent?.trim() || "未命名")}
        >{node.title}</h1>
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
            onActiveBlockChange={onActiveBlockChange}
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
      <p>{node.kind === "folder" ? "在这个文件夹中创建笔记或添加文件。" : node.localPath || "该文件将在桌面端安全打开。"}</p>
      {node.kind === "file" && node.fileType === "PDF" && (
        <small>{node.lfsTracked ? "Git LFS 已跟踪" : "本地文件（未启用 Git LFS）"}</small>
      )}
      <button><Plus size={16} /> 新建内容</button>
    </div>
  );
}

function getBlockPlainText(content: unknown) {
  if (Array.isArray(content)) {
    return content.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "").join("");
  }
  return typeof content === "string" ? content : "";
}

function getDocumentOutline(document: unknown[] | undefined) {
  if (!document) return [];
  const items: { id: string; content: string }[] = [];
  const visit = (blocks: unknown[]) => {
    for (const value of blocks) {
      if (!value || typeof value !== "object") continue;
      const block = value as { id?: unknown; type?: unknown; content?: unknown; children?: unknown };
      if (block.type === "heading") {
        const content = getBlockPlainText(block.content);
        if (content) items.push({ id: typeof block.id === "string" ? block.id : `heading-${items.length}`, content });
      }
      if (Array.isArray(block.children)) visit(block.children);
    }
  };
  visit(document);
  return items;
}

function getCanvasPathForBlock(document: unknown[] | undefined, activeBlockId: string | null) {
  if (!document || !activeBlockId) return [];

  type HeadingCrumb = { id: string; content: string; level: number };
  let headings: HeadingCrumb[] = [];
  let result: { id: string; content: string }[] = [];
  let found = false;

  const visit = (blocks: unknown[]) => {
    for (const value of blocks) {
      if (found || !value || typeof value !== "object") continue;
      const block = value as {
        id?: unknown;
        type?: unknown;
        content?: unknown;
        children?: unknown;
        props?: { level?: unknown };
      };
      const blockId = typeof block.id === "string" ? block.id : null;

      if (block.type === "heading") {
        const level = typeof block.props?.level === "number" ? block.props.level : 1;
        const content = getBlockPlainText(block.content);
        headings = headings.filter((item) => item.level < level);
        if (content) {
          headings = [...headings, { id: blockId ?? `heading-${headings.length}`, content, level }];
        }
      }

      if (blockId === activeBlockId) {
        result = headings.map(({ id, content }) => ({ id, content }));
        found = true;
        return;
      }

      if (Array.isArray(block.children)) visit(block.children);
    }
  };

  visit(document);
  return result;
}


function getHeadingSiblings(document: unknown[] | undefined, headingId: string) {
  if (!document) return [];

  type HeadingItem = { id: string; content: string; level: number; parentId: string | null };
  const headings: HeadingItem[] = [];
  let stack: HeadingItem[] = [];

  const visit = (blocks: unknown[]) => {
    for (const value of blocks) {
      if (!value || typeof value !== "object") continue;
      const block = value as {
        id?: unknown;
        type?: unknown;
        content?: unknown;
        children?: unknown;
        props?: { level?: unknown };
      };
      if (block.type === "heading") {
        const level = typeof block.props?.level === "number" ? block.props.level : 1;
        const content = getBlockPlainText(block.content);
        const id = typeof block.id === "string" ? block.id : `heading-${headings.length}`;
        stack = stack.filter((item) => item.level < level);
        const item = { id, content, level, parentId: stack.at(-1)?.id ?? null };
        if (content) headings.push(item);
        stack = [...stack, item];
      }
      if (Array.isArray(block.children)) visit(block.children);
    }
  };

  visit(document);
  const target = headings.find((item) => item.id === headingId);
  if (!target) return [];
  return headings
    .filter((item) => item.level === target.level && item.parentId === target.parentId)
    .map(({ id, content }) => ({ id, content }));
}

function focusCanvasBlock(blockId: string) {
  const selectors = [
    `.bn-block-outer[data-id="${blockId}"]`,
    `[data-id="${blockId}"]`,
    `#${CSS.escape(blockId)}`,
  ];
  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) {
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
  }
}


function WorkspaceTabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onOpenInfo,
}: {
  tabs: ContentNode[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onOpenInfo: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const overflowRef = useRef<HTMLDivElement>(null);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const actionWidth = 36;
      const spacerMin = 20;
      const overflowBtnWidth = 28;
      const widths = tabs.map((tab) => measureRefs.current.get(tab.id)?.offsetWidth ?? 120);
      const total = widths.reduce((sum, width) => sum + width, 0);
      const baseAvailable = Math.max(0, container.clientWidth - actionWidth - spacerMin);
      const needsOverflow = total > baseAvailable + 0.5;
      const available = Math.max(0, baseAvailable - (needsOverflow ? overflowBtnWidth : 0));

      const ids = tabs.map((tab) => tab.id);
      const widthOf = Object.fromEntries(ids.map((id, index) => [id, widths[index]]));
      let visible: string[] = [];
      let used = 0;
      for (const id of ids) {
        const width = widthOf[id] ?? 120;
        if (used + width <= available + 0.5) {
          visible.push(id);
          used += width;
        } else {
          break;
        }
      }

      if (activeId && ids.includes(activeId) && !visible.includes(activeId)) {
        visible.push(activeId);
        used += widthOf[activeId] ?? 120;
        while (visible.length > 1 && used > available + 0.5) {
          const removed = visible.shift();
          if (!removed || removed === activeId) {
            if (removed) visible.unshift(removed);
            break;
          }
          used -= widthOf[removed] ?? 120;
        }
        visible = ids.filter((id) => visible.includes(id));
      }

      const nextHidden = ids.filter((id) => !visible.includes(id));
      setHiddenIds((current) => {
        if (current.length === nextHidden.length && current.every((id, index) => id === nextHidden[index])) {
          return current;
        }
        return nextHidden;
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [tabs, activeId]);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!overflowRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    setMenuOpen(false);
  }, [activeId, tabs.length]);

  const hiddenSet = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const hiddenTabs = useMemo(
    () => tabs.filter((tab) => hiddenSet.has(tab.id)),
    [tabs, hiddenSet],
  );

  return (
    <div className="workspace-tabs" ref={containerRef} role="tablist" aria-label="打开的页面">
      <div className="workspace-tabs-measure" aria-hidden="true">
        {tabs.map((tab) => (
          <button
            key={`measure-${tab.id}`}
            ref={(element) => {
              if (element) measureRefs.current.set(tab.id, element);
              else measureRefs.current.delete(tab.id);
            }}
            className="document-tab"
            tabIndex={-1}
            type="button"
          >
            <NodeIcon node={tab} size={15} />
            <span>{tab.title}</span>
            <i><X size={11} /></i>
          </button>
        ))}
      </div>

      {tabs.map((tab) => {
        if (hiddenSet.has(tab.id)) return null;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={tab.id === activeId}
            className={`document-tab ${tab.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(tab.id)}
          >
            <NodeIcon node={tab} size={15} />
            <span>{tab.title}</span>
            <i
              role="button"
              aria-label={`关闭 ${tab.title}`}
              tabIndex={0}
              onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onClose(tab.id);
                }
              }}
            ><X size={11} /></i>
          </button>
        );
      })}

      <div className="tabbar-spacer" data-tauri-drag-region />

      {hiddenTabs.length > 0 && (
        <div className="tab-overflow" ref={overflowRef}>
          <button
            type="button"
            className={`tab-overflow-button ${menuOpen ? "open" : ""}`}
            aria-label="更多页签"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((current) => !current)}
          >
            <ChevronDown size={14} />
          </button>
          {menuOpen && (
            <div className="tab-overflow-menu" role="menu" aria-label="被隐藏的页签">
              {hiddenTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="menuitem"
                  className={tab.id === activeId ? "active" : ""}
                  onClick={() => {
                    onSelect(tab.id);
                    setMenuOpen(false);
                  }}
                >
                  <NodeIcon node={tab} size={14} />
                  <span>{tab.title}</span>
                  <i
                    role="button"
                    aria-label={`关闭 ${tab.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onClose(tab.id);
                    }}
                  ><X size={12} /></i>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <button type="button" className="tabbar-action" aria-label="更多操作" onClick={onOpenInfo}>
        <MoreVertical size={16} />
      </button>
    </div>
  );
}


type BreadcrumbSibling = {
  id: string;
  label: string;
  kind: "node" | "heading";
};

type BreadcrumbSegment = {
  key: string;
  label: string;
  currentId?: string;
  siblings: BreadcrumbSibling[];
};

function PathBreadcrumbs({
  selected,
  nodes,
  projectName,
  canvasPath,
  editorDocument,
  onSelectNode,
  onSelectHeading,
}: {
  selected: ContentNode;
  nodes: ContentNode[];
  projectName: string;
  canvasPath: { id: string; content: string }[];
  editorDocument: unknown[] | undefined;
  onSelectNode: (id: string) => void;
  onSelectHeading: (id: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const segments = useMemo<BreadcrumbSegment[]>(() => {
    const rootNodes = nodes.filter((node) => node.parentId === null);
    const kindLabel = selected.kind === "page" ? "笔记" : selected.kind === "folder" ? "文件夹" : "文件";
    const kindNodes = nodes.filter((node) => node.kind === selected.kind);
    const peerNodes = nodes.filter((node) => node.parentId === selected.parentId);

    const items: BreadcrumbSegment[] = [
      {
        key: "root",
        label: projectName,
        siblings: rootNodes.map((node) => ({ id: node.id, label: node.title, kind: "node" })),
      },
      {
        key: "kind",
        label: kindLabel,
        currentId: selected.id,
        siblings: kindNodes.map((node) => ({ id: node.id, label: node.title, kind: "node" })),
      },
      {
        key: `node-${selected.id}`,
        label: selected.title,
        currentId: selected.id,
        siblings: peerNodes.map((node) => ({ id: node.id, label: node.title, kind: "node" })),
      },
    ];

    for (const crumb of canvasPath) {
      items.push({
        key: `heading-${crumb.id}`,
        label: crumb.content,
        currentId: crumb.id,
        siblings: getHeadingSiblings(editorDocument, crumb.id).map((item) => ({
          id: item.id,
          label: item.content,
          kind: "heading",
        })),
      });
    }

    return items;
  }, [selected, nodes, projectName, canvasPath, editorDocument]);

  useEffect(() => {
    if (!openKey) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenKey(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenKey(null);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openKey]);

  useEffect(() => {
    setOpenKey(null);
  }, [selected.id, canvasPath.map((item) => item.id).join("/")]);

  return (
    <div className="breadcrumbs" ref={rootRef} aria-label="当前位置">
      {segments.map((segment, index) => (
        <Fragment key={segment.key}>
          {index > 0 && <ChevronRight size={13} />}
          <div className={`breadcrumb-item ${openKey === segment.key ? "open" : ""}`}>
            <button
              type="button"
              className={`breadcrumb-trigger ${segment.key === "root" ? "is-root" : ""}`}
              aria-haspopup="menu"
              aria-expanded={openKey === segment.key}
              onClick={() => setOpenKey((current) => current === segment.key ? null : segment.key)}
            >
              <span>{segment.label}</span>
            </button>
            {openKey === segment.key && (
              <div className="breadcrumb-menu" role="menu" aria-label={`${segment.label} 同级内容`}>
                {segment.siblings.length === 0 ? (
                  <div className="breadcrumb-menu-empty">暂无同级内容</div>
                ) : (
                  segment.siblings.map((sibling) => {
                    const node = sibling.kind === "node"
                      ? nodes.find((item) => item.id === sibling.id)
                      : undefined;
                    return (
                      <button
                        key={sibling.id}
                        type="button"
                        role="menuitem"
                        className={sibling.id === segment.currentId ? "active" : ""}
                        onClick={() => {
                          if (sibling.kind === "heading") onSelectHeading(sibling.id);
                          else onSelectNode(sibling.id);
                          setOpenKey(null);
                        }}
                      >
                        {sibling.kind === "heading" ? (
                          <Hash size={13} />
                        ) : node ? (
                          <NodeIcon node={node} size={13} />
                        ) : (
                          <FileText size={13} />
                        )}
                        <span>{sibling.label}</span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </Fragment>
      ))}
    </div>
  );
}


const OPEN_FOLDER_REQUESTED_EVENT = "open-folder-requested";

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(cloneInitial);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("loading");
  const [rightTool, setRightTool] = useState<RightTool | null>(null);
  const [bottomTool, setBottomTool] = useState<BottomTool | null>(null);
  const [secondaryBottomTool, setSecondaryBottomTool] = useState<SecondaryBottomTool | null>(null);
  const [query, setQuery] = useState("");
  const [lockedNodeIds, setLockedNodeIds] = useState<string[]>([]);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [primaryLeftTool, setPrimaryLeftTool] = useState<PrimaryLeftTool | null>("project");
  const [secondaryLeftTool, setSecondaryLeftTool] = useState<SecondaryLeftTool | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(316);
  const [openTabIds, setOpenTabIds] = useState<string[]>([initialWorkspace.selectedNodeId]);
  const [treeSelectedId, setTreeSelectedId] = useState(initialWorkspace.selectedNodeId);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [gitInfo, setGitInfo] = useState<GitRepositoryInfo>(emptyGitInfo);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [indexedSearchResults, setIndexedSearchResults] = useState<WorkspaceSearchResult[] | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    void loadWorkspace().then((stored) => {
      if (stored) {
        setWorkspace(stored);
        setTreeSelectedId(stored.selectedNodeId);
        setOpenTabIds([stored.selectedNodeId]);
      }
      hydrated.current = true;
      setSyncStatus(navigator.onLine ? "saved" : "offline");
    });

    void getCurrentProject()
      .then((path) => {
        if (path) setProjectPath(path);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/event").then(({ listen }) => {
      if (disposed) return;
      return listen(OPEN_FOLDER_REQUESTED_EVENT, async () => {
        const { message, open } = await import("@tauri-apps/plugin-dialog");
        try {
          const selectedPath = await open({
            directory: true,
            multiple: false,
            title: "Open Folder",
          });
          if (typeof selectedPath !== "string" || !selectedPath) return;

          const openedWorkspace = await openProject(selectedPath);
          const fallbackWorkspace = createBlankWorkspace(projectNameFromPath(selectedPath));
          handleProjectOpened(openedWorkspace ?? fallbackWorkspace, selectedPath);
        } catch (error) {
          await message(error instanceof Error ? error.message : String(error), {
            title: "Unable to Open Folder",
            kind: "error",
          });
        }
      }).then((stop) => {
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
      });
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/event").then(({ listen }) => {
      if (disposed) return;
      return listen<ProjectCreatedPayload>(PROJECT_CREATED_EVENT, (event) => {
        handleProjectCreated(event.payload.workspace, event.payload.path);
      }).then((stop) => {
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
      });
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
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

  useEffect(() => {
    if (!projectPath || !("__TAURI_INTERNALS__" in window)) {
      setGitInfo(emptyGitInfo);
      return;
    }
    let cancelled = false;
    setGitLoading(true);
    void getGitRepositoryInfo()
      .then((info) => {
        if (!cancelled) {
          setGitInfo(info);
          setGitError(info.error ?? null);
        }
      })
      .catch((error) => { if (!cancelled) setGitError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!cancelled) setGitLoading(false); });
    return () => { cancelled = true; };
  }, [projectPath, primaryLeftTool, secondaryBottomTool]);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      setIndexedSearchResults([]);
      return;
    }
    if (!("__TAURI_INTERNALS__" in window) || !projectPath) {
      setIndexedSearchResults(null);
      return;
    }
    let cancelled = false;
    setIndexedSearchResults(null);
    const timer = window.setTimeout(() => {
      void searchWorkspace(normalized, 20)
        .then((results) => { if (!cancelled) setIndexedSearchResults(results); })
        .catch(() => { if (!cancelled) setIndexedSearchResults([]); });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [projectPath, query, workspace.lastSavedAt]);

  const selected = workspace.nodes.find((node) => node.id === workspace.selectedNodeId) ?? workspace.nodes[0];
  const selectedReadOnly = lockedNodeIds.includes(selected.id);
  const projectName = projectNameFromPath(projectPath);
  const openTabs = openTabIds
    .map((id) => workspace.nodes.find((node) => node.id === id))
    .filter((node): node is ContentNode => Boolean(node));
  const fallbackSearchResults = useMemo<WorkspaceSearchResult[]>(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const tagsById = new Map((workspace.tags ?? []).map((tag) => [tag.id, tag]));
    return workspace.nodes.flatMap((node) => {
      const markdown = workspace.noteMarkdown?.[node.id] ?? "";
      const matches = node.title.toLowerCase().includes(normalized) ||
        markdown.toLowerCase().includes(normalized) ||
        node.tagIds?.some((tagId) => tagsById.get(tagId)?.name.toLowerCase().includes(normalized));
      return matches ? [{
        nodeId: node.id,
        title: node.title,
        kind: node.kind,
        fileType: node.fileType,
        path: node.localPath ?? "",
        snippet: markdown.slice(0, 120),
        score: node.title.toLowerCase().includes(normalized) ? 60 : 20,
      }] : [];
    }).slice(0, 20);
  }, [query, workspace.nodes, workspace.noteMarkdown, workspace.tags]);
  const searchResults = indexedSearchResults ?? fallbackSearchResults;
  const outlineItems = workspace.editorDocuments?.[selected.id]
    ? getDocumentOutline(workspace.editorDocuments[selected.id])
    : (workspace.blocks[selected.id] ?? []).filter((block) =>
        (block.kind === "heading1" || block.kind === "heading" || block.kind === "heading3") && block.content
      ).map((block) => ({ id: block.id, content: block.content ?? "" }));
  const canvasPath = selected.kind === "page"
    ? getCanvasPathForBlock(workspace.editorDocuments?.[selected.id], activeBlockId)
    : [];

  useEffect(() => {
    setCursorPosition({ line: 1, column: 1 });
    setActiveBlockId(null);
  }, [selected.id]);

  useEffect(() => {
    const title = `${projectName} - ${selected.title}`;
    document.title = title;
    if (!("__TAURI_INTERNALS__" in window)) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      void getCurrentWindow().setTitle(title);
    }).catch(() => undefined);
  }, [projectName, selected.title]);

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

  function toggleRightTool(tool: RightTool) {
    setRightTool((current) => current === tool ? null : tool);
  }

  function selectNode(id: string) {
    setWorkspace((current) => ({ ...current, selectedNodeId: id }));
    setOpenTabIds((current) => current.includes(id) ? current : [...current, id]);
  }

  function selectFromTree(id: string) {
    setTreeSelectedId(id);
    selectNode(id);
  }

  function handleProjectCreated(nextWorkspace: WorkspaceState, nextProjectPath: string) {
    hydrated.current = true;
    setProjectPath(nextProjectPath);
    setWorkspace(nextWorkspace);
    setTreeSelectedId(nextWorkspace.selectedNodeId);
    setOpenTabIds([nextWorkspace.selectedNodeId]);
    setLockedNodeIds([]);
    setQuery("");
    setSyncStatus(navigator.onLine ? "saved" : "offline");
  }

  function handleProjectOpened(nextWorkspace: WorkspaceState, nextProjectPath: string) {
    handleProjectCreated(nextWorkspace, nextProjectPath);
    setGitInfo(emptyGitInfo);
    setGitError(null);
    setCommitMessage("");
    setIndexedSearchResults(null);
  }

  async function refreshGitStatus() {
    if (!projectPath || !("__TAURI_INTERNALS__" in window)) return;
    setGitLoading(true);
    setGitError(null);
    try {
      const info = await getGitRepositoryInfo();
      setGitInfo(info);
      setGitError(info.error ?? null);
    } catch (error) {
      setGitError(error instanceof Error ? error.message : String(error));
    } finally {
      setGitLoading(false);
    }
  }

  async function commitWorkspace() {
    if (!commitMessage.trim()) return;
    setGitLoading(true);
    setGitError(null);
    try {
      await saveWorkspace({ ...workspace, lastSavedAt: new Date().toISOString() });
      const info = await commitAll(commitMessage);
      setGitInfo(info);
      setCommitMessage("");
    } catch (error) {
      setGitError(error instanceof Error ? error.message : String(error));
    } finally {
      setGitLoading(false);
    }
  }

  async function importPdfFile() {
    if (!("__TAURI_INTERNALS__" in window) || !projectPath) {
      window.alert("请先在桌面应用中创建或打开本地项目");
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selectedPath = await open({
        multiple: false,
        directory: false,
        title: "导入 PDF",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof selectedPath !== "string" || !selectedPath) return;
      const imported = await importPdf(selectedPath);
      const parentId = selected.kind === "folder" ? selected.id : selected.parentId;
      const node: ContentNode = {
        id: imported.id,
        parentId,
        kind: "file",
        title: imported.title,
        fileType: "PDF",
        size: formatFileSize(imported.size),
        updatedAt: "刚刚",
        localPath: imported.relativePath,
        contentHash: imported.contentHash,
        lfsTracked: imported.lfsTracked,
      };
      setWorkspace((current) => ({
        ...current,
        selectedNodeId: node.id,
        nodes: [...current.nodes, node],
      }));
      setTreeSelectedId(node.id);
      setOpenTabIds((current) => [...current, node.id]);
      window.setTimeout(() => { void refreshGitStatus(); }, 650);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGitError(message);
      window.alert(message);
    }
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

  function updateDocument(pageId: string, document: unknown[], markdown: string) {
    setWorkspace((current) => ({
      ...current,
      editorDocuments: { ...current.editorDocuments, [pageId]: document },
      noteMarkdown: { ...current.noteMarkdown, [pageId]: markdown },
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
    setTreeSelectedId(id);
  }

  function renameNode(id: string, title: string) {
    if (!title) return;
    setWorkspace((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === id ? { ...node, title, updatedAt: "刚刚" } : node),
    }));
  }

  function setNodeMarkerColor(id: string, markerColor?: MarkerColor) {
    setWorkspace((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === id ? { ...node, markerColor, updatedAt: "刚刚" } : node),
    }));
  }

  function setNodeTags(id: string, tagIds: string[]) {
    setWorkspace((current) => {
      const validIds = new Set((current.tags ?? []).map((tag) => tag.id));
      const normalized = [...new Set(tagIds)].filter((tagId) => validIds.has(tagId));
      return {
        ...current,
        nodes: current.nodes.map((node) => node.id === id ? { ...node, tagIds: normalized, updatedAt: "刚刚" } : node),
      };
    });
  }

  function createTag(nodeId: string, name: string) {
    const normalizedName = name.trim();
    if (!normalizedName) return;
    setWorkspace((current) => {
      const existing = (current.tags ?? []).find((tag) => tag.name.localeCompare(normalizedName, undefined, { sensitivity: "accent" }) === 0);
      const tag: TagDefinition = existing ?? {
        id: `tag-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: normalizedName,
      };
      return {
        ...current,
        tags: existing ? current.tags : [...(current.tags ?? []), tag],
        nodes: current.nodes.map((node) => node.id === nodeId
          ? { ...node, tagIds: [...new Set([...(node.tagIds ?? []), tag.id])], updatedAt: "刚刚" }
          : node),
      };
    });
  }

  function deleteTag(tagId: string) {
    const tag = (workspace.tags ?? []).find((item) => item.id === tagId);
    if (!tag || !window.confirm(`确定删除标签“${tag.name}”吗？该标签会从所有文件和笔记中移除。`)) return;
    setWorkspace((current) => ({
      ...current,
      tags: (current.tags ?? []).filter((item) => item.id !== tagId),
      nodes: current.nodes.map((node) => node.tagIds?.includes(tagId)
        ? { ...node, tagIds: node.tagIds.filter((id) => id !== tagId), updatedAt: "刚刚" }
        : node),
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
    setTreeSelectedId((current) => allIds.has(current) ? (leavesWorkspaceEmpty ? fallbackId : workspace.nodes.find((node) => !allIds.has(node.id))?.id ?? "") : current);
  }

  const syncCopy = syncStatus === "loading" ? "读取本地数据" : syncStatus === "saving" ? "正在保存" : syncStatus === "offline" ? "离线模式" : "已保存到本地";

  return (
    <div className="app-shell" style={{
      "--sidebar-width": primaryLeftTool || secondaryLeftTool ? `${sidebarWidth}px` : "0px",
      "--secondary-bottom-panel-height": secondaryBottomTool ? "220px" : "0px",
    } as React.CSSProperties}>
      <header className="window-titlebar" aria-label="窗口标题栏">
        <div className="titlebar-main" data-tauri-drag-region>
          <strong data-tauri-drag-region title={projectPath ?? projectName}>{projectName} - {selected.title}</strong>
        </div>
        <div className="ide-toolbar">
          <PathBreadcrumbs
            selected={selected}
            nodes={workspace.nodes}
            projectName={projectName}
            canvasPath={canvasPath}
            editorDocument={workspace.editorDocuments?.[selected.id]}
            onSelectNode={selectNode}
            onSelectHeading={(blockId) => {
              setActiveBlockId(blockId);
              requestAnimationFrame(() => focusCanvasBlock(blockId));
            }}
          />
          <div className={`toolbar-sync ${syncStatus}`}><Cloud size={13} /><span>{syncCopy}</span></div>
          <button className="toolbar-secondary" onClick={() => void importPdfFile()}><FileUp size={13} /> 导入 PDF</button>
          <button className="toolbar-primary" onClick={createPage}><Plus size={13} /> 新建页面</button>
          <button className="toolbar-icon" aria-label="更多操作"><MoreHorizontal size={15} /></button>
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
              treeSelectedId={treeSelectedId}
              activeNodeId={selected.id}
              projectName={projectName}
              projectPath={projectPath}
              onSelect={selectFromTree}
              onRevealActive={() => setTreeSelectedId(selected.id)}
              onCreatePage={createPage}
              onCreateNode={createNode}
              onRenameNode={renameNode}
              onSetNodeMarkerColor={setNodeMarkerColor}
              onSetNodeTags={setNodeTags}
              onCreateTag={createTag}
              onDeleteTag={deleteTag}
              onMoveNodes={moveNodes}
              onDeleteNodes={deleteNodes}
              onClose={() => setPrimaryLeftTool(null)}
            />
          ) : primaryLeftTool ? (
            <ToolSidebar
              tool={primaryLeftTool}
              outlineItems={outlineItems}
              bookmarks={workspace.nodes.filter((node) => node.favorite)}
              gitInfo={gitInfo}
              gitLoading={gitLoading}
              onRefreshGit={() => void refreshGitStatus()}
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
        <WorkspaceTabBar
          tabs={openTabs}
          activeId={selected.id}
          onSelect={selectNode}
          onClose={closeTab}
          onOpenInfo={() => toggleRightTool("notifications")}
        />

        <div className={`workspace-content ${rightTool ? "with-details" : ""}`}>
          <section className="workspace-canvas" role="tabpanel" onContextMenu={(event) => event.preventDefault()}>
            {openTabs.length === 0 ? (
              <div className="blank-workspace"><FileText size={34} /><p>从项目列表中选择一个页面</p></div>
            ) : selected.kind === "page" ? (
              <NoteView
                node={selected}
                workspace={workspace}
                readOnly={selectedReadOnly}
                onTitleChange={(title) => { if (!selectedReadOnly) updateSelectedNode({ title }); }}
                onDocumentChange={(document, markdown) => { if (!selectedReadOnly) updateDocument(selected.id, document, markdown); }}
                onActiveBlockChange={setActiveBlockId}
              />
            ) : <EmptyView node={selected} />}
          </section>

          {rightTool && (
            <aside className="details-panel">
              <div className="details-header"><strong>{rightTool === "notifications" ? "Notification" : rightTool === "references" ? "Referenced Files" : "AI Chat"}</strong><button onClick={() => setRightTool(null)} aria-label="关闭辅助面板"><X size={16} /></button></div>
              {rightTool === "notifications" && (
                <div className="notification-list">
                  <div className="notification-item">
                    <Bell size={14} />
                    <div>
                      <strong>工作空间已同步</strong>
                      <p>本地更改已保存完成。</p>
                      <small>刚刚</small>
                    </div>
                  </div>
                  <div className="notification-item">
                    <Files size={14} />
                    <div>
                      <strong>有文件被引用</strong>
                      <p>当前页面新增了 1 个引用文件。</p>
                      <small>12 分钟前</small>
                    </div>
                  </div>
                  <p className="panel-empty-hint">暂无更多通知</p>
                </div>
              )}
              {rightTool === "references" && (
                <div className="reference-list">
                  {workspace.nodes.filter((node) => node.kind === "file").slice(0, 8).map((node) => (
                    <button key={node.id} className="reference-item" onClick={() => selectNode(node.id)}>
                      <NodeIcon node={node} size={15} />
                      <span>
                        <strong>{node.title}</strong>
                        <small>{node.fileType ?? "文件"} · {node.updatedAt}</small>
                      </span>
                    </button>
                  ))}
                  {workspace.nodes.every((node) => node.kind !== "file") && (
                    <p className="panel-empty-hint">当前工作空间还没有可引用的文件</p>
                  )}
                </div>
              )}
              {rightTool === "ai" && (
                <div className="ai-card expanded">
                  <span className="ai-icon"><Sparkles size={17} /></span>
                  <div><strong>AI Chat</strong><p>围绕当前页面继续写作、总结内容，或在工作空间中查找答案。</p></div>
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
              <label className="bottom-search-field">
                <Search size={14} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索工作空间"
                  autoFocus
                />
              </label>
              <span>{searchResults.length} 个结果</span>
              <button onClick={() => setBottomTool(null)} aria-label="收起底部工具窗口" title="收起窗口"><Minus size={15} /></button>
            </div>
            <div className="bottom-panel-content">
              {query.trim() ? searchResults.map((result) => {
                const node = workspace.nodes.find((item) => item.id === result.nodeId);
                if (!node) return null;
                return <button key={result.nodeId} onClick={() => selectNode(result.nodeId)}><NodeIcon node={node} /><span><strong>{result.title}</strong><small>{result.snippet || result.path || (node.kind === "page" ? "笔记" : node.kind === "folder" ? "文件夹" : node.fileType)}</small></span><ChevronRight size={14} /></button>;
              }) : <div className="tool-empty"><Search size={20} /><span>输入关键词搜索页面、文件和笔记正文</span></div>}
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
            {secondaryBottomTool === "git" ? (
              <div className="git-bottom-content">
                <div className="git-bottom-summary">
                  <span><GitBranch size={14} />{gitInfo.isRepository ? gitInfo.branch || "HEAD" : "未启用 Git"}</span>
                  <span className={gitInfo.lfsAvailable ? "available" : "missing"}>Git LFS {gitInfo.lfsAvailable ? "可用" : "未安装"}</span>
                  <button type="button" onClick={() => void refreshGitStatus()} disabled={gitLoading}><RefreshCw size={13} />刷新</button>
                </div>
                {gitError && <p className="git-error" role="alert">{gitError}</p>}
                <div className="git-bottom-columns">
                  <section>
                    <strong>更改 · {gitInfo.changes.length}</strong>
                    <div className="git-change-list compact">
                      {gitInfo.changes.map((change, index) => <div key={`${change.path}-${index}`}><code>{change.status}</code><span>{change.path}</span></div>)}
                      {gitInfo.isRepository && gitInfo.changes.length === 0 && <small>工作树干净</small>}
                    </div>
                    {gitInfo.isRepository && (
                      <form className="git-commit-form" onSubmit={(event) => { event.preventDefault(); void commitWorkspace(); }}>
                        <input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="提交说明" disabled={gitLoading} />
                        <button type="submit" disabled={gitLoading || !commitMessage.trim()}>提交全部</button>
                      </form>
                    )}
                  </section>
                  <section>
                    <strong>历史 · {gitInfo.history.length}</strong>
                    <div className="git-history-list">
                      {gitInfo.history.map((commit) => <div key={commit.id}><code>{commit.shortId}</code><span><b>{commit.subject}</b><small>{commit.author} · {commit.authoredAt.slice(0, 10)}</small></span></div>)}
                      {gitInfo.isRepository && gitInfo.history.length === 0 && <small>还没有提交记录</small>}
                    </div>
                  </section>
                </div>
              </div>
            ) : secondaryBottomTool === "terminal" ? (
              <TerminalPanel projectPath={projectPath} />
            ) : (
              <><span>{secondaryBottomTool === "todo" ? <ListTodo size={26} /> : <Server size={26} />}</span><span>{secondaryBottomTool === "todo" ? "暂无待办事项" : "暂无运行中的服务"}</span></>
            )}
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
        <span className="statusbar-project" title={projectPath ?? projectName}>{projectPath || projectName}</span>
        <span className="statusbar-spacer" />
        <span>{selected.kind === "page" ? "笔记" : selected.kind === "folder" ? "文件夹" : selected.fileType ?? "文件"}</span>
        <span>UTF-8</span>
        <span>行 {cursorPosition.line}, 字符 {cursorPosition.column}</span>
        <span>LF</span>
        <span className="statusbar-branch"><GitBranch size={13} /> {gitInfo.isRepository ? gitInfo.branch || "HEAD" : "未启用"}</span>
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
