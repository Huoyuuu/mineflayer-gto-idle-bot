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

---

# 前端界面重设计（2026-08-04）

## 你提的问题

“界面丑爆了”。这是个主观判断，但主观判断通常有客观成因，所以我先去找成因，而不是直接换配色。

## 我看到了什么

先列 `public/`，发现界面已经被拆成了模块：`index.html` 负责结构，`app.css` 是唯一样式表，
`app.js` 是路由外壳，`lib.js` 是格式化与手写 SVG 图表，`store.js` 管 SSE 与轮询兜底，
`view-status.js` / `view-chat.js` / `view-stats.js` 三个视图各自 mount/unmount。这个结构本身是干净的，
所以我判断问题不在架构，而在视觉层——也就是说，这是一次纯样式改造，不需要动数据流。

然后我把三个 view 文件都读完了。这一步不是为了改它们，是为了**确认哪些 class 是 JS 契约**。
读出来的结果很关键：

- `view-status.js` 的 `dotClass()` 直接赋值整个 className 字符串（`dot dot-online` 等），
  并且 `$('#hero-dot').className` 会把 Tailwind 的尺寸类一起重写掉；
- `lib.js` 的 `rows()` 硬编码生成 `<div class="kv"><dt><dd>`；
- `view-chat.js` 的 `messageRow()` 硬编码 `msg msg-${kind}`、`msg-hit`、`daymark`、`mark`、`chip`；
- `view-stats.js` 用 `dot` 当图例色块，靠 inline style 覆盖背景色。

所以改造的边界确定了：**class 名一个都不能删**，只能重写它们的实现，并且可以新增 class。
这个约束让我放弃了“重写 HTML 结构”的念头——那样会引入一堆需要同步修改 JS 的风险，
而收益（视觉）完全可以靠样式层拿到。这也符合“在所有可行实现中选最简单的一个”。

## 原来的样式为什么显得丑

读完 `app.css`（旧版 317 行）我找到了几个具体原因，而不是笼统的“不好看”：

1. **没有字体层级**。全站 `system-ui`，只靠 `font-size` 和 `font-weight` 区分层级。
   最大的数字是 `text-[28px] font-semibold`，和正文只差一点，屏幕上没有视觉锚点，
   眼睛不知道该先看哪里。
2. **信息密度均匀**。每个 card 内边距一样、每个数字大小接近，整页是一张灰色的网格，
   没有主次。仪表盘的本质是“一眼看状态”，均匀密度正好破坏了这件事。
3. **纯平背景**。`--paper: #faf9f7` 是个不错的纸白，但铺成一整块纯色后就只是“浅灰”，
   不是“纸”。纸的质感来自纤维颗粒和受光不均。
4. **动效只有 120ms 的颜色过渡**。没有入场、没有生长、没有节奏，界面像截图而不像活的。
5. **`--ink: #1c1917` 偏中性冷**，配纸白偏灰调，缺一点暖。

## 我做了什么

重写 `app.css`（现 630 行），主题定为 **Paper Telemetry**：一张会呼吸的印刷排版表。
`index.html` 只做最小改动——加字体、把大数字挂上 `.display`、把 card 标题挂上 `.eyebrow`、
微调间距。JS 一行未动。

**排版**：引入 Instrument Serif 作为 display 字体，专门给数字用。hero 的状态字号做到
`clamp(2.4rem, 7vw, 4.25rem)`，坐标 26px，统计总数 38px，倒计时 40px。
微标签换成 JetBrains Mono、9.5px、`0.19em` 字距、全大写——这是印刷体系里
“小字反而更精确”的处理，和巨大的衬线数字形成对位。正文换 Inter。
一句话：**数字用衬线，标签用等宽，正文用无衬线**，三种声音各司其职。

**纸**：`body::before` 叠三层 radial-gradient 模拟从左上打来的光和右上的暖影；
`body::after` 用 data-URI 的 `feTurbulence` 生成灰度噪声，`mix-blend-mode: multiply`
压上去做纤维颗粒。两者都 `position: fixed` 且 `pointer-events: none`，
`body > *` 抬到 `z-index: 1`。这里踩到的点：噪声层必须 `inset: -50%`，
否则 `fixed` 元素在某些滚动合成路径下边缘会露白。

**油墨色**：`--ink` 调成 `#171310`（更暖更深），`--online` 调成 `#0d7a5f`，
`--wait` `#b4620a`，`--error` `#b3261e`——三个状态色都降低了饱和度，
让它们像印在纸上而不是发光。

