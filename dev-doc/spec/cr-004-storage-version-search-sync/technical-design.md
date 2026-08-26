# HyperSpace 版本管理、对象存储、搜索与本地同步技术方案

## 1. 文档信息

- 状态：提案
- 适用范围：HyperSpace Desktop 及后续云端服务
- 目标版本：分阶段落地，第一阶段不依赖完整云端服务即可运行
- 当前基线：工作空间整体保存在 `.hyperspace/workspace.json`，Git 仅支持创建项目时执行 `git init`，搜索仅匹配节点标题与标签

## 2. 目标与非目标

### 2.1 目标

1. 笔记具备可查看、比较、恢复和合并的版本历史。
2. 项目可以同时包含笔记、目录、图片、音视频、压缩包、数据集及其他任意文件。
3. 大文件内容以 OSS 为最终持久化载体，避免 Git 仓库随二进制文件快速膨胀。
4. 支持 Git 的状态、提交、分支、拉取、推送和冲突处理，并支持标准 Git LFS 客户端。
5. 文件名、路径、标签、笔记正文和可提取的文件正文可以快速搜索。
6. 保持 local-first：无网络时可编辑、查看本地文件和搜索，联网后再同步。
7. 数据模型从一开始就支持后续与本地文件系统的双向同步。

### 2.2 非目标

- 第一阶段不实现多人实时协同编辑；先实现设备间异步同步和冲突处理。
- OSS 不直接承担数据库、可变引用或搜索引擎职责。
- 搜索索引不是数据源，不参与备份，任何时候都可以从工作树和对象重新构建。

## 3. 核心结论

采用“工作树 + Git 元数据历史 + Git LFS/OSS 大对象 + 本地索引 + 同步控制面”的分层架构：

```text
React / BlockNote
       │ Tauri command/event
       ▼
Rust Core
  ├── Workspace Service     节点、路径、笔记序列化、原子写入
  ├── Version Service       Git status/diff/commit/branch/merge
  ├── Object Service        哈希、缓存、分片上传、Git LFS
  ├── Index Service         元数据/全文提取/增量索引
  └── Sync Engine           变更日志、拉取、合并、重试
       │
       ├── 本地工作树 + .git
       ├── .hyperspace/state.db
       ├── .hyperspace/index/
       └── .hyperspace/cache/objects/
                         │
                         ▼
Cloud Control Plane                         Object Plane
  ├── Auth / Workspace API                    ├── OSS blobs
  ├── PostgreSQL：成员、refs、上传会话         ├── OSS LFS objects
  ├── Git HTTP/SSH service                    └── OSS snapshots/backups
  ├── Git LFS Batch API
  └── 可选云端搜索
```

关键约束：OSS 只保存不可变对象。`workspace head`、分支引用、上传会话和权限等可变状态必须由数据库或 Git 服务原子更新，不能依赖覆盖 OSS 上的 `latest.json`。

## 4. 本地项目布局

建议将现有单一 `workspace.json` 拆为可独立变更、可合并、可索引的文件：

```text
project-root/
├── .git/
├── .gitattributes
├── .gitignore
├── .hyperspace/
│   ├── manifest.json              # schema 版本、workspaceId、功能开关
│   ├── nodes/                     # 稳定 ID 与路径/类型映射，进入 Git
│   │   └── <node-id>.json
│   ├── state.db                   # 本机状态与同步队列，不进入 Git/OSS 快照
│   ├── index/                     # 可重建搜索索引，不进入 Git
│   ├── cache/objects/             # 已下载对象缓存，不进入 Git
│   └── tmp/                       # 原子写入和下载临时区，不进入 Git
├── notes/
│   └── product-exploration.md     # 笔记的可移植主格式
├── research/
│   ├── report.pdf                 # 工作树是实际文件，Git index 中是 LFS pointer
│   └── roadmap.xlsx               # LFS 内容最终持久化到 OSS
└── src/                           # 普通小文件可直接由 Git 管理
```

