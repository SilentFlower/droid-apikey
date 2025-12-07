## Context
- 公共查询需在无登录、无 D1 写入的前提下提供与私有仪表盘一致的体验，并支持多条 Key 结果列表。
- 需要兼顾安全（不暴露完整 Key、无服务器持久化）与易用性（自动预填/自动查询、单行刷新/删除）。

## Goals / Non-Goals
- Goals: Worker 代理调用 Factory AI；公共查询数据仅在 localStorage/内存；多记录列表、去重（重复 Key 覆盖）；UI 对齐私有仪表盘。
- Non-Goals: 不将公共 Key/结果写入 D1 或其他后端存储；不修改私有登录/自动刷新逻辑。

## Decisions
- 请求路径保持 `/api/public/usage`，Worker 代理外部接口，避免 CORS/密钥直曝。
- localStorage 存公共 Key 列表，页面加载恢复；重复 Key 覆盖原行，避免列表膨胀。
- 表格/卡片样式复用私有页风格；操作列提供单行刷新/删除。

## Risks / Trade-offs
- localStorage 仅浏览器侧，不同步多端；可接受。
- 外部接口限流需保持已有并发/重试策略（复用后端逻辑）。

## Validation
- 手动验证未登录/重载/登录后场景，确认去重和隔离行为。
