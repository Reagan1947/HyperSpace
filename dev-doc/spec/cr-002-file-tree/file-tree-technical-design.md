# CR-02 文件树技术方案

## 1. 文档说明

本文档根据当前代码实现反向整理 HyperSpace 文件树的技术设计，解释数据结构、组件职责、拖拽算法、状态更新和持久化链路。

- 关联需求：[文件树功能需求文档](file-tree-requirements.md)
- 核心实现：`../../../src/FileTree.tsx`
- 状态编排：`../../../src/App.tsx`
- 数据类型：`../../../src/types.ts`
- 本地存储：`../../../src/storage.ts`
- 交互样式：`../../../src/styles.css`

## 2. 技术目标

1. 使用单一工作空间状态表达树结构，避免树组件持有另一份业务数据。
2. 页面与文件夹均支持子节点，文件保持叶子语义。
3. 使用 Pointer Events 实现桌面 WebView 中稳定的拖拽。
4. 将视觉落点完整解析为 `parentId + index`，再由上层统一更新数据。
5. 用横向指针位置和插入线长度表达层级意图。
6. 保证移动操作不会产生循环引用，并正确处理同级索引偏移。

## 3. 技术栈与依赖

| 技术 | 用途 |
| --- | --- |
| React 19 | 组件、状态和生命周期管理 |
| TypeScript | 节点、落点和回调接口约束 |
| react-arborist | 树渲染、虚拟列表、展开、选择和键盘焦点 |
| Pointer Events | 自定义拖拽手势 |
| ResizeObserver | 根据侧边栏高度更新树可视区域 |
| Tauri API | 桌面端工作空间持久化 |
| localStorage | Web 预览环境持久化 |

`react-arborist` 的原生拖拽通过 `disableDrag` 关闭。原因是 HTML5 Drag and Drop 在目标桌面 WebView 中无法稳定触发；当前实现只复用其树渲染和选择能力。

## 4. 总体架构

```text
App
├── WorkspaceState
│   ├── nodes: ContentNode[]
│   ├── blocks: Record<pageId, NoteBlock[]>
│   └── selectedNodeId
├── ProjectSidebar
│   └── FileTree
│       ├── toTree：扁平数据转渲染树
│       ├── react-arborist Tree：虚拟化/展开/选择
│       ├── RenameContext：行内重命名
│       ├── PointerDragContext：拖拽状态和落点
│       └── FileTreeRow：单行渲染与菜单
└── loadWorkspace / saveWorkspace
```

职责边界：

| 模块 | 职责 |
| --- | --- |
| `FileTree` | 树形派生、交互状态、拖拽命中和落点计算 |
| `FileTreeRow` | 节点视觉、菜单、重命名输入和拖拽手势入口 |
| `ProjectSidebar` | 将工作空间与业务回调传给文件树 |
| `App` | 新建、重命名、移动、删除、页签和选中状态更新 |
| `storage.ts` | 环境识别、读取、迁移和保存工作空间 |

## 5. 数据模型

### 5.1 业务节点

```ts
type NodeKind = "page" | "folder" | "file";

interface ContentNode {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  title: string;
  icon?: string;
  fileType?: string;
  size?: string;
  updatedAt: string;
  favorite?: boolean;
}
```

设计要点：

- 业务状态保存为扁平数组，父子关系只由 `parentId` 表达。
- `parentId = null` 表示根级节点。
- 同级顺序由数组中的相对位置表达，不增加独立 `sortOrder` 字段。
- 移动容器时只需修改容器自身的 `parentId` 和数组位置，其后代仍引用原父节点，因此整棵子树自然随容器移动。

### 5.2 渲染节点

```ts
interface FileTreeNode extends ContentNode {
  children?: FileTreeNode[];
}
```

`toTree(nodes)` 的转换过程：

1. 按 `parentId` 建立 `childrenByParent` 映射。
2. 从 `parentId = null` 的节点开始递归构建。
3. 页面和文件夹生成 `children` 数组，因而可成为内部节点。
4. 文件不生成 `children`，保持叶子节点。
5. 使用 `visited` 集合防止异常数据导致无限递归。

