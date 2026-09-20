import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  Cloud,
  File,
  Files,
  FileSpreadsheet,
  FileText,
  FileUp,
  Folder,
  FoldVertical,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Hash,
  ListTodo,
  ListTree,
  LocateFixed,
  Lock,
  LockOpen,
  Minus,
  MoreHorizontal,
  MoreVertical,
  Plus,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  Tag,
  TerminalSquare,
  UnfoldVertical,
  X,
} from "lucide-react";
import { createBlankWorkspace, initialWorkspace } from "./data";
import { FileTree } from "./FileTree";
import type { FileTreeHandle } from "./FileTree";
import { headingPath, headingSiblings, parseMarkdownHeadings, type MarkdownHeading } from "./markdownNavigation";
import { TerminalPanel } from "./TerminalPanel";
import { HyperSpaceVditor } from "./VditorEditor";
import { PROJECT_CREATED_EVENT, type ProjectCreatedPayload } from "./NewProjectDialog";
import {
  commitAll,
  createWorkspaceEntry,
  deleteWorkspaceEntries,
  getCurrentProject,
  getGitRepositoryInfo,
  importPdf,
  loadWorkspace,
  openProject,
  projectNameFromPath,
  renameWorkspaceEntry,
  saveWorkspace,
  searchWorkspace,
  type GitRepositoryInfo,
  type WorkspaceSearchResult,
} from "./storage";
import type { ContentNode, MarkerColor, TagDefinition, WorkspaceState } from "./types";

type SyncStatus = "loading" | "saved" | "saving" | "offline";
type PrimaryLeftTool = "project" | "commit" | "pullRequests";
type SecondaryLeftTool = "structure" | "bookmarks";
type BottomTool = "search";
type SecondaryBottomTool = "git" | "terminal" | "todo" | "services";
type RightTool = "notifications" | "references" | "ai";

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
  if (isMarkdownDocument(node)) return <File size={size} strokeWidth={1.8} />;
  if (node.fileType === "XLSX") return <FileSpreadsheet size={size} strokeWidth={1.8} />;
  if (node.kind === "file") return <FileText size={size} strokeWidth={1.8} />;
  return <File size={size} strokeWidth={1.8} />;
}

function isMarkdownDocument(node: ContentNode) {
  if (node.kind === "page") return true;
  const fileType = node.fileType?.toLowerCase();
  return node.kind === "file" && (fileType === "md" || fileType === "markdown");
}

function parentDirectoryPath(parent: ContentNode | undefined) {
  if (!parent) return "";
  if (parent.kind === "folder") return parent.localPath ?? "";
  if (!parent.localPath) return "";
  const parts = parent.localPath.split("/");
  parts.pop();
  return parts.join("/");
}

