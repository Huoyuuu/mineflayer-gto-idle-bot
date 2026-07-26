# Development Handoff

## Architecture

- `src/light-bot.js`: 唯一 Bot 状态机。连接生命周期、自身状态、聊天、世界包接入、按键控制与方块交互。
- `src/world.js`: 自研 1.18+ 区块解码与有界世界缓存。只保存方块 state id，不依赖 prismarine-chunk。
- `src/forge3.js`: 从参考 GTO 项目复用的 Forge 1.20.1 FML3 登录握手；不要删除。
- `src/server.js`: `createApp(bot, chatStore)` 返回可测试的 HTTP + SSE 应用；`main()` 只在直接运行时启动。
- `src/chat-store.js`: 追加式 JSONL 聊天存储；内存只保留每行的 byte offset，页面按 cursor 读连续字节范围。
- `public/index.html` + `app.css` + `app.js`: 纸白三栏界面（状态 / 世界 / 聊天）。
- `public/view-math.js`: 页面里**没有 DOM 依赖**的纯函数（旋转、配色、键盘意图、时钟）。浏览器挂在
  `window.ViewMath`，Node 里可 `require`，因此这些逻辑有真单元测试。
- `scripts/preview.js`: 开发用预览服务器，合成世界 + 假 Bot，不连接 Minecraft。改 UI 时用它，
  避免与线上同名账号 duplicate login。

## World decoding

`map_chunk.chunkData` 按 1.18+ 格式逐段解析：`blockCount(i16)` + 方块调色板容器 + 生物群系调色板容器。
调色板三态：`bits=0` 单值、`bits<=8`（生物群系 `<=3`）间接、否则直接。条目 LSB 优先、不跨 long，
但会跨 long 内的 32 位边界，因此解码用 hi/lo 双 32 位拼接（BigInt 每次刷新会产生上百万次分配）。

不变量：**一列区块必须恰好消耗完缓冲区**。多余或不足一律判为解析失败并丢弃该列，
错误计数进 `state.worldStats.errors`。这条自校验是"格式理解错了"时唯一的兜底。

内存：每个非空段 `Uint16Array(4096)` = 8 KiB，全空段只存一个数字。半径 `viewDistance+1`（默认 3）
之外的区块列即时淘汰，`unload_chunk` 同步删除，`maxChunks` 兜底。实测 5×5 列 / 46 段 = 368 KiB。
维度切换（`respawn`）必须 `world.reset()`：方块 state id 是按维度注册表定义的。

## HTTP API

```text
GET  /api/state                      自身状态快照（含 look / worldStats / inventory / timeOfDay）
GET  /api/world?radius=&ceiling=     以 Bot 为中心的地表切片：palette + blocks + heights
GET  /api/chat?before=&limit=        分页聊天，end-exclusive cursor
GET  /events                         SSE：state / chat / world 三类事件 + 25s 心跳
POST /api/chat      {message}
POST /api/action    {action}         return-p0 / empty-silencer
POST /api/control   {forward,...,look}   按键状态，**4 秒过期**
POST /api/held      {slot}           0-8 快捷栏
POST /api/world-input {button,shiftKey,target}  left=挖掘 right=使用
```

`blocks` 里 `-1` 表示该列没有区块数据，`-2` 表示有数据但整列都是空气。

## Invariants

- 不添加 entity、玩家列表、物理引擎；不导入 mineflayer、prismarine-chunk、prismarine-physics、Three.js。
- 世界解码只保留 state id，且必须受半径与 `maxChunks` 双重约束；任何"顺手缓存一下"都会破坏内存预算。
- position 包必须同时发送 `teleport_confirm` 和 `position_look`。
- keepalive 由 `minecraft-protocol` 默认插件负责；不要设置 `keepAlive: false`。
- 1.20.x `declare_recipes` 必须保持 `restBuffer` 覆盖；Forge 自定义 serializer 不能用原版 schema 解码。
- play 阶段协议解析错误必须终止 socket，90 秒无包 watchdog 是假在线的最后保护。
- **按键状态必须有服务端过期时间**：网页崩溃时不能留下一个一直向前走的 Bot。改动 `/api/control`
  时要同时保证网页每 100ms 刷新一次。
- 网页键盘只能在"画布已接管"时拦截；输入框内一律不拦截（`keyIntent` 有测试守着）。
- `.env` 不得提交；网页默认仅绑定 loopback。
- `.minecraft-idle-bot.chat.jsonl` 和 `.minecraft-idle-bot.cooldown` 是运行数据，必须持久保留且不得提交。

## Verification

```powershell
npm ci
npm test          # 34 项
npm run check     # 服务端与页面脚本语法
npm run preview   # 合成世界，浏览器实测 UI，不碰线上账号
git diff --check
```

实服验收关注：进入 `play`、聊天收发、坐标/生命更新、死亡后单次复活、断线重连，
`/api/state` 里的 `worldStats.errors` 应保持 0，以及长时间运行时 RSS 是否稳定
（基线 76 MiB，世界缓存预期增量 < 5 MiB）。参考项目已有同用户名进程运行时不要并发登录。

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

## Unattended Push Deployment

The previous hook automated only the second half of deployment: it ran after somebody executed
`git pull` on the server. It did not provide a GitHub push trigger. The live server therefore
remained at `96d15bb` after GitHub advanced `server-live` to `a328ce2` on 2026-07-26.

`minecraft-idle-bot-update.timer` now runs once per minute. Its oneshot service calls
`scripts/update-and-deploy.sh`, which fetches only `server-live`, rejects tracked local changes or
diverged history, fast-forwards the checkout, and runs `scripts/deploy.sh`. The merge suppresses
`post-merge` because the updater invokes deployment explicitly and must surface deployment errors
as a failed systemd unit. Manual `git pull` continues to deploy through the tracked hook.

Inspect the unattended path with:

```bash
systemctl --user status minecraft-idle-bot-update.timer
journalctl --user -u minecraft-idle-bot-update.service -n 50
```

## Forge Section Span Compatibility

The live Forge server appends exactly 12 zero bytes after the 24 sections declared by its dimension
codec. The old exact-length check therefore rejected every column. The decoder accepts only that
exact observed padding shape; different lengths or any non-zero padding still fail. It can also
continue through at most 16 additional complete sections while keeping the exact EOF invariant.
The first successful column fixes the effective span and padding for that dimension; later columns
with different values are rejected. `worldStats` exposes `expectedSections`, `decodedSections`, and
`paddingBytes` for diagnosis.

The inventory UI groups identical backpack stacks, constrains the list height, and shows only stack
counts in the nine narrow hotbar cells. Full item names remain available in the selected-item line
and native tooltips. An empty or failed world slice now renders an explicit Canvas status instead
of a blank surface.
