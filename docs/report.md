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

## 2026-07-23 指数退避与自动部署

- 重连等待调整为 `2 分钟、4 分钟、8 分钟、16 分钟、32 分钟、60 分钟`。
- 60 分钟重试仍失败时，服务写入 2 小时冷却时间戳并由 systemd 自动重启；此前已建立连接连续掉线超过 3 次也触发同一保护。
- 新增 `.githooks/post-merge` 与 `scripts/deploy.sh`。服务器配置 `core.hooksPath` 后，`git pull` 会自动执行 `npm ci --omit=dev`、刷新 user systemd unit 并重启挂机服务。

## 2026-07-26 断联根因与聊天修复

### 断联时间线

Bot 在 `18:52:43 CST` 收到 `ECONNRESET`。重连逻辑确实按 `2m -> 4m -> 8m`
执行：第一次登录超时，第二次被 Minecraft 端 `ECONNREFUSED`，第三次于
`19:08:09` 开始 Forge 登录。本次没有达到 2 小时 cooldown 条件。

真正导致后续“没有重连”的是登录后立即解码失败：

```text
Parse error for play.toClient (808920 bytes, 6d942d...) :
Read error for undefined : unexpected tag end
```

`0x6d` 是 1.20.1 的 `declare_recipes`。Forge 服务器发送了含模组自定义 recipe
serializer 的约 790 KiB 配方包，原版 `minecraft-protocol` schema 读偏后产生 NBT
`unexpected tag end`。解析流已停止，但 TCP 没有关闭，旧代码因此一直误报
`phase=play`，并在 10 分钟后错误清零重连计数。

### 修复内容

- 挂机 Bot 不需要配方，因此将 `declare_recipes` 覆盖为 `restBuffer` 直接丢弃，避免解码模组配方和持有大对象。
- 协议解析错误现在会主动关闭连接；进入 play 后 90 秒无任何数据包也会关闭假死连接。
- 退避时状态新增 `nextReconnectAt` / `reconnectDelayMs` / `reconnectAttempt`，journal 会记录下次重连时间。
- 修复 `stop()` 与 `end` 的竞态，防止 systemd 停服务时旧连接再次调度重连。
- 聊天组件使用 `prismarine-chat` 完整处理 `translate` 模板，`1/20` 不再变成 `120`。
- 发送时不再插入本地 `outbound` 副本，只保留服务器回显，因此 `hi` 只显示一行。
- 聊天按 JSONL 持久化到 `.minecraft-idle-bot.chat.jsonl`，`GET /api/chat?before=<cursor>&limit=50`
  提供稳定 cursor 分页。第 1 页始终取最新消息，历史页在新消息到达时不会位移。

### 验证

`npm test` 共 7 项通过，覆盖聊天组件分隔符、发送回显、配方包跳过、
退避序列及 121 条跨重启分页记录。

## 2026-07-26 三栏 GUI 与轻量交互

- 网页重排为左状态/背包/动作、中间 Canvas 视图、右聊天。
- 修复截图中的点选错误：单击只选块，双击才发起交互，右键阻止浏览器菜单。
- 中间 Canvas 在浏览器端完成等距投影反解、红色选框、拖拽视角和滚轮缩放；VPS 不保存地图缓存。
- 键盘 `WASD`、`Shift`、`Space` 通过 `/api/control` 发送合并按键状态，服务端 100ms 一次发送最小位置包。
- 本版故意不引入 Three.js、prismarine-chunk 或物理引擎，因此中间视图是轻量 GUI 与坐标选择层，不是完整世界区块渲染器。
