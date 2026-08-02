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

## 2026-07-26 回退到纯聊天界面

- 按要求将应用代码恢复到 `b513e7e`，页面只保留 Bot 状态与分页聊天框。
- 移除后续加入的世界 Canvas、区块缓存、背包、移动/挖掘控制、快捷动作和预览服务器。
- 同步恢复该版本的 `src/light-bot.js`、`src/server.js`、`package.json` 与对应测试，避免留下
  已无页面入口的后台功能。
- 保留 `minecraft-idle-bot-update.timer` 和安全 fast-forward 更新脚本；它们只负责 push 后
  自动部署，与界面版本无关。

## 2026-08-02 Dred 登录诊断

- 新增 `start-dred-test.cmd` 双击入口，不修改 `.env`，仅让该诊断进程使用用户名 `Dred`。
- 进入 `play` 后自动发送 `/home`，默认继续观察 60 秒，捕获协议错误、断线、未处理异常和进程崩溃。
- 诊断结果写入 `.runtime/dred-login-report.json`；退出码 `0` 表示观察期内连接健康，其余退出码表示登录、命令、连接或进程异常。
- 诊断使用 `.runtime/dred-login.cooldown`，不会读取或改写正式 Bot 的冷却文件。

## 2026-08-02 网页登录控制

- 页面新增“登入”和“登出”按钮，分别调用 `POST /api/login` 与 `POST /api/logout`。
- 登入/登出操作复用现有 `LightBot` 生命周期，状态通过 SSE 即时同步；服务启动时仍保持原有自动登录行为。

## 2026-08-03 AE2 存储总线定位

### 排查过程

- 先检查 18013 服务，确认正式 Bot 位于 `minecraft:overworld` 的
  `(117.5, 120.1, -89.5)`，服务为 `/home/huoyuuu/services/minecraft-idle-bot` 下的
  `minecraft-idle-bot.service`。
- 当前轻量 Bot 会主动丢弃 `map_chunk`，因此新增独立的只读脚本
  `scripts/storage-bus-scan.js`。脚本只登录、确认传送、请求视距并记录区块、方块实体、
  Forge registry 和 custom payload；不发送方块点击、窗口点击或物品移动包。
- 第一次尝试调用远端 `/api/logout` 时，线上旧版本尚无该接口，返回 404，Bot 未退出；
  随后的脚本又因系统 Node 18 不支持 `--env-file-if-exists` 而未启动。为此给扫描脚本增加
  Node 18 `.env` 兼容加载，并改为停止 user service 后使用项目自带 Node 运行，最后无条件恢复服务。
- 有效扫描重新加载 337 个区块，采集 4380 个方块实体，其中 785 个是 AE2 方块实体、
  676 个是 `ae2:cable_bus`。扫描结束后正式服务恢复，Bot 再次进入 `play`。
- `ae2:storage_bus` 是 cable bus 内部 part，不是独立方块。GTO 精确版本位于
  `gtocore-forge-1.20.1-0.5.6-beta.jar` 内嵌的 AE2 `15.267.4`。`#upd` 首字节是
  DOWN/UP/NORTH/SOUTH/WEST/EAST/中心线缆的 presence mask，随后按方位写 item registry ID
  的 VarInt 和 part 状态。该服务器 registry 中 `ae2:storage_bus` 的 raw ID 为 1604，
  对应 VarInt `c4 0c`。按此格式找到 17 个已放置存储总线。

### 全部存储总线

```text
存储总线             朝向    相邻目标
102 120 -81          UP      102 121 -81  functionalstorage:fluid_1
107 126 -102         WEST    106 126 -102 gtceu:hv_input_bus
107 125 -102         WEST    106 125 -102 gtocore:steam_fluid_input_hatch
107 126 -100         WEST    106 126 -100 gtceu:hv_input_bus
107 125 -100         WEST    106 125 -100 gtocore:steam_fluid_input_hatch
111 123 -51          DOWN    111 122 -51  gtceu:hv_input_hatch
111 123 -50          DOWN    111 122 -50  gtceu:hv_input_bus
111 123 -52          DOWN    111 122 -52  gtceu:hv_input_hatch
110 123 -52          DOWN    110 122 -52  gtceu:hv_input_hatch
90 120 -71           SOUTH   90 120 -70   gtceu:lv_input_bus
89 120 -71           SOUTH   89 120 -70   gtceu:lv_input_hatch
121 124 -48          DOWN    121 123 -48  gtceu:lv_input_hatch
120 124 -47          DOWN    120 123 -47  gtceu:hv_input_bus
120 124 -48          DOWN    120 123 -48  gtceu:lv_input_hatch
119 124 -48          DOWN    119 123 -48  gtceu:lv_input_hatch
76 125 -79           UP      76 126 -79   functionalstorage:oak_4
73 125 -76           NORTH   73 125 -77   functionalstorage:fluid_4
```

截图的“16 格且每格最大 64”与 HV 输入总线吻合，因此优先人工检查四组：

```text
storage bus 107 126 -102 -> HV input bus 106 126 -102
storage bus 107 126 -100 -> HV input bus 106 126 -100
storage bus 111 123 -50  -> HV input bus 111 122 -50
storage bus 120 124 -47  -> HV input bus 120 123 -47
```

原始诊断结果保存在本地未跟踪运行目录 `.runtime/storage-bus-scan.remote.json`；其中包含
本次 registry、所有区块方块实体和 AE2 更新字节，便于复核，但不提交 12 MiB 运行数据。
