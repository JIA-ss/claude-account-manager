# 核心流程与数据格式

## OAuth 授权码建号流程

1. 前端调用 `POST /api/generate-auth-url`。
2. 后端生成新的 `state`、`code_verifier`、`code_challenge`、`session_id`，返回授权 URL。
3. 用户完成授权后粘贴授权码（或回调 URL）。
4. 前端提交 `POST /api/accounts/from-auth-code`。
5. 后端调用 Claude token 接口完成 `code -> token` 兑换并保存账号。

说明：

- `client_id` 固定，`state/code_verifier/code_challenge/session_id` 每次重新生成。
- 当前授权码建号仅支持 `platform=anthropic`。

## 用量刷新流程

### 手动刷新

- 前端点击刷新，调用 `POST /api/accounts/refresh-usage`。
- 后端串行刷新全部账号并返回汇总。

### 前端自动刷新

- 页面端按 5/10/15/30 秒倒计时触发手动刷新流程。
- 仅在页面打开时生效。

### 后台自动刷新

- 由服务端定时器执行，与前端页面是否打开无关。
- 可配置间隔：`1|10|30|60|120|300` 秒。
- 可通过状态接口查看最近一次执行结果。

## 数据导出格式（DataPayload）

```json
{
  "type": "sub2api-data",
  "version": 1,
  "exported_at": "2026-02-25T00:00:00Z",
  "proxies": [
    {
      "proxy_key": "http|127.0.0.1|8080||",
      "name": "p1",
      "protocol": "http",
      "host": "127.0.0.1",
      "port": 8080,
      "username": "",
      "password": "",
      "status": "active"
    }
  ],
  "accounts": [
    {
      "name": "acc-1",
      "notes": "optional",
      "platform": "anthropic",
      "type": "oauth",
      "credentials": {
        "access_token": "..."
      },
      "extra": {
        "email_address": "user@example.com"
      },
      "proxy_key": "http|127.0.0.1|8080||",
      "concurrency": 1,
      "priority": 1,
      "rate_multiplier": 1,
      "expires_at": 1767225600,
      "auto_pause_on_expired": false
    }
  ]
}
```

说明：

- 支持 `type: sub2api-data` 与 `sub2api-bundle`。
- 支持 `version: 1`。
- `proxy_key` 规则：`protocol|host|port|username|password`。

## 数据导入结果格式

```json
{
  "proxy_created": 1,
  "proxy_reused": 0,
  "proxy_failed": 0,
  "account_created": 1,
  "account_failed": 0,
  "errors": []
}
```

`errors` 中单项结构：

```json
{
  "kind": "proxy|account",
  "name": "optional",
  "proxy_key": "optional",
  "message": "error detail"
}
```
