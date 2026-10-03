# 项目介绍

Minecraft Idle Bot 是 Minecraft 1.20.1 Forge 的轻量挂机客户端。一个 Node.js 进程负责协议连接、网页/API、聊天存储和网络探测，不运行额外的探测服务。

## 功能与结构

| 文件 | 职责 |
| --- | --- |
| `src/light-bot.js` | 登录、Forge 握手、保活、聊天、自动复活、探测和重连门控 |
| `src/forge3.js` | Forge 协议握手 |
| `src/server.js` | 网页、API、SSE 实时状态和探测历史持久化 |
| `src/chat-store.js` | 聊天 JSONL、分页、搜索和统计 |
| `src/config.js` | 读取 `.env`，校验配置 |
| `public/` | 无构建的原生 ESM 前端，Tailwind、Lucide、纸白风格和 SVG 图表 |
| `scripts/`、`deploy/` | 部署、自动更新和手动诊断工具 |

网页有四页：**状态**展示会话与重连进度，**对话**支持聊天和历史搜索，**汇总**展示消息统计，**网络**提供手动探测、时间线、失败率、延迟分布和最近记录。网络历史支持 6 小时至 14 天的查询。

## 网络与重连

- 在线、离线和手动退出时都每 30 秒进行 Server List Ping；单次超时 5 秒，不登录游戏。
- 启动和掉线使用同一个等待流程，复用已存探测历史；手动登录也通过门控。
- 门控只检查最近 **20 分钟失败率 < 5%**，恰好 5% 不通过，延迟不作为重连条件。
- 历史需覆盖该窗口（允许一个采样间隔的边界误差）且至少有 30 条记录；不足时继续采样。
- 首次等待没有额外退避。登录失败后叠加 **2 / 4 / 8 / 16 / 32 / 60 分钟**退避；每档退避结束后，网络达标即连接，等待一小时仍未达标则兜底尝试。
- 60 分钟档登录仍失败，或已连接会话在稳定计数清零前累计掉线四次，进入两小时保护冷却。冷却跨进程重启保留，到期后重新走门控。
- 连续在线 10 分钟清零掉线计数。客户端 keepalive 超时为 60 秒，无数据包看门狗为 90 秒。
- 手动退出停止自动重连，探测仍继续。网络页和 Bot 使用同一份记录与门控判定。

## 配置与数据

`.env` 设置 `BOT_USERNAME`、`MC_HOST`、`MC_PORT`、`MC_VERSION`、`WEB_HOST`、`WEB_PORT` 等，示例见 `.env.example`。默认网页监听本机地址。

| 文件 | 内容 |
| --- | --- |
| `.minecraft-idle-bot.chat.jsonl` | 聊天历史，可通过 `CHAT_FILE` 改路径 |
| `.minecraft-idle-bot.probes.jsonl` | 自动和手动探测记录，保留最近 14 天，重启复用 |
| `.minecraft-idle-bot.cooldown` | 保护冷却截止时间 |

以上数据和 `.env` 均被 Git 忽略；更新代码时保留它们。

## 接口

- `GET /api/state`、`GET /api/health`：当前状态与健康检查。
- `POST /api/login`、`POST /api/logout`：请求登录或退出。
- `GET /api/chat`、`GET /api/chat/search`、`POST /api/chat`：聊天分页、搜索与发送。
- `GET /api/stats`：汇总统计与运行阈值。
- `GET /api/probes?hours=24&since=...`：探测历史、窗口判定及按小时统计；`since` 为毫秒时间戳，可取增量。
- `POST /api/probes/run`：立即探测，与正在执行的探测合并，结果写入同一份历史。
- `GET /events`：SSE 实时状态和聊天。

## 部署与检查

线上目录为 `/home/huoyuuu/services/minecraft-idle-bot`，主服务为 `minecraft-idle-bot.service`。本机监听 `127.0.0.1:18013`，系统 nginx 将带登录门禁的公网 `107.173.39.150:18013` 请求转发到此进程。

首次部署运行 `scripts/deploy.sh`。`minecraft-idle-bot-update.timer` 每分钟检查 `origin/server-live`，只允许干净工作区的 fast-forward。只改前端、文档和测试时不重启，刷新页面生效；后端、依赖或部署脚本改动会重启主服务，启动后仍按门控等待。

日常检查用 `npm test`、`npm run check`，线上用 `systemctl --user status minecraft-idle-bot.service` 和 `journalctl --user -u minecraft-idle-bot.service`。`npm run test:dred` 是手动单次登录诊断，不是常驻 Bot 的启动入口。
