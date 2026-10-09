# 第三方组件与许可清单（THIRD-PARTY NOTICES）

> 项目：IDC 可视化运维项目（IDC Visual Ops，IDC Visual Operations & Maintenance Platform）

> 本项目的**全部业务代码均为原创**（`src/`、`tools/`、`scripts/` 共 41 个自研文件，约 1.7 万行），
> 未包含任何 GPL / AGPL / 商业授权代码。以下为随仓库分发或开发期使用的第三方组件。

## 一、随仓库分发（redistributed）

| 组件 | 版本 | 许可证 | 用途 / 位置 | 义务 |
|---|---|---|---|---|
| three.js（含 examples：OrbitControls、RoomEnvironment） | r169 | **MIT** | `vendor/three.module.js`、`vendor/OrbitControls.js`、`vendor/RoomEnvironment.js` —— 3D 渲染、轨道相机、PBR 环境贴图 | 保留版权与许可声明：见 `vendor/three.module.js` 文件头与 `vendor/LICENSE-three.txt` ✅ |

> OrbitControls.js / RoomEnvironment.js 两个文件被改为相对路径 `./three.module.js` 引用（仅改 import 路径），其余未改动。

## 二、仅开发期使用（devDependencies，不随产物分发）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| esbuild | ^0.28.2 | MIT | 把 `src/*.js` 打包成单文件 `dist/app.js` |
| puppeteer-core | ^25.12.0 | Apache-2.0 | 无头 Chrome 截图 + 控制台错误检查（QA 自检） |

> `pnpm-lock.yaml` 中的传递依赖仅用于构建/测试，不进入运行产物；如再分发，请遵守各自许可（多为 MIT / Apache-2.0 / ISC）。

## 三、运行环境依赖（非本项目分发）

| 组件 | 说明 |
|---|---|
| Node.js（可选） | 运行打包脚本 `scripts/build.mjs`、动环网关 `tools/gateway/*`、本地服务 `scripts/start.mjs`；仅在本机使用，不随仓库分发 |
| 浏览器 Web API | Canvas 2D、WebGL2、WebSocket、Web Speech API、speechSynthesis —— W3C/WHATWG 标准，直接调用，无需授权 |
| Windows PowerShell | `start.bat` 兜底静态服务器（`scripts/serve.ps1`），系统自带 |

## 四、协议与标准的授权状态

| 协议 | 标准归属 | 实现授权 |
|---|---|---|
| Modbus（TCP/RTU） | Modbus Organization（公开规范） | 公开规范、可自由实现；TCP 端口 502 为业界约定 |
| SNMP v1/v2c | IETF RFC 1157 / 1901 / 3411 等 | 公开标准，可自由实现（本项目仅实现 v2c 明文 GET） |
| MQTT 3.1.1 | OASIS 标准（免版税） | 公开标准，可自由实现 |
| HTTP / WebSocket | IETF RFC 7230 / 6455 | 公开标准，可自由实现 |
| WebGL / Canvas 2D | Khronos / W3C | 浏览器 API，直接调用 |

结论：本项目**只按公开标准自行实现协议客户端**，未复制任何厂家的私有协议库、SDK 或驱动二进制，不涉及协议授权费用。

## 五、商标与型号声明

界面与文档中出现的 华为 / 维谛 / 施耐德 / 浪潮 / 深信服 / H3C / F5 / 双登 / ABB / 海湾 等名称与型号，
**仅作为演示数据中的示例设备型号引用**，用于说明兼容的协议类型，与上述厂商**无任何关联、合作或背书关系**。
如用于正式项目，请替换为实际设备信息并取得厂商授权。

## 六、未包含的第三方内容

- **参考视频素材未入库**：抖音原片与抽帧图（`ref/`）不随仓库分发，避免第三方版权问题；仅在本项目文档中做**描述性**还原说明并注明来源。
- **未分发任何字体文件**：界面仅通过 CSS 引用系统字体（Microsoft YaHei / PingFang SC / 等宽字体）。
- **未包含真实机房数据**：`src/pointtable.js` 的寄存器地址、SNMP OID、MQTT Topic、阈值均为**示例数据**（为演示便于对点而设计），并非任何厂家手册的摘录。