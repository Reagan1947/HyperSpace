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
  noteMarkdown: {
    "page-project": `我们正在构建一种更自然的信息组织方式——让笔记、文件和文件夹在同一个空间里自由流动。

## 本周重点

完成桌面端的信息架构，验证文件夹能够作为块被嵌入笔记，并打通本地同步的第一条链路。

\`\`\`hyperspace
{"version":1,"kind":"folder","targetNodeId":"folder-research","blockId":"b4"}
\`\`\`

## 待确认

> 离线编辑产生的修改需要优先写入本地，再由后台队列安全地同步到云端。

\`\`\`hyperspace
{"version":1,"kind":"file","targetNodeId":"file-report","blockId":"b7"}
\`\`\``,
    "page-meeting": "记录讨论结果、关键决策和后续行动。",
    "page-ideas": "把稍纵即逝的想法留在这里。",
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
    noteMarkdown: { "page-home": "" },
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
    noteMarkdown: {
      "page-guide": `# 欢迎来到「${title}」

这是为你生成的新项目指引。你可以把它当作起点，逐步搭建自己的工作空间。

## 建议从这里开始

- 在左侧文件树中创建笔记、文件夹，整理项目资料。
- 把关键文件拖入或引用到笔记中，让上下文留在同一处。
- 需要版本管理时，可在创建项目时启用 Git，并在底部 Git 面板查看状态。

## 小提示

> 项目数据保存在本地项目目录的 .hyperspace 文件夹中，可随时备份或迁移。`,
      "page-notes": "从这里开始记录你的想法。",
    },
    lastSavedAt: new Date().toISOString(),
  };
}