### 4.1 节点身份与路径分离

所有节点使用 UUID/ULID 作为永久 `node_id`，路径只是可变属性。重命名和移动不能产生新节点 ID，否则引用、历史和搜索结果会失效。

`nodes/<node-id>.json` 示例：

```json
{
  "schemaVersion": 1,
  "id": "01J...",
  "kind": "note",
  "path": "notes/product-exploration.md",
  "mime": "text/markdown",
  "tags": ["focus"],
  "contentHash": "sha256:...",
  "createdAt": "2026-08-26T10:00:00Z"
}
```

`updatedAt`、本机绝对路径、下载进度、最近打开时间等高频或设备相关字段只放入 `state.db`，避免制造无意义的 Git 冲突。

### 4.2 笔记格式

笔记以 UTF-8 Markdown 作为主格式，YAML front matter 保存稳定 ID、标题和 schema 版本；HyperSpace 特有块使用有版本号的 Markdown 扩展语法。

```markdown
---
id: 01J...
title: 产品探索
schemaVersion: 1
---

我们正在构建一种更自然的信息组织方式。

<!-- hs:block id="01J..." type="file" -->
[用户访谈汇总](hyperspace://node/01J...)
```

保存时必须保证确定性：固定换行符、字段顺序和 Markdown 输出规则。这样 Git diff 才稳定。BlockNote 文档在读写边界转换为该格式，不再把整个 `editorDocuments` 作为一个大型 JSON 保存。

对暂时无法无损表示的编辑器块，可使用带版本号的 fenced JSON 扩展，但必须局部化到单个块，不能退回整个工作空间 JSON。

## 5. 版本管理设计

### 5.1 两类历史

不要把“每次自动保存”都变成用户可见 Git commit：

| 历史类型 | 用途 | 载体 | 策略 |
|---|---|---|---|
| 本地恢复点 | 崩溃恢复、撤销近期误操作 | `state.db` 变更日志/增量快照 | 秒级写入，按时间和容量滚动清理 |
| 项目版本 | 查看差异、恢复、分支、跨设备同步 | Git commit | 用户手动提交；可选空闲 5 分钟自动 checkpoint |

本地恢复点不推送。自动 checkpoint 可写入隐藏引用 `refs/hyperspace/checkpoints/<device-id>`，避免污染主分支；用户确认后再形成普通提交。

### 5.2 Git 能力边界

Rust Core 统一封装 Git，不允许 React 直接拼装 shell 命令。首版可调用系统 `git`/`git-lfs`，后续如需减少外部依赖再迁移至 `git2`；所有参数使用进程参数数组传递。

应提供以下命令和事件：

- `git_capabilities`：检测 Git/LFS 版本、远端和仓库状态。
- `git_status`、`git_diff`、`git_log`、`git_show`。
- `git_stage`、`git_unstage`、`git_commit`。
- `git_fetch`、`git_pull`、`git_push`、`git_branch`。
- `git_restore_version`：优先恢复指定节点，不默认回退整个仓库。
- `git_conflicts`：返回结构化冲突，不把 CLI 文本直接交给 UI 解析。

Git 凭据使用系统 Keychain/Credential Manager，绝不写入项目文件或前端状态。

### 5.3 Git LFS 策略

大文件仍保留在用户可理解的工作树路径中，Git 中提交的是标准 LFS pointer：

```text
version https://git-lfs.github.com/spec/v1
oid sha256:<content-hash>
size <bytes>
```

默认策略：

1. 图片、音视频、Office/PDF、压缩包、模型和数据库文件默认进入 LFS。
2. 其他文件超过可配置阈值（建议 10 MiB）时，导入界面提示加入 LFS。
3. `.gitattributes` 进入 Git，规则修改本身也是可审计版本。
4. 已经提交进普通 Git 历史的大文件不自动重写历史；迁移必须是显式维护操作。
5. 未安装 Git LFS 时允许继续编辑笔记，但阻止错误提交应由 LFS 管理的大文件，并给出安装/修复提示。

