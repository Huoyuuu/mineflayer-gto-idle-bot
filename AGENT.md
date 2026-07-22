# Deployment Guide for Coding Agents

This repository is a minimal Forge-aware Minecraft idle bot. It intentionally does not use
Mineflayer world plugins or retain chunks, entities, inventory, physics, or render data.

## Required configuration

Create an untracked `.env` from `.env.example` and set:

- `BOT_USERNAME`: offline-mode Minecraft username.
- `MC_HOST` and `MC_PORT`: Minecraft endpoint.
- `MC_VERSION`: normally `1.20.1`.
- `WEB_PORT`: first available host port starting at `18000`.

Never commit `.env` or real credentials. Never run two instances with the same bot username.

## Docker deployment

```bash
cp .env.example .env
# edit .env
docker compose up -d --build
docker compose ps
docker compose logs --tail 100 idle-bot
curl -fsS http://127.0.0.1:${WEB_PORT:-18000}/api/health
```

Compose binds the page to host loopback. Put it behind an authenticated reverse proxy if remote
browser access is required. The application chat endpoint has no built-in authentication.

## Direct Node deployment

Node.js 22.12+ is required:

```bash
npm ci --omit=dev
npm test
npm run check
npm start
```

For unattended operation, use the unit template at `deploy/minecraft-idle-bot.service`. Adjust its
absolute paths and user before installation, then verify linger or use a system-level service.

## Acceptance checks

1. `/api/health` returns `{"ok":true,"phase":"play"}`.
2. `/api/state` shows the configured username, world, health, and position.
3. Browser chat can send and receive a message.
4. RSS remains below the configured memory limit after login and chunk delivery.
5. `chunksIgnored` increases while no chunk/entity data structures are retained.
6. Restart the service once and confirm automatic reconnect without duplicate-login loops.

Do not add Mineflayer, Prismarine world/physics modules, resource packs, WebSockets, databases, or
world packet listeners unless the project scope explicitly changes.
