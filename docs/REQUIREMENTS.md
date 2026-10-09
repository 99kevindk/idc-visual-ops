# IDC 智能运维管理平台 — 需求与接口契约（依据抖音参考视频还原）

参考素材（已下载到工作区）：
- `ref/douyin_original.mp4`   原始参考视频（1440x1080, 263s, 抖音「瞎话话」：我用Codex搓了个能语音巡检的机房）
- `ref/keyframes/`  40 张关键帧 JPEG（帧号 N ≈ 第 N-1 秒），**可直接 read_image 查看**
- `ref/crops/`  关键局部放大图
- 需要全部 263 帧：`ffmpeg -i ref/douyin_original.mp4 -vf fps=1 ref/frames/f_%04d.png`
参考视频里的成品是「IDC 智能运维管理平台」，6 个页签 + 语音巡检数字助手「小维」。

## 1. 产品目标
纯前端（HTML + Three.js）的 3D 机房可视化运维软件，可离线双击运行。
核心卖点（必须实现）：
1. 3D 机房数字孪生：多排机柜、地板/冷通道、精密空调、UPS/配电，机柜可开门看到内部 U 位设备，状态发光（正常/告警/离线）、温度热力、告警定位动画。
2. 语音巡检助手「小维」：麦克风语音（Web Speech API 中文识别）或文字输入 → 意图解析 → 小维 3D 形象走到目标机柜 → 机柜开门 + 状态面板弹出 + 语音播报(TTS) + 生成巡检结论/工单。
3. 六大页面：总览、机房监控、资产管理、能效管理、告警中心、运维工单。
4. 动态片头（纯代码生成的镜头飞入 + 标题动画，可跳过）。
5. 全本地模拟数据，无后端；小维的"AI 回复"用本地规则/VoiceAI 技能库实现（视频作者也是本地指令演示）。

## 2. 视觉设计规范（严格对照参考帧）
- 设计分辨率 1440x810（16:9），整体深色科技风；`body` 背景 #05080f，画布外围留深色渐变。
- 主色板：
  - 面板底 `#0a1524`（径向渐变到 `#08111d`），面板描边 `rgba(64,180,255,.18)`，内发光 `rgba(34,211,238,.08)`
  - 主强调青 `#22d3ee` / `#35e0ff`，次强调蓝 `#2f7fe8`，紫 `#7c6cf0`
  - 正常绿 `#22c55e`，告警黄 `#f5a524`，严重红 `#ff4d4f`，离线灰 `#5b6b80`
  - 正文 `#dce9ff`，次要 `#8aa0bd`，英文小标签 `#5f7791`（大写 + letter-spacing:1px, 字号 10px）
- 字体：`"Microsoft YaHei","PingFang SC",system-ui,sans-serif`；数字用 `font-variant-numeric: tabular-nums`，大数字加发光 text-shadow。
- 面板结构：标题（左侧 2px 青色竖条 + 中文标题 + 下方大写英文小标签）+ 右侧角标按钮。四角有细括号装饰线。
- 顶部：① 主标题栏 h=48："IDC 智能运维管理平台"（居中，两侧带装饰线）+ 英文副标题 "IDC INTELLIGENT OPERATION AND MAINTENANCE PLATFORM"；左侧 "2026-11-02 14:28:36" + "查看引导"按钮，右侧 "上海 18℃" + 消息铃铛 + "管理员"。
  ② 页签栏 h=38：总览 | 机房监控 | 资产管理 | 能效管理 | 告警中心 | 运维工单（激活项=青色描边胶囊+左侧图标）。
- 底部状态栏 h=44：4 个 KPI（机柜总数 42 / 总功耗 32.6 kW / PUE 1.36 / 可用率 99.99%）+ 右侧麦克风按钮"进入三维巡检"；左下角滚动告警 ticker（"▲ 2026-11-02 14:28:34 A3温度偏高 …"）。
- 三栏布局：左 240px、中自适应、右 240px（总览页）。图表全部用 Canvas 2D 手绘（不用第三方图表库）。

