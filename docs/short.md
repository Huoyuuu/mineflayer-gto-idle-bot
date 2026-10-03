# 简要交接

**项目**：Minecraft 挂机 Bot（mineflayer + 自定义 Forge 协议），带 Web 控制台。
线上是 user systemd 服务 `minecraft-idle-bot.service`，Web/API 端口 `18013`。
`minecraft-idle-bot-update.timer` 每分钟拉 `origin/server-live` 并自动部署，
所以推到 `server-live` 就等于上线，不要手动 scp。

**后端重点**：断线后用 SLP 探测网络（30s 一次，20 次窗口：失败≤1、中位≤400ms、p90≤800ms）达标才重连，60 分钟兜底；登录仍失败才叠加 2/4/8/16/32/60 分钟退避；keepalive 容忍 60s；连续掉线超限则写
`.minecraft-idle-bot.cooldown` 并以 exit 75 退出，重启后仍等到期。聊天存 JSONL，
`src/chat-store.js` 负责分页、搜索与聚合。`POST /api/login` `/api/logout` 是幂等控制。

**前端重点**（2026-08-04 重做）：`public/` 下无构建，纯 ESM 模块 + CDN Tailwind。
`app.js` 是 hash 路由，`view-status/chat/stats.js` 三个视图，`lib.js` 手写 SVG 图表，
`app.css` 是设计系统（"Paper Telemetry"：纸白、发丝线、Instrument Serif 大字号、
零圆角、按钮墨水上扫）。改样式改 `app.css`，别在 HTML 里堆 Tailwind 工具类。
图标统一 Lucide `data-lucide`，注入新 DOM 后要调 `lucide.createIcons()`。全站禁用 emoji。

**部署**：只改 `public/`、`docs/`、`test/`、`*.md` 时 timer 只做 fast-forward、不重启（热更新）；其他改动才重启。

**验证**：`npm test`（16 项）+ `node --check public/*.js`。
详细设计决策见 `docs/report.md`，接手须知见 `docs/development.md`。
