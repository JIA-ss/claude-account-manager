# claude-account-manager

独立的 Claude 账号管理服务（前后端分离），用于账号维护、OAuth 授权、用量刷新，以及账号数据导入导出。

## 主要功能

- 账号管理：分页展示、筛选、添加、删除。
- Claude OAuth：生成授权链接，输入授权码后完成 token 兑换并落库。
- 用量查询：支持手动刷新、前端自动刷新、后端常驻定时刷新。
- 后台刷新状态面板：展示开关状态、执行间隔、最近执行结果。
- 账号导入导出：兼容原工程格式（`sub2api-data` / `sub2api-bundle`）。

## 快速开始

```bash
node backend/server.js
```

访问：

```text
http://127.0.0.1:8787
```

## 项目结构

- `backend/server.js`：后端 API + 静态文件服务
- `frontend/index.html`：账号管理页面
- `frontend/app.js`：前端交互逻辑
- `frontend/styles.css`：样式
- `docs/`：详细文档（接口、流程、数据格式）

## 文档

- [系统概览](docs/overview.md)
- [后台启动服务](docs/run-backend.md)
- [接口说明](docs/api.md)
- [核心流程与数据格式](docs/workflows.md)
