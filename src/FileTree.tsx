import { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Folder,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Tree, adjustMoveIndex } from "react-arborist";
import type { NodeRendererProps, TreeApi } from "react-arborist";
import folderIcon from "./assets/icons/folder.svg";
import noteIcon from "./assets/icons/note.svg";
import type { ContentNode, NodeKind } from "./types";

interface FileTreeNode extends ContentNode {
  children?: FileTreeNode[];
}

interface FileTreeProps {
  nodes: ContentNode[];
  selectedId: string;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onMove: (dragIds: string[], parentId: string | null, index: number) => void;
  onCreate: (kind: Extract<NodeKind, "page" | "folder">, parentId: string | null) => void;
  onDelete: (ids: string[]) => void;
}

const TREE_ROW_HEIGHT = 26;
const TREE_INDENT = 16;

export interface FileTreeHandle {
  revealSelected: () => void;
  expandAll: () => void;
  collapseAll: () => void;
}

const RenameContext = createContext<{
  editingId: string | null;
  startRename: (id: string) => void;
  finishRename: (id: string, title?: string) => void;
}>({ editingId: null, startRename: () => undefined, finishRename: () => undefined });

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

function FileTreeRow({ node, style }: NodeRendererProps<FileTreeNode>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rename = useContext(RenameContext);
  const pointerDrag = useContext(PointerDragContext);
  const isEditing = rename.editingId === node.id;

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as globalThis.Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const parentForNewItem = node.data.kind === "file" ? node.data.parentId : node.id;
  const hasChildren = (node.data.children?.length ?? 0) > 0;
  const dropPosition = pointerDrag.dropTarget?.targetId === node.id
    ? pointerDrag.dropTarget.position
    : null;
  const dropDepth = pointerDrag.dropTarget?.targetId === node.id
    ? pointerDrag.dropTarget.depth
    : 0;
  const rowStyle = dropPosition === "before" || dropPosition === "after"
    ? { ...style, "--drop-depth": dropDepth } as React.CSSProperties
    : style;

  return (
    <div
      style={rowStyle}
      data-tree-node-id={node.id}
      className={`tree-item ${node.isSelected ? "selected" : ""} ${node.isFocused ? "focused" : ""} ${pointerDrag.draggingId === node.id ? "dragging" : ""} ${dropPosition ? `drop-${dropPosition}` : ""}`}
      title={node.data.title}
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
      <div className="tree-actions" ref={menuRef}>
        <button
          className="tree-more"
          aria-label={`${node.data.title} 的更多操作`}
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((value) => !value);
          }}
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen && (
          <div className="tree-context-menu" role="menu" onClick={(event) => event.stopPropagation()}>
            <button role="menuitem" onClick={() => { setMenuOpen(false); rename.startRename(node.id); }}><Pencil size={14} />重命名 <kbd>F2</kbd></button>
            <button role="menuitem" onClick={() => { setMenuOpen(false); node.tree.props.onCreate?.({ parentId: parentForNewItem, parentNode: node.parent, index: 0, type: "leaf" }); }}><Plus size={14} />新建页面</button>
            <button role="menuitem" onClick={() => { setMenuOpen(false); node.tree.props.onCreate?.({ parentId: parentForNewItem, parentNode: node.parent, index: 0, type: "internal" }); }}><Folder size={14} />新建文件夹</button>
            <span className="tree-menu-separator" />
            <button className="danger" role="menuitem" onClick={() => { setMenuOpen(false); node.tree.delete(node.id); }}><Trash2 size={14} />删除 <kbd>⌫</kbd></button>
          </div>
        )}
      </div>
    </div>
  );
}

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
  { nodes, selectedId, onSelect, onRename, onMove, onCreate, onDelete },
  ref,
) {
  const data = useMemo(() => toTree(nodes), [nodes]);
  const [containerRef, height] = useElementHeight<HTMLDivElement>();
  const treeRef = useRef<TreeApi<FileTreeNode> | undefined>(undefined);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
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
              Math.floor((moveEvent.clientX - row.getBoundingClientRect().left) / indent),
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

  return (
    <div className="project-tree" ref={containerRef}>
      <button className="workspace-root tree-item" onClick={() => setWorkspaceOpen((value) => !value)} aria-expanded={workspaceOpen}>
        <span className="tree-chevron visible">{workspaceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <TreeAssetIcon src={folderIcon} />
        <span className="tree-label">HyperSpace</span>
      </button>
      {workspaceOpen && height > TREE_ROW_HEIGHT && (
        <RenameContext.Provider value={renameContext}>
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
              selectionFollowsFocus
              disableDrag
              openByDefault
              childrenAccessor="children"
              idAccessor="id"
              onActivate={(node) => onSelect(node.id)}
              onSelect={(selectedNodes) => {
                const selected = selectedNodes.at(-1);
                if (selected) onSelect(selected.id);
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
        </RenameContext.Provider>
      )}
    </div>
  );
});
