# newapi-health

为 [new-api](https://github.com/Calcium-Ion/new-api) 及 OpenAI 兼容接口设计的模型健康度监控面板。

实时检测模型接口的可用性与响应延迟，在单页仪表盘里展示健康度、延迟趋势和历史记录。

## 功能特性

- 三级结构配置：`供应商 → 分组 → 模型`，按层级筛选
- 支持 OpenAI-compatible、Anthropic Messages、Google Gemini 三种协议
- 历史时间线（40格），hover 查看每次检测的状态、延迟、Ping 和消息
- 端点 Ping 检测（HEAD 请求测网络延迟）
- 顶部统计随筛选实时联动（健康度 / 模型数 / 平均延迟）
- 自动识别 OpenAI / Anthropic / Gemini 品牌图标
- 白天 / 夜间主题切换（19:00–07:00 自动暗色，右上角可手动切换）
- 历史数据纯内存存储，无需数据库

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/yourname/newapi-health.git
cd newapi-health
```

### 2. 安装依赖

```bash
pnpm install
# 或 npm install
```

### 3. 配置检测目标

```bash
cp config/checks.example.json config/checks.json
```

编辑 `config/checks.json`，填入你的供应商、分组和模型信息（见下方[配置说明](#配置说明)）。

### 4. 启动

```bash
# 开发模式
pnpm dev

# 生产构建
pnpm build
pnpm start
```

访问 [http://localhost:3000](http://localhost:3000)。

---

## 配置说明

配置文件为 `config/checks.json`，采用三级结构：

```json
{
  "providers": [
    {
      "id": "claude",
      "name": "Anthropic",
      "groups": [
        {
          "id": "claude-max",
          "name": "claude-max",
          "models": [
            {
              "id": "claude-sonnet-4-6",
              "name": "claude-sonnet-4-6",
              "baseUrl": "https://your-proxy.example.com",
              "apiKey": "sk-xxxxxxxx",
              "endpoint": "/v1/messages",
              "model": "claude-sonnet-4-6",
              "description": "主力线路",
              "enabled": true
            }
          ]
        }
      ]
    }
  ]
}
```

### 字段说明

**provider**

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 唯一标识，如 `openai` / `claude` / `gemini` |
| `name` | ✅ | 页面展示名称 |
| `groups` | ✅ | 分组数组 |

**group**

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 分组唯一标识 |
| `name` | ✅ | 分组展示名称 |
| `models` | ✅ | 模型数组 |

**model**

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 模型唯一 ID，同一分组内不能重复 |
| `name` | ✅ | 卡片展示名称 |
| `baseUrl` | ✅ | 接口根地址，不带末尾斜杠 |
| `apiKey` | ✅ | API 密钥 |
| `endpoint` | ✅ | 协议路径，见下方支持的协议 |
| `model` | ✅ | 实际请求的模型名 |
| `description` | ❌ | 卡片描述文字 |
| `enabled` | ❌ | `false` 时跳过该模型，默认 `true` |

### 支持的协议

| 协议 | endpoint |
|------|----------|
| OpenAI Chat | `/v1/chat/completions` |
| OpenAI Responses | `/v1/responses` |
| Anthropic Messages | `/v1/messages` |
| Google Gemini | `/v1beta/models/{model}:generateContent` |

> Gemini 的 `{model}` 占位符会自动替换为 `model` 字段的值。

### 检测方式

每次检测向接口发送 `Reply with OK only.` 的请求：

- 响应文本包含 `ok`（不区分大小写）→ 健康
- 延迟超过阈值 → 标记为「响应较慢」
- 超时 / HTTP 错误 / 鉴权失败 / 响应结构异常 → 标记为「检测失败」

---

## 环境变量

在项目根目录创建 `.env.local` 可覆盖以下默认值：

```bash
# 检测轮询间隔（毫秒）
REFRESH_INTERVAL_MS=60000

# 检测进行中，前端刷新间隔（毫秒）
LIVE_POLL_INTERVAL_MS=1500

# 单次检测超时（毫秒）
CHECK_TIMEOUT_MS=20000

# 超过此延迟标记为「响应较慢」（毫秒）
DEGRADED_THRESHOLD_MS=4000

# 并发检测数量
CHECK_CONCURRENCY=4

# 每个模型保留的历史记录条数
HISTORY_LIMIT=40
```

---

## 安全提示

- `config/checks.json` 包含真实的 API 密钥，**请勿提交到公开仓库**
- 所有检测请求在服务端执行，密钥不会暴露到浏览器
- 建议将 `config/checks.json` 加入 `.gitignore`：

```bash
echo "config/checks.json" >> .gitignore
```

---

## 技术栈

- [Next.js 16](https://nextjs.org/) — App Router + Server Actions
- [React 19](https://react.dev/)
- [Tailwind CSS 4](https://tailwindcss.com/)
- [@lobehub/icons](https://github.com/lobehub/lobe-icons) — AI 品牌图标
- [Lucide React](https://lucide.dev/)
