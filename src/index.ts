// main.ts

// ==================== Type Definitions ====================

interface ApiKey {
  id: string;
  key: string;
}

interface ApiUsageData {
  id: string;
  key: string;
  startDate: string;
  endDate: string;
  orgTotalTokensUsed: number;
  totalAllowance: number;
  usedRatio: number;
}

interface ApiErrorData {
  id: string;
  key: string;
  error: string;
}

type ApiKeyResult = ApiUsageData | ApiErrorData;

interface UsageTotals {
  total_orgTotalTokensUsed: number;
  total_totalAllowance: number;
  totalRemaining: number;
}

interface AggregatedResponse {
  update_time: string;
  total_count: number;
  totals: UsageTotals;
  data: ApiKeyResult[];
}

interface ApiResponse {
  usage: {
    startDate: number;
    endDate: number;
    standard: {
      orgTotalTokensUsed: number;
      totalAllowance: number;
      usedRatio: number;
    };
  };
}


interface Env {
  DB: D1Database;
  EXPORT_PASSWORD: string;
}

interface BatchImportResult {
  success: boolean;
  added: number;
  skipped: number;
}

// ==================== Configuration ====================

const CONFIG = {
  API_ENDPOINT: 'https://app.factory.ai/api/organization/members/chat-usage',
  USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  TIMEZONE_OFFSET_HOURS: 8, // Beijing time
  KEY_MASK_PREFIX_LENGTH: 4,
  KEY_MASK_SUFFIX_LENGTH: 4,
  AUTO_REFRESH_INTERVAL_SECONDS: 60, // Set auto-refresh interval to 60 seconds
  // EXPORT_PASSWORD 从 env 对象获取 // Default password for key export
} as const;

// ==================== Server State and Caching (NEW) ====================

class ServerState {
  private cachedData: AggregatedResponse | null = null;
  private lastError: string | null = null;
  private isUpdating = false;

  getData = () => this.cachedData;
  getError = () => this.lastError;
  isCurrentlyUpdating = () => this.isUpdating;
  
  updateCache(data: AggregatedResponse) {
    this.cachedData = data;
    this.lastError = null;
    this.isUpdating = false;
  }

  setError(errorMessage: string) {
    this.lastError = errorMessage;
    this.isUpdating = false;
  }
  
  startUpdate() {
    this.isUpdating = true;
  }
  
  clearCache() {
    this.cachedData = null;
    this.lastError = null;
    this.isUpdating = false;
  }
}

const serverState = new ServerState();


// ==================== Database Initialization ====================



// ==================== Database Operations ====================

/**
 * 获取所有 API Keys（使用 D1）
 */
async function getAllKeys(db: D1Database): Promise<ApiKey[]> {
  const result = await db.prepare(
    'SELECT id, key FROM api_keys ORDER BY created_at DESC'
  ).all<ApiKey>();
  
  return result.results || [];
}

/**
 * 添加新的 API Key（使用 D1）
 */
async function addKey(db: D1Database, id: string, key: string): Promise<void> {
  await db.prepare(
    'INSERT INTO api_keys (id, key) VALUES (?, ?)'
  ).bind(id, key).run();
}

/**
 * 删除指定的 API Key（使用 D1）
 */
async function deleteKey(db: D1Database, id: string): Promise<void> {
  await db.prepare(
    'DELETE FROM api_keys WHERE id = ?'
  ).bind(id).run();
}

/**
 * 检查 API Key 是否已存在（使用 D1）
 */
async function apiKeyExists(db: D1Database, key: string): Promise<boolean> {
  const result = await db.prepare(
    'SELECT COUNT(*) as count FROM api_keys WHERE key = ?'
  ).bind(key).first<{ count: number }>();
  
  return (result?.count || 0) > 0;
}

/**
 * 根据 ID 获取 API Key（使用 D1）
 */
async function getKeyById(db: D1Database, id: string): Promise<string | null> {
  const result = await db.prepare(
    'SELECT key FROM api_keys WHERE id = ?'
  ).bind(id).first<{ key: string }>();
  
  return result?.key || null;
}

// ==================== Utility Functions ====================

function maskApiKey(key: string): string {
  if (key.length <= CONFIG.KEY_MASK_PREFIX_LENGTH + CONFIG.KEY_MASK_SUFFIX_LENGTH) {
    return `${key.substring(0, CONFIG.KEY_MASK_PREFIX_LENGTH)}...`;
  }
  return `${key.substring(0, CONFIG.KEY_MASK_PREFIX_LENGTH)}...${key.substring(key.length - CONFIG.KEY_MASK_SUFFIX_LENGTH)}`;
}

function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp && timestamp !== 0) return 'N/A';

  try {
    return new Date(timestamp).toISOString().split('T')[0];
  } catch {
    return 'Invalid Date';
  }
}

function getBeijingTime(): Date {
  return new Date(Date.now() + CONFIG.TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000);
}


function formatBeijingTime(date: Date, formatStr: string): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  
  if (formatStr === "yyyy-MM-dd HH:mm:ss") {
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  } else if (formatStr === "HH:mm:ss") {
    return `${hours}:${minutes}:${seconds}`;
  }
  return date.toISOString();
}

function createJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createErrorResponse(message: string, status = 500): Response {
  return createJsonResponse({ error: message }, status);
}

// HTML content is embedded as a template string
// ==================== Session Management ====================

const SESSION_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 days

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
let cachedHmacKey: CryptoKey | null = null;
let cachedHmacSecret: string | null = null;

function toBase64Url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(base64Url: string): Uint8Array {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64Url.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  if (cachedHmacKey && cachedHmacSecret === secret) return cachedHmacKey;

  cachedHmacKey = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  cachedHmacSecret = secret;
  return cachedHmacKey;
}

async function createSessionToken(secret: string): Promise<string> {
  const now = Date.now();
  const payload = { exp: now + SESSION_DURATION, iat: now };
  const body = toBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(body));
  return `${body}.${toBase64Url(signature)}`;
}

async function isValidSession(token: string, secret: string): Promise<boolean> {
  const [body, signature] = token.split('.');
  if (!body || !signature) return false;

  try {
    const key = await getHmacKey(secret);
    const validSignature = await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64Url(signature),
      textEncoder.encode(body)
    );
    if (!validSignature) return false;

    const payloadStr = textDecoder.decode(fromBase64Url(body));
    const payload = JSON.parse(payloadStr) as { exp?: number };
    if (!payload?.exp || Date.now() > payload.exp) return false;

    return true;
  } catch {
    return false;
  }
}

function getCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get('Cookie');
  if (!cookies) return null;
  const match = cookies.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? match[1] : null;
}

// ==================== Login Page HTML ====================