Git LFS 不能只靠 OSS bucket URL 工作。云端必须提供标准 LFS Batch API，由它完成鉴权并返回短时效的 OSS 预签名上传/下载地址：

```text
git lfs push
  -> POST /git/<workspace>.git/info/lfs/objects/batch
  -> LFS Service 校验 workspace 权限和对象是否存在
  -> 返回 OSS multipart/pre-signed upload action
  -> 客户端直传 OSS
  -> verify API 校验 size + sha256，登记对象可用
```

OSS key 使用内容寻址，例如 `lfs/sha256/ab/cd/<64-char-oid>`。对象不可覆盖；相同内容天然去重。

### 5.4 冲突处理

- 笔记：基于共同祖先执行三方合并；优先按稳定 block ID 合并，再退化为文本 diff3。
- 节点元数据：忽略可派生字段，对 `path`、`parentId`、`tags` 做字段级三方合并。
- 二进制文件：不尝试内容合并，保留双方版本，生成“冲突副本”，由用户选择。
- 删除与修改冲突：保留修改版本到恢复区，UI 明确询问是否删除。
- 路径大小写冲突：同步前按目标文件系统规则校验，尤其处理 macOS/Windows 大小写不敏感问题。

## 6. OSS 对象存储设计

### 6.1 OSS 中保存什么

```text
oss://bucket/
├── blobs/sha256/ab/cd/<hash>                  # 通用不可变内容对象
├── lfs/sha256/ab/cd/<oid>                    # 标准 Git LFS 对象
├── snapshots/<workspace-id>/<snapshot-id>/manifest.json
├── git-backups/<workspace-id>/<timestamp>.bundle
└── quarantine/<upload-id>                    # 未校验完成的临时上传
```

- Git 小对象和分支引用由 Git 服务管理；定期生成 bundle/pack 备份到 OSS。
- 大文件/LFS 对象直接持久化到 OSS。
- `snapshot manifest` 记录某个版本包含的节点及其内容哈希，用于灾难恢复、完整性校验和未来非 Git 客户端。
- 本地索引、缩略图和提取文本可缓存到 OSS，但不能作为唯一数据源。

如果“所有用户内容最终都必须落 OSS”是硬性要求，则每次服务端接受 Git push 后，还需由 snapshot worker 展开新 commit tree：普通小文件按 SHA-256 写入 `blobs/`，大文件复用 `lfs/` 对象，最后写入引用这些对象的 immutable manifest。Git 服务的仓库存储是在线读写层，OSS snapshot/bundle 是长期持久化与灾难恢复层；两者不能用简单的 bucket 目录映射互相替代。

### 6.2 控制面最小数据模型

PostgreSQL 建议至少包含：

- `workspaces(id, owner_id, git_repo_id, head_commit, status)`
- `workspace_members(workspace_id, user_id, role)`
- `objects(hash, size, mime, storage_key, state, ref_count)`
- `object_refs(workspace_id, node_id, commit_id, object_hash)`
- `upload_sessions(id, workspace_id, object_hash, state, expires_at)`
- `devices(id, user_id, last_seen_at)`
- `sync_cursors(workspace_id, device_id, last_commit, last_event_seq)`
- `events(seq, workspace_id, type, payload, created_at)`

`objects.state` 至少区分 `quarantine / available / deleting`。只有服务端校验哈希和大小后才能切换为 `available`。

### 6.3 一致性与回收

上传采用“先对象、后引用”：

1. 客户端计算 SHA-256 并申请上传。
2. 对象不存在时直传 quarantine；存在时直接复用。
3. 服务端验证后登记为 available。
4. Git push 或 snapshot 提交成功后创建引用。
5. 后台 GC 仅删除超过宽限期且无引用的对象。

