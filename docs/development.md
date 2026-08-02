# Development Handoff

## Architecture

- `src/light-bot.js`: 唯一 Bot 状态机。只处理连接生命周期、自身状态和聊天。
- `src/forge3.js`: 从参考 GTO 项目复用的 Forge 1.20.1 FML3 登录握手；不要删除。
- `src/server.js`: Node 内置 HTTP、SSE 状态/聊天推送、聊天 GET 分页和 POST；端口从 `WEB_PORT` 自动递增。
- `src/chat-store.js`: 追加式 JSONL 聊天存储；内存只保留每行的 byte offset，页面按 cursor 读连续字节范围。
- `public/index.html`: 单文件纸白界面，Tailwind utility classes 与 Lucide send icon。

## Invariants

- 不添加 `map_chunk`、entity、block、inventory 的业务处理器。
- 不导入 mineflayer、prismarine-chunk、prismarine-physics 或渲染资源。
- position 包必须同时发送 `teleport_confirm` 和 `position_look`。
- keepalive 由 `minecraft-protocol` 默认插件负责；不要设置 `keepAlive: false`。
- 1.20.x `declare_recipes` 必须保持 `restBuffer` 覆盖；Forge 自定义 serializer 不能用原版 schema 解码，Bot 也不使用配方。
- play 阶段协议解析错误必须终止 socket，90 秒无包 watchdog 是假在线的最后保护。
- `.env` 不得提交；网页默认仅绑定 loopback。
- `.minecraft-idle-bot.chat.jsonl` 和 `.minecraft-idle-bot.cooldown` 是运行数据，必须持久保留且不得提交。

## Verification

```powershell
npm ci
npm test
npm run check
git diff --check
```

实服验收关注：进入 `play`、聊天收发、坐标/生命更新、死亡后单次复活、断线重连，
以及长时间运行时 RSS 是否稳定。参考项目已有同用户名进程运行时不要并发登录。

## Deployment Status (2026-07-23)

Local live login passed with RSS `76.0 MiB`; both the old dashboard and the temporary light bot were
stopped afterward. Remote deployment is pending because SSH never reaches authentication:

```text
ssh huoyuuu@107.173.39.150 -p 17999 -> connection established, banner exchange timeout
ssh 107.173.39.150                    -> TCP connect timeout on port 22
```

When SSH recovers, deploy under the `huoyuuu` account, run `npm ci --omit=dev`, set
`WEB_HOST=0.0.0.0`, and inspect `ss -ltn` starting at port `18000`. The server can automatically
advance up to 100 ports when its configured port is occupied. Run it under systemd and verify
`/api/health` plus `/api/state` before leaving it enabled.


## Current Remote Deployment

The live user service is `minecraft-idle-bot.service` on port `18013`. The bot persists a cooldown deadline in `.minecraft-idle-bot.cooldown`; this file must survive a systemd restart. On the fourth connection end within a 10-minute stability window, the process exits with status 75, `Restart=always` restarts it, and startup waits until the persisted deadline before calling `connect()`.

Inspect behavior with:

```bash
journalctl --user -u minecraft-idle-bot.service -f
curl -s http://127.0.0.1:18013/api/state
```

## Reconnect Backoff and Pull Deployment

The retry schedule is `2m, 4m, 8m, 16m, 32m, 60m`. If the connection still fails after
the 60-minute retry, the bot persists a two-hour cooldown and exits; user-level systemd
restarts the service, and startup waits for the persisted deadline before reconnecting.
Four repeated disconnects from already-established sessions keep the same two-hour protection.

The state API now exposes `nextReconnectAt`, `reconnectDelayMs`, and `reconnectAttempt` while
waiting. Every scheduled attempt is also written to journald. A successful `login` alone is not
enough evidence of a healthy connection: recipe decoding previously left the parser dead while
the socket remained open, so fatal parser errors close the socket and a 90-second packet watchdog
provides a second recovery path.

## Chat History

`GET /api/state` no longer embeds chat. Use:

```text
GET /api/chat?limit=50
GET /api/chat?before=150&limit=50
```

The response contains chronological `items`, `nextBefore`, `hasOlder`, and `total`. `before` is an
end-exclusive message index; append operations never shift an existing history cursor. The SSE
endpoint emits separate `state` and `chat` events. Page 1 should refresh on `chat`; historical pages
must remain fixed until the user navigates.

On the server, configure the tracked hook once:

```bash
git config core.hooksPath .githooks
```

After that, `git pull` invokes `.githooks/post-merge`, which runs `scripts/deploy.sh` to
install production dependencies, refresh the user unit, and restart the service.

## Unattended Deployment

`minecraft-idle-bot-update.timer` checks `origin/server-live` once per minute. It accepts only a
clean fast-forward update, then runs `scripts/deploy.sh`. The deploy script installs both the Bot
service and updater units, ensures `core.hooksPath=.githooks`, and restarts the Bot. Inspect it with:

```bash
systemctl --user status minecraft-idle-bot-update.timer
journalctl --user -u minecraft-idle-bot-update.service -n 50
```

## UI Rollback (2026-07-26)

The application is intentionally restored to commit `b513e7e`: status plus paginated chat only.
Do not assume the removed world view, inventory, movement, block interaction, action endpoints, or
preview server still exist. The updater timer remains newer infrastructure and is intentionally
retained; it is independent of the application UI.

## Dred Login Diagnostic (2026-08-02)

Run `npm run test:dred` or double-click `start-dred-test.cmd`. The diagnostic overrides only the
constructed Bot username, sends `/home` 1.5 seconds after entering play, observes the connection for
60 seconds, and writes `.runtime/dred-login-report.json`. It has an isolated cooldown file and must
not be changed to rewrite `.env` or the production service account. `DRED_OBSERVE_MS` and
`DRED_LOGIN_TIMEOUT_MS` can override the two diagnostic timeouts.
