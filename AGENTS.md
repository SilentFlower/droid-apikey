# Repository Guidelines

## 语言
请总是使用中文回复，包括codeReview

## 项目结构与模块
- `src/index.ts`：Cloudflare Worker 入口，负责路由、D1 访问、缓存与响应。
- `migrations/0001_create_api_keys_table.sql`：D1 表结构与元数据迁移脚本。
- `main.ts`：遗留/本地监控脚本，优先使用 `src/` 内代码进行部署。
- `wrangler.toml`：绑定 D1（`DB`）与密钥（如 `EXPORT_PASSWORD`），随环境调整。
- `tsconfig.json`：ES2022 模块 + WebWorker 库配置。

## 构建、测试与开发命令
- 安装依赖：`npm install`
- 开发（远程 D1）：`npm run dev`；开发（本地 D1）：`npm run dev:local`
- 部署：`npm run deploy`
- 日志：`npm run tail`
- D1 管理：`npm run d1:create`、`npm run d1:migrate` / `npm run d1:migrate:local`、`npm run d1:query "<SQL>"`、`npm run d1:backup`

## 代码风格与命名
- 语言：TypeScript（ES2022 模块，Web/Worker API）。
- 缩进 2 空格，避免使用 `any`（即便 `strict: false`）。
- 命名：小驼峰（变量/函数）、大驼峰（类/接口）、常量全大写下划线。
- 避免 Node 专属模块；全局类型保持在 Worker 入口附近。

## 测试与验证
- 当前无自动化测试；推荐通过 `npm run dev` 后手动验证 `/api/login`、`/api/keys`、`/api/data`、导出流程。
- Schema 变更后必须重新迁移并烟囱测试 Key CRUD + usage 刷新，确保缓存行为稳定。
- 若新增自动化测试，优先使用 Miniflare/Workers 测试工具，测试名称对齐端点。

## 提交与 PR 规范
- Commit 使用 Conventional Commit 前缀（如 `feat:` / `fix:` / `chore:`），一次提交聚焦单一改动。
- PR 需概述范围、列出运行的命令，标注迁移或配置/密钥改动，关联相关 Issue，UI 变更附截图/GIF。

## 安全与配置提示
- 不要硬编码密码/Key；使用 `wrangler secret put EXPORT_PASSWORD` 设置密钥。
- 部署前更新 `wrangler.toml` 中的 `database_id`，避免提交环境特定值。
- 定期执行 `npm run d1:backup` 并轮换 `EXPORT_PASSWORD`；必要时添加访问控制。