不能在 Git push 尚未成功时立即删除未引用对象，否则重试会反复上传。建议未引用对象保留 7 天，历史版本的实际保留期由项目策略决定。

## 7. 搜索与索引

### 7.1 本地索引优先

桌面端搜索必须在离线状态可用。推荐在 Rust Core 中使用：

- SQLite：节点、同步游标、提取任务和对象缓存元数据。
- Tantivy：标题、路径、标签、笔记正文及文件提取文本的倒排索引。
- 中文分词：索引时使用 Jieba/同类 tokenizer，同时保存字符 n-gram 字段支持文件名和短语模糊匹配。

若希望第一阶段减少依赖，可先用 SQLite FTS5 + 预分词实现，接口保持不变，数据量增大后替换为 Tantivy。索引目录始终可删除重建。

### 7.2 索引文档模型

每个节点一个主文档，长文件按页或固定 token 数拆成 chunk：

```text
SearchDocument
  node_id
  workspace_id
  path
  title
  kind
  mime
  tags[]
  content
  chunk_no
  content_hash
  extractor_version
  modified_at
```

搜索结果返回 `node_id + chunk_no + highlights`，再由节点表解析当前路径。索引不能把路径当主键，否则重命名会造成大量失效记录。

### 7.3 内容提取流水线

```text
文件/笔记发生变化
  -> 计算 content_hash
  -> 查询 extraction_cache(hash, extractor_version)
  -> 文本提取
       ├── Markdown/TXT/代码：直接解析
       ├── PDF：文本层提取
       ├── DOCX/PPTX/XLSX：结构化解析
       ├── 图片/扫描 PDF：可选 OCR
       └── 其他格式：仅索引元数据
  -> 分词与 chunk
  -> 原子更新索引
```

提取任务必须有文件大小、页数、运行时间和内存上限。第三方解析器放在受限子进程中，避免恶意文件影响主进程。

### 7.4 排序与云端搜索

首版排序可采用：标题精确匹配 > 标题前缀 > 标签/路径 > 正文 BM25 > 最近打开时间。语义向量搜索作为后续可选能力，不替代关键词索引。

如果后续需要 Web 端或跨设备“未下载即搜索”，云端从已确认 snapshot/event 异步构建 OpenSearch/Elasticsearch 索引。云端搜索只返回用户有权限的 workspace 数据；本地索引仍为桌面端默认路径。

## 8. 本地文件系统同步

### 8.1 同步模型

项目目录本身就是工作树，不额外维护一份“应用内部文件副本”。编辑器保存和外部程序修改都汇入同一个变更日志：

```text
编辑器保存 ─┐
            ├─> File Event Normalizer -> state.db journal -> hash/index -> Git/OSS sync
FS watcher ─┘
```

Rust 端使用跨平台 watcher 监听目录，但 watcher 事件只作为“可能变化”的提示。最终状态必须通过重新 stat/hash 确认，因为操作系统可能合并、重复或丢失事件。

### 8.2 变更日志

`state.db` 中维护单调递增 journal：

```text
change_journal(
  seq, node_id, op, old_path, new_path,
  base_hash, content_hash, source, state, created_at
)
```

- `source`：`editor / filesystem / remote`，用于抑制自身写入造成的事件回环。
- `state`：`pending / indexing / uploading / committed / failed`。
- 所有任务幂等；应用重启后从未完成状态继续。

### 8.3 文件身份识别

优先级如下：

1. 已存在的 `.hyperspace/nodes/<id>.json` 路径映射。
2. 平台 file ID/inode 仅作短期重命名辅助，不能作为跨设备 ID。
3. 内容哈希 + 时间窗口用于识别外部移动。
4. 无法确认时创建新 node_id，旧节点进入删除候选，不冒险错误合并。

不要依赖扩展属性保存唯一 ID：压缩、网盘和跨平台复制经常丢失 xattr。可将 xattr 作为优化，但 sidecar 元数据才是可移植依据。

