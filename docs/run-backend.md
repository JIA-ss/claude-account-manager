# 后台启动服务

## 前台启动（开发调试）

```bash
node backend/server.js
```

默认监听 `127.0.0.1:8787`。

## 后台启动（常驻运行）

```bash
nohup node backend/server.js >/tmp/claude-account-manager.log 2>&1 & echo $!
```

- 命令会输出进程 PID，建议记录下来。
- 日志文件：`/tmp/claude-account-manager.log`

## 查看日志

```bash
tail -f /tmp/claude-account-manager.log
```

## 停止服务

```bash
kill <PID>
```

## 自定义监听地址

可通过环境变量设置：

```bash
HOST=0.0.0.0 PORT=8787 node backend/server.js
```
