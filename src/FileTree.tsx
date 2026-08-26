import { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Folder,
  Pencil,
  Plus,
  Tag,
  Trash2,
} from "lucide-react";
import { Tree, adjustMoveIndex } from "react-arborist";
import type { NodeRendererProps, TreeApi } from "react-arborist";
import folderIcon from "./assets/icons/folder.svg";
import noteIcon from "./assets/icons/note.svg";
import type { ContentNode, MarkerColor, NodeKind, TagDefinition } from "./types";

interface FileTreeNode extends ContentNode {
  children?: FileTreeNode[];
}

interface FileTreeProps {
  nodes: ContentNode[];
  selectedId: string;
  projectName: string;
  projectPath?: string | null;
  filter?: "notes" | "files" | null;
  tagFilterIds?: string[];
  tags: TagDefinition[];
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onSetMarkerColor: (id: string, color?: MarkerColor) => void;
  onSetTags: (id: string, tagIds: string[]) => void;
  onCreateTag: (nodeId: string, name: string) => void;
  onDeleteTag: (tagId: string) => void;
  onMove: (dragIds: string[], parentId: string | null, index: number) => void;
  onCreate: (kind: Extract<NodeKind, "page" | "folder">, parentId: string | null) => void;
  onDelete: (ids: string[]) => void;
}

const TREE_ROW_HEIGHT = 26;
const TREE_INDENT = 16;
const TREE_BASE_PADDING = 22;

export interface FileTreeHandle {
  revealSelected: () => void;
  revealNode: (id: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
}

const RenameContext = createContext<{
  editingId: string | null;
  startRename: (id: string) => void;
  finishRename: (id: string, title?: string) => void;
}>({ editingId: null, startRename: () => undefined, finishRename: () => undefined });

const MarkerContext = createContext<{
  setMarkerColor: (id: string, color?: MarkerColor) => void;
}>({ setMarkerColor: () => undefined });

const TagContext = createContext<{
  tags: TagDefinition[];
  setTags: (id: string, tagIds: string[]) => void;
  createTag: (nodeId: string, name: string) => void;
  deleteTag: (tagId: string) => void;
}>({ tags: [], setTags: () => undefined, createTag: () => undefined, deleteTag: () => undefined });

const MARKER_COLORS: { color: MarkerColor; label: string; value: string }[] = [
  { color: "red", label: "红色", value: "#ff5d61" },
  { color: "orange", label: "橙色", value: "#ff963f" },
  { color: "yellow", label: "黄色", value: "#ffcc3b" },
  { color: "green", label: "绿色", value: "#48ca6b" },
  { color: "blue", label: "蓝色", value: "#4598ed" },
  { color: "purple", label: "紫色", value: "#d84bdd" },
  { color: "gray", label: "灰色", value: "#aaa9ad" },
];

function markerColorValue(color: MarkerColor) {
  return MARKER_COLORS.find((item) => item.color === color)?.value;
}

type DropPosition = "before" | "inside" | "after" | "root";

interface DropTarget {
  /** Row currently under the pointer; owns the visual indicator. */
  targetId: string | null;
  /** Node the insertion is actually placed before/after after resolving depth. */
  anchorId: string | null;
  position: DropPosition;
  parentId: string | null;
  index: number;
  depth: number;
}

interface PointerDragState {
  id: string;
  title: string;
  x: number;
  y: number;
}

const PointerDragContext = createContext<{
  draggingId: string | null;
  dropTarget: DropTarget | null;
  beginDrag: (id: string, title: string, event: React.PointerEvent<HTMLDivElement>) => void;
  suppressClick: () => boolean;
}>({
  draggingId: null,
  dropTarget: null,
  beginDrag: () => undefined,
  suppressClick: () => false,
});

function toTree(nodes: ContentNode[]): FileTreeNode[] {
  const childrenByParent = new Map<string | null, ContentNode[]>();

  for (const node of nodes) {
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }

  const visited = new Set<string>();
  const build = (node: ContentNode): FileTreeNode => {
    const canHaveChildren = node.kind !== "file";
    if (visited.has(node.id)) return { ...node, children: canHaveChildren ? [] : undefined };
    visited.add(node.id);
    return {
      ...node,
      // Pages can contain sub-pages just like folders. Keeping an empty children
      // array also makes them valid drop targets in react-arborist.
      children: canHaveChildren ? (childrenByParent.get(node.id) ?? []).map(build) : undefined,
    };
  };

  return (childrenByParent.get(null) ?? []).map(build);
}

function filterTreeNodes(nodes: ContentNode[], filter: FileTreeProps["filter"], tagFilterIds: string[]): ContentNode[] {
  if (!filter && tagFilterIds.length === 0) return nodes;

  const targetKind: NodeKind | null = filter === "notes" ? "page" : filter === "files" ? "file" : null;
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const visibleIds = new Set<string>();

  for (const node of nodes) {
    if (targetKind && node.kind !== targetKind) continue;
    if (tagFilterIds.length > 0 && !tagFilterIds.some((tagId) => node.tagIds?.includes(tagId))) continue;
    let current: ContentNode | undefined = node;
    while (current && !visibleIds.has(current.id)) {
      visibleIds.add(current.id);
      current = current.parentId ? nodesById.get(current.parentId) : undefined;
    }
  }

  return nodes.filter((node) => visibleIds.has(node.id));
}

function useElementHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setHeight(element.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, height] as const;
}