### 8.4 拉取与推送流程

推送：

1. 刷新 watcher 事件，完成所有文件原子写入。
2. 计算内容哈希并更新本地索引。
3. 创建 checkpoint/用户 commit，确定需要引用的 LFS OID。
4. 上传缺失的 LFS/OSS 对象并校验。
5. `fetch` 后检查远端 head；必要时三方合并。
6. push Git refs，成功后更新同步游标。

拉取：

1. fetch refs 和缺失的小对象。
2. 计算本地未提交修改并创建恢复点。
3. fast-forward 或进入结构化合并流程。
4. 按需下载 LFS 对象：列表和搜索只需 pointer/元数据，打开文件时再取正文。
5. 临时文件下载完成并验证 SHA-256 后原子替换目标文件。
6. 增量更新节点表和搜索索引。

默认不在首次同步时下载所有大文件。节点需要 `local_state = present / placeholder / downloading / error`，UI 显示云端占位状态。

## 9. Tauri 模块边界

建议将当前 `src-tauri/src/lib.rs` 拆分：

```text
src-tauri/src/
├── commands/
│   ├── workspace.rs
│   ├── git.rs
│   ├── search.rs
│   └── sync.rs
├── domain/
│   ├── node.rs
│   ├── note.rs
│   └── change.rs
├── storage/
│   ├── workspace_store.rs
│   ├── state_db.rs
│   └── object_cache.rs
├── version/git_service.rs
├── index/index_service.rs
├── sync/sync_engine.rs
└── extractors/
```

前端只消费结构化 DTO 和事件：

- `workspace_changed`
- `git_status_changed`
- `index_progress`
- `sync_progress`
- `sync_conflict`
- `object_download_progress`

所有长任务返回 `task_id` 并通过事件报告进度，避免 Tauri command 长时间阻塞。

## 10. 安全与可靠性

- 网络：TLS；预签名 URL 只授予单个 object key，短时有效。
- OSS：开启服务端加密；高敏场景可增加客户端 envelope encryption，但会降低服务端去重、预览和索引能力。
- 完整性：下载、缓存命中、上传完成均校验 SHA-256；不能只相信 ETag，分片上传的 ETag 通常不是内容 MD5。
- 权限：服务端对 Git、LFS、对象下载和云端搜索使用同一 workspace ACL。
- 原子写：本地统一采用同目录临时文件、fsync、rename；不能先删除正式文件再重命名。
- 防路径穿越：远端路径规范化后必须仍位于 workspace root 内，拒绝绝对路径、`..` 和设备保留名。
- 备份：Git bundle、PostgreSQL PITR 和 OSS versioning/lifecycle 三者分别覆盖小对象历史、控制面和大对象。
- 可观测性：同步任务记录 correlation id、workspace id、device id、commit id 和 object hash，不记录笔记正文或凭据。

## 11. 迁移方案

从现有 `.hyperspace/workspace.json` 迁移时：

1. 以只读方式加载旧 JSON，创建迁移前备份。
2. 为每个旧节点保留原 ID；非法或重复 ID 才生成新 ID。
3. 每篇页面输出独立 Markdown，并生成节点 sidecar。
4. 文件节点如果当前没有真实内容，只生成 `missing` 状态，不能伪造空文件。
5. 生成 `manifest.json`、`.gitignore` 和 `.gitattributes`。
6. 构建本地数据库与索引。
7. 校验节点数、笔记数、引用目标和内容摘要后，创建迁移 commit。
8. 保留旧 JSON 若干版本，只在用户确认后归档，不立即删除。

迁移器必须可重复执行并能检测已完成版本，避免应用崩溃后重复生成节点。

## 12. 分阶段实施

### Phase 1：本地数据拆分与版本管理

- 引入 `manifest + node sidecar + note Markdown`。
- 建立 `state.db` 和原子文件写入。
- 完成旧 `workspace.json` 迁移。
- 接入 Git status/diff/log/commit/restore。
- 检测并配置 Git LFS，生成 `.gitattributes`。