## 3. 各页面内容（照抄参考视频信息架构）
### 总览
- 左：`机房运行状态`（环形仪表 98 + "运行良好"；设备总数 256 / 在线设备 252 / 告警设备 4 / 维护中 0）
      `环境监控（平均）`（温度 24.3℃ / 湿度 45.2% / PUE 1.36，各带迷你趋势线）
      `告警统计`（最近24小时：12 告警总数 / 2 严重 / 4 一般 / 6 提示 + 24h 柱状图，X 轴 00:00~24:00）
- 中：3D 机房等轴视图 + 顶部小标题"机房实时总览"；浮动卡片「严重告警 A-02 送风温度过高 让小维看看→」；底部图例 正常运行/告警中/已离线 + "数据更新于 10:26:08"
- 右：`IT 负载`（环图 68%，12.6 / 18.5 kW，日曲线）
      `能耗趋势`（今日能耗 28,430 kWh，-6.8% 较昨日，柱图 + 日/周/月）
      `设备类型占比`（环图 256 设备总数；服务器 58% / 存储设备 18% / 网络设备 12% / 安全设备 7%）
- 底：256→42 机柜总数 / 32.6 kW / 1.36 / 99.99%

### 机房监控（核心页）
- 左上返回："← 返回总览"；标题"— A-02 · 设备概览"（随选中机柜变化）；中间按钮"查看整间机房"
- 左：`设备定位` DEVICE EXPLORER + 机柜下拉框；`当前告警 4` 列表（A-02 进风温度过高 严重 14:21:08 / D-07 网络丢包偏高 一般 14:12:45 / E-05 PDU负载偏高 一般 14:09:16 / C-05 散热风扇故障 严重 14:18:32），每项带"定位 →"
- 中：单机柜 3D 特写（机柜门打开、U 位设备、风扇模组、线缆），点击 U 位可选中高亮
- 中下：处置详情卡 `A-02 · A 区 02 号机柜` + 状态短语"处理已安排，等待现场结果" + 页签 `分析异常|安排处理|核验结果`
  - 温度 31.8 °C（参考阈值 ≤ 28 °C，"告警仍在监控"）；右侧小卡"已交给责任人跟进 / WO-1102-001 / 负责人 张工"
  - `告警依据`：进风温度过高，这是异常信号，尚不能仅凭该指标确定故障根因。
  - 流程清单：告警生成工单 / 维保人员接单（演示）/ 用户确认处置方案后，助手关联工单并安排处理（演示）
  - 底部提示：需要现场人员实际检查：助手不会把派单当作维修完成。
- 右：`小维 · 巡检助手`（AI ASSISTANT 本地指令演示），页签 `巡检对话|设备详情`
  - 消息流："· 已到达 A-02"、回复卡（上次维保 2024-10-28，下次计划 2024-11-28，负责班组：IDC 维保一组。建议：检查进风通道与冷通道送风，确认温度传感器读数。以上为示例维保记录。）、"小维正在回复：A-02 号机柜，进风温度过高，温度 31.8 度，功率 2.23 千瓦。…"
  - `A-02 · 处理闭环`（告警待确认）+ "下一步：确认告警 →"
  - 按钮组：巡检 A-02 / 当前告警 / 继续巡检；"关闭语音唤醒" + ☑语音播报
  - 输入框 placeholder "例如：查看 A-02 的状态" + 麦克风 + 发送

### 资产管理
- 顶部 `资产全景` 四个数字：机柜总数 42 个 / 运行正常 38 个 / 异常设备 4 台 / 设备总数 1512 台
- 左：机柜树（机房分区 A区/B区…、按排/机柜展开，点击定位三维机柜）
- 中：设备台账表格（设备名称 / 型号 / 状态 / 告警 / 容量 / 所属机柜(U位)），每行"定位""编辑"
- 右：资产详情卡（选中设备详情 + 迷你 3D 预览 + "在三维中定位"按钮）

### 能效管理
- 顶部指标：今日累计能耗 210,785 kWh / 当前 PUE 1.36 / 节能率 -6.8% / PUE 目标 1.40
- 左/中：`用电趋势` 柱状图（今日|近7天切换，tooltip 例：10:00 29,450）
- 右：`PUE 变化` 折线（Y 轴 0.5/1.0/1.4）+ 今日 PUE 1.36 徽标；`能耗构成` 环图（IT设备 / 制冷系统 / 供配电 / 照明与其它）

