# 接口说明

## 通用

- Base URL：`http://127.0.0.1:8787`
- 返回格式：JSON

## 健康检查

- `GET /api/health`
  - 出参：`{ status, sessions, accounts, background_refresh_enabled, background_refresh_running }`

## 账号管理

- `GET /api/accounts`
  - 查询参数：`page` `page_size` `search` `platform` `type` `status`
  - 出参：`{ items, total, page, page_size, pages }`

- `POST /api/accounts`
  - 入参：普通账号创建信息（`name/platform/type/...`）
  - 出参：创建后的账号对象

- `DELETE /api/accounts/:id`
  - 出参：`{ message: "deleted" }`

- `POST /api/accounts/:id/schedulable`
  - 入参：`{ schedulable: boolean }`
  - 出参：更新后的账号对象

## OAuth 相关

- `POST /api/generate-auth-url`
  - 入参：`{ add_method?: "oauth" | "setup-token" }`
  - 出参：`{ auth_url, session_id }`

- `POST /api/prepare-exchange`
  - 入参：`{ session_id, code }`
  - 出参：`{ session_id, code }`

- `POST /api/accounts/from-auth-code`
  - 入参：`{ name, platform: "anthropic", type: "oauth|setup-token", session_id, code, ... }`
  - 出参：`{ account, token_info }`

## 用量刷新

- `POST /api/accounts/refresh-usage`
  - 说明：强制刷新当前所有账号用量
  - 出参：`{ total, refreshed, failed, results }`

## 后台刷新

- `GET /api/background-refresh/status`
  - 出参：`{ enabled, interval_seconds, allowed_intervals, running, next_run_at, next_run_in_seconds, last_started_at, last_finished_at, last_error, last_result }`

- `POST /api/background-refresh/config`
  - 入参：`{ enabled?: boolean, interval_seconds?: 1|10|30|60|120|300 }`
  - 出参：同状态接口

- `POST /api/background-refresh/run-now`
  - 出参：`{ status, result }`

## 数据导入导出

- `GET /api/accounts/data`
  - 查询参数：`ids`（逗号分隔，可选）`platform` `type` `status` `search` `include_proxies`
  - 出参：`DataPayload`

- `POST /api/accounts/data`
  - 入参：`{ data: DataPayload, skip_default_group_bind?: boolean }`
  - 出参：`{ proxy_created, proxy_reused, proxy_failed, account_created, account_failed, errors? }`