**细节动效**（全部走同一条 `--ease: cubic-bezier(0.22,1,0.36,1)`，这是保持“一个手感”的关键）：

- 在线状态点有 2.8s 的雷达 ping 扩散；等待重连时是 breathe 缩放。
- 按钮 hover 是**油墨上翻**：`::before` 从 `translateY(101%)` 推到 0。
  这里有个必须成对存在的实现——`::before` 放 `z-index: 0`，
  同时把直接子元素抬到 `z-index: 1`。我第一版写的是 `z-index: -1`，
  那样填充会被按钮自身背景挡住完全看不见；改成 0 之后又会盖住文字，
  所以子元素提层是配套的、不能省。
- tab 下划线用 `scaleX` 从左侧生长，hover 时到 0.34，选中到 1，340ms。
- 聊天行 hover 时左边距浮出一条 1.5px 的墨线（`scaleY` 生长），像读到哪画到哪。
- 搜索命中行有 2.4s 的 `flare` 从深黄褪到浅黄。
- 图表 `rect` 有 `transform-origin: bottom` 的 640ms 生长，`path` 有淡入。
- 视图切换时 `section:not([hidden]) > *` 按 `nth-child` 阶梯延迟 0/55/110/165ms 落位。
  这一招能成立，是因为路由用的是 `hidden` 属性而不是 class——读 `app.js` 时确认过 `setHidden()`。
- 全部动效在 `prefers-reduced-motion: reduce` 下关闭。

**印刷符号**：hero 卡片的 `::before` / `::after` 画左上右下两个 9px 的直角角标，
是印刷业的套准标记；`.eyebrow` 给 card 标题加发丝下划线；`.meter` 上叠
`repeating-linear-gradient` 刻度，像印好的标尺；`.daymark` 两侧是渐隐的发丝线；
`mark` 改成 `linear-gradient(180deg, transparent 54%, #fbe08a 54%)`，
即只有下半截着色的荧光笔效果，比整块背景色干净。

**边框**：全站 `border-radius: 0`（chip 除外，保留胶囊形），一律 1px 发丝线。
圆角是让界面显得“软”和“通用”的主要来源，去掉之后立刻有印刷品的硬朗。

## 验证

`node --check` 过了 `public/` 下全部 7 个 JS 模块（`public/package.json` 标了
`"type": "module"` 才能这样检查）。`npm test` 14 项全过——本次没动 JS，
这一步是确认工作区里上一轮遗留的 `src/` 改动没坏。

提交 `b64490f` 推到 `server-live`。服务器上 `minecraft-idle-bot-update.timer`
每分钟拉一次 `origin/server-live`，我手动触发了一次 update service 让它立刻生效。
远端确认：HEAD 已是 `b64490f`，服务 `active`，`/api/state` 返回 200，
`/app.css` 返回 200 且首行是新的 Paper Telemetry 注释头。

## 有一点我要说明

我没做浏览器截图验证——你明确说了不需要。所以“好不好看”这件事，
我只能保证设计意图和实现是一致的、代码不报错、线上已经生效。
最终判断在 18013 上，由你来下。

# 2026-10-03 网络质量门控重连

## 观察

- 服务器与本地同为 `server-live`；服务器 HEAD 为 `18f2cf4`，工作区干净，tracked 文件索引哈希一致。本地落后 1 个提交，已 fast-forward。
- 近 30 天断线原因：`keepAliveError` 53 次、`socketClosed` 9 次、`login timeout` 8 次，基本是链路卡顿而非被踢。
- 断线集中在北京时间 19–23 点，其次 01–03 点，符合跨境线路晚高峰拥塞。
- 10-03 晚上旧逻辑形成死循环：断线 → 2 分钟后重连成功 → 稳定 10 分钟清零 → 约 8 分钟后再断，一晚 8 轮，指数退避从未升级。
- 目标服屏蔽 ICMP（ping 100% 丢包），不能用 ping 判断网络。
- Server List Ping（SLP，不登录、不进服、不刷公告）可用。40 次实测（5 秒间隔）呈双峰：约 240ms 为正常，约 950ms 为丢包重传，另有 5 次超时。

## 决策（与用户讨论后确定）

- 判定方式选 B：滑动窗口打分。
- 组合方式选 2：网络门控为主，时间退避只留给“网络好但登录仍失败”。
- 设兜底；阈值偏保守；不考虑服务端卡顿（用户确认服务器总是好的）。
- 不做一天观测，直接上线；同时放宽客户端 keepalive 容忍。