扁平数组是唯一业务事实源，嵌套树仅供渲染，每次 `nodes` 变化后通过 `useMemo` 重新生成。

### 5.3 拖拽状态

```ts
type DropPosition = "before" | "inside" | "after" | "root";

interface DropTarget {
  targetId: string | null; // 指针当前所在行，用于显示指示器
  anchorId: string | null; // 解析层级后真正的前后锚点
  position: DropPosition;
  parentId: string | null; // 最终目标父节点
  index: number;           // 目标父节点下的插入槽位
  depth: number;           // 指示线对应的最终深度
}

interface PointerDragState {
  id: string;
  title: string;
  x: number;
  y: number;
}
```

`targetId` 与 `anchorId` 分离是层级感知拖拽的关键。例如指针位于文件夹最后一个子项下方，但横向移动到父级深度时：

- `targetId` 仍是该子项，指示线显示在用户正在观察的位置；
- `anchorId` 提升为文件夹，实际结果是插入到文件夹之后；
- `depth` 变为文件夹深度，指示线同步向左延长。

## 6. 树渲染与基础交互

### 6.1 尺寸与虚拟列表

- `useElementHeight` 使用 `ResizeObserver` 读取 `.project-tree` 高度。
- 树高度为容器高度减去 30 px 的工作空间根节点行。
- 行高固定为 30 px，层级缩进固定为 18 px。
- 顶部内边距为 2 px，底部内边距为 12 px。

### 6.2 选择和展开

- `selection` 由 `WorkspaceState.selectedNodeId` 控制。
- `disableMultiSelection` 保证当前仅单选。
- `selectionFollowsFocus` 使键盘焦点与选中节点保持一致。
- `onActivate` 和 `onSelect` 最终调用 `App.selectNode`，同步选中状态和打开页签。
- 展开状态由 react-arborist 管理，初始 `openByDefault = true`。

### 6.3 重命名上下文

`RenameContext` 提供：

- `editingId`：当前编辑节点；
- `startRename(id)`：进入重命名；
- `finishRename(id, title?)`：标准化名称并提交。

输入框进入后自动聚焦和全选。`Escape` 不传新值，`Enter` 或失焦传入编辑值。名称经 `trim` 后为空时不调用业务回调。

### 6.4 节点菜单

菜单使用行内绝对定位，通过全局 `mousedown` 监听实现点击外部关闭。菜单操作直接转发到 Tree 的创建/删除入口或 RenameContext。

新建父节点计算：

```ts
const parentForNewItem = node.kind === "file"
  ? node.parentId
  : node.id;
```

因此页面和文件夹下创建子节点，文件旁创建同级节点。

## 7. Pointer Events 拖拽方案

### 7.1 为什么使用自定义拖拽

原生 HTML5 拖拽依赖浏览器/系统 Drag and Drop 后端，在 Tauri WebView 中存在手势不触发或落点不更新的问题。自定义方案只依赖以下标准事件：

- `pointerdown`：记录拖拽候选；
- `pointermove`：超过阈值后启动并持续计算落点；
- `pointerup`：提交移动；
- `pointercancel`：取消并清理。

监听绑定在 `window`，保证指针离开原节点后仍能继续拖动。

### 7.2 启动与点击隔离

```text
pointerdown
  ├── 非主键：忽略
  ├── 来自 button/input/menu：忽略
  └── 记录 startX/startY
        ├── 移动距离 < 5 px：仍是点击
        └── 移动距离 ≥ 5 px：进入拖拽
```

拖拽结束后记录一个 250 ms 的点击抑制窗口。节点行的 `onClickCapture` 在该窗口内阻止冒泡，避免 `pointerup` 后附带的 click 打开节点。

### 7.3 命中节点

每个节点行写入：

```html
<div data-tree-node-id="...">
```