验收：断网可完整编辑；笔记可按节点查看差异和恢复；大文件提交后 Git 中为合法 LFS pointer。

### Phase 2：本地全文索引

- 建立增量索引和提取任务队列。
- 支持 Markdown、纯文本、代码、PDF 和 Office 文档。
- 将当前前端数组过滤替换为 Rust 搜索 API。

验收：十万节点规模下标题搜索 P95 小于 100 ms，已索引正文搜索 P95 小于 300 ms；删除索引后可完整重建。

### Phase 3：云端 Git/LFS/OSS

- 部署 Git 服务、LFS Batch API、PostgreSQL 和 OSS bucket。
- 实现直传、断点续传、按需下载、对象校验和 GC。
- 支持 fetch/merge/push 及同步进度 UI。

验收：两个设备可离线修改后同步；相同大对象不重复存储；中断上传可恢复；无权限用户无法通过已知 hash 下载对象。

### Phase 4：完整本地文件系统双向同步

- 接入 watcher、journal、回环抑制和重命名识别。
- 实现二进制冲突副本、删除/修改冲突恢复区。
- 支持云端占位文件与按需下载。

验收：应用内编辑和外部编辑结果一致；应用重启、网络抖动、重复事件均不会丢文件或重复提交。

### Phase 5：可选云端索引与协作增强

- 云端异步内容提取和权限过滤搜索。
- 语义索引、分享、审计及更细粒度协作能力。

## 13. 技术决策摘要

| 决策 | 选择 | 原因 |
|---|---|---|
| 笔记主格式 | 独立 Markdown + 稳定 block/node ID | Git diff 友好、可移植、外部编辑可行 |
| 大文件 | Git LFS pointer + OSS 内容对象 | 标准工具兼容，避免 Git 仓库膨胀 |
| OSS 对象键 | SHA-256 内容寻址 | 去重、完整性校验、不可变 |
| 可变 head/权限 | Git 服务 + PostgreSQL | 需要事务和原子并发控制 |
| 本地状态 | SQLite | 事务、恢复、任务队列和游标 |
| 全文索引 | Tantivy；首版可 FTS5 | 离线、低延迟、可重建 |
| 同步单位 | Git commit + LFS object | 有共同祖先，可合并，可审计 |
| 文件身份 | 稳定 node_id，与路径分离 | 支持移动、重命名、引用和跨设备同步 |

## 14. 不建议采用的方案

1. **继续同步整个 `workspace.json`**：任意编辑都会改变大文件，多设备几乎无法可靠合并，索引和按需下载也无法增量化。
2. **把所有文件直接提交普通 Git**：大文件历史永久膨胀，clone、fetch 和 GC 成本不可控。
3. **让客户端直接把 OSS 当目录盘**：OSS 没有本地文件系统语义，rename、watch、锁和原子引用更新都不等价。
4. **只使用 OSS 的 `latest.json` 作为 head**：并发覆盖会丢更新，无法安全实现 compare-and-swap 和权限审计。
5. **把索引文件同步到多设备**：索引依赖平台和版本，冲突多且可重建，应同步源数据而不是派生数据。

## 15. 首个实现切片

建议第一个可交付切片只做以下闭环：

1. 将一个页面保存为独立 Markdown，并保留稳定 node ID。
2. 将现有项目初始化为 Git 仓库，展示真实 status/diff/log。
3. 导入一个 PDF，生成 LFS pointer，并保留本地可打开内容。
4. 使用 SQLite FTS5/Tantivy 搜到该笔记正文和 PDF 文件名。
5. 重启应用后，从拆分后的文件恢复工作空间。

该切片先验证最重要的数据边界，再开始接入 OSS。否则 OSS 同步会固化当前单 JSON 模型，后续迁移和冲突处理成本会显著增加。