## 实际修改

- `src/light-bot.js`
  - 断线后每 30 秒做一次 SLP 探测（超时 5 秒），探测只在等待重连期间进行，在线时不探测。
  - 每次断线清空样本，只认断线之后的探测。
  - 达标条件：最近 20 次（约 10 分钟）中失败 ≤ 1、延迟中位数 ≤ 400ms、p90 ≤ 800ms。p90 原定 1000ms，看了实测双峰后收紧到 800ms，让约 950ms 的重传尖峰算作“差”。
  - 兜底：退避等待结束后再等 60 分钟仍未达标，就强制重试一次。
  - 退避语义：第 1 次重连只有网络门控（0 分钟），之后登录仍失败才依次叠加 2/4/8/16/32/60 分钟；60 分钟那档也失败则进入原有 2 小时 cooldown。连续掉线 4 次触发 cooldown 的保护不变。
  - cooldown 到期后也走网络门控，不再直接连接；服务启动和手动登录仍立即连接。
  - `connect()` 会先清掉待执行的探测定时器，修复“等待中手动登录后旧定时器又连一次”的隐患。探测结果按 generation 校验，过期结果直接丢弃。
  - 客户端 `checkTimeoutInterval` 从默认 30 秒放宽到 60 秒（看门狗仍为 90 秒）。
  - 状态新增 `network`（samples / failures / medianMs / p90Ms / good）；`nextReconnectAt` 现在表示兜底时间。
- `src/server.js`：`limits.reconnectDelays` 前面补一个 0，作为“网络”档。
- `public/view-status.js`：阶梯第一档显示“网络”；等待文案与连接卡片显示探测进度和中位 / p90。
- `test/light-bot.test.js`：更新退避用例，新增 `networkQuality` 用例和门控流程用例（注入假 probe）。

## 验证

- `npm test` 16 项全过，`npm run check` 通过。
- 用 40 条线上真实样本回放 `networkQuality`：前 20–25 条判为达标，后段失败增多后判为不达标，符合预期。
- 推送 `534f176`，update timer 自动部署，服务 active，Bot 重新进入 `play`。
- 在服务器上用独立 LightBot 实例跑 3 次真实 `probe()`（`connect` 已替换），走的是真实 `mc.ping`：1 次失败，中位 245ms，没有影响线上 Bot。
- `/api/stats` 的 limits 返回 `[0, 2m … 60m]`。

## 未决事项

- 还没在真实断线中走完一整轮门控，需要等下一次晚高峰断线后看 journal 中的 `network good` / `network fallback reached`。
- 阈值偏保守：坏时段可能长时间不重连，最长约 60 分钟后才兜底一次。如果在线时长下降明显，可以把 `NETWORK_MAX_FAILURES` 放宽到 2，或缩短兜底时间。
- 服务端那一侧的 keepalive 超时无法从客户端放宽。

## 补充：网络门控 UI 与热更新

- 状态页新增整行“网络门控”卡片：显示窗口进度条（x / 20）、失败次数、中位延迟、p90 延迟，每项旁边标注阈值，达标绿色、超标红色，另有兜底重连时间和倒计时。右上角徽标显示“门控中 / 已达标 / 上次断线数据 / 在线不探测”。连接卡片里原先的“网络门控”一行删掉，避免重复。
- 前端阈值常量 `NET` 与 `src/light-bot.js` 中的 `NETWORK_*` 手动保持一致；后端只上报实测窗口。
- 在线期间不探测，所以平时卡片显示的是上次断线时的窗口数据，进程刚启动时为空。
- 发现部署脚本每次 push 都会重启服务：推送纯文档的 `3118a42` 也让 Bot 重新登录了一次。
- `scripts/update-and-deploy.sh`：fast-forward 之后，如果改动文件全部属于 `public/`、`docs/`、`test/` 或 `*.md`，就直接退出，不调用 `deploy.sh`。`serveStatic` 每次请求都从磁盘读取，并用 mtime 生成 ETag，所以前端改动刷新页面即可生效。其他改动（`src/`、`scripts/`、`package*.json`、`deploy/`）仍然走完整部署并重启。
- 这次提交改动了脚本本身，服务器上的旧脚本会照常重启，所以手动处理：先停 update timer，等它空闲后在服务器上执行 `merge --ff-only`（禁用 hooks），再启动 timer。Bot 进程 PID 1115804 全程没变。
