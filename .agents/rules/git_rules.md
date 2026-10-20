# Git 与开发规范

1. 保持零外部 npm 依赖，网络请求统一走 `src/http.mjs`。
2. SQLite 底层统一封装在 `src/db/driver.mjs`，强制启用 WAL 与 `busy_timeout=8000`。
3. 必须提供数据定向补偿机制（`src/compensate.mjs`）。
4. 严格 Header 鉴权（`Authorization: Bearer <AUTH_TOKEN>`），禁用 URL query 传 token。
5. 提交前必须确认 `.gitignore` 排除 `data/*.db*`，提交信息遵循 Conventional Commits 规范并推送到远程 master 分支。
