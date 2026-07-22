# Minecraft Idle Bot

一个面向 Minecraft 1.20.1 Forge 服务器的极简挂机客户端。它直接使用
`minecraft-protocol`，不加载 Mineflayer 世界插件，不解析或缓存区块、方块、实体、
背包、物理和资源包。网页仅包含 Bot 自身状态与聊天。

## 启动

需要 Node.js 22.12+：

```powershell
Copy-Item .env.example .env
# 编辑 .env 中的 BOT_USERNAME、MC_HOST、MC_PORT
npm ci
npm test
npm start
```

打开终端打印的地址。若 `WEB_PORT` 被占用，会自动使用后续空闲端口。

## 资源边界

服务器发来的区块包仍必须经过底层协议解压和反序列化，但本项目不注册世界处理器，
也不会复制、解码或持久保存区块。`VIEW_DISTANCE=2` 用于请求尽可能小的服务端视距。
运行时唯一直接依赖是 `minecraft-protocol`。

## 配置

真实连接信息只放在被 Git 忽略的 `.env` 中。默认网页只监听 `127.0.0.1`；聊天接口
没有登录鉴权，不要直接暴露到公网。