function uniqueSiblingName(nodes: ContentNode[], parentId: string | null, fileName: string) {
  const used = new Set(nodes.filter((node) => node.parentId === parentId).map((node) => node.title));
  if (!used.has(fileName)) return fileName;
  const lastDot = fileName.lastIndexOf(".");
  const hasExtension = lastDot > 0;
  const stem = hasExtension ? fileName.slice(0, lastDot) : fileName;
  const extension = hasExtension ? fileName.slice(lastDot) : "";
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${stem} (${suffix})${extension}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${stem}-new${extension}`;
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

function ToolSidebar({ tool, outlineItems, bookmarks, gitInfo, gitLoading, onRefreshGit, onSelectNode, onSelectHeading, onClose }: {
  tool: Exclude<PrimaryLeftTool, "project"> | SecondaryLeftTool;
  outlineItems: { id: string; content: string; level: number }[];
  bookmarks: ContentNode[];
  gitInfo?: GitRepositoryInfo;
  gitLoading?: boolean;
  onRefreshGit?: () => void;
  onSelectNode: (id: string) => void;
  onSelectHeading?: (id: string) => void;
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
        <div className="sidebar-tool-list outline-list">
          {outlineItems.map((item) => (
            <button
              key={item.id}
              type="button"
              style={{ paddingLeft: 8 + (item.level - 1) * 12 }}
              onClick={() => onSelectHeading?.(item.id)}
            >
              <Hash size={14} />
              <span>{item.content}</span>
            </button>
          ))}
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

function NoteView({
  node,
  workspace,
  readOnly,
  onMarkdownChange,
  onNavigateNode,
  onActiveHeadingChange,
  onCursorChange,
}: {
  node: ContentNode;
  workspace: WorkspaceState;
  readOnly: boolean;
  onMarkdownChange: (markdown: string) => void;
  onNavigateNode: (nodeId: string) => void;
  onActiveHeadingChange?: (headingId: string | null) => void;
  onCursorChange?: (position: { line: number; column: number }) => void;
}) {
  return (
    <article className={`note-page ${readOnly ? "read-only" : ""}`}>
      <div className="editor">
        <HyperSpaceVditor
          key={node.id}
          pageId={node.id}
          nodes={workspace.nodes}
          value={workspace.noteMarkdown[node.id] ?? ""}
          readOnly={readOnly}
          onChange={onMarkdownChange}
          onNavigateNode={onNavigateNode}
          onActiveHeadingChange={onActiveHeadingChange}
          onCursorChange={onCursorChange}
        />
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

function focusCanvasBlock(headingId: string) {
  const selectors = [
    `[data-hs-heading-id="${CSS.escape(headingId)}"]`,
    `#${CSS.escape(headingId)}`,
  ];
  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(`.hyperspace-vditor ${selector}`);
    if (element) {
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
  }
  const heading = parseMarkdownHeadings(
    document.querySelector<HTMLElement>(".hyperspace-vditor .vditor-ir, .hyperspace-vditor .vditor-wysiwyg, .hyperspace-vditor textarea")?.innerText
      ?? document.querySelector<HTMLTextAreaElement>(".hyperspace-vditor textarea")?.value
      ?? "",
  ).find((item) => item.id === headingId);
  if (!heading) return;
  const element = Array.from(document.querySelectorAll<HTMLElement>(".hyperspace-vditor h1, .hyperspace-vditor h2, .hyperspace-vditor h3, .hyperspace-vditor h4, .hyperspace-vditor h5, .hyperspace-vditor h6"))
    .find((candidate) => (candidate.textContent ?? "").replace(/^H[1-6]/, "").replace(/^#{1,6}\s*/, "").trim() === heading.text);
  element?.scrollIntoView({ block: "center", behavior: "smooth" });
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
  headings,
  onSelectNode,
  onSelectHeading,
}: {
  selected: ContentNode;
  nodes: ContentNode[];
  projectName: string;
  canvasPath: { id: string; content: string }[];
  headings: MarkdownHeading[];
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
        siblings: headingSiblings(headings, crumb.id).map((item) => ({
          id: item.id,
          label: item.text,
          kind: "heading",
        })),
      });
    }

    return items;
  }, [selected, nodes, projectName, canvasPath, headings]);

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
    let cancelled = false;
    void (async () => {
      try {
        const path = await getCurrentProject().catch(() => null);
        if (cancelled) return;
        if (path) {
          setProjectPath(path);
          const opened = await openProject(path).catch(() => null);
          if (cancelled) return;
          if (opened) {
            setWorkspace(opened);
            setTreeSelectedId(opened.selectedNodeId);
            setOpenTabIds([opened.selectedNodeId]);
            return;
          }
        }
        const stored = await loadWorkspace();
        if (cancelled) return;
        if (stored) {
          setWorkspace(stored);
          setTreeSelectedId(stored.selectedNodeId);
          setOpenTabIds([stored.selectedNodeId]);
        }
      } finally {
        if (!cancelled) {
          hydrated.current = true;
          setSyncStatus(navigator.onLine ? "saved" : "offline");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
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
  const markdownHeadings = useMemo(
    () => parseMarkdownHeadings(isMarkdownDocument(selected) ? workspace.noteMarkdown[selected.id] ?? "" : ""),
    [selected.id, selected.kind, workspace.noteMarkdown],
  );
  const outlineItems = markdownHeadings.map((heading) => ({ id: heading.id, content: heading.text, level: heading.level }));
  const canvasPath = isMarkdownDocument(selected)
    ? headingPath(markdownHeadings, activeBlockId).map((heading) => ({ id: heading.id, content: heading.text }))
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

  function updateDocument(pageId: string, markdown: string) {
    setWorkspace((current) => ({
      ...current,
      noteMarkdown: { ...current.noteMarkdown, [pageId]: markdown },
    }));
  }

  function createPage() {
    const parentId = selected.kind === "folder" ? selected.id : selected.parentId;
    void createNode("page", parentId);
  }

  async function createNode(kind: "page" | "folder", parentId: string | null) {
    const parent = parentId ? workspace.nodes.find((node) => node.id === parentId) : undefined;
    const parentPath = parentDirectoryPath(parent);
    if (projectPath && "__TAURI_INTERNALS__" in window) {
      try {
        const created = await createWorkspaceEntry(parentPath, kind === "folder" ? "folder" : "file");
        const node: ContentNode = {
          id: created.id,
          parentId,
          kind: created.kind,
          title: created.title,
          fileType: created.fileType ?? undefined,
          size: created.size ?? undefined,
          localPath: created.relativePath,
          fileIdentity: created.fileIdentity ?? undefined,
          updatedAt: "刚刚",
        };
        setWorkspace((current) => ({
          ...current,
          selectedNodeId: node.id,
          nodes: [...current.nodes, node],
          noteMarkdown: node.kind === "file" ? { ...current.noteMarkdown, [node.id]: "" } : current.noteMarkdown,
        }));
        setOpenTabIds((current) => [...current, node.id]);
        setTreeSelectedId(node.id);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const title = uniqueSiblingName(
      workspace.nodes,
      parentId,
      kind === "folder" ? "新建文件夹" : "未命名页面.md",
    );
    const localPath = parentPath ? `${parentPath}/${title}` : title;
    const id = `${kind === "folder" ? "folder" : "file"}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setWorkspace((current) => ({
      ...current,
      selectedNodeId: id,
      nodes: [...current.nodes, {
        id,
        parentId,
        kind: kind === "folder" ? "folder" : "file",
        title,
        fileType: kind === "folder" ? undefined : "MD",
        localPath,
        updatedAt: "刚刚",
      }],
      noteMarkdown: kind === "page" ? { ...current.noteMarkdown, [id]: "" } : current.noteMarkdown,
    }));
    setOpenTabIds((current) => [...current, id]);
    setTreeSelectedId(id);
  }

  async function renameNode(id: string, title: string) {
    if (!title) return;
    const target = workspace.nodes.find((node) => node.id === id);
    if (!target) return;
    let nextPath = target.localPath;
    if (target.localPath && projectPath) {
      try {
        nextPath = await renameWorkspaceEntry(target.localPath, title);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    const previousPath = target.localPath;
    setWorkspace((current) => ({
      ...current,
      nodes: current.nodes.map((node) => {
        if (node.id === id) {
          return {
            ...node,
            title,
            localPath: nextPath,
            fileType: node.kind === "file" ? title.split(".").at(-1)?.toUpperCase() : node.fileType,
            updatedAt: "刚刚",
          };
        }
        if (previousPath && nextPath && node.localPath?.startsWith(`${previousPath}/`)) {
          return { ...node, localPath: `${nextPath}${node.localPath.slice(previousPath.length)}` };
        }
        return node;
      }),
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

  async function deleteNodes(ids: string[]) {
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
    const diskPaths = workspace.nodes
      .filter((node) => roots.has(node.id))
      .map((node) => node.localPath)
      .filter((path): path is string => Boolean(path));
    if (diskPaths.length > 0 && projectPath) {
      try {
        await deleteWorkspaceEntries(diskPaths);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
        return;
      }
    }
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
      const remainingMarkdown = Object.fromEntries(Object.entries(current.noteMarkdown).filter(([id]) => !allIds.has(id)));
      const noteMarkdown = remainingNodes.length > 0 ? remainingMarkdown : { ...remainingMarkdown, [fallbackId]: "" };
      const selectedNodeId = allIds.has(current.selectedNodeId) ? nodes[0]?.id ?? "" : current.selectedNodeId;
      return { ...current, nodes, noteMarkdown, selectedNodeId };
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
            headings={markdownHeadings}
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
              onSelectHeading={(headingId) => {
                setActiveBlockId(headingId);
                requestAnimationFrame(() => focusCanvasBlock(headingId));
              }}
              onClose={() => setPrimaryLeftTool(null)}
            />
          ) : null}
          {secondaryLeftTool && (
            <ToolSidebar
              tool={secondaryLeftTool}
              outlineItems={outlineItems}
              bookmarks={workspace.nodes.filter((node) => node.favorite)}
              onSelectNode={selectNode}
              onSelectHeading={(headingId) => {
                setActiveBlockId(headingId);
                requestAnimationFrame(() => focusCanvasBlock(headingId));
              }}
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
            ) : isMarkdownDocument(selected) ? (
              <NoteView
                node={selected}
                workspace={workspace}
                readOnly={selectedReadOnly}
                onMarkdownChange={(markdown) => { if (!selectedReadOnly) updateDocument(selected.id, markdown); }}
                onNavigateNode={selectNode}
                onActiveHeadingChange={setActiveBlockId}
                onCursorChange={setCursorPosition}
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
