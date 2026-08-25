# HyperSpace Desktop

一个面向笔记、文件和文件夹的本地优先桌面工作空间。

## 当前能力

- 统一的笔记、文件夹和文件内容树，支持键盘导航、展开折叠、内联重命名和拖拽整理
- 文件夹与文件块嵌入笔记
- 页面和正文编辑
- 本地搜索与页面跳转原型
- Tauri 应用数据目录持久化
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

桌面数据存放在操作系统为 `com.hyperspace.desktop` 分配的应用数据目录中，文件名为 `workspace.json`。
