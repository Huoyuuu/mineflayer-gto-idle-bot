# Minecraft Idle Bot

面向 Minecraft 1.20.1 Forge 的轻量挂机客户端，使用 `minecraft-protocol`，不加载世界、实体、背包或物理插件。一个 Node.js 进程提供 Bot、网页控制台、聊天存储和持续网络探测。

## 使用

需要 Node.js 22.12+：

```bash
cp .env.example .env
# 在 .env 中设置 BOT_USERNAME、MC_HOST、MC_PORT 等
npm ci
npm start
```

网页包含状态、对话、汇总和网络四个页面。网络页支持手动探测、历史查询和图表。

启动等同于刚掉线：读取已有探测历史，进入重连等待，不直接登录。每 30 秒探测一次，最近 20 分钟失败率严格低于 5% 才提前重连；保留一小时兜底、指数退避和两小时保护冷却。

项目结构、配置、接口和部署方式见 [项目介绍](docs/README.md)。

```bash
npm test
npm run check
```
