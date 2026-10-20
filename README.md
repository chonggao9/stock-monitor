# A股智能监控与研判系统（stock-monitor v2.0）

监控多只 A 股标的的**实时行情、资金流向、重大公告与盘后交易（龙虎榜/大宗/两融）**，具备 **SQLite 时序持久化存储、纯原生轻量 Web 看板、历史数据定向补偿与 AI 智能对话研判** 能力。

**核心哲学**：保持 **纯 Node 原生 ESM、零外部 npm 依赖（Zero-npm-dependencies）**，基于 Node 内置 `node:sqlite`（WAL 模式）、内置 `fetch` 与原生内联 SVG 图表构建。

---

## 一、 系统核心功能

1. **标的动态持久化管理**：监控标的存入 SQLite 数据库，支持在 Web 界面增删改查、秒级启停开关、添加自定义研判备注。
2. **时序数据全面入库**：
   - 实时行情快照入库（`quotes`）
   - 资金流向多日时序入库（`fund_flows`，金额统一以“元”计入，展示层自动换算万元/亿元）
   - 巨潮资讯公告去重持久化（`announcements`）
   - 盘后交易（`post_market_data`：龙虎榜、大宗交易、融资融券）
   - 事件与升级告警（`events`：支持“黄升红”升级重新推送）
   - 每次运行批次与异常源记录（`pipeline_runs`）
3. **数据定向补偿（重点功能，Backfill）**：
   - 支持指定标的、指定历史日期范围、指定数据模块（公告、资金流向、盘后交易）进行回溯补齐，彻底解决断网遗漏与接口频控导致的未爬取问题。
   - Web 控制台提供一键后台补偿触发；CLI 提供 `npm run compensate` 脚本。
4. **AI 智能对话舱（RAG 动态注入）**：
   - 绑定个股时，自动调取目标股票的**最新行情报价、近5日主力资金流向、近7天重大预警事件、最近20条公告**作为客观事实注入 System Prompt。
   - 严格约束 AI 仅基于事实回答，禁止无依据臆测，自动记录结论引用的上下文 ID 列表（`context_refs`）。
   - 前端采用带自定义 `Authorization` 请求头的流式读取（`fetch` + `ReadableStream`），支持客户端中断与 `partial` 状态保护。
5. **极简内联 SVG 走势看板（零 CDN、零打包、完全离线）**：
   - 原生内联 SVG 绘制价格折线图（带高低标尺与红涨绿跌基准）
   - 原生内联 SVG 绘制主力资金红正绿负柱状图（带零轴与金额刻度）

---

## 二、 目录结构

```
stock-monitor/
├── package.json               # scripts 与配置
├── config.json               # 阈值、钉钉机器人与种子标的
├── data/
│   ├── stock_monitor.db      # SQLite 数据库文件 (WAL 模式)
│   └── szse_map.json         # 巨潮深市 orgId 映射本地缓存
├── public/                   # 纯原生 Web 前端（零构建单页）
│   ├── index.html            # 单页布局（5 大视图）
│   ├── style.css             # 现代深色科技主题
│   └── app.js                # 前端数据交互、内联SVG图表、流式对话
├── src/
│   ├── index.mjs             # 主采集编排入口
│   ├── server.mjs            # 内置 HTTP Web 服务与 RESTful API
│   ├── compensate.mjs        # 数据定向补偿引擎
│   ├── chat.mjs              # AI 对话与 RAG 上下文装配
│   ├── classify.mjs          # 本地规则引擎（带反向排除词与金额格式化）
│   ├── llm.mjs               # AI 结构化分析与 (type, id, model, ver) 缓存
│   ├── dingtalk.mjs          # 钉钉机器人加签推送
│   ├── fetchers.mjs          # 多源接口直采（公告多页、行情、资金、两融）
│   ├── http.mjs              # 带超时控制与重试的 HTTP 工具
│   ├── config.mjs            # 基础配置与标的校验
│   └── db/
│       ├── driver.mjs        # SQLite 驱动薄封装（busy_timeout与警告屏蔽）
│       ├── schema.mjs        # DDL 定义与 PRAGMA user_version 迁移管理
│       ├── repo.mjs          # 仓储层（所有业务 CRUD 与时序查询）
│       └── init.mjs          # 一键建表与种子数据导入
└── test/                     # node:test 自动化测试套件
    ├── classify.test.mjs     # 规则分级与反向排除词测试
    ├── repo.test.mjs         # 数据库 CRUD 与黄升红升级测试
    └── chat.test.mjs         # 对话上下文 RAG 提取测试
```