### 告警中心
- 顶部统计：严重 2 / 一般 2 / 已确认 / 未确认 + 最近24h 趋势
- 左：告警列表（级别色条 + 设备 + 描述 + 时间 + 状态 + 定位/处置按钮）
- 中：3D 机房（自动飞到告警机柜，红色脉冲光圈）
- 右：告警详情 + 处置建议 + "生成工单"按钮

### 运维工单
- 标题 `运维工作台` / 副标题 "查看维保任务，推进接单、处理与完成状态。"
- 统计：全部工单 4 项 / 待处理 1 项 / 进行中 1 项 / 待核验 1 项 / 已完成 1 项
- 左：`维保任务`（筛选页签 全部|待处理|进行中|待核验|已完成）+ 工单卡：
  WO-1102-001 严重 检查 A 区送风与温度传感器 A-02 张工 待处理 2026-11-02 14:23
  WO-1102-002 严重 更换故障风扇模组 C-05 李工 进行中 2026-11-02 14:20
  WO-1102-003 一般 检查交换机上联丢包 D-07 王工 待处理 2026-11-02 14:15
  WO-1101-004 计划 机柜周巡检与清洁 B-04 刘工 已完成 2026-11-01 10:00
- 右：`任务详情`（关联机柜/负责人/创建时间/处理说明 + 处理记录时间线 + 按钮"关闭工单""查看关联告警" + 页脚建议）

## 4. 语音巡检剧本（必须能演示）
唤醒/入口：底部"进入三维巡检"麦克风按钮、右侧助手输入框。
示例指令与预期动作（意图 → 3D 动作 + 语音 + UI）：
| 指令 | 小维动作 |
|---|---|
| 巡检 A-02 / 查看 A-02 的状态 | 镜头飞向 A-02 → 小维走过去 → 开门 → 高亮 31.8°C 的进风温度 → 播报"A-02 号机柜，进风温度过高，温度 31.8 度，功率 2.23 千瓦。检查进风通道与冷通道送风，确认温度传感器读数。" → "下一步：确认告警" |
| 当前有哪些告警 | 逐条播报 4 条告警，列表高亮，3D 依次飘红点 |
| 检查电力数据 / 查看 PDU | 切到 A-02 配电视图，PDU 负载条 + 播报 2.23 kW / 额定 3.68 kW |
| 整间机房 / 返回总览 | 镜头拉回总览，显示温湿度热力 |
| 分析原因 / 怎么处理 | 输出排查顺序（进风通道 → 冷通道送风 → 温度传感器读数）+ 处置边界说明 |
| 生成工单 / 派人处理 | 生成 WO-1102-00x，写入运维工单页，播报负责人 |
| 现场处理完成，复核并归档 | 温度回落正常 → 机柜转绿 → 工单推进到待核验 → 输出闭环小结 |
| 打开 B 排机柜 / 看看冷通道 | 镜头/开门/通道视角切换 |
未识别时："没听清，可以说『巡检 A-02』或『当前告警』。"

## 5. 代码结构与接口契约（严格遵守，便于并行开发）
```
index.html            入口（脚本/样式引用，加载 dist/app.js 或 src/app.js）
scripts/build.mjs     esbuild 打包（src/app.js -> dist/app.js）
scripts/shot.mjs      headless Chrome 截图（QA 用）
start.bat             本地静态服务 + 打开浏览器（可选）
src/app.js            【Lead】主循环、页面路由、镜头编排、模块装配
src/data.js           【Lead】模拟数据模型 + 事件总线
src/scene3d.js        【viz-3d】Three.js 场景
src/hud.js            【ui-hud】6 大页面 DOM/HUD + Canvas 图表
src/xiaowei.js        【voice-ai】语音识别/播报 + 意图解析 + 巡检剧本状态机
src/styles.css        【ui-hud】全部样式
vendor/three.module.js, vendor/OrbitControls.js
```
模块间只通过 `window.IDC` 命名空间 + `IDC.bus` 事件通信；**不要互相 import，不要改动别人的文件**。

