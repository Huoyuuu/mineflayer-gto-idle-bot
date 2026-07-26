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

## 2026-07-26 真实世界视图与交互细节整改

### 一、中间面板现在显示"具体的世界"

之前中间那张图是**假的**：一张固定棋盘格，不含任何真实方块数据，点哪一格都只是算个坐标。
现在改成真实地形：

- 新增 `src/world.js`，自研 1.18+ 区块分段解码器（约 200 行），不引入 `prismarine-chunk`。
  只解出方块 state id，逐段存为 `Uint16Array`，全空段只存一个数字。
- 只保留 Bot 周围半径 `viewDistance+1`（默认 3）的区块列，超出即淘汰；服务器发 `unload_chunk`
  也会同步删除。实测 5×5 区块、46 个非空段占 **368 KiB**，是可忽略的内存增量。
- 解码带自校验：一列区块必须**恰好**消耗完 `chunkData` 缓冲区，多一字节或少一字节都判定为
  解析失败并丢弃该列（错误计数写进 `/api/state`）。这样即使某个模组服务器格式有出入，也只是
  少显示地形，不会污染内存、更不会像上次配方包那样打死解析器。
- 网页用等距投影绘制真实方块：按方块名着色（草/石/水/木/玻璃/矿物各有色系），按高度做明暗与
  侧面立体感，画家算法保证高柱子正确遮挡。可 `R` 旋转 90°、滚轮缩放、拖动平移。
- 顶部工具条给出**层高 Y 滑块**：室内挂机时把层高压到脚下高度就能看到房间地板而不是屋顶。
- 悬停显示方块名与坐标，选中显示与 Bot 的实际距离；不再是"点了个格子"，而是"点了 stone_bricks"。

### 二、聊天框不再吞掉 WASD

原来的 `window.onkeydown` 无条件 `preventDefault` 了 WASD/Shift/Space，导致在聊天框里根本
打不出这些字母。现在改为三态判定（`view-math.js` 里的 `keyIntent`，有单元测试覆盖）：

| 场景 | 行为 |
| --- | --- |
| 焦点在聊天输入框 | 所有按键原样交给输入框，`Esc` 退出输入 |
| 未接管画布 | 按键不拦截，浏览器快捷键照常 |
| 点击画布接管后 | 仅 `WASD/Q/E/Space/Shift/Ctrl` 被捕获，`Esc`、切标签页、窗口失焦立即释放 |

接管状态在画面上有明确提示（边框高亮 + 右下角实时键帽），不会出现"我以为在控制 Bot"的歧义。

### 三、移动改为朝向相对，并加了跑飞保护

- 原来 `WASD` 是按世界坐标轴平移的：不管 Bot 朝哪，按 W 永远是 -Z。现在按朝向走，
  `Q/E` 转身，转身角度实时发 `position_look`，潜行/疾跑用 `entity_action` 正式声明。
- 借助已解码的世界做**地面吸附**：自动上一格台阶、掉落回地面，跳跃是带重力的抛物线，
  不再"贴地漂移"或穿进方块里。
- **发现并修复一个危险 bug**：本次真机联调时我发过一次 `forward:true`，网页没有再发任何包，
  结果 Bot 一路走出 40 格。现在服务端对按键状态设 4 秒有效期，网页每 100ms 刷新一次；
  标签页崩溃、断网、关机都会让 Bot 在 4 秒内自动停下，不会走进岩浆。

### 四、其它已修复的细节

- 双击交互改为真实的两段挖掘（`start` → 挥手 → 按硬度计时 → `finish`），基岩/流体直接拒绝，
  空气位置也拒绝，超出 6 格给出"距离 X 格"的具体报错，而不是笼统的失败。
- 拖动视角后松手会误触"选中方块"——现在拖动超过 4px 即判定为拖动，不再误选。
- Bot 死亡/换维度后 `position` 变 `null`，旧代码画布会崩；现在维度切换会清空世界缓存
  （方块 id 是按维度定义的，留着会画出错误的世界），画布也不再依赖非空坐标。
