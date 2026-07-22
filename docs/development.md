# Development Handoff

## Architecture

- `src/light-bot.js`: 唯一 Bot 状态机。只处理连接生命周期、自身状态和聊天。
- `src/forge3.js`: 从参考 GTO 项目复用的 Forge 1.20.1 FML3 登录握手；不要删除。
- `src/server.js`: Node 内置 HTTP、SSE 状态推送和聊天 POST；端口从 `WEB_PORT` 自动递增。
- `public/index.html`: 单文件纸白界面，Tailwind utility classes 与 Lucide send icon。
- `Dockerfile` / `compose.yaml`: Node 22 Alpine 非 root 镜像，带健康检查和资源限制。
- `AGENT.md`: 可直接交给部署代理的操作与验收说明。

## Invariants

- 不添加 `map_chunk`、entity、block、inventory 的业务处理器。
- 不导入 mineflayer、prismarine-chunk、prismarine-physics 或渲染资源。
- position 包必须同时发送 `teleport_confirm` 和 `position_look`。
- keepalive 由 `minecraft-protocol` 默认插件负责；不要设置 `keepAlive: false`。
- `.env` 不得提交；网页默认仅绑定 loopback。

## Verification

```powershell
npm ci
npm test
npm run check
git diff --check
```

实服验收关注：进入 `play`、聊天收发、坐标/生命更新、死亡后单次复活、断线重连，
以及长时间运行时 RSS 是否稳定。参考项目已有同用户名进程运行时不要并发登录。

## Deployment Notes

Local live login passed with RSS around `76 MiB`. For a remote deployment, run `npm ci --omit=dev`,
select the first free port starting at `18000`, and install the provided user-level systemd unit.
Verify `/api/health` plus `/api/state` before leaving it enabled.
