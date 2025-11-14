# droid-apikey

API Key 余额监控看板 - Cloudflare Workers 版本

一个用于监控和管理 Factory AI API Keys 使用情况的 Web 应用，部署在 Cloudflare Workers 上。

## 功能特性

- 📊 实时监控所有 API Key 的余额和使用情况
- 📥 批量导入/导出 API Keys
- 🗑️ 批量删除无效或零余额的 Keys
- 🔄 单个或全局刷新数据
- 🔐 密码保护的 Key 导出功能
- 💾 使用 Cloudflare KV 存储数据
- 🌐 全球 CDN 加速访问

## 部署步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 KV Namespace

```bash
# 创建生产环境 KV namespace
npx wrangler kv:namespace create API_KEYS

# （可选）创建开发环境 KV namespace
npx wrangler kv:namespace create API_KEYS --preview
```

命令执行后会输出类似以下内容：
```
🌀 Creating namespace with title "droid-apikey-API_KEYS"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "API_KEYS", id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

### 3. 配置 wrangler.toml

将上一步获得的 KV namespace ID 填入 `wrangler.toml` 文件：

```toml
[[kv_namespaces]]
binding = "API_KEYS"
id = "你的KV_NAMESPACE_ID"  # 替换为实际的 ID
```

同时可以修改导出密码（可选）：

```toml
[vars]
EXPORT_PASSWORD = "your_secure_password"  # 修改为你的密码
```

### 4. 部署到 Cloudflare Workers

```bash
# 部署到生产环境
npx wrangler deploy

# 或使用 npm script
npm run deploy
```

部署成功后，会显示你的 Workers URL，例如：
```
Published droid-apikey (x.xx sec)
  https://droid-apikey.your-subdomain.workers.dev
```

### 5. 本地开发（可选）

```bash
# 启动本地开发服务器
npm run dev

# 或
npx wrangler dev
```

本地开发服务器会在 `http://localhost:8787` 启动。

## 使用说明

### 添加 API Keys

1. 访问部署后的 URL
2. 点击右上角的 "Key 管理" 按钮
3. 在文本框中输入 API Keys（每行一个）
4. 点击 "批量导入" 按钮

支持两种格式：
- 纯 Key：`fk-xxxxx`（系统会自动生成 ID）
- ID:Key 格式：`my-key-1:fk-xxxxx`

### 导出 API Keys

1. 点击右下角的 "📥 导出Key" 按钮
2. 输入导出密码（默认：`admin123`，可在 `wrangler.toml` 中修改）
3. Keys 会以文本文件形式下载

### 删除 Keys

- **删除单个 Key**：点击表格中对应行的 "删除" 按钮
- **删除无效 Key**：点击 "🗑️ 删除无效" 按钮（删除余额为 0 的 Keys）
- **删除所有 Key**：点击 "🗑️ 删除所有" 按钮（需要二次确认）

### 刷新数据

- **刷新所有数据**：点击右下角的 "🔄 刷新数据" 按钮
- **刷新单个 Key**：点击表格中对应行的 "刷新" 按钮

## 配置选项

在 `src/index.ts` 中可以修改以下配置：

```typescript
const CONFIG = {
  API_ENDPOINT: 'https://app.factory.ai/api/organization/members/chat-usage',
  USER_AGENT: 'Mozilla/5.0 ...',
  TIMEZONE_OFFSET_HOURS: 8,  // 时区偏移（北京时间 UTC+8）
  KEY_MASK_PREFIX_LENGTH: 4,  // Key 显示的前缀长度
  KEY_MASK_SUFFIX_LENGTH: 4,  // Key 显示的后缀长度
  AUTO_REFRESH_INTERVAL_SECONDS: 60,  // 自动刷新间隔（秒）
};
```

## 自动刷新（Cron Triggers）

如果需要定时自动刷新数据，可以在 `wrangler.toml` 中添加 Cron Triggers：

```toml
[triggers]
crons = ["*/5 * * * *"]  # 每 5 分钟刷新一次
```

常用的 Cron 表达式：
- `*/5 * * * *` - 每 5 分钟
- `*/15 * * * *` - 每 15 分钟
- `0 * * * *` - 每小时
- `0 0 * * *` - 每天午夜

## 项目结构

```
droid-apikey/
├── src/
│   └── index.ts          # 主应用代码（Cloudflare Workers 版本）
├── main.ts               # 原 Deno 版本（保留作为参考）
├── wrangler.toml         # Cloudflare Workers 配置
├── package.json          # 项目依赖
├── tsconfig.json         # TypeScript 配置
└── README.md             # 项目文档
```

## 技术栈

- **运行时**: Cloudflare Workers
- **存储**: Cloudflare KV
- **语言**: TypeScript
- **构建工具**: Wrangler

## 从 Deno 版本迁移

如果你之前使用的是 Deno 版本（`main.ts`），数据不会自动迁移。你需要：

1. 从 Deno 版本导出所有 Keys
2. 在 Cloudflare Workers 版本中重新导入

## 常见问题

### Q: 部署后访问显示 503 错误？
A: 首次访问时，系统需要初始化数据，请等待几秒后刷新页面。

### Q: 如何修改导出密码？
A: 在 `wrangler.toml` 文件中修改 `EXPORT_PASSWORD` 的值，然后重新部署。

### Q: KV 存储有什么限制？
A: Cloudflare KV 免费版限制：
- 每天 100,000 次读取操作
- 每天 1,000 次写入操作
- 1 GB 存储空间
- 对于本项目来说完全够用

### Q: 如何查看日志？
A: 使用以下命令查看实时日志：
```bash
npx wrangler tail
```

### Q: 如何删除部署？
A: 使用以下命令：
```bash
npx wrangler delete
```

## 安全建议

1. **修改默认密码**：部署前务必在 `wrangler.toml` 中修改 `EXPORT_PASSWORD`
2. **限制访问**：考虑使用 Cloudflare Access 限制访问权限
3. **定期备份**：定期导出 Keys 进行备份

## 许可证

MIT License

## 支持

如有问题或建议，请提交 Issue。