- 断线时残留的控制定时器会被清掉，按键状态归零，重连后不会"继承"上次的按键。
- 背包不再显示 `itemId ×N` 这种数字，改为物品名；新增 9 格快捷栏，点击即切换手持槽位。
- 聊天恢复分页（"加载更早"），历史页不位移；只有贴着底部时才自动滚动，否则给"回到最新"按钮。
- 页面拆成 `index.html / app.css / view-math.js / app.js`，去掉 CDN 图标依赖（VPS 无外网也能用）。
- 服务端：`/api/world` 支持 gzip（半径 32 的地形 21 KiB），所有 POST 统一 8 KiB 上限与 JSON 报错，
  SSE 加 25 秒心跳与断连清理，静态资源走白名单（不存在路径穿越）。
- 左栏补上生命/饥饿条、运行时长、重连倒计时、封包数、区块缓存占用、游戏内日期与时刻。

### 五、验证

`npm test` 共 **34 项**通过，其中新增：

- 用**独立编写的编码器**（照着 1.18+ 协议格式写，不是复用解码器）往返验证单值/间接/直接调色板，
  含 15 bit 跨 32 位边界的最难情况；
- 区块淘汰、切片、地面高度、维度边界解析；
- 键盘三态判定、旋转矩阵自洽性（栅格旋转与分数坐标旋转必须互为逆运算）、时钟/罗盘/时长格式化；
- 朝向相对移动、跳跃落地、entity_action 只发一次、按键超时保护、交互校验、世界切片、背包命名；
- HTTP 层：静态白名单、请求体上限、SSE 推送与聊天落盘。

另外新增 `npm run preview`：用合成世界（山丘、水塘、砖房、灯笼）启动真实页面，
**不连接 Minecraft 服务器**，因此改 UI 时不会和线上 Bot 抢登录。本次改动就是这样验收的：
`/api/world` 返回的地形栅格、层高切片、挖掘/使用校验、gzip 均已实际跑通。

## 2026-07-26 Push 后未自动部署的修复

### 根因

服务器的 `.githooks/post-merge` 和 `scripts/deploy.sh` 都能正常工作，但它们只会在服务器
主动执行 `git pull` 后运行。服务器没有 cron、systemd timer 或 webhook，GitHub 上也没有
部署 workflow。因此 push 后 GitHub 已到 `a328ce2`，服务器仍停在 `96d15bb`。

### 修复

- 新增 `minecraft-idle-bot-update.timer`，每分钟检查一次 `origin/server-live`。
- 新增 `scripts/update-and-deploy.sh`，只接受干净工作树上的 fast-forward 更新，拒绝分支错误、
  本地 tracked 修改和历史分叉，避免无人值守更新覆盖服务器内容。
- 更新部署脚本，使其安装并启用 updater service/timer，同时确保 `core.hooksPath=.githooks`。
- updater 明确调用部署脚本，因此依赖安装或 systemd 重启失败会记录为 unit failure；人工
  `git pull` 仍保留原来的 post-merge 自动部署行为。

## 2026-07-26 线上交互界面修复

- 线上世界空白并非 Canvas 尺寸问题。`/api/state` 显示 98 次区块解码失败；线上采样确认
  每列在 24 个标准 section 后固定追加 12 个全零字节，并不是额外完整 section。
- 解码器只兼容这个精确的零填充形状，也支持能够继续严格解析到 EOF 的额外完整 section；
  非零尾巴、不同长度、截断 section 以及不同列的 section 数或填充变化仍会拒绝。
- `worldStats` 新增预期/实际 section 数，空切片和请求异常会在 Canvas 上显示明确原因。
- hotbar 改为格内只显示堆叠数量，完整物品名显示在下方并保留 tooltip；背包相同物品聚合，
  列表限制高度并使用省略号，避免大量 `iron_ingot` 撑坏整个左栏。
