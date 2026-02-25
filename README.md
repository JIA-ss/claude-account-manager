# claude-account-manager

独立于主工程的账号管理 + Claude OAuth 测试页（前后端分离）。

## 目录

- `backend/server.js`：后端 API + 静态资源托管
- `frontend/index.html`：前端页面
- `frontend/app.js`：前端交互逻辑
- `frontend/styles.css`：页面样式（对齐原工程账号管理页面风格）

## 启动

```bash
node backend/server.js
```

默认地址：

```text
http://127.0.0.1:8787
```

## 接口

- `GET /api/accounts`
  - 查询参数：`page` `page_size` `search` `platform` `type` `status`
  - 出参：`{ items, total, page, page_size, pages }`
- `POST /api/accounts`
  - 入参：普通账号创建信息（`name/platform/type/...`）
  - 出参：创建后的账号对象
- `GET /api/accounts/data`
  - 查询参数：`ids`（逗号分隔，可选）`platform` `type` `status` `search` `include_proxies`
  - 逻辑：导出账号数据，格式对齐原工程 `DataPayload`
  - 出参：`{ exported_at, proxies, accounts }`
- `POST /api/accounts/data`
  - 入参：`{ data: DataPayload, skip_default_group_bind?: boolean }`
  - 逻辑：按原工程数据格式导入账号与代理（支持 `type: sub2api-data/sub2api-bundle`、`version: 1`）
  - 出参：`{ proxy_created, proxy_reused, proxy_failed, account_created, account_failed, errors? }`
- `POST /api/accounts/from-auth-code`
  - 入参：`{ name, platform: "anthropic", type: "oauth|setup-token", session_id, code, ... }`
  - 逻辑：按原工程 Claude OAuth 流程 `code -> token` 兑换后落库存储账号凭证
- `POST /api/accounts/refresh-usage`
  - 逻辑：强制拉取所有账号用量信息（当前实现主要针对 Anthropic OAuth 账号）
  - 出参：刷新结果汇总
- `GET /api/background-refresh/status`
  - 出参：后台刷新状态（开关、间隔、下次执行、上次执行结果等）
- `POST /api/background-refresh/config`
  - 入参：`{ enabled?: boolean, interval_seconds?: 1|10|30|60|120|300 }`
  - 逻辑：更新后台刷新配置（持久化到本地）
- `POST /api/background-refresh/run-now`
  - 逻辑：立即触发一次后台刷新任务
  - 出参：`{ status, result }`
- `POST /api/generate-auth-url`
  - 入参：`{ "add_method": "oauth" }`（可选；`setup-token` 会生成 inference scope）
  - 出参：`{ "auth_url": "...", "session_id": "..." }`
- `POST /api/prepare-exchange`
  - 入参：`{ "session_id": "...", "code": "..." }`
  - 出参：`{ "session_id": "...", "code": "..." }`

## 说明

- 账号页已包含：
  - 账号列表展示（分页/筛选）
  - 自动刷新（5/10/15/30s）
  - 后台刷新状态展示（服务端常驻任务）
  - 添加账号（普通创建 + Anthropic OAuth 授权码创建）
  - 数据导入/导出（格式与原工程一致）
- 自动刷新与手动刷新会触发后端强制拉取所有账号用量。
- 当后台刷新开启后，即使没有前端页面在线，后端也会按配置间隔自动执行用量查询。
- Claude OAuth 链接生成逻辑与主工程保持一致：
  - 固定 `client_id`
  - 每次生成新的 `state` / `code_verifier` / `code_challenge` / `session_id`
- `from-auth-code` 会直接调用 Claude token 兑换接口并保存账号信息。