---

## 三、 环境变量配置 (Environment Variables)

为确保 API Key 与敏感凭证不落入代码仓库，系统通过环境变量进行严格安全控制：

| 环境变量名 | 说明 | 必填 | 默认值 / 示例 |
|---|---|---|---|
| `AUTH_TOKEN` | **Web API 访问密钥**（所有数据接口强制使用 `Authorization: Bearer <TOKEN>` 鉴权；**未配置此项 Web 服务拒绝启动**） | **是** | `your_secret_token_123` |
| `PORT` | Web 服务监听端口 | 否 | `3000` |
| `HOST` | Web 服务绑定 IP | 否 | `127.0.0.1` |
| `LLM_ANALYSIS_ENDPOINT` | 事件低延迟分析模型 OpenAI 兼容端点 | 否 | `https://api.deepseek.com/v1/chat/completions` |
| `LLM_ANALYSIS_KEY` | 事件分析模型 API Key | 否 | `sk-xxxx` |
| `LLM_ANALYSIS_MODEL` | 事件分析模型名称 | 否 | `deepseek-chat` |
| `MAX_AI_ANALYSIS_PER_RUN` | 单轮采集最大 AI 事件分析预算上限（防止大面积异动产生巨额 Token 账单） | 否 | `5` |
| `LLM_CHAT_ENDPOINT` | AI 对话舱大模型端点（支持本地 Ollama / vLLM 或云端端点） | 否 | `https://api.deepseek.com/v1/chat/completions` |
| `LLM_CHAT_KEY` | AI 对话舱 API Key | 否 | `sk-xxxx` |
| `LLM_CHAT_MODEL` | AI 对话舱模型名称 | 否 | `deepseek-chat` |

---

## 四、 快速上手与命令清单

### 1. 初始化数据库
从 `config.json` 导入初始股票种子并创建 SQLite 表：
```bash
npm run db:init
```

### 2. 启动 Web 控制台
设置环境变量并启动 Web 服务：
```powershell
# Windows PowerShell
$env:AUTH_TOKEN="my_admin_token"
npm run web
```
启动后在浏览器打开：`http://127.0.0.1:3000`，首次打开输入配置的 `AUTH_TOKEN` 即可进入管理看板。

### 3. 数据定向补偿 (Backfill)
对历史数据进行定向补爬：
```bash
# 方式 A: Web 控制台进入「数据补偿与状态」面板，直接选择标的、日期范围、模块一键后台触发。

# 方式 B: CLI 命令行执行
# 补偿指定股票（如 600703）最近 15 天的数据：
node src/compensate.mjs --stock 600703 --days 15

# 补偿全部已启用标的最近 30 天的数据：
npm run compensate
```

### 4. 运行采集与监控
```bash
# 实时轮询模式（仅抓取已启用的 enabled=1 股票）
npm run realtime

# 盘后补漏模式（含龙虎榜、大宗、两融全量盘后数据）
npm run catchup
```

### 5. 运行自动化测试
```bash
npm test
```

---

## 五、 数据来源与合规说明

1. **接口合规与限速政策**：
   - 本工具采集的巨潮资讯、腾讯财经、东方财富数据来源于互联网公共数据接口。
   - **内置限速防护**：多页抓取之间内置了礼貌延迟，深市代码映射本地文件持久缓存 7 天，标的采集默认限制并发数为 3，避免对第三方公共服务造成高频冲击。
   - 本系统仅供个人量化与技术研讨使用，切勿将其用于高频恶意爬取或商业倒卖。
2. **安全防护**：
   - 彻底废除 URL Query 传 Token 的做法，防止凭证泄露在浏览器历史和代理日志中。
   - 所有 `/api/*` 接口严格执行 `Authorization: Bearer <TOKEN>` 校验。
   - 数据库配置了 WAL 模式与 `busy_timeout=8000`，支持 Web 进程与采集任务平稳并发读写。
3. **免责声明**：
   - 本工具及 AI 对话提供的一切分析结论、异动分级均仅基于客观数据的清洗与统计，**不构成任何形式的投资建议或买卖依据**。