function TreeAssetIcon({ src }: { src: string }) {
  return <img className="tree-node-icon" src={src} alt="" aria-hidden="true" draggable={false} />;
}

function FileNodeIcon({ node }: { node: ContentNode }) {
  if (node.kind === "folder") return <TreeAssetIcon src={folderIcon} />;
  if (node.kind === "page") return <TreeAssetIcon src={noteIcon} />;
  if (node.fileType === "XLSX") return <FileSpreadsheet size={16} strokeWidth={1.8} />;
  return <FileText size={16} strokeWidth={1.8} />;
}

type TreeMenuState = { x: number; y: number } | null;

function clampTreeMenuPosition(x: number, y: number, width = 174, height = 168) {
  const pad = 8;
  return {
    x: Math.max(pad, Math.min(x, window.innerWidth - width - pad)),
    y: Math.max(pad, Math.min(y, window.innerHeight - height - pad)),
  };
}

function FileTreeRow({ node, style }: NodeRendererProps<FileTreeNode>) {
  const [menu, setMenu] = useState<TreeMenuState>(null);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rename = useContext(RenameContext);
  const marker = useContext(MarkerContext);
  const tagContext = useContext(TagContext);
  const pointerDrag = useContext(PointerDragContext);
  const isEditing = rename.editingId === node.id;
  const menuOpen = menu !== null;

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as globalThis.Node;
      if (menuRef.current?.contains(target)) return;
      if ((target as Element).closest?.(".tree-context-menu")) return;
      setMenu(null);
    };
    const closeOnScroll = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", closeOnScroll);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", closeOnScroll);
    };
  }, [menuOpen]);

  const parentForNewItem = node.data.kind === "file" ? node.data.parentId : node.id;
  const hasChildren = (node.data.children?.length ?? 0) > 0;
  const dropPosition = pointerDrag.dropTarget?.targetId === node.id
    ? pointerDrag.dropTarget.position
    : null;
  const dropDepth = pointerDrag.dropTarget?.targetId === node.id
    ? pointerDrag.dropTarget.depth
    : 0;
  const arboristPaddingLeft = typeof style?.paddingLeft === "number"
    ? style.paddingLeft
    : Number.parseFloat(String(style?.paddingLeft ?? 0)) || 0;
  const rowStyle = {
    ...style,
    paddingLeft: arboristPaddingLeft + TREE_BASE_PADDING,
    ...(dropPosition === "before" || dropPosition === "after"
      ? { "--drop-depth": dropDepth }
      : null),
  } as React.CSSProperties;

  function openPointerMenu(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    node.select();
    const supportsMarker = node.data.kind === "page" || node.data.kind === "file";
    const next = clampTreeMenuPosition(event.clientX, event.clientY, supportsMarker ? 264 : 174, supportsMarker ? 292 : 168);
    setTagEditorOpen(false);
    setNewTagName("");
    setMenu({ x: next.x, y: next.y });
  }

  function closeMenu() {
    setMenu(null);
  }

  return (
    <div
      style={rowStyle}
      data-tree-node-id={node.id}
      className={`tree-item ${node.isSelected ? "selected" : ""} ${node.isFocused ? "focused" : ""} ${pointerDrag.draggingId === node.id ? "dragging" : ""} ${dropPosition ? `drop-${dropPosition}` : ""}`}
      title={node.data.title}
      onContextMenu={openPointerMenu}
      onPointerDown={(event) => {
        if ((event.target as Element).closest("button, input, [role='menu']")) return;
        pointerDrag.beginDrag(node.id, node.data.title, event);
      }}
      onClickCapture={(event) => {
        if (pointerDrag.suppressClick()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <button
        className={`tree-chevron ${hasChildren ? "visible" : ""}`}
        aria-label={node.isOpen ? "折叠" : "展开"}
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
          node.toggle();
        }}
      >
        {node.isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      <FileNodeIcon node={node.data} />
      {isEditing ? (
        <input
          ref={inputRef}
          className="tree-rename-input"
          defaultValue={node.data.title}
          aria-label="重命名"
          onClick={(event) => event.stopPropagation()}
          onBlur={(event) => rename.finishRename(node.id, event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") rename.finishRename(node.id);
            if (event.key === "Enter") rename.finishRename(node.id, event.currentTarget.value);
          }}
        />
      ) : (
        <span className="tree-label">{node.data.title}</span>
      )}
      {(node.data.kind === "page" || node.data.kind === "file") && (node.data.tagIds?.length ?? 0) > 0 && (
        <span className="tree-tags" aria-label={`标签：${node.data.tagIds?.map((id) => tagContext.tags.find((tag) => tag.id === id)?.name).filter(Boolean).join("、")}`}>
          {node.data.tagIds?.map((id) => tagContext.tags.find((tag) => tag.id === id)).filter((tag): tag is TagDefinition => Boolean(tag)).slice(0, 2).map((tag) => (
            <span key={tag.id} className="tree-tag" title={tag.name}>
              <span>{tag.name}</span>
            </span>
          ))}
          {(node.data.tagIds?.length ?? 0) > 2 && <span className="tree-tag-more">+{(node.data.tagIds?.length ?? 0) - 2}</span>}
        </span>
      )}
      {node.data.markerColor && (
        <span
          className="tree-color-marker"
          style={{ "--marker-color": markerColorValue(node.data.markerColor) } as React.CSSProperties}
          aria-label={`${MARKER_COLORS.find((item) => item.color === node.data.markerColor)?.label ?? ""}标记`}
          title={`${MARKER_COLORS.find((item) => item.color === node.data.markerColor)?.label ?? ""}标记`}
        />
      )}
      {menu && createPortal(
        <div
          ref={menuRef}
          className={`tree-context-menu is-pointer ${node.data.kind === "page" || node.data.kind === "file" ? "has-color-picker" : ""}`}
          role="menu"
          style={{ top: menu.y, left: menu.x }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button role="menuitem" onClick={() => { closeMenu(); rename.startRename(node.id); }}><Pencil size={14} />重命名 <kbd>F2</kbd></button>
          {(node.data.kind === "page" || node.data.kind === "file") && (
            <>
              <span className="tree-menu-separator" />
              <div className="tree-color-menu" aria-label="颜色标记">
                <span className="tree-color-menu-title">颜色标记</span>
                <div className="tree-color-palette" role="group" aria-label="选择颜色标记">
                  {MARKER_COLORS.map(({ color, label, value }) => {
                    const active = node.data.markerColor === color;
                    return (
                      <button
                        key={color}
                        type="button"
                        className={`tree-color-swatch ${active ? "active" : ""}`}
                        style={{ "--marker-color": value } as React.CSSProperties}
                        aria-label={`${label}标记${active ? "，再次点击移除" : ""}`}
                        aria-pressed={active}
                        title={`${label}${active ? "（再次点击移除）" : ""}`}
                        onClick={() => {
                          marker.setMarkerColor(node.id, active ? undefined : color);
                          closeMenu();
                        }}
                      >
                        {active && <Check size={14} strokeWidth={2.4} />}
                      </button>
                    );
                  })}
                </div>
              </div>
              <button
                type="button"
                role="menuitem"
                aria-expanded={tagEditorOpen}
                onClick={() => setTagEditorOpen((open) => !open)}
              >
                <Tag size={14} />编辑标签 <ChevronRight className={tagEditorOpen ? "expanded" : ""} size={13} />
              </button>
              {tagEditorOpen && (
                <div className="tree-tag-editor" onClick={(event) => event.stopPropagation()}>
                  {tagContext.tags.length > 0 ? (
                    <div className="tree-tag-options" role="group" aria-label="分配标签">
                      {tagContext.tags.map((tag) => {
                        const active = node.data.tagIds?.includes(tag.id) ?? false;
                        return (
                          <div key={tag.id} className="tree-tag-option-row">
                            <span className="tree-tag-option-name" title={tag.name}>{tag.name}</span>
                            <button
                              type="button"
                              className={`tree-tag-apply ${active ? "active" : ""}`}
                              aria-pressed={active}
                              aria-label={`${active ? "移除" : "应用"}标签 ${tag.name}`}
                              onClick={() => tagContext.setTags(
                                node.id,
                                active
                                  ? (node.data.tagIds ?? []).filter((id) => id !== tag.id)
                                  : [...(node.data.tagIds ?? []), tag.id],
                              )}
                            >
                              <Check size={13} />
                            </button>
                            <button
                              type="button"
                              className="tree-tag-delete"
                              aria-label={`删除标签 ${tag.name}`}
                              title="删除标签"
                              onClick={() => tagContext.deleteTag(tag.id)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : <span className="tree-tag-empty">还没有标签</span>}
                  <form
                    className="tree-tag-create"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const name = newTagName.trim();
                      if (!name) return;
                      tagContext.createTag(node.id, name);
                      setNewTagName("");
                    }}
                  >
                    <div className="tree-tag-create-field">
                      <input
                        value={newTagName}
                        maxLength={20}
                        placeholder="新建标签"
                        aria-label="新标签名称"
                        onChange={(event) => setNewTagName(event.target.value)}
                        onKeyDown={(event) => event.stopPropagation()}
                      />
                      <button type="submit" aria-label="创建并添加标签" disabled={!newTagName.trim()}><Plus size={13} /></button>
                    </div>
                  </form>
                </div>
              )}
            </>
          )}
          <button role="menuitem" onClick={() => { closeMenu(); node.tree.props.onCreate?.({ parentId: parentForNewItem, parentNode: node.parent, index: 0, type: "leaf" }); }}><Plus size={14} />新建页面</button>
          <button role="menuitem" onClick={() => { closeMenu(); node.tree.props.onCreate?.({ parentId: parentForNewItem, parentNode: node.parent, index: 0, type: "internal" }); }}><Folder size={14} />新建文件夹</button>
          <span className="tree-menu-separator" />
          <button className="danger" role="menuitem" onClick={() => { closeMenu(); node.tree.delete(node.id); }}><Trash2 size={14} />删除 <kbd>⌫</kbd></button>
        </div>,
        document.body,
      )}
    </div>
  );
}

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
  { nodes, selectedId, projectName, projectPath, filter = null, tagFilterIds = [], tags, onSelect, onRename, onSetMarkerColor, onSetTags, onCreateTag, onDeleteTag, onMove, onCreate, onDelete },
  ref,
) {
  const visibleNodes = useMemo(() => filterTreeNodes(nodes, filter, tagFilterIds), [filter, nodes, tagFilterIds]);
  const data = useMemo(() => toTree(visibleNodes), [visibleNodes]);
  const [containerRef, height] = useElementHeight<HTMLDivElement>();
  const treeRef = useRef<TreeApi<FileTreeNode> | undefined>(undefined);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [blankMenu, setBlankMenu] = useState<{ x: number; y: number } | null>(null);
  const [pointerDragState, setPointerDragState] = useState<PointerDragState | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const suppressClickUntil = useRef(0);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const runWhenTreeIsVisible = useCallback((action: (tree: TreeApi<FileTreeNode>) => void) => {
    setWorkspaceOpen(true);
    window.requestAnimationFrame(() => {
      if (treeRef.current) action(treeRef.current);
    });
  }, []);

  useImperativeHandle(ref, () => ({
    revealSelected: () => runWhenTreeIsVisible((tree) => { void tree.scrollTo(selectedId, "center"); }),
    revealNode: (id: string) => runWhenTreeIsVisible((tree) => { void tree.scrollTo(id, "center"); }),
    expandAll: () => runWhenTreeIsVisible((tree) => tree.openAll()),
    collapseAll: () => treeRef.current?.closeAll(),
  }), [runWhenTreeIsVisible, selectedId]);

  const renameContext = useMemo(() => ({
    editingId,
    startRename: setEditingId,
    finishRename: (id: string, title?: string) => {
      const normalized = title?.trim();
      if (normalized) onRename(id, normalized);
      setEditingId(null);
    },
  }), [editingId, onRename]);

  const beginDrag = useCallback((id: string, title: string, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    dragCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let latestTarget: DropTarget | null = null;

    const isDescendantOf = (candidateId: string | null, ancestorId: string) => {
      let currentId = candidateId;
      while (currentId) {
        if (currentId === ancestorId) return true;
        currentId = nodes.find((item) => item.id === currentId)?.parentId ?? null;
      }
      return false;
    };

    const getDepth = (nodeId: string) => {
      let depth = 0;
      let currentId = nodes.find((item) => item.id === nodeId)?.parentId ?? null;
      while (currentId) {
        depth += 1;
        currentId = nodes.find((item) => item.id === currentId)?.parentId ?? null;
      }
      return depth;
    };

    const getSiblings = (parentId: string | null) => nodes.filter((item) => item.parentId === parentId);

    const resolveBoundary = (
      hoveredNode: ContentNode,
      position: Extract<DropPosition, "before" | "after">,
      desiredDepth: number,
    ): DropTarget => {
      let anchorNode = hoveredNode;
      let anchorDepth = getDepth(hoveredNode.id);

      // A boundary can be promoted to an ancestor only at the first/last child.
      // This makes the horizontal length of the line map to a real tree position.
      while (anchorDepth > desiredDepth && anchorNode.parentId) {
        const siblings = getSiblings(anchorNode.parentId);
        const edgeNode = position === "before" ? siblings[0] : siblings.at(-1);
        if (edgeNode?.id !== anchorNode.id) break;
        const parentNode = nodes.find((item) => item.id === anchorNode.parentId);
        if (!parentNode) break;
        anchorNode = parentNode;
        anchorDepth -= 1;
      }

      const siblings = getSiblings(anchorNode.parentId);
      return {
        targetId: hoveredNode.id,
        anchorId: anchorNode.id,
        position,
        parentId: anchorNode.parentId,
        index: siblings.findIndex((item) => item.id === anchorNode.id) + (position === "after" ? 1 : 0),
        depth: anchorDepth,
      };
    };

    const updateTarget = (moveEvent: PointerEvent) => {
      const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const row = element?.closest<HTMLElement>("[data-tree-node-id]");
      let nextTarget: DropTarget | null = null;

      if (row) {
        const targetId = row.dataset.treeNodeId ?? null;
        const targetNode = nodes.find((item) => item.id === targetId);
        if (targetId && targetNode && targetId !== id) {
          const rect = row.getBoundingClientRect();
          const ratio = (moveEvent.clientY - rect.top) / rect.height;
          const position: DropPosition = ratio < 0.28
            ? "before"
            : ratio > 0.72
              ? "after"
              : targetNode.kind === "file" ? (ratio < 0.5 ? "before" : "after") : "inside";
          if (position === "inside") {
            const children = getSiblings(targetId);
            nextTarget = {
              targetId,
              anchorId: targetId,
              position,
              parentId: targetId,
              index: children.length,
              depth: getDepth(targetId) + 1,
            };
          } else {
            const targetDepth = getDepth(targetId);
            const indent = 18;
            const desiredDepth = Math.max(0, Math.min(
              targetDepth,
              Math.floor((moveEvent.clientX - row.getBoundingClientRect().left - TREE_BASE_PADDING) / indent),
            ));
            nextTarget = resolveBoundary(targetNode, position, desiredDepth);
          }
          if (nextTarget && isDescendantOf(nextTarget.parentId, id)) nextTarget = null;
        }
      } else if (element?.closest(".workspace-tree-content")) {
        nextTarget = {
          targetId: null,
          anchorId: null,
          position: "root",
          parentId: null,
          index: getSiblings(null).length,
          depth: 0,
        };
      }

      latestTarget = nextTarget;
      setDropTarget(nextTarget);
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (!active && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return;
      if (!active) {
        active = true;
        document.body.classList.add("is-tree-dragging");
        document.getSelection()?.removeAllRanges();
      }
      moveEvent.preventDefault();
      setPointerDragState({ id, title, x: moveEvent.clientX, y: moveEvent.clientY });
      updateTarget(moveEvent);
    };

    const cleanup = () => {
      document.body.classList.remove("is-tree-dragging");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      setPointerDragState(null);
      setDropTarget(null);
      dragCleanupRef.current = null;
    };

    const handlePointerUp = () => {
      if (active) {
        suppressClickUntil.current = performance.now() + 250;
        if (latestTarget) {
          const destination = latestTarget;
          const { parentId, index } = destination;
          const siblingIds = nodes.filter((item) => item.parentId === parentId).map((item) => item.id);
          onMove([id], parentId, adjustMoveIndex({ index, dragIds: [id], siblingIds }));
        }
      }
      cleanup();
    };

    const handlePointerCancel = () => cleanup();
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    dragCleanupRef.current = cleanup;
  }, [nodes, onMove]);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const pointerDragContext = useMemo(() => ({
    draggingId: pointerDragState?.id ?? null,
    dropTarget,
    beginDrag,
    suppressClick: () => performance.now() < suppressClickUntil.current,
  }), [beginDrag, dropTarget, pointerDragState?.id]);
  const dropTargetNode = nodes.find((node) => node.id === dropTarget?.anchorId);
  const dropHint = dropTarget?.position === "root"
    ? "移动到根目录末尾"
    : dropTargetNode && dropTarget
      ? dropTarget.position === "inside"
        ? `移入“${dropTargetNode.title}”`
        : `放到“${dropTargetNode.title}”${dropTarget.position === "before" ? "上方" : "下方"}`
      : "拖到页面或文件夹中，或拖到节点之间排序";

  useEffect(() => {
    if (!blankMenu) return;
    const close = () => setBlankMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [blankMenu]);

  return (
    <div
      className="project-tree"
      ref={containerRef}
      tabIndex={-1}
      onMouseDown={(event) => {
        if ((event.target as Element).closest("input, textarea, [contenteditable='true']")) return;
        containerRef.current?.focus({ preventScroll: true });
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if ((event.target as Element).closest("[data-tree-node-id], .tree-context-menu")) return;
        const next = clampTreeMenuPosition(event.clientX, event.clientY, 174, 96);
        setBlankMenu({ x: next.x, y: next.y });
      }}
    >
      <button className="workspace-root tree-item" onClick={() => setWorkspaceOpen((value) => !value)} aria-expanded={workspaceOpen} title={projectPath ?? projectName}>
        <span className="tree-chevron visible">{workspaceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <TreeAssetIcon src={folderIcon} />
        <span className="tree-label">{projectName}</span>
      </button>
      {workspaceOpen && height > TREE_ROW_HEIGHT && (
        <RenameContext.Provider value={renameContext}>
          <MarkerContext.Provider value={{ setMarkerColor: onSetMarkerColor }}>
          <TagContext.Provider value={{ tags, setTags: onSetTags, createTag: onCreateTag, deleteTag: onDeleteTag }}>
          <PointerDragContext.Provider value={pointerDragContext}>
          <div
            className={`workspace-tree-content ${dropTarget?.position === "root" ? "drop-root" : ""}`}
            onKeyDownCapture={(event) => {
              if ((event.target as Element).closest("input")) return;
              if (event.key === "F2" && selectedId) {
                event.preventDefault();
                event.stopPropagation();
                setEditingId(selectedId);
              }
              if (event.key === "Enter" && selectedId) {
                event.preventDefault();
                event.stopPropagation();
                onSelect(selectedId);
              }
            }}
          >
            <Tree<FileTreeNode>
              ref={treeRef}
              data={data}
              width="100%"
              height={height - TREE_ROW_HEIGHT}
              rowHeight={TREE_ROW_HEIGHT}
              indent={TREE_INDENT}
              paddingTop={2}
              paddingBottom={12}
              selection={selectedId}
              disableMultiSelection
              disableDrag
              openByDefault
              childrenAccessor="children"
              idAccessor="id"
              onActivate={(node) => onSelect(node.id)}
              onSelect={(selectedNodes) => {
                const selected = selectedNodes.at(-1);
                if (selected) {
                  onSelect(selected.id);
                  return;
                }
                // Keep the current highlight when clicking blank space below nodes.
                if (selectedId) {
                  window.requestAnimationFrame(() => {
                    treeRef.current?.select(selectedId);
                  });
                }
              }}
              onCreate={({ parentId, type }) => {
                onCreate(type === "internal" ? "folder" : "page", parentId);
                return null;
              }}
              onDelete={({ ids }) => onDelete(ids)}
              onMove={({ dragIds, parentId, index }) => {
                const siblingIds = nodes.filter((item) => item.parentId === parentId).map((item) => item.id);
                onMove(dragIds, parentId, adjustMoveIndex({ index, dragIds, siblingIds }));
              }}
              disableDrop={({ parentNode, dragNodes }) => Boolean(
                !parentNode.isRoot && (
                  parentNode.data.kind === "file" ||
                  dragNodes.some((dragNode) => dragNode.id === parentNode.id || dragNode.isAncestorOf(parentNode))
                )
              )}
              aria-label="项目文件"
            >
              {FileTreeRow}
            </Tree>
          </div>
          {pointerDragState && (
            <div
              className="tree-drag-preview"
              style={{ transform: `translate(${pointerDragState.x + 12}px, ${pointerDragState.y + 12}px)` }}
            >
              <FileText size={14} />
              <span className="tree-drag-preview-copy">
                <strong>{pointerDragState.title}</strong>
                <small>{dropHint}</small>
              </span>
            </div>
          )}
          </PointerDragContext.Provider>
          </TagContext.Provider>
          </MarkerContext.Provider>
        </RenameContext.Provider>
      )}
      {blankMenu && createPortal(
        <div
          className="tree-context-menu is-pointer"
          role="menu"
          style={{ top: blankMenu.y, left: blankMenu.x }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button role="menuitem" onClick={() => { setBlankMenu(null); onCreate("page", null); }}><Plus size={14} />新建页面</button>
          <button role="menuitem" onClick={() => { setBlankMenu(null); onCreate("folder", null); }}><Folder size={14} />新建文件夹</button>
        </div>,
        document.body,
      )}
    </div>
  );
});
