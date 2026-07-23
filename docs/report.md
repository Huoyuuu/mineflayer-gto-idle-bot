# 工作报告

## 完成内容

- 从完整 GTO Dashboard 中抽离 Forge 3 登录握手，改为直接使用 `minecraft-protocol`。
- Bot 只保留登录、keepalive、低视距 settings、传送确认、生命值、自动复活、聊天和断线退避重连。
- 不导入或维护区块、方块、实体、玩家列表、背包、物理、资源包和 3D 场景。
- 页面只有自身状态和聊天，服务端使用 Node 内置 HTTP + SSE，不引入 WebSocket 服务端框架。
- 聊天最多保留 100 条；区块包只计数后丢弃，不复制、不缓存、不二次解码。

## 性能设计

`VIEW_DISTANCE` 默认为协议允许的保守低值 `2`。底层协议仍必须接收和反序列化服务器
发来的数据，但对象在事件结束后即可回收。相比参考项目，已经移除主要长期内存所有者：
chunk cache、raw chunk copies、entity map、resource catalog、Prismarine physics 和 Three.js。

## 使用

执行 `npm ci && npm test && npm start`，打开控制台输出的网页地址。真实服务器配置位于
未跟踪的 `.env`。

## 2026-07-23 实服验收

关闭参考项目的完整 Dashboard 后，轻量 Bot 使用原有 `huoyuuu_bot` 和 Minecraft 服务器配置完成真实登录：

```text
phase=play
world=minecraft:overworld
health=20
food=18
position=116.73,121.00,-93.70
chunksIgnored=338
RSS=76.0 MiB
```

网页健康接口和自身状态接口均返回正常，系统聊天成功接收。验收结束后已关闭本地进程，
避免与待部署的远端实例发生 duplicate login。

远端部署暂时被 SSH 服务阻断：`107.173.39.150:17999` 可以建立 TCP，但连续 35 秒收不到
SSH banner；`107.173.39.150:22` TCP 连接超时。两条入口均未到达用户认证阶段，因此尚未能
检查远端端口、上传代码或创建 systemd 服务。


## 2026-07-23 断线保护

- 为连接结束事件增加 journald 日志，记录 `disconnect`、`end` 和底层 socket reason。
- 连续断线重连超过 3 次（第 4 次结束）时写入持久化冷却时间戳并退出进程，由 systemd 自动重启。
- 重启后的服务在冷却时间内保持 Web/API 可用但不连接 Minecraft；冷却时长为 2 小时。
- 连接稳定 10 分钟后，连续断线计数清零。
