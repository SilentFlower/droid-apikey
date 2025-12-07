# Project Context

## Purpose
基于 Cloudflare Workers + D1 的 API Key 余额监控看板，聚合查询 Factory AI（`app.factory.ai`）的用量接口，提供登录、自动刷新、可视化展示以及 Key 的批量导入、删除与导出能力，便于在边缘环境快速获知额度余额并做运维管理。

## Tech Stack
- 运行时：Cloudflare Workers（ES2022 模块，WebWorker API）
- 语言：TypeScript（`noEmit`，`strict: false`）
- 数据库：Cloudflare D1（SQLite），迁移脚本位于 `migrations/0001_create_api_keys_table.sql`
- 开发/部署：Wrangler 3（`npm run dev`、`npm run dev:local`、`npm run deploy`）
- 前端：Worker 内嵌的原生 HTML/CSS/JS 仪表盘
- 调度：Workers `scheduled` 事件驱动的自动刷新

## Project Conventions

### Code Style
- TypeScript 为主，缩进 2 空格，避免使用 `any`
- 命名：小驼峰（变量/函数）、大驼峰（类型/接口/类）、常量全大写下划线
- WebWorker 环境优先，避免 Node 专属模块；不得使用全限定类名，必须通过 `import` 引入
- 保持代码简洁（KISS/YAGNI），必要时添加简短注释说明复杂逻辑

### Architecture Patterns
- `src/index.ts` 为 Cloudflare Worker 入口，使用简单的 if 路由分发各 API
- D1 仅存储 Key（id、key、created_at），所有用量数据实时向 Factory AI 接口拉取
- `ServerState` 提供内存缓存与更新标记，`scheduled` 事件触发 `autoRefreshData` 定期刷新
- `batchProcess` 控制并发与重试，避免外部接口限流；结果聚合后按剩余额度排序并输出汇总
- 认证使用 HMAC（`EXPORT_PASSWORD` 作为密钥）签发的 Cookie 会话，登录/导出均复用同一密码
- 根路径返回内嵌仪表盘 HTML（登录页与主面板），前端通过 Fetch 调用 `/api/*` 接口

### Testing Strategy
- 当前无自动化测试；开发时通过 `npm run dev` 或 `npm run dev:local` 手动验证登录、Key CRUD、数据刷新与导出流程
- 变更 D1 Schema 后需重新执行迁移脚本，并验证缓存刷新与接口一致性
- 如需补充自动化测试，优先考虑 Miniflare/Workers 相关工具模拟环境

### Git Workflow
- 提交信息采用 Conventional Commit 前缀（如 `feat:`、`fix:`、`chore:`），一次提交聚焦单一改动
- 建议在功能分支完成改动后合并，PR 需包含范围说明与执行命令，配置/密钥/迁移变更需显式标注

## Domain Context
- 目标是监控 Factory AI 组织级聊天用量；外部接口为 `https://app.factory.ai/api/organization/members/chat-usage`，需携带 `Authorization: Bearer <key>`
- Key 在数据库中以 id+密钥存储，接口返回时仅暴露掩码；可通过 `/api/keys/:id/full` 获取明文
- 仪表盘展示用量窗口（start/end）、额度与已用、使用率及剩余额度，并区分错误项
- 登录与导出密码统一使用 `EXPORT_PASSWORD`（默认值需在生产前修改）

## Important Constraints
- 禁止硬编码生产密码或密钥；生产环境应通过 `wrangler secret` 管理 `EXPORT_PASSWORD`
- 运行环境为 Workers，不能依赖 Node 内置模块或文件系统；注意 D1 绑定名固定为 `DB`
- 内存缓存仅限单实例生命周期，不能作为持久化依赖；缓存失效需主动清理以确保数据实时性
- 外部接口有限流风险，须保持现有并发与重试控制（默认并发 10，线性退避重试 2 次）

## External Dependencies
- Cloudflare 平台：Workers（HTTP/Scheduled）、D1 数据库
- 外部 API：Factory AI 用量接口 `https://app.factory.ai/api/organization/members/chat-usage`
- 工具链：Wrangler CLI、TypeScript 编译链（无输出，仅校验）
