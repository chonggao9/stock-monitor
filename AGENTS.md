# 项目规范与开发守则 (Project Rules & Agent Guide)

本文档记录本项目（`a-stock-monitor`）的核心架构原则、代码与提交规范，供所有参与本项目的开发者与 AI Agent 遵循。

---

## 一、 核心架构纪律 (Core Architecture)

1. **纯 Node 原生 ESM，坚持零外部 npm 依赖（Zero-npm-dependencies）**：
   - 所有网络请求使用 Node 内置 `fetch`，统一封装在 `src/http.mjs` 中，必须带有超时控制（Timeout）与重试保护。
   - 严禁擅自安装第三方网络库（如 axios、got、request 等）或图表/UI 框架。
2. **SQLite 驱动薄封装与并发隔离**：
   - 底层使用 Node 原生 `node:sqlite`，所有调用必须收口在 `src/db/driver.mjs` 中，禁止在业务层直接导入底层驱动，确保未来迁移驱动零成本。
   - 数据库必须启用 `PRAGMA journal_mode = WAL;` 与 `PRAGMA busy_timeout = 8000;`，确保 Web 服务与后台采集进程安全并发读写。
3. **数据获取与定向补偿机制（重点）**：
   - 任何新增数据源或爬虫逻辑，必须配套实现**定向补偿功能（Backfill）**，支持按标的、时间范围、数据模块定向回溯补齐，防止断网与频控造成数据断层。
4. **严格安全与 Header 鉴权**：
   - 所有 `/api/*` 接口强制使用 `Authorization: Bearer <AUTH_TOKEN>` 请求头鉴权。
   - 严禁通过 URL Query 参数传递 Token。
   - 未配置环境变量 `AUTH_TOKEN` 时，Web 服务必须拒绝启动。

---

## 二、 代码规范与业务逻辑防错 (Code Quality)

1. **行情与编码防御**：
   - 腾讯行情接口输出为 GBK 编码，解析时必须通过 `arrayBuffer()` 与 `TextDecoder('gbk')` 正确解码，股票名称优先使用系统内置校验名称。
   - 解析第三方接口字段时，必须做空值与 `NaN` 防御。
2. **规则引擎反向排除词**：
   - 关键词匹配必须包含反向排除逻辑（如“终止减持”、“未减持”、“解除质押”等），禁止将中性/利好进展误杀为红色恶性事件。
3. **AI 成本与调用上限**：
   - AI 分析只针对新入库且未超出单轮上限（`MAX_AI_ANALYSIS_PER_RUN`）的红/黄事件调用，并强制使用 `(target_type, target_id, model, prompt_ver)` 做 SQLite 唯一缓存。
4. **测试驱动保障**：
   - 修改分级规则、数据仓储或 API 接口后，必须运行 `npm test` 验证全部用例，保证测试 100% 通过。

---

## 三、 Git 提交与发布规范 (Git Workflow)

1. **敏感文件与运行时数据防泄露**：
   - 提交前必须确认 `.gitignore` 规则生效，**严禁将 `data/*.db`、`data/*.db-wal`、`data/*.db-shm` 等运行时产物及 `.env` 凭证文件提交至版本库**。
2. **提交信息规范 (Conventional Commits)**：
   - `feat: ...` 新增功能（如添加新视图、新数据源）
   - `fix: ...` 缺陷修复（如修复接口解析、补齐事件监听）
   - `docs: ...` 文档与规则更新
   - `test: ...` 自动化测试用例增补
   - `refactor: ...` 代码重构或性能优化
3. **远程推送流程**：
   - 每次完成功能或修复并测试全绿后，统一执行提交并同步至 GitHub：
     ```bash
     git add .
     git commit -m "docs: add project rules and git workflow guidelines"
     git push origin master
     ```