### `IDC.bus`（由 src/data.js 提供）
```js
IDC.bus.on(evt, fn)      // evt: 'page'|'rack:select'|'rack:open'|'alarm:add'|'alarm:ack'
                         //      'wo:update'|'assistant:say'|'assistant:listen'|'voice:cmd'
                         //      'data:tick'|'toast'|'tour:start'
IDC.bus.emit(evt, payload)
```

### `IDC.data`（src/data.js）
```
kpi: { rackTotal:42, deviceTotal:256, deviceOnline:252, deviceAlarm:4, deviceMaintain:0,
       tempAvg:24.3, humAvg:45.2, pue:1.36, itLoadPct:68, itLoadKW:12.6, itLoadCapKW:18.5,
       energyTodayKWh:28430, energyDeltaPct:-6.8, available:99.99, totalPowerKW:32.6,
       energyMonthKWh:210785, pueTarget:1.40, savingPct:-6.8 }
racks: [ { id:'A-02', row:'A', rowIndex:2, zoneLabel:'A 区', x:.., z:.., rot:0,
           status:'normal'|'alarm'|'offline', tempIn:31.8, tempOut:23.8, humidity:45.2,
           powerKW:2.23, powerRatedKW:3.68, loadPct:61, uUsed:32, uTotal:42,
           devices:[{ id, name, model, type:'server'|'storage'|'network'|'security',
                      status, temp, capacityPct, uStart, uSize }] } ]
alarms: [ { id, rackId, level:'critical'|'warning'|'info', title, detail, time:'14:21:08',
            ts, acked:false, woId:null } ]
workOrders: [ { id:'WO-1102-001', level, title, rackId, owner:'张工', status:'pending'|'doing'|'verify'|'done',
                created:'2026-11-02 14:23', note, timeline:[{time,text}] } ]
energy: { hourly:[{label:'00:00',kwh}], week:[...], pueSeries:[...], mix:[{name,pct,color}] }
deviceMix: [{name:'服务器',pct:58,color},{name:'存储设备',pct:18},...]
alarmStats: { total:12, critical:2, warning:4, info:6, hourly:[[h,v],...] }
events: [{ time, text }]
getRack(id), getAlarm(id), getWorkOrder(id), addAlarm(a), ackAlarm(id),
toggleRackDoor?? -> 用 bus 事件
tick()            // 每 2s 调用一次，微扰数据并 emit('data:tick')
clock()           // 返回 '2026-11-02 14:28:36' 字符串（仿真时间，随真实时间推进）
```

### `IDC.scene`（src/scene3d.js）— 由 3D 负责人实现
```js
IDC.scene.init(canvasEl, { data })          // 建场景；返回 this
IDC.scene.frame(ts)                          // 每帧调用（动画/脉冲/小维行走）
IDC.scene.resize(w, h)
IDC.scene.setView(name, opts)                // 'overview'|'aisle'|'roomOrbit'|'rack'|'energy'|'intro'
IDC.scene.focusRack(rackId, {open=true, duration=1.2})   // 镜头飞行 + 开门 + 高亮
IDC.scene.openRack(rackId, bool)
IDC.scene.highlightRack(rackId, mode)        // mode:'alarm'|'normal'|'temp'|null
IDC.scene.setMode(mode)                      // 'status'|'temp'|'load'|'alarm'  (地表/机柜着色)
IDC.scene.setAlarmBeacons(list)              // 红色脉冲光柱列表
IDC.scene.assistantTo(rackId, opts)          // 小维走到机柜前（含行走动画）
IDC.scene.setAssistantSpeaking(bool)
IDC.scene.resetCamera()
IDC.scene.playIntro(cb)                      // 片头动画，结束回调
点击机柜 emit('rack:select', rackId)
```

