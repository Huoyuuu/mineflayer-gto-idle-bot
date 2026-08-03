# 简要交接

线上 Bot 为 user systemd 服务 `minecraft-idle-bot.service`，Web/API 端口 `18013`。2026-08-03 16:57:59 Minecraft keepalive 超时，16:58:29 断开。Bot 已按 2、4、8 分钟自动重连，但前两次 Forge 登录均未进入 `play`，最终触发 `login timeout`；17:07:07 已安排 17:15:07 再试。服务进程、API 与目标 TCP 均正常，未进入 cooldown，问题更可能在 Minecraft 服务端登录流程，而非重连逻辑失效。
