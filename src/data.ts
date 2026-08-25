import type { WorkspaceState } from "./types";

export const initialWorkspace: WorkspaceState = {
  selectedNodeId: "page-project",
  nodes: [
    { id: "page-project", parentId: null, kind: "page", title: "产品探索", updatedAt: "刚刚", favorite: true },
    { id: "folder-research", parentId: null, kind: "folder", title: "调研资料", updatedAt: "12 分钟前" },
    { id: "file-report", parentId: "folder-research", kind: "file", title: "用户访谈汇总.pdf", fileType: "PDF", size: "2.4 MB", updatedAt: "昨天" },
    { id: "file-roadmap", parentId: "folder-research", kind: "file", title: "产品路线图.xlsx", fileType: "XLSX", size: "860 KB", updatedAt: "周二" },
    { id: "page-meeting", parentId: null, kind: "page", title: "会议记录", updatedAt: "昨天" },
    { id: "folder-personal", parentId: null, kind: "folder", title: "个人", updatedAt: "周一" },
    { id: "page-ideas", parentId: "folder-personal", kind: "page", title: "灵感收集", updatedAt: "周一" },
  ],
  blocks: {
    "page-project": [
      { id: "b1", kind: "text", content: "我们正在构建一种更自然的信息组织方式——让笔记、文件和文件夹在同一个空间里自由流动。" },
      { id: "b2", kind: "heading", content: "本周重点" },
      { id: "b3", kind: "text", content: "完成桌面端的信息架构，验证文件夹能够作为块被嵌入笔记，并打通本地同步的第一条链路。" },
      { id: "b4", kind: "folder", targetNodeId: "folder-research" },
      { id: "b5", kind: "heading", content: "待确认" },
      { id: "b6", kind: "callout", content: "离线编辑产生的修改需要优先写入本地，再由后台队列安全地同步到云端。" },
      { id: "b7", kind: "file", targetNodeId: "file-report" },
      { id: "b8", kind: "text", content: "" },
    ],
    "page-meeting": [
      { id: "m1", kind: "text", content: "记录讨论结果、关键决策和后续行动。" },
    ],
    "page-ideas": [
      { id: "i1", kind: "text", content: "把稍纵即逝的想法留在这里。" },
    ],
  },
};
