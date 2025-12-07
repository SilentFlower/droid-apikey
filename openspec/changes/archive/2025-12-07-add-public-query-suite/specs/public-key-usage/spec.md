## ADDED Requirements

### Requirement: Public Key Usage Query Without Login
公共 Key 用量查询 MUST 在无登录态下可用，不要求或写入会话 Cookie；私有 Key 管理与自动刷新仍需登录。

#### Scenario: Query without session
- **WHEN** 用户未登录访问公共查询接口或页面
- **THEN** 系统允许提交公共 Key 并返回用量数据
- **AND** 私有 Key 接口与自动刷新仍需登录且行为保持不变

### Requirement: Local-Only Public Key Handling
公共 Key 及其查询结果列表 MUST 仅由浏览器 localStorage 保存；服务器端 MUST NOT 将公共 Key 或查询结果写入 D1 或其他持久存储；所有持久化仅限前端 localStorage，服务器端不留存。

#### Scenario: Local storage only
- **WHEN** 用户在公共面板输入/更新公共 Key 并查询
- **THEN** 浏览器将该 Key 及查询结果列表存入 localStorage 供后续预填/恢复
- **AND** 服务器端不在 D1 或其他持久介质存储该 Key 或结果

### Requirement: Public Usage Fetch via Worker Proxy
公共查询请求 MUST 由 Worker 代理调用 Factory AI 用量接口，不直接暴露跨域请求；每次查询 MUST 独立发起，不复用私有缓存。

#### Scenario: Proxy fetch per request
- **WHEN** 用户提交公共 Key 查询
- **THEN** Worker 使用该 Key 调用 Factory AI 用量接口并返回额度/用量/时间窗口数据
- **AND** 不写入或污染私有缓存/`ServerState`
- **AND** 不记录完整 Key 到日志或响应

### Requirement: Dedicated Public Query UI
系统 SHALL 提供独立的“公共查询”面板，与私有仪表盘区隔但在布局与样式上保持一致；页面 SHOULD 在存在保存记录时自动发起一次查询并刷新最近一条；查询结果展示与列表读取均仅发生在前端，不写入 D1。

#### Scenario: Style parity and auto query
- **WHEN** 用户打开公共查询页面
- **THEN** 页面布局、配色、按钮风格与私有仪表盘一致
- **AND** 如 localStorage 存在公共列表，则自动刷新最近一条记录（可不强制预填输入框）
- **AND** 查询结果仅在页面展示，不写入 D1

### Requirement: Public Query Multi-Entry Listing
公共查询页面 SHALL 支持多条查询结果列表；每次输入/查询新的公共 Key 应追加一行；重复 Key 查询 MUST 覆盖原行而非追加；每行 MUST 提供刷新与删除操作；列表与数据应持久化到 localStorage 以便重载时恢复。

#### Scenario: Append/overwrite and single-row ops
- **WHEN** 用户连续输入不同的公共 Key 并点击查询
- **THEN** 每次查询都会在列表追加一行展示该 Key 的掩码与用量数据
- **AND** 当输入的 Key 已存在列表时，覆盖原行数据而非新增
- **AND** 每行有刷新按钮仅重新拉取该 Key 的数据，删除按钮移除该行并同步 localStorage

### Requirement: Isolation from Private Key Management
公共查询 MUST NOT 影响或访问私有 Key 管理与 D1 数据，私有数据安全性 MUST NOT 下降。

#### Scenario: No D1 interaction for public mode
- **WHEN** 仅使用公共查询功能
- **THEN** D1 不会新增/读取公共 Key 记录
- **AND** 私有 Key 列表、导出、自动刷新等行为与现状一致