移动时调用 `document.elementFromPoint(clientX, clientY)`，再使用 `closest("[data-tree-node-id]")` 获取当前节点行。浮动预览设置 `pointer-events: none`，不会遮挡命中测试。

### 7.4 纵向落点解析

设：

```ts
ratio = (pointerY - row.top) / row.height;
```

解析规则：

```text
ratio < 0.28             -> before
ratio > 0.72             -> after
0.28 <= ratio <= 0.72
  ├── page/folder        -> inside
  └── file               -> ratio < 0.5 ? before : after
```

`inside` 落点直接解析为：

```ts
parentId = targetId;
index = children(targetId).length;
depth = depth(targetId) + 1;
```

### 7.5 横向目标深度

对 `before` 和 `after` 落点，根据指针横坐标计算期望深度：

```ts
desiredDepth = clamp(
  floor((pointerX - row.left) / 18),
  0,
  targetDepth,
);
```

含义：

- 指针保持在节点正文缩进范围内时，期望深度等于目标节点深度；
- 指针每向左跨过约 18 px，期望深度降低一级；
- CSS 指示线的 `left` 使用同一深度值，因此视觉线长和实际目标层级一致。

### 7.6 边界提升算法

`resolveBoundary` 从当前悬停节点开始向父级检查：

```text
anchor = hoveredNode
anchorDepth = depth(hoveredNode)

while anchorDepth > desiredDepth:
  siblings = children(anchor.parentId)
  edge = before ? siblings.first : siblings.last

  if anchor != edge:
    break

  anchor = parent(anchor)
  anchorDepth -= 1

parentId = anchor.parentId
index = indexOf(anchor) + (after ? 1 : 0)
```

必须满足首/末边界才能提升的原因：若悬停节点后仍有兄弟节点，把落点直接提升到父节点之后会在视觉上跨过这些兄弟节点，导致指示线和最终结果不一致。

该算法天然支持多层提升，只要每一层都持续满足对应的首/末边界条件。

### 7.7 循环保护

落点生成后，从 `destination.parentId` 沿父链向上查找：

```text
若任意祖先 id == draggingId，则落点无效
```

同时，当前悬停节点等于拖动节点时不生成落点。这两项共同阻止拖入自身和拖入后代。

### 7.8 松手提交

`DropTarget` 已包含完整的 `parentId` 和预移除状态下的 `index`。提交前使用 react-arborist 提供的 `adjustMoveIndex` 修正同级拖动偏移：

```ts
const siblingIds = nodes
  .filter(node => node.parentId === parentId)
  .map(node => node.id);

const adjustedIndex = adjustMoveIndex({
  index,
  dragIds: [draggingId],
  siblingIds,
});

onMove([draggingId], parentId, adjustedIndex);
```

## 8. 视觉反馈实现

### 8.1 状态类

| 类名 | 含义 |
| --- | --- |
| `.dragging` | 当前拖动源节点 |
| `.drop-before` | 插入到目标边界上方 |
| `.drop-after` | 插入到目标边界下方 |
| `.drop-inside` | 移入页面或文件夹 |
| `.drop-root` | 移动到根目录末尾 |
| `.is-tree-dragging` | 页面处于文件树拖拽状态 |

### 8.2 深度指示线

行组件根据 `DropTarget.depth` 注入 CSS 自定义属性：

```css
--drop-depth: <number>;
```

插入线使用：

```css
left: calc(var(--drop-depth, 0) * 18px);
right: 4px;
height: 2px;
```

结果：

- 深度越大，左侧起点越靠右，线越短；
- 深度越小，左侧起点越靠左，线越长；
- 90 ms 的 `left` 过渡帮助用户感知层级切换。

### 8.3 浮动预览

预览以 `position: fixed` 跟随指针，并展示：

- 被拖节点标题；
- “移入某节点”；
- “放到某节点上方/下方”；
- “移动到根目录末尾”；
- 没有有效落点时的操作提示。

## 9. 工作空间状态更新

### 9.1 移动算法

`App.moveNodes(ids, parentId, index)` 执行：