### `IDC.hud`（src/hud.js）
```js
IDC.hud.mount(rootEl, data, scene)
IDC.hud.setPage(name)          // 'overview'|'monitor'|'assets'|'energy'|'alarms'|'workorder'
IDC.hud.refresh()              // 重绘 KPI/图表/列表（监听 'data:tick' 自动调用更佳）
IDC.hud.setRackDetail(rackId)  // 机房监控页选中机柜
IDC.hud.chat.add({role:'user'|'assistant', text})   // 追加对话
IDC.hud.chat.setStatus(text)   // "小维正在回复：…"
IDC.hud.chat.setNextStep(text) // "下一步：确认告警 →"
IDC.hud.toast(text, level)
IDC.hud.setListening(bool)     // 麦克风动效
IDC.hud.openWorkOrder(woId)
```

### `IDC.xiaowei`（src/xiaowei.js）
```js
IDC.xiaowei.init({ data, scene, hud })
IDC.xiaowei.listen()            // 开始语音识别（不支持时自动降级为文字输入）
IDC.xiaowei.stop()
IDC.xiaowei.ask(text)           // 文字/识别文本 -> 执行意图（动作+播报+UI）
IDC.xiaowei.say(text)           // TTS 播报 + hud.chat.add + scene.setAssistantSpeaking
IDC.xiaowei.speakEnabled = true // 语音播报开关
IDC.xiaowei.wakeWordEnabled     // 语音唤醒开关（默认 false）
```

## 6. 验收标准
- 双击 `index.html`（或运行 start.bat）即可离线运行，无控制台报错，1440x810 下布局不溢出。
- 6 个页签均可切换且内容与上表一致；总览页 3D 可鼠标旋转/缩放。
- 点击机柜 → 高亮 + 弹出信息 + 镜头对准；机房监控页可看开门后的 U 位设备。
- 语音/文字指令 "巡检 A-02"、"当前告警"、"检查电力数据"、"怎么处理"、"生成工单"、"现场处理完成" 均能得到相应 3D 动作 + 文字 + 语音播报。
- 仅用示例数据，界面角标注明"本地演示数据 / 示例数据"。
> 抽帧素材说明：`ref/keyframes/` 保留 40 张关键帧（JPEG，1100px 宽，帧号 = 视频秒数+1）；
> 需要全部 263 帧时执行：`ffmpeg -i ref/douyin_original.mp4 -vf fps=1 ref/frames/f_%04d.png`。


---

## 8. 拟真化改造（第二轮需求："可视化机房机柜需要拟真3D图形实例"）

- **渲染管线**：ACESFilmic 色调映射、sRGB 输出、PCFSoft 阴影（主光 2048、normalBias）、RoomEnvironment + PMREMGenerator 环境反射、半球/主/轮廓/补光四灯。
- **贴图**：全部由 `src/textures.js` 用 Canvas 2D 程序化生成（拉丝金属、镂空网孔门 alphaMap、19" 立柱方孔、U 位刻度、四种设备前面板 + LED 自发光、架空地板方砖、冷通道格栅、桥架、多色线缆束、屏幕 UI、铭牌、光晕），法线贴图由高度图经 Sobel 生成；零外部图片/字体资源。
- **机柜几何**：铝型材框架 + 侧/后板 + 真实镂空前门（alphaTest，可开合 70°）+ 19" 立柱与 U 位刻度 + 服务器/存储/网络/安全四类前面板 + 盲板补满 42U + 风扇模组 + 竖装 PDU + 跳线束 + 门前沿铭牌。
- **机房环境**：600mm 架空地板方砖（1504 实例）、冷通道格栅、吊顶灯盘（含光晕）、桥架与吊挂线缆、玻璃隔断、结构柱、沿墙精密空调/UPS/配电柜/电池柜/监控大屏、门禁/摄像头/灭火器/温湿度传感器/分区牌。
- **LOD 与性能**：>21m（low 16m）机柜降级为整体柜体 + 门贴图；细节全部 InstancedMesh；≈6.2 万三角面 / ≈508 draw call；`?quality=low` 关阴影与环境贴图。
- **风格约束**：深蓝暗场 + 银灰金属 + 青色灯带为画面最亮元素，机柜被灯照亮、环境压暗（基准图 `shots/ref_realistic_look.png`）。
- **契约不变**：`IDC.scene` 的 13 个方法与 `rack:select`/`device:select` 事件保持不变，HUD 与语音助手无需改动。
