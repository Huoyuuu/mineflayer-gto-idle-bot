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

The web dashboard exposes `POST /api/login` and `POST /api/logout`. They are intentionally
idempotent controls over the existing `LightBot`; the server still calls `bot.start()` once after
the HTTP listener is ready, preserving unattended deployment behavior. Logout sets the bot's
stopping generation, so an ended socket cannot schedule a reconnect; a later login starts a fresh
generation.

## Storage Bus Diagnostic (2026-08-03)

Run `npm run scan:storage-bus` only when the production Minecraft session is stopped; the scanner
uses the configured `BOT_USERNAME` and duplicate login will invalidate one of the sessions. It is a
read-only packet collector and writes `.runtime/storage-bus-scan.json` by default. `SCAN_MS` and
`SCAN_OUTPUT` override its observation duration and output path. It supports both the bundled Node
runtime and system Node 18 by loading `.env` itself when `process.loadEnvFile` is unavailable.

AE2 parts are serialized in the `#upd` byte array of `ae2:cable_bus`. For the embedded AE2
15.267.4 build, the first byte is a presence mask in DOWN, UP, NORTH, SOUTH, WEST, EAST, center
order. Each present entry begins with the current server's raw `minecraft:item` registry ID as a
VarInt. Never hard-code ID 1604 for a future server: obtain `ae2:storage_bus` from the Forge item
registry snapshot for every scan. `StorageBusPart` then writes one flags byte. Earlier parts can
have variable-length streams, so a general decoder must understand each preceding part; the 17
current records were checked against their complete short update layouts and neighboring block
entities.

The verified 2026-08-03 result is in `docs/report.md`. Four storage buses face HV input buses and
are the primary candidates for a 16-slot inventory: `(107,126,-102)`, `(107,126,-100)`,
`(111,123,-50)`, and `(120,124,-47)`. The production service was restored after scanning and no
scanner process was left running.

## Frontend Design System (2026-08-04)

`public/app.css` is the single stylesheet. Tailwind is loaded from the CDN for layout utilities
only (grid, flex, spacing, breakpoints); every visual decision — colour, border, type, motion —
lives in `app.css` as a semantic class. Do not add colour or border utilities in markup, and do
not restyle a component by editing `index.html`.

Tokens are CSS custom properties on `:root`: `--paper`, `--paper-2`, `--sheet`, `--ink`,
`--ink-soft`, `--ink-faint`, `--ink-ghost`, `--line`, `--line-soft`, `--online`, `--wait`,
`--error`, plus `--ease` (the single shared easing curve) and `--gutter`. Change a token, not a
rule, when adjusting the palette.

Fonts are declared twice on purpose: once in `tailwind.config` so `font-sans`/`font-mono`/
`font-display` utilities resolve, and once as `--font-display` / `--font-mono` in an inline
`<style>` so `app.css` can reference them without depending on Tailwind. Instrument Serif is the
display face, JetBrains Mono the micro-label and timestamp face, Inter the body face.

Class contract used by the JS views — renaming any of these breaks rendering:

- `.label` — letterspaced uppercase micro-label. `.eyebrow` composes with it for card headings and
  adds the hairline underscore; `.eyebrow` must stay declared after `.label` because it overrides
  `display`.
- `.display` — the oversized serif numeral voice. Applied to hero phase, hero metrics, coordinates,
  countdown, and the four stats totals. Size comes from a Tailwind bracket utility in markup.
- `.num` — tabular figures only, no other effect.
- `.card`, `.card-quiet`, `.hair` — surfaces. `.card-quiet` draws printer registration ticks via
  `::before`/`::after`, so it cannot host another pseudo-element.
- `.kv` — rows emitted by `rows()` in `lib.js` as `<div class="kv"><dt><dd>`.
- `.dot` plus `.dot-online` / `.dot-wait` / `.dot-error` / `.dot-pulse` — set as a whole className
  string by `dotClass()` in `view-status.js`; the hero and header share it.
- `.msg`, `.msg-player` / `.msg-system` / `.msg-actionbar`, `.msg-hit`, `.daymark`, `mark` — chat
  rows built by `messageRow()` in `view-chat.js`.
- `.btn`, `.btn-solid`, `.btn-icon`, `.chip`, `.field`, `.tab`, `.meter`, `.chart`, `.toast`.

`.btn` hover is an ink wipe: an absolutely positioned `::before` at `z-index:0` translates up from
`101%`, and direct children are lifted to `z-index:1`. Both parts are required — dropping the child
rule hides the label behind the fill.

Paper texture is two fixed pseudo-elements on `body`: `::before` for the light gradients and
`::after` for a data-URI `feTurbulence` grain at `mix-blend-mode: multiply`. `body > *` is raised to
`z-index:1` to sit above them, so any new top-level element must be a child of `body`.

Section entrance uses `section:not([hidden]) > *` with `nth-child` delays, which works because the
router toggles the `hidden` attribute rather than a class. Everything is disabled under
`prefers-reduced-motion: reduce`.

Icons are Lucide via `data-lucide` attributes, replaced by `lucide.createIcons()`. The router calls
it after every mount, so any markup injected later needs an `icons()` call. Emoji are not used
anywhere in the interface.

`public/package.json` only marks the directory as ESM so `node --check public/*.js` parses the
modules; it is not an installable package.

## Network-Gated Reconnect (2026-10-03)

After any drop, `schedule()` clears the sample window and starts a 30-second Server List Ping
probe (`mc.ping`, 5-second timeout; no login, so no join/leave spam). `probe()` reconnects only when
the backoff delay has elapsed and `networkQuality()` reports a full 20-sample window with at most one
failure, median latency <= 400 ms and p90 <= 800 ms, or when the 60-minute fallback is reached.
`reconnectDelay(0)` is now 0 (gate only); repeated login failures add the `2m..60m` schedule, and
failure after the 60-minute step still triggers the persisted two-hour cooldown. Cooldown expiry also
goes through the gate. Probe results are tied to `generation` and dropped after stop/manual login.
Client `checkTimeoutInterval` is 60 s. State exposes `network`; `nextReconnectAt` is the fallback deadline.
Tests inject `options.probe` to avoid network access.

## Standalone Probe Service (2026-10-03)

`probe/server.js` is a separate user service (`minecraft-idle-bot-probe.service`, 127.0.0.1:18014)
so probing can evolve without restarting the bot. It pings every 30 s, stores
`{t, ms, src, phase, err?}` lines in `.minecraft-idle-bot.probes.jsonl` (14-day retention), serves
`GET /api/probes?hours=&since=` and `POST /api/probes/run`. The system nginx `port-gate.conf`
server for 18013 has a `location /api/probes` copy of the cookie-gated block pointing at 18014.
`update-and-deploy.sh` treats `public/ docs/ test/ probe/ *.md .gitignore` as hot: no bot restart,
and `probe/` changes restart only the probe service. Changes to `src/`, `scripts/`, `deploy/` or
`package*.json` still trigger a full deploy (bot reconnect); to avoid that, stop the timer and
fast-forward manually as done for `52fe167`. Gate thresholds are duplicated in `src/light-bot.js`,
`probe/server.js` and `public/view-status.js`.