const LOGIN_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 - API 余额监控看板</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .login-container { background: white; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); padding: 40px; width: 90%; max-width: 400px; }
        .login-header { text-align: center; margin-bottom: 30px; }
        .login-header h1 { font-size: 28px; color: #667eea; margin-bottom: 10px; }
        .login-header p { color: #6c757d; font-size: 14px; }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-size: 14px; }
        .form-group input { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; transition: border-color 0.3s; }
        .form-group input:focus { outline: none; border-color: #667eea; }
        .login-btn { width: 100%; padding: 12px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: transform 0.3s, box-shadow 0.3s; }
        .login-btn:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4); }
        .login-btn:active { transform: translateY(0); }
        .error-msg { background: #f8d7da; color: #721c24; padding: 12px; border-radius: 8px; margin-bottom: 15px; border: 1px solid #f5c6cb; font-size: 14px; display: none; }
    </style>
</head>
<body>
    <div class="login-container">
        <div class="login-header">
            <h1>🔐 登录</h1>
            <p>API 余额监控看板</p>
        </div>
        <div id="errorMsg" class="error-msg"></div>
        <form id="loginForm">
            <div class="form-group">
                <label>账号</label>
                <input type="text" id="username" name="username" required autocomplete="username">
            </div>
            <div class="form-group">
                <label>密码</label>
                <input type="password" id="password" name="password" required autocomplete="current-password">
            </div>
            <button type="submit" class="login-btn">登录</button>
        </form>
        <div style="margin-top: 14px; text-align: center; font-size: 14px; color: #6c757d;">
            <a href="/public" style="color: #667eea; text-decoration: none;">无需登录？前往公共查询</a>
        </div>
    </div>
    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const errorMsg = document.getElementById('errorMsg');
            
            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    window.location.href = '/';
                } else {
                    errorMsg.textContent = result.error || '登录失败';
                    errorMsg.style.display = 'block';
                }
            } catch (error) {
                errorMsg.textContent = '网络错误，请重试';
                errorMsg.style.display = 'block';
            }
        });
    </script>
</body>
</html>
`;  

// ==================== Public Query Page HTML ====================

const PUBLIC_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>公共 API Key 查询</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; background: white; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); overflow: hidden; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
        .header h1 { font-size: 32px; margin-bottom: 6px; }
        .header .update-time { font-size: 14px; opacity: 0.9; }
        .link-btn { color: white; text-decoration: none; font-weight: 600; border: 2px solid rgba(255,255,255,0.6); padding: 10px 16px; border-radius: 10px; transition: all 0.25s ease; background: rgba(255,255,255,0.15); }
        .link-btn:hover { background: rgba(255,255,255,0.25); transform: translateY(-1px); }
        .content { padding: 20px 30px 30px 30px; background: #f8f9fa; }
        .card { background: white; border-radius: 14px; padding: 18px 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); border: 1px solid #e9ecef; margin-bottom: 18px; }
        .card-title { font-size: 18px; font-weight: 700; color: #333; margin-bottom: 12px; display: flex; align-items: center; gap: 10px; }
        .badge { display: inline-block; padding: 6px 10px; border-radius: 999px; font-size: 12px; background: #f1f3f5; color: #495057; }
        .form-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
        .form-group { flex: 1; min-width: 320px; }
        .form-group label { display: block; margin-bottom: 8px; font-weight: 600; color: #333; }
        .form-group input { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 10px; font-size: 14px; }
        .btn-group { display: flex; gap: 10px; flex-wrap: wrap; }
        .btn { padding: 12px 20px; border: none; border-radius: 10px; font-size: 14px; cursor: pointer; font-weight: 600; transition: all 0.2s ease; }
        .btn-primary { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
        .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 18px rgba(102, 126, 234, 0.35); }
        .btn-secondary { background: #f1f3f5; color: #495057; border: 1px solid #e9ecef; }
        .btn-secondary:hover { background: #e9ecef; }
        .status { margin-top: 12px; font-size: 14px; color: #6c757d; }
        .status.error { color: #d32f2f; }
        .stats-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; background: #f8f9fa; }
        .stat-card { background: white; border-radius: 12px; padding: 18px; text-align: center; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08); }
        .stat-card .label { font-size: 13px; color: #6c757d; margin-bottom: 6px; font-weight: 500; }
        .stat-card .value { font-size: 22px; font-weight: bold; color: #667eea; }
        .table-container { margin-top: 14px; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 10px; overflow: hidden; }
        thead { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
        th { padding: 14px; text-align: left; font-weight: 600; font-size: 14px; white-space: nowrap; }
        th.number { text-align: right; }
        td { padding: 12px 14px; border-bottom: 1px solid #e9ecef; font-size: 14px; }
        td.number { text-align: right; font-weight: 500; }
        tbody tr:hover { background-color: #f8f9fa; }
        tbody tr:last-child td { border-bottom: none; }
        td.error-row { color: #dc3545; }
        .ops-btn { padding: 8px 14px; border: none; border-radius: 8px; color: white; cursor: pointer; font-weight: 600; }
        .ops-btn.refresh { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .ops-btn.delete { background: linear-gradient(135deg, #dc3545 0%, #c82333 100%); margin-left: 6px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>公共 API Key 查询</h1>
                <div class="update-time" id="updateTime">无需登录，Key 仅保存在当前浏览器的 localStorage，不会写入服务器</div>
            </div>
            <a class="link-btn" href="/">返回私有仪表盘</a>
        </div>

        <div class="content">
            <div class="card">
                <div class="card-title">
                    公共 Key 查询
                    <span class="badge">不入库 · 不登录</span>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label for="publicKeyInput">公共 API Key</label>
                        <input id="publicKeyInput" type="text" placeholder="fk-xxxxxxxx" autocomplete="off" />
                    </div>
                    <div class="btn-group">
                        <button class="btn btn-primary" onclick="queryPublicUsage()">查询用量</button>
                        <button class="btn btn-secondary" onclick="clearSavedKey()">清除保存</button>
                    </div>
                </div>
                <div class="status" id="statusText">请输入公共 Key 并点击查询</div>
            </div>

            <div class="stats-cards" id="statsCards"></div>

            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>API Key</th>
                            <th>开始时间</th>
                            <th>结束时间</th>
                            <th class="number">总计额度</th>
                            <th class="number">已使用</th>
                            <th class="number">剩余额度</th>
                            <th class="number">使用百分比</th>
                            <th style="text-align:center;">操作</th>
                        </tr>
                    </thead>
                    <tbody id="tableBody">
                        <tr><td colspan="8" style="text-align:center; padding: 20px;">暂无数据，请查询</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        const publicKeyInput = document.getElementById('publicKeyInput');
        const statusText = document.getElementById('statusText');
        const tableBody = document.getElementById('tableBody');
        const statsCards = document.getElementById('statsCards');
        const updateTime = document.getElementById('updateTime');

        const STORAGE_KEY = 'public_api_keys';

        const formatNumber = (num) => num ? new Intl.NumberFormat('en-US').format(num) : '0';
        const formatPercentage = (ratio) => ratio ? (ratio * 100).toFixed(2) + '%' : '0.00%';
        const maskDisplay = (key) => {
            if (!key) return 'N/A';
            return key.length > 10 ? \`\${key.slice(0, 4)}...\${key.slice(-4)}\` : key;
        };

        function getStoredList() {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                return raw ? JSON.parse(raw) : [];
            } catch {
                return [];
            }
        }

        function saveList(list) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        }

        function setStatus(message, isError = false) {
            statusText.textContent = message;
            statusText.className = 'status' + (isError ? ' error' : '');
        }

        function clearSavedKey() {
            saveList([]);
            localStorage.removeItem('public_api_key');
            publicKeyInput.value = '';
            tableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 20px;">已清除本地保存的 Key 列表</td></tr>';
            statsCards.innerHTML = '';
            setStatus('已清除本地保存的 Key 列表');
        }

        function renderStats(latestItem) {
            if (!latestItem || latestItem.error) {
                statsCards.innerHTML = '';
                return;
            }
            const remaining = Math.max(0, (latestItem.totalAllowance || 0) - (latestItem.orgTotalTokensUsed || 0));
            statsCards.innerHTML = \`
                <div class="stat-card"><div class="label">总计额度 (Total Allowance)</div><div class="value">\${formatNumber(latestItem.totalAllowance || 0)}</div></div>
                <div class="stat-card"><div class="label">已使用 (Total Used)</div><div class="value">\${formatNumber(latestItem.orgTotalTokensUsed || 0)}</div></div>
                <div class="stat-card"><div class="label">剩余额度 (Remaining)</div><div class="value">\${formatNumber(remaining)}</div></div>
                <div class="stat-card"><div class="label">使用百分比 (Usage %)</div><div class="value">\${formatPercentage(latestItem.usedRatio)}</div></div>
            \`;
        }

        function renderTable(list) {
            if (!list.length) {
                tableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 20px;">暂无数据，请查询</td></tr>';
                return;
            }

            tableBody.innerHTML = list.map((item, index) => {
                const displayKey = maskDisplay(item.key || item.originalKey);

                if (item.loading) {
                    return \`
                        <tr>
                            <td title="\${item.originalKey || ''}"><span>\${displayKey}</span></td>
                            <td colspan="6" style="text-align:center;">加载中...</td>
                            <td style="text-align:center;">
                                <button class="ops-btn delete" onclick="deleteRow(\${index})">删除</button>
                            </td>
                        </tr>
                    \`;
                }

                if (item.error) {
                    return \`
                        <tr>
                            <td title="\${item.originalKey || ''}"><span>\${displayKey}</span></td>
                            <td colspan="5" class="error-row">查询失败：\${item.error}</td>
                            <td class="number">-</td>
                            <td style="text-align:center;">
                                <button class="ops-btn refresh" onclick="refreshRow(\${index})">刷新</button>
                                <button class="ops-btn delete" onclick="deleteRow(\${index})">删除</button>
                            </td>
                        </tr>
                    \`;
                }

                const remaining = Math.max(0, (item.totalAllowance || 0) - (item.orgTotalTokensUsed || 0));
                return \`
                    <tr>
                        <td title="\${item.originalKey || ''}"><span>\${displayKey}</span></td>
                        <td>\${item.startDate || 'N/A'}</td>
                        <td>\${item.endDate || 'N/A'}</td>
                        <td class="number">\${formatNumber(item.totalAllowance || 0)}</td>
                        <td class="number">\${formatNumber(item.orgTotalTokensUsed || 0)}</td>
                        <td class="number">\${formatNumber(remaining)}</td>
                        <td class="number">\${formatPercentage(item.usedRatio)}</td>
                        <td style="text-align:center;">
                            <button class="ops-btn refresh" onclick="refreshRow(\${index})">刷新</button>
                            <button class="ops-btn delete" onclick="deleteRow(\${index})">删除</button>
                        </td>
                    </tr>
                \`;
            }).join('');
        }

        async function refreshRow(index) {
            const list = getStoredList();
            if (!list[index]) return;
            const key = list[index].originalKey || list[index].key;
            if (!key) return;
            setStatus('刷新中...', false);
            await queryPublicUsage(false, key, index);
        }

        function deleteRow(index) {
            const list = getStoredList();
            list.splice(index, 1);
            saveList(list);
            renderTable(list);
            renderStats(list[list.length - 1]);
            setStatus('已删除该条记录');
        }

        async function queryPublicUsage(isAuto = false, customKey = '', replaceIndex = -1) {
            const keyToUse = (customKey || publicKeyInput.value || '').trim();
            if (!keyToUse) {
                setStatus('请输入公共 API Key', true);
                return;
            }

            setStatus(isAuto ? '自动查询中，请稍候...' : '查询中，请稍候...');
            let list = getStoredList();
            const targetIndex = replaceIndex >= 0
                ? replaceIndex
                : list.findIndex(item => (item.originalKey || item.key) === keyToUse) >= 0
                    ? list.findIndex(item => (item.originalKey || item.key) === keyToUse)
                    : list.length;

            list[targetIndex] = { key: keyToUse, loading: true, originalKey: keyToUse };
            saveList(list);
            renderTable(list);

            try {
                const response = await fetch('/api/public/usage', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: keyToUse })
                });

                const result = await response.json();

                if (!response.ok || result.error) {
                    throw new Error(result.error || '查询失败');
                }

                const data = result.data;
                const entry = {
                    ...data,
                    originalKey: keyToUse,
                    queriedAt: new Date().toISOString()
                };
                list = getStoredList();
                list[targetIndex] = entry;
                saveList(list);
                renderTable(list);
                renderStats(list[list.length - 1]);
                if (data && data.error) {
                    setStatus('查询失败：' + data.error, true);
                } else {
                    setStatus(isAuto ? '自动查询完成' : '查询成功');
                }
                updateTime.textContent = '最后更新: ' + (new Date().toISOString().replace('T', ' ').split('.')[0]) + ' | 公共查询';
            } catch (error) {
                setStatus('查询失败：' + (error instanceof Error ? error.message : String(error)), true);
                list = getStoredList();
                list[targetIndex] = { key: maskDisplay(keyToUse), error: error instanceof Error ? error.message : String(error), originalKey: keyToUse };
                saveList(list);
                renderTable(list);
                renderStats(list[list.length - 1]);
            }
        }

        (function init() {
            const list = getStoredList();
            renderTable(list);
            if (list.length) {
                renderStats(list[list.length - 1]);
                refreshRow(list.length - 1);
            }
        })();
    </script>
</body>
</html>
`;

