import type { WorkspaceState } from "./types";

export const initialWorkspace: WorkspaceState = {
  selectedNodeId: "page-project",
  tags: [
    { id: "tag-focus", name: "重点" },
    { id: "tag-research", name: "调研" },
    { id: "tag-idea", name: "灵感" },
  ],
  nodes: [
    { id: "page-project", parentId: null, kind: "page", title: "产品探索", updatedAt: "刚刚", favorite: true, tagIds: ["tag-focus"] },
    { id: "folder-research", parentId: null, kind: "folder", title: "调研资料", updatedAt: "12 分钟前" },
    { id: "file-report", parentId: "folder-research", kind: "file", title: "用户访谈汇总.pdf", fileType: "PDF", size: "2.4 MB", updatedAt: "昨天", tagIds: ["tag-research"] },
    { id: "file-roadmap", parentId: "folder-research", kind: "file", title: "产品路线图.xlsx", fileType: "XLSX", size: "860 KB", updatedAt: "周二", tagIds: ["tag-focus"] },
    { id: "page-meeting", parentId: null, kind: "page", title: "会议记录", updatedAt: "昨天", tagIds: ["tag-focus"] },
    { id: "folder-personal", parentId: null, kind: "folder", title: "个人", updatedAt: "周一" },
    { id: "page-ideas", parentId: "folder-personal", kind: "page", title: "灵感收集", updatedAt: "周一", tagIds: ["tag-idea"] },
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

export function createBlankWorkspace(projectName: string): WorkspaceState {
  const title = projectName.trim() || "无标题";
  return {
    selectedNodeId: "page-home",
    nodes: [
      {
        id: "page-home",
        parentId: null,
        kind: "page",
        title,
        updatedAt: "刚刚",
        favorite: true,
      },
    ],
    blocks: {
      "page-home": [{ id: "home-1", kind: "text", content: "" }],
    },
    editorDocuments: {},
    lastSavedAt: new Date().toISOString(),
  };
}

export function createGuidedWorkspace(projectName: string): WorkspaceState {
  const title = projectName.trim() || "新项目";
  return {
    selectedNodeId: "page-guide",
    nodes: [
      {
        id: "page-guide",
        parentId: null,
        kind: "page",
        title: "新项目指引",
        updatedAt: "刚刚",
        favorite: true,
      },
      {
        id: "page-notes",
        parentId: null,
        kind: "page",
        title: "笔记",
        updatedAt: "刚刚",
      },
    ],
    blocks: {
      "page-guide": [
        {
          id: "g1",
          kind: "heading1",
          content: `欢迎来到「${title}」`,
        },
        {
          id: "g2",
          kind: "text",
          content: "这是为你生成的新项目指引。你可以把它当作起点，逐步搭建自己的工作空间。",
        },
        { id: "g3", kind: "heading", content: "建议从这里开始" },
        {
          id: "g4",
          kind: "bullet",
          content: "在左侧文件树中创建笔记、文件夹，整理项目资料。",
        },
        {
          id: "g5",
          kind: "bullet",
          content: "把关键文件拖入或引用到笔记中，让上下文留在同一处。",
        },
        {
          id: "g6",
          kind: "bullet",
          content: "需要版本管理时，可在创建项目时启用 Git，并在底部 Git 面板查看状态。",
        },
        { id: "g7", kind: "heading", content: "小提示" },
        {
          id: "g8",
          kind: "callout",
          content: "项目数据保存在本地项目目录的 .hyperspace 文件夹中，可随时备份或迁移。",
        },
        { id: "g9", kind: "text", content: "" },
      ],
      "page-notes": [
        { id: "n1", kind: "text", content: "从这里开始记录你的想法。" },
      ],
    },
    editorDocuments: {},
    lastSavedAt: new Date().toISOString(),
  };
}