1. 按 `ids` 取出移动节点并更新 `parentId`、`updatedAt`。
2. 从原数组移除移动节点。
3. 获取目标父节点下剩余兄弟节点。
4. 通过目标兄弟锚点查找扁平数组插入位置。
5. 无锚点时插入到目标兄弟末尾；空容器时插到父节点之后；根目录空位插到数组末尾。
6. 将移动节点插回数组并更新工作空间。

由于树展示时会按 `parentId` 重新分组，子节点不要求在扁平数组中紧邻父节点，但当前插入策略尽量保持可读的局部顺序。

### 9.2 新建

- ID 格式为 `<kind>-<timestamp>-<random>`。
- 新页面创建默认空文本块。
- 新节点追加到扁平数组，并成为当前选择和新页签。

### 9.3 删除

- 使用集合保存根删除节点和全部后代 ID。
- 迭代扫描父子关系，直到不再发现新的后代。
- 过滤节点、内容块和打开页签。
- 空工作空间创建兜底页面，保证 `selectedNodeId` 始终有合法目标。

## 10. 持久化链路

```text
用户操作
  -> setWorkspace
  -> React 状态变化
  -> 500 ms 防抖计时
  -> saveWorkspace
       ├── Tauri: invoke("save_workspace", payload)
       └── Web: localStorage.setItem(...)
```

启动读取：

1. Tauri 调用 `load_workspace`，Web 读取 localStorage。
2. JSON 反序列化为 `WorkspaceState`。
3. 对旧版 `folder-work` 虚拟工作空间节点执行迁移，将其直接子节点提升到根级。
4. 读取失败时返回 `null` 并保留初始工作空间。

## 11. 生命周期与异常处理

- 新拖拽开始前调用上一次拖拽的清理函数。
- `pointerup`、`pointercancel` 和组件卸载均移除 window 级监听。
- 清理时恢复 body 光标和文字选择状态，并清空预览及落点。
- 只有命中有效节点并完成循环校验后才生成可提交落点；无落点时松手不更新状态。
- 存储异常记录警告并将同步状态切换为离线，不回滚内存中的用户操作。

## 12. 测试方案

### 12.1 单元测试建议

建议将以下纯逻辑抽离后覆盖表格驱动测试：

- `toTree`：页面/文件夹子树、文件叶子和异常循环；
- `getDepth`：根级及多层深度；
- `resolveBoundary`：首项、末项、非边缘项和多层提升；
- `adjustMoveIndex` 组合：同级向前、向后和跨父节点移动；
- 循环保护：自身、直接子节点和多层后代。

### 12.2 组件测试建议

- 5 px 阈值前后点击与拖拽行为；
- 菜单、输入框、展开按钮不启动拖拽；
- 纵向 28%/72% 边界；
- 文件中部不能出现 `.drop-inside`；
- `--drop-depth` 与解析深度一致；
- pointercancel 后状态和全局类名清理。

### 12.3 端到端测试建议

完整用例以需求文档 AC-01 至 AC-15 为准，重点覆盖：

1. 文件跨目录移动；
2. 根级和子级排序；
3. 最后子项短线留在目录、长线移出目录；
4. 多层提升和非边缘节点保护；
5. 刷新后的结构持久化；
6. Web 与 Tauri 桌面端行为一致性。

## 13. 已知限制与演进方向

当前算法每次 pointermove 会在线性数组中多次查找节点、父节点和兄弟节点。当前工作空间规模较小时足够；节点规模扩大后建议：

1. 在 `nodes` 变化时预计算 `nodeById`、`childrenByParent` 和 `depthById`；
2. 将拖拽纯逻辑抽到独立模块并增加单元测试；
3. 增加边缘自动滚动与折叠容器延时展开；
4. 增加键盘拖拽和可访问性实时播报；
5. 引入撤销/重做命令，避免误移动后只能手动恢复；
6. 若未来支持批量拖动，需要扩展索引调整、循环校验和预览文案；
7. 若改用显式 `sortOrder`，需提供旧数组顺序到排序字段的数据迁移。