const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API 余额监控看板</title>  
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; background: white; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); overflow: hidden; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; position: relative; }
        .header h1 { font-size: 32px; margin-bottom: 10px; }
        .header .update-time { font-size: 14px; opacity: 0.9; }
        .manage-btn { position: absolute; top: 30px; right: 30px; background: rgba(255, 255, 255, 0.2); color: white; border: 2px solid white; border-radius: 8px; padding: 10px 20px; font-size: 14px; cursor: pointer; transition: all 0.3s ease; }
        .manage-btn:hover { background: rgba(255, 255, 255, 0.3); transform: scale(1.05); }
        .stats-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; padding: 30px; background: #f8f9fa; }
        .stat-card { background: white; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); transition: transform 0.3s ease, box-shadow 0.3s ease; }
        .stat-card:hover { transform: translateY(-5px); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15); }
        .stat-card .label { font-size: 13px; color: #6c757d; margin-bottom: 8px; font-weight: 500; }
        .stat-card .value { font-size: 24px; font-weight: bold; color: #667eea; }
        .table-container { padding: 0 30px 30px 30px; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; }
        thead { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
        th { padding: 15px; text-align: left; font-weight: 600; font-size: 14px; white-space: nowrap; }
        th.number { text-align: right; }
        td { padding: 12px 15px; border-bottom: 1px solid #e9ecef; font-size: 14px; }
        td.number { text-align: right; font-weight: 500; }
        td.error-row { color: #dc3545; }
        tbody tr:hover { background-color: #f8f9fa; }
        tbody tr:last-child td { border-bottom: none; }
        tfoot { background: #f8f9fa; font-weight: bold; }
        tfoot td { padding: 15px; border-top: 2px solid #667eea; border-bottom: none; }
        .key-cell { color: #495057; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .fab-container { position: fixed; bottom: 24px; right: 24px; display: flex; flex-direction: column; align-items: flex-end; gap: 12px; z-index: 900; }
        .fab-toggle { width: 56px; height: 56px; border-radius: 50%; border: none; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; font-size: 22px; font-weight: 700; cursor: pointer; box-shadow: 0 6px 18px rgba(102, 126, 234, 0.35); display: flex; align-items: center; justify-content: center; transition: transform 0.25s ease, box-shadow 0.25s ease; }
        .fab-toggle:hover { transform: translateY(-2px); box-shadow: 0 10px 26px rgba(102, 126, 234, 0.45); }
        .fab-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 12px; max-height: 0; opacity: 0; pointer-events: none; transform: translateY(8px); transition: all 0.25s ease; }
        .fab-container.open .fab-actions { max-height: 500px; opacity: 1; pointer-events: auto; transform: translateY(0); }
        .action-btn { width: 190px; display: flex; align-items: center; justify-content: center; gap: 8px; border: none; border-radius: 999px; padding: 14px 18px; font-size: 14px; cursor: pointer; color: white; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.18); transition: all 0.3s ease; }
        .action-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 22px rgba(0, 0, 0, 0.24); }
        .action-btn:active { transform: translateY(0); }
        .export-keys-btn { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); }
        .export-keys-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .delete-all-btn { background: linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%); }
        .delete-all-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .delete-zero-btn { background: linear-gradient(135deg, #dc3545 0%, #c82333 100%); }
        .delete-zero-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .refresh-btn { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .refresh-btn .spinner { width: 18px; height: 18px; }
        .loading { text-align: center; padding: 40px; color: #6c757d; }
        .error { text-align: center; padding: 40px; color: #dc3545; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .spinner { display: inline-block; width: 20px; height: 20px; border: 3px solid rgba(255, 255, 255, 0.3); border-radius: 50%; border-top-color: white; animation: spin 1s linear infinite; }

        /* Modal styles */
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); z-index: 1000; align-items: center; justify-content: center; }
        .modal.show { display: flex; }
        .modal-content { background: white; border-radius: 16px; width: 90%; max-width: 800px; max-height: 90vh; overflow: auto; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); }
        .modal-header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px 30px; display: flex; justify-content: space-between; align-items: center; }
        .modal-header h2 { font-size: 24px; }
        .close-btn { background: none; border: none; color: white; font-size: 28px; cursor: pointer; line-height: 1; }
        .modal-body { padding: 30px; }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 8px; font-weight: 600; color: #333; }
        .form-group input, .form-group textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; }
        .form-group textarea { min-height: 150px; font-family: 'Courier New', monospace; }
        .btn { padding: 12px 24px; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; transition: all 0.3s ease; font-weight: 600; }
        .btn-primary { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
        .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4); }
        .btn-secondary { background: #6c757d; color: white; }
        .btn-secondary:hover { background: #5a6268; }
        .btn-danger { background: #dc3545; color: white; }
        .btn-danger:hover { background: #c82333; }
        .btn-group { display: flex; gap: 10px; margin-top: 20px; }
        .keys-list { margin-top: 30px; }
        .keys-list h3 { margin-bottom: 15px; color: #333; }
        .key-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 15px; border: 1px solid #e9ecef; border-radius: 8px; margin-bottom: 10px; background: #f8f9fa; }
        .key-item-info { flex: 1; overflow: hidden; }
        .key-item-id { font-weight: 600; color: #667eea; margin-bottom: 4px; }
        .key-item-key { font-family: 'Courier New', monospace; font-size: 12px; color: #6c757d; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tabs { display: flex; border-bottom: 2px solid #e9ecef; margin-bottom: 20px; }
        .tab { padding: 12px 24px; background: none; border: none; font-size: 16px; font-weight: 600; color: #6c757d; cursor: pointer; border-bottom: 3px solid transparent; transition: all 0.3s ease; }
        .tab.active { color: #667eea; border-bottom-color: #667eea; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .success-msg { background: #d4edda; color: #155724; padding: 12px; border-radius: 8px; margin-bottom: 15px; border: 1px solid #c3e6cb; }
        .error-msg { background: #f8d7da; color: #721c24; padding: 12px; border-radius: 8px; margin-bottom: 15px; border: 1px solid #f5c6cb; }
        .copy-btn { background: none; border: none; color: #667eea; cursor: pointer; font-size: 16px; padding: 4px 8px; margin-left: 8px; transition: all 0.2s ease; border-radius: 4px; }
        .copy-btn:hover { background: #f0f0f0; transform: scale(1.1); }
        .copy-btn:active { transform: scale(0.95); }
        .copy-btn.copied { color: #28a745; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <button class="manage-btn" onclick="openManageModal()">Key 管理</button>
            <h1>API 余额监控看板</h1>
            <div class="update-time" id="updateTime">正在加载...</div>
        </div>


        <div class="stats-cards" id="statsCards"></div>


        <div class="table-container">
            <div id="tableContent">
                <div class="loading">正在加载数据...</div>
            </div>
        </div>
    </div>

    <div class="fab-container" id="fabContainer">
        <button class="fab-toggle" onclick="toggleFabMenu(event)" aria-expanded="false" aria-controls="fabActions">
            <span id="fabToggleIcon">☰</span>
        </button>
        <div class="fab-actions" id="fabActions">
            <button class="export-keys-btn action-btn" onclick="closeFabMenu(); exportKeys();" id="exportKeysBtn">
                <span>📥 导出Key</span>
            </button>
            <button class="delete-all-btn action-btn" onclick="closeFabMenu(); deleteAllKeys();" id="deleteAllBtn">
                <span>🗑️ 删除所有</span>
            </button>
            <button class="delete-zero-btn action-btn" onclick="closeFabMenu(); deleteZeroBalanceKeys();" id="deleteZeroBtn">
                <span>🗑️ 删除无效</span>
            </button>
            <button class="refresh-btn action-btn" onclick="closeFabMenu(); loadData();">
                <span class="spinner" style="display: none;" id="spinner"></span>
                <span id="btnText">刷新数据</span>
            </button>
        </div>
    </div>

    <div id="manageModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>API Key 管理</h2>
                <button class="close-btn" onclick="closeManageModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div id="modalMessage"></div>

                <form onsubmit="batchImportKeys(event)">
                    <div class="form-group">
                        <label>批量导入 Keys（每行一个 Key）</label>
                        <textarea id="batchKeysInput" placeholder="例如:&#10;fk-xxxxx&#10;fk-yyyyy&#10;fk-zzzzz"></textarea>
                    </div>
                    <div class="btn-group">
                        <button type="submit" class="btn btn-primary">批量导入</button>
                        <button type="button" class="btn btn-secondary" onclick="document.getElementById('batchKeysInput').value='';">清空</button>
                    </div>
                </form>
            </div>
        </div>
    </div>  
  
  
    <script>
        // Global variable to store current API data
        let currentApiData = null;
        let fabMenuInitialized = false;

        function closeFabMenu() {
            const container = document.getElementById('fabContainer');
            const toggleBtn = document.querySelector('.fab-toggle');
            const icon = document.getElementById('fabToggleIcon');
            if (!container) return;
            container.classList.remove('open');
            if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
            if (icon) {
                icon.textContent = '☰';
                icon.setAttribute('aria-label', '展开操作');
            }
        }

        function toggleFabMenu(event) {
            event.stopPropagation();
            const container = document.getElementById('fabContainer');
            const toggleBtn = document.querySelector('.fab-toggle');
            const icon = document.getElementById('fabToggleIcon');
            if (!container) return;
            const isOpen = container.classList.toggle('open');
            if (toggleBtn) toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            if (icon) {
                icon.textContent = isOpen ? '×' : '☰';
                icon.setAttribute('aria-label', isOpen ? '收起操作' : '展开操作');
            }
            if (!fabMenuInitialized) {
                document.addEventListener('click', (e) => {
                    const fabContainer = document.getElementById('fabContainer');
                    if (fabContainer && !fabContainer.contains(e.target)) {
                        closeFabMenu();
                    }
                });
                fabMenuInitialized = true;
            }
        }

        const formatNumber = (num) => num ? new Intl.NumberFormat('en-US').format(num) : '0';
        const formatPercentage = (ratio) => ratio ? (ratio * 100).toFixed(2) + '%' : '0.00%';  
  
  
        function loadData(retryCount = 0) {  
            const spinner = document.getElementById('spinner');  
            const btnText = document.getElementById('btnText');  
                
            spinner.style.display = 'inline-block';  
            btnText.textContent = '加载中...';  
  
  
            fetch('/api/data?t=' + new Date().getTime())  
                .then(response => {  
                    // If server is still initializing (503), auto-retry after 2 seconds
                    if (response.status === 503 && retryCount < 5) {
                        console.log(\`Server initializing, retrying in 2 seconds... (attempt \${retryCount + 1}/5)\`);
                        document.getElementById('tableContent').innerHTML = \`<div class="loading">服务器正在初始化数据，请稍候... (尝试 \${retryCount + 1}/5)</div>\`;
                        setTimeout(() => loadData(retryCount + 1), 2000);
                        return null;
                    }
                    if (!response.ok) {  
                        throw new Error('无法加载数据: ' + response.statusText);  
                    }  
                    return response.json();  
                })  
                .then(data => {
                    if (data === null) return; // Skip if retrying
                    if (data.error) {  
                        throw new Error(data.error);  
                    }  
                    displayData(data);  
                })  
                .catch(error => {  
                    document.getElementById('tableContent').innerHTML = \`<div class="error">❌ 加载失败: \${error.message}</div>\`;  
                    document.getElementById('updateTime').textContent = "加载失败";  
                })  
                .finally(() => {  
                    spinner.style.display = 'none';  
                    btnText.textContent = '🔄 刷新数据';  
                });  
        }  
  
  
        function displayData(data) {
            // Store data globally for other functions to use
            currentApiData = data;

            document.getElementById('updateTime').textContent = \`最后更新: \${data.update_time} | 共 \${data.total_count} 个API Key\`;

            const totalAllowance = data.totals.total_totalAllowance;
            const totalUsed = data.totals.total_orgTotalTokensUsed;
            // MODIFICATION: Use the totalRemaining value calculated on the backend.
            const totalRemaining = data.totals.totalRemaining;
            const overallRatio = totalAllowance > 0 ? totalUsed / totalAllowance : 0;  
  
  
            const statsCards = document.getElementById('statsCards');  
            statsCards.innerHTML = \`  
                <div class="stat-card"><div class="label">总计额度 (Total Allowance)</div><div class="value">\${formatNumber(totalAllowance)}</div></div>  
                <div class="stat-card"><div class="label">已使用 (Total Used)</div><div class="value">\${formatNumber(totalUsed)}</div></div>  
                <div class="stat-card"><div class="label">剩余额度 (Remaining)</div><div class="value">\${formatNumber(totalRemaining)}</div></div>  
                <div class="stat-card"><div class="label">使用百分比 (Usage %)</div><div class="value">\${formatPercentage(overallRatio)}</div></div>  
            \`;  
  
  
            let tableHTML = \`
                <table>
                    <thead>
                        <tr>
                            <th>API Key</th>
                            <th>开始时间</th>
                            <th>结束时间</th>
                            <th class="number">总计额度</th>
                            <th class="number">已使用</th>
                            <th class="number">剩余额度</th>
                            <th class="number">使用百分比</th>
                            <th style="text-align: center;">操作</th>
                        </tr>
                    </thead>
                    <tbody>\`;


            data.data.forEach(item => {
                if (item.error) {
                    tableHTML += \`
                        <tr>
                            <td class="key-cell" title="\${item.key}">
                                <span>\${item.key}</span>
                                <button class="copy-btn" onclick="copyKey('\${item.id}')" title="复制完整Key">📋</button>
                            </td>
                            <td colspan="5" class="error-row">加载失败: \${item.error}</td>
                            <td style="text-align: center;">
                                <button class="btn btn-primary" onclick="refreshSingleKey('\${item.id}')" style="padding: 6px 12px; font-size: 12px; margin-right: 5px;">刷新</button>
                                <button class="btn btn-danger" onclick="deleteKeyFromTable('\${item.id}')" style="padding: 6px 12px; font-size: 12px;">删除</button>
                            </td>
                        </tr>\`;
                } else {
                    // MODIFICATION: Calculate remaining here, ensuring it's not negative.
                    const remaining = Math.max(0, item.totalAllowance - item.orgTotalTokensUsed);
                    tableHTML += \`
                        <tr id="key-row-\${item.id}">
                            <td class="key-cell" title="\${item.key}">
                                <span>\${item.key}</span>
                                <button class="copy-btn" onclick="copyKey('\${item.id}')" title="复制完整Key">📋</button>
                            </td>
                            <td>\${item.startDate}</td>
                            <td>\${item.endDate}</td>
                            <td class="number">\${formatNumber(item.totalAllowance)}</td>
                            <td class="number">\${formatNumber(item.orgTotalTokensUsed)}</td>
                            <td class="number">\${formatNumber(remaining)}</td>
                            <td class="number">\${formatPercentage(item.usedRatio)}</td>
                            <td style="text-align: center;">
                                <button class="btn btn-primary" onclick="refreshSingleKey('\${item.id}')" style="padding: 6px 12px; font-size: 12px; margin-right: 5px;">刷新</button>
                                <button class="btn btn-danger" onclick="deleteKeyFromTable('\${item.id}')" style="padding: 6px 12px; font-size: 12px;">删除</button>
                            </td>
                        </tr>\`;
                }
            });


            tableHTML += \`
                    </tbody>
                </table>\`; 
  
  
            document.getElementById('tableContent').innerHTML = tableHTML;  
        }  
  
  
        document.addEventListener('DOMContentLoaded', loadData);

        // Copy Key Function
        async function copyKey(id) {
            try {
                // Fetch the full unmasked key from the server
                const response = await fetch(\`/api/keys/\${id}/full\`);
                const result = await response.json();
                
                if (!response.ok || !result.success) {
                    throw new Error(result.error || '获取完整Key失败');
                }
                
                // Copy the full key to clipboard
                await navigator.clipboard.writeText(result.key);
                
                // Find the button that was clicked and show feedback
                const buttons = document.querySelectorAll('.copy-btn');
                buttons.forEach(btn => {
                    if (btn.getAttribute('onclick').includes(id)) {
                        const originalText = btn.textContent;
                        btn.textContent = '✓';
                        btn.classList.add('copied');
                        
                        setTimeout(() => {
                            btn.textContent = originalText;
                            btn.classList.remove('copied');
                        }, 1500);
                    }
                });
            } catch (error) {
                alert('复制失败: ' + error.message);
            }
        }

        // Modal and Key Management Functions
        function openManageModal() {
            document.getElementById('manageModal').classList.add('show');
            clearMessage();
        }

        function closeManageModal() {
            document.getElementById('manageModal').classList.remove('show');
            clearMessage();
        }

        function showMessage(message, isError = false) {
            const msgDiv = document.getElementById('modalMessage');
            msgDiv.innerHTML = \`<div class="\${isError ? 'error-msg' : 'success-msg'}">\${message}</div>\`;
            setTimeout(() => clearMessage(), 5000);
        }

        function clearMessage() {
            document.getElementById('modalMessage').innerHTML = '';
        }

        async function exportKeys() {
            const password = prompt('请输入导出密码：');
            if (!password) return;

            const exportBtn = document.getElementById('exportKeysBtn');
            exportBtn.disabled = true;
            exportBtn.innerHTML = '<span>⏳ 导出中...</span>';

            try {
                const response = await fetch('/api/keys/export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });

                const result = await response.json();

                if (response.ok) {
                    const keysText = result.keys.map(k => k.key).join('\\n');
                    const blob = new Blob([keysText], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = Object.assign(document.createElement('a'), {
                        href: url,
                        download: \`api_keys_export_\${new Date().toISOString().split('T')[0]}.txt\`
                    });
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    alert(\`成功导出 \${result.keys.length} 个Key\`);
                } else {
                    alert('导出失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                alert('网络错误: ' + error.message);
            } finally {
                exportBtn.disabled = false;
                exportBtn.innerHTML = '<span>📥 导出Key</span>';
            }
        }

        async function deleteAllKeys() {
            if (!currentApiData) return alert('请先加载数据');

            const totalKeys = currentApiData.total_count;
            if (totalKeys === 0) return alert('没有可删除的Key');

            const confirmMsg = \`⚠️ 危险操作！\\n\\n确定要删除所有 \${totalKeys} 个Key吗？\\n此操作不可恢复！\`;
            if (!confirm(confirmMsg)) return;

            const secondConfirm = prompt('请输入 "确认删除" 以继续：');
            if (secondConfirm !== '确认删除') return alert('操作已取消');

            const deleteBtn = document.getElementById('deleteAllBtn');
            deleteBtn.disabled = true;
            deleteBtn.innerHTML = '<span>⏳ 删除中...</span>';

            try {
                const allIds = currentApiData.data.map(item => item.id);
                const response = await fetch('/api/keys/batch-delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: allIds })
                });

                const result = await response.json();

                if (response.ok) {
                    alert(\`成功删除 \${result.deleted || totalKeys} 个Key\`);
                    loadData(); // Refresh data
                } else {
                    alert('删除失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                alert('网络错误: ' + error.message);
            } finally {
                deleteBtn.disabled = false;
                deleteBtn.innerHTML = '<span>🗑️ 删除所有</span>';
            }
        }

        async function deleteZeroBalanceKeys() {
            if (!currentApiData) return alert('请先加载数据');

            const zeroBalanceKeys = currentApiData.data.filter(item => {
                if (item.error) return false;
                const remaining = Math.max(0, (item.totalAllowance || 0) - (item.orgTotalTokensUsed || 0));
                return remaining === 0;
            });

            if (zeroBalanceKeys.length === 0) return alert('没有找到余额为0的Key');

            const confirmMsg = \`确定要删除 \${zeroBalanceKeys.length} 个余额为0的Key吗？\\n\\n将删除以下Key ID:\\n\${zeroBalanceKeys.map(k => k.id).join('\\n')}\`;

            if (!confirm(confirmMsg)) {
                return;
            }

            const deleteBtn = document.getElementById('deleteZeroBtn');
            deleteBtn.disabled = true;
            deleteBtn.innerHTML = '<span>⏳ 删除中...</span>';

            try {
                const response = await fetch('/api/keys/batch-delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: zeroBalanceKeys.map(k => k.id) })
                });

                const result = await response.json();

                if (response.ok) {
                    alert(\`成功删除 \${result.deleted || zeroBalanceKeys.length} 个Key\`);
                    loadData(); // Refresh data
                } else {
                    alert('删除失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                alert('网络错误: ' + error.message);
            } finally {
                deleteBtn.disabled = false;
                deleteBtn.innerHTML = '<span>🗑️ 删除无效</span>';
            }
        }

        async function batchImportKeys(event) {
            event.preventDefault();
            const input = document.getElementById('batchKeysInput').value.trim();

            if (!input) return showMessage('请输入要导入的 Keys', true);

            const lines = input.split('\\n').map(line => line.trim()).filter(line => line.length > 0);
            const keysToImport = [];
            const timestamp = Date.now();
            let autoIdCounter = 1;

            for (const line of lines) {
                if (line.includes(':')) {
                    const [id, key] = line.split(':').map(s => s.trim());
                    if (id && key) keysToImport.push({ id, key });
                } else {
                    const randomSuffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
                    keysToImport.push({
                        id: \`key-\${timestamp}-\${autoIdCounter++}-\${randomSuffix}\`,
                        key: line
                    });
                }
            }

            if (keysToImport.length === 0) return showMessage('没有有效的 Key 可以导入', true);

            try {
                const response = await fetch('/api/keys', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(keysToImport)
                });

                const result = await response.json();

                if (response.ok) {
                    const msg = \`成功导入 \${result.added} 个 Key\${result.skipped > 0 ? \`, 跳过 \${result.skipped} 个重复的 Key\` : ''}\`;
                    showMessage(msg);
                    document.getElementById('batchKeysInput').value = '';
                    loadData(); // Refresh main data
                } else {
                    showMessage(result.error || '批量导入失败', true);
                }
            } catch (error) {
                showMessage('网络错误: ' + error.message, true);
            }
        }

        async function deleteKeyFromTable(id) {
            if (!confirm(\`确定要删除 Key "\${id}" 吗？\`)) return;

            try {
                const response = await fetch(\`/api/keys/\${id}\`, { method: 'DELETE' });
                const result = await response.json();

                if (response.ok) {
                    alert(\`Key "\${id}" 已删除成功\`);
                    loadData();
                } else {
                    alert('删除失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                alert('网络错误: ' + error.message);
            }
        }

        async function refreshSingleKey(id) {
            const row = document.getElementById(\`key-row-\${id}\`);
            if (!row) return alert('找不到对应的行');

            const cells = row.querySelectorAll('td');
            const originalContent = [];
            cells.forEach((cell, index) => {
                originalContent[index] = cell.innerHTML;
                if (index > 0 && index < cells.length - 1) {
                    cell.innerHTML = '<span style="color: #6c757d;">⏳ 刷新中...</span>';
                }
            });

            try {
                const response = await fetch(\`/api/keys/\${id}/refresh\`, {
                    method: 'POST'
                });

                const result = await response.json();

                if (response.ok && result.data) {
                    const item = result.data;
                    
                    if (item.error) {
                        cells[1].innerHTML = '<span class="error-row">加载失败: ' + item.error + '</span>';
                        cells[2].colSpan = 5;
                        for (let i = 3; i < cells.length - 1; i++) cells[i].style.display = 'none';
                    } else {
                        const remaining = Math.max(0, item.totalAllowance - item.orgTotalTokensUsed);
                        [cells[1].innerHTML, cells[2].innerHTML, cells[3].innerHTML, 
                         cells[4].innerHTML, cells[5].innerHTML, cells[6].innerHTML] = 
                        [item.startDate, item.endDate, formatNumber(item.totalAllowance),
                         formatNumber(item.orgTotalTokensUsed), formatNumber(remaining), formatPercentage(item.usedRatio)];
                        
                        for (let i = 1; i < cells.length - 1; i++) {
                            cells[i].style.display = '';
                            cells[i].colSpan = 1;
                        }
                    }
                    loadData();
                } else {
                    alert('刷新失败: ' + (result.error || '未知错误'));
                    cells.forEach((cell, index) => cell.innerHTML = originalContent[index]);
                }
            } catch (error) {
                alert('网络错误: ' + error.message);
                cells.forEach((cell, index) => cell.innerHTML = originalContent[index]);
            }
        }

        document.addEventListener('click', (event) => {
            const modal = document.getElementById('manageModal');
            if (event.target === modal) closeManageModal();
        });
    </script>
</body>
</html>
`;  
  
  
// ==================== API Data Fetching ====================

/**
 * Batch process promises with concurrency control to avoid rate limiting.
 */
async function batchProcess<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = 10,
  delayMs: number = 100
): Promise<R[]> {
  const results: R[] = [];
  
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
    
    // Add delay between batches to avoid rate limiting
    if (i + concurrency < items.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  return results;
}

/**
 * Fetches usage data for a single API key with retry logic.
 */
async function fetchApiKeyData(id: string, key: string, retryCount = 0): Promise<ApiKeyResult> {
  const maskedKey = maskApiKey(key);
  const maxRetries = 2;

  try {
    const response = await fetch(CONFIG.API_ENDPOINT, {
      headers: {
        'Authorization': `Bearer ${key}`,
        'User-Agent': CONFIG.USER_AGENT,
      }
    });

    if (!response.ok) {
      if (response.status === 401 && retryCount < maxRetries) {
        const delayMs = (retryCount + 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return fetchApiKeyData(id, key, retryCount + 1);
      }
      return { id, key: maskedKey, error: `HTTP ${response.status}` };
    }

    const apiData: ApiResponse = await response.json();
    const { usage } = apiData;
    
    if (!usage?.standard) {
      return { id, key: maskedKey, error: 'Invalid API response' };
    }

    const { standard } = usage;
    return {
      id,
      key: maskedKey,
      startDate: formatDate(usage.startDate),
      endDate: formatDate(usage.endDate),
      orgTotalTokensUsed: standard.orgTotalTokensUsed || 0,
      totalAllowance: standard.totalAllowance || 0,
      usedRatio: standard.usedRatio || 0,
    };
  } catch (error) {
    return { id, key: maskedKey, error: 'Failed to fetch' };
  }
}  
  
  
// ==================== Type Guards ====================

const isApiUsageData = (result: ApiKeyResult): result is ApiUsageData => !('error' in result);

// ==================== Data Aggregation ====================

/**
 * Aggregates data from all configured API keys.
 */
async function getAggregatedData(db: D1Database): Promise<AggregatedResponse> {
  const keyPairs = await getAllKeys(db);
  const beijingTime = getBeijingTime();
  const emptyResponse = {
    update_time: formatBeijingTime(beijingTime, "yyyy-MM-dd HH:mm:ss"),
    total_count: 0,
    totals: { total_orgTotalTokensUsed: 0, total_totalAllowance: 0, totalRemaining: 0 },
    data: [],
  };

  if (keyPairs.length === 0) return emptyResponse;

  const results = await batchProcess(
    keyPairs,
    ({ id, key }) => fetchApiKeyData(id, key),
    10,
    100
  );

  const validResults = results.filter(isApiUsageData);
  const sortedValid = validResults
    .map(r => ({ ...r, remaining: Math.max(0, r.totalAllowance - r.orgTotalTokensUsed) }))
    .sort((a, b) => b.remaining - a.remaining)
    .map(({ remaining, ...rest }) => rest);

  const totals = validResults.reduce((acc, res) => ({
    total_orgTotalTokensUsed: acc.total_orgTotalTokensUsed + res.orgTotalTokensUsed,
    total_totalAllowance: acc.total_totalAllowance + res.totalAllowance,
    totalRemaining: acc.totalRemaining + Math.max(0, res.totalAllowance - res.orgTotalTokensUsed)
  }), emptyResponse.totals);

  logKeysWithBalance(validResults, keyPairs);

  return {
    update_time: formatBeijingTime(beijingTime, "yyyy-MM-dd HH:mm:ss"),
    total_count: keyPairs.length,
    totals,
    data: [...sortedValid, ...results.filter(r => 'error' in r)],
  };
}

/**
 * Logs API keys that still have remaining balance.
 */
function logKeysWithBalance(validResults: ApiUsageData[], keyPairs: ApiKey[]): void {
  const keysWithBalance = validResults.filter(r => {
    const remaining = r.totalAllowance - r.orgTotalTokensUsed;
    return remaining > 0;
  });

  if (keysWithBalance.length > 0) {
    console.log("=".repeat(80));
    console.log("📋 剩余额度大于0的API Keys:");
    console.log("-".repeat(80));

    keysWithBalance.forEach(item => {
      const originalKeyPair = keyPairs.find(kp => kp.id === item.id);
      if (originalKeyPair) {
        console.log(originalKeyPair.key);
      }
    });

    console.log("=".repeat(80) + "\n");
  } else {
    console.log("\n⚠️  没有剩余额度大于0的API Keys\n");
  }
}  


// ==================== Auto-Refresh Logic (NEW) ====================

/**
 * Periodically fetches data and updates the server state cache.
 */
async function autoRefreshData(env: Env) {
  if (serverState.isCurrentlyUpdating()) return;
  
  const timestamp = formatBeijingTime(getBeijingTime(), "HH:mm:ss");
  console.log(`[${timestamp}] Starting data refresh...`);
  serverState.startUpdate();
  
  try {
    const data = await getAggregatedData(env.DB);
    serverState.updateCache(data);
    console.log(`[${timestamp}] Data updated successfully.`);
  } catch (error) {
    serverState.setError(error instanceof Error ? error.message : 'Refresh failed');
  }
}

  
  
// ==================== Route Handlers ====================

/**
 * Handles POST /api/public/usage - fetch usage for a single public key without login or D1 access.
 */
async function handlePublicUsage(req: Request): Promise<Response> {
  try {
    const { key } = await req.json() as { key?: string };
    const trimmedKey = (key || '').trim();

    if (!trimmedKey) {
      return createErrorResponse("key is required", 400);
    }

    const keyData = await fetchApiKeyData(`public-${Date.now()}`, trimmedKey);
    if ('error' in keyData) {
      return createJsonResponse({ success: false, error: keyData.error, data: keyData }, 400);
    }

    return createJsonResponse({ success: true, data: keyData });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Invalid JSON';
    return createErrorResponse(errorMessage, 400);
  }
}

/**
 * Handles the root path - serves the HTML dashboard.
 */
async function handleRoot(req: Request, env: Env): Promise<Response> {
  const token = getCookie(req, 'session_token');
  if (!token || !(await isValidSession(token, env.EXPORT_PASSWORD))) {
    return new Response(LOGIN_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
  
  return new Response(HTML_CONTENT, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

/**
 * Handles POST /api/login - authenticates user and creates session.
 */
async function handleLogin(req: Request, env: Env): Promise<Response> {
  try {
    const { username, password } = await req.json() as { username: string; password: string };
    
    if (username !== env.EXPORT_PASSWORD || password !== env.EXPORT_PASSWORD) {
      return createErrorResponse("账号或密码错误", 401);
    }
    
    const token = await createSessionToken(env.EXPORT_PASSWORD);
    
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": `session_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DURATION / 1000}`
      }
    });
  } catch (error) {
    return createErrorResponse("请求格式错误", 400);
  }
}

/**
 * Handles POST /api/logout - destroys session.
 */
function handleLogout(_req: Request): Response {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": "session_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
    }
  });
}

/**
 * Handles the /api/data endpoint - returns aggregated usage data.
 * Always fetches fresh data from KV to ensure consistency across requests.
 */
async function handleGetData(env: Env): Promise<Response> {
  try {
    const data = await getAggregatedData(env.DB);
    return createJsonResponse(data);
  } catch (error) {
    console.error('Error getting data:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to load data';
    return createErrorResponse(errorMessage, 500);
  }
}

/**
 * Handles GET /api/keys - returns all stored API keys.
 */
async function handleGetKeys(env: Env): Promise<Response> {
  try {
    const keys = await getAllKeys(env.DB);
    return createJsonResponse(keys);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error getting keys:', errorMessage);
    return createErrorResponse(errorMessage, 500);
  }
}

/**
 * Handles POST /api/keys - adds single or multiple API keys.
 */
async function handleAddKeys(req: Request, env: Env): Promise<Response> {
  try {
    const body = await req.json();

    // Support batch import
    if (Array.isArray(body)) {
      return await handleBatchImport(body, env);
    } else {
      return await handleSingleKeyAdd(body, env);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Invalid JSON';
    console.error('Error adding keys:', errorMessage);
    return createErrorResponse(errorMessage, 400);
  }
}

async function handleBatchImport(items: unknown[], env: Env): Promise<Response> {
  let added = 0, skipped = 0;
  const existingKeys = new Set((await getAllKeys(env.DB)).map(k => k.key));

  for (const item of items) {
    if (!item || typeof item !== 'object' || !('key' in item)) continue;
    
    const { key } = item as { key: string };
    if (!key || existingKeys.has(key)) {
      if (key) skipped++;
      continue;
    }

    const id = `key-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    await addKey(env.DB, id, key);
    existingKeys.add(key);
    added++;
  }

  if (added > 0) serverState.clearCache();

  return createJsonResponse({ success: true, added, skipped });
}

async function handleSingleKeyAdd(body: unknown, env: Env): Promise<Response> {
  if (!body || typeof body !== 'object' || !('key' in body)) {
    return createErrorResponse("key is required", 400);
  }

  const { key } = body as { key: string };
  if (!key) return createErrorResponse("key cannot be empty", 400);
  if (await apiKeyExists(env.DB, key)) return createErrorResponse("API key already exists", 409);

  const id = `key-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  await addKey(env.DB, id, key);
  serverState.clearCache();
  
  return createJsonResponse({ success: true });
}

async function handleDeleteKey(pathname: string, env: Env): Promise<Response> {
  const id = pathname.split("/api/keys/")[1];
  if (!id) return createErrorResponse("Key ID is required", 400);

  await deleteKey(env.DB, id);
  serverState.clearCache();
  
  return createJsonResponse({ success: true });
}

async function handleBatchDeleteKeys(req: Request, env: Env): Promise<Response> {
  try {
    const { ids } = await req.json() as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return createErrorResponse("ids array is required", 400);
    }

    await Promise.all(ids.map(id => deleteKey(env.DB, id).catch(() => {})));
    serverState.clearCache();

    return createJsonResponse({ success: true, deleted: ids.length });
  } catch (error) {
    return createErrorResponse(error instanceof Error ? error.message : 'Invalid JSON', 400);
  }
}

/**
 * Handles POST /api/keys/export - exports all API keys with password verification.
 */
async function handleExportKeys(req: Request, env: Env): Promise<Response> {
  try {
    const { password } = await req.json() as { password: string };

    // Verify password
    if (password !== env.EXPORT_PASSWORD) {
      return createErrorResponse("密码错误", 401);
    }

    // Get all keys (unmasked)
    const keys = await getAllKeys(env.DB);

    return createJsonResponse({
      success: true,
      keys
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Invalid JSON';
    console.error('Error exporting keys:', errorMessage);
    return createErrorResponse(errorMessage, 400);
  }
}

/**
 * Handles GET /api/keys/:id/full - returns the full unmasked key for a specific ID.
 */
async function handleGetFullKey(pathname: string, env: Env): Promise<Response> {
  try {
    const id = pathname.split("/api/keys/")[1]?.split("/")[0];
    if (!id) return createErrorResponse("Key ID is required", 400);

    const fullKey = await getKeyById(env.DB, id);
    if (!fullKey) return createErrorResponse("Key not found", 404);

    return createJsonResponse({ success: true, key: fullKey });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error getting full key:', errorMessage);
    return createErrorResponse(errorMessage, 500);
  }
}

/**
 * Handles POST /api/keys/:id/refresh - refreshes data for a single API key.
 */
async function handleRefreshSingleKey(pathname: string, env: Env): Promise<Response> {
  try {
    const id = pathname.split("/api/keys/")[1].replace("/refresh", "");

    if (!id) {
      return createErrorResponse("Key ID is required", 400);
    }

    // Get the key from database
    const key = await getKeyById(env.DB, id);
    
    if (!key) {
      return createErrorResponse("Key not found", 404);
    }

    // Fetch fresh data for this key
    const keyData = await fetchApiKeyData(id, key);

    return createJsonResponse({
      success: true,
      data: keyData
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error refreshing key:', errorMessage);
    return createErrorResponse(errorMessage, 500);
  }
}

// ==================== Main Request Handler ====================

/**
 * Main HTTP request handler that routes requests to appropriate handlers.
 */
async function handler(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  // Route: Root path - Dashboard
  if (url.pathname === "/") {
    return await handleRoot(req, env);
  }

  // Route: GET /public - Public query page
  if (url.pathname === "/public" && req.method === "GET") {
    return new Response(PUBLIC_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }

  // Route: POST /api/public/usage - Public key usage query
  if (url.pathname === "/api/public/usage" && req.method === "POST") {
    return await handlePublicUsage(req);
  }

  // Route: POST /api/login - Login
  if (url.pathname === "/api/login" && req.method === "POST") {
    return await handleLogin(req, env);
  }

  // Route: POST /api/logout - Logout
  if (url.pathname === "/api/logout" && req.method === "POST") {
    return handleLogout(req);
  }

  // Route: GET /api/data - Get aggregated usage data
  if (url.pathname === "/api/data" && req.method === "GET") {
    return await handleGetData(env);
  }

  // Route: GET /api/keys - Get all keys
  if (url.pathname === "/api/keys" && req.method === "GET") {
    return await handleGetKeys(env);
  }

  // Route: POST /api/keys - Add key(s)
  if (url.pathname === "/api/keys" && req.method === "POST") {
    return await handleAddKeys(req, env);
  }

  // Route: POST /api/keys/batch-delete - Batch delete keys
  if (url.pathname === "/api/keys/batch-delete" && req.method === "POST") {
    return await handleBatchDeleteKeys(req, env);
  }

  // Route: POST /api/keys/export - Export keys with password
  if (url.pathname === "/api/keys/export" && req.method === "POST") {
    return await handleExportKeys(req, env);
  }

  // Route: DELETE /api/keys/:id - Delete a key
  if (url.pathname.startsWith("/api/keys/") && req.method === "DELETE") {
    return await handleDeleteKey(url.pathname, env);
  }

  // Route: POST /api/keys/:id/refresh - Refresh single key
  if (url.pathname.match(/^\/api\/keys\/.+\/refresh$/) && req.method === "POST") {
    return await handleRefreshSingleKey(url.pathname, env);
  }

  // Route: GET /api/keys/:id/full - Get full unmasked key
  if (url.pathname.match(/^\/api\/keys\/.+\/full$/) && req.method === "GET") {
    return await handleGetFullKey(url.pathname, env);
  }

  // 404 for all other routes
  return new Response("Not Found", { status: 404 });
}

// ==================== Cloudflare Workers Export ====================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      console.log(`[${new Date().toISOString()}] Request: ${request.method} ${new URL(request.url).pathname}`);
      const response = await handler(request, env);
      console.log(`[${new Date().toISOString()}] Response: ${response.status}`);
      return response;
    } catch (error) {
      console.error('[FATAL ERROR]', error);
      return new Response(JSON.stringify({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    await autoRefreshData(env);
  }
};
