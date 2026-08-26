# HyperSpace Desktop

一个面向笔记、文件和文件夹的本地优先桌面工作空间。

## 当前能力

- 统一的笔记、文件夹和文件内容树，支持键盘导航、展开折叠、内联重命名和拖拽整理
- 文件夹与文件块嵌入笔记
- 页面和正文编辑
- 本地搜索与页面跳转原型
- 笔记按独立 Markdown 和无损文档 sidecar 持久化，支持旧版 `workspace.json` 自动迁移
- 真实 Git 状态、提交与历史查看
- 项目目录内的交互式 Terminal，支持 ANSI 输出、窗口缩放和会话重启
- PDF 导入与 Git LFS 跟踪
- 本地全文索引，可搜索笔记正文、文件名、路径和标签
- `hyperspace://` 桌面 Deep Link 协议注册
- Web 环境下使用 LocalStorage 作为开发回退

## 环境要求

- Node.js 20+
- Rust stable
- 当前平台对应的 Tauri 系统依赖

## 开发

```bash
npm install
npm run desktop:dev
```

仅调试前端：

```bash
npm run dev
```

## 构建

```bash
npm run build
npm run desktop:build
```

## 项目数据

创建本地项目后，HyperSpace 使用以下布局：

```text
project-root/
├── notes/<node-id>.md
├── attachments/
├── .gitattributes
├── .gitignore
└── .hyperspace/
    ├── manifest.json
    ├── nodes/<node-id>.json
    ├── documents/<node-id>.json
    └── search-index.json
```

`search-index.json` 是可重建的本地派生数据，不进入 Git。没有打开本地项目时，应用仍使用操作系统为 `com.hyperspace.desktop` 分配的应用数据目录作为兼容回退。

PDF 的 Git LFS 导入需要系统安装 `git-lfs`。HyperSpace 会为项目执行本地 `git lfs install --local`，并在依赖缺失时阻止 PDF 被误提交进普通 Git。
