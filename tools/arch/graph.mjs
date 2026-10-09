/* =========================================================================
 *  tools/arch/graph.mjs — 项目结构图谱生成器（零依赖，静态分析真实代码）
 *  产出：
 *    docs/项目图谱.md    —— Mermaid 图谱（GitHub 可直接渲染）：架构/依赖/事件/数据流/页面矩阵/目录树
 *    docs/项目图谱.svg   —— 静态分层依赖图
 *    docs/项目图谱.html  —— 自包含交互图谱（可缩放/悬停高亮）
 *  用法：node tools/arch/graph.mjs
 * ========================================================================= */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP = new Set(["node_modules", ".git", "ref", "shots", "dist", "_backup", "_qa", ".vscode"]);
const SRC_EXT = new Set([".js", ".mjs", ".css", ".md", ".html", ".bat", ".ps1", ".json"]);

/* ---------------- 1. 扫描目录与文件 ---------------- */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith("_")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (SRC_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}
const files = walk(ROOT).map((f) => path.relative(ROOT, f).replace(/\\/g, "/")).sort();

/* ---------------- 2. 解析每个文件 ---------------- */
const mods = {};
for (const rel of files) {
  const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const lines = text.split("\n").length;
  const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])
    .concat([...text.matchAll(/import\s+["']([^"']+)["']/g)].map((m) => m[1]));
  const emits = [...text.matchAll(/(?:bus\.)?emit\(\s*["']([A-Za-z:_\-]+)["']/g)].map((m) => m[1]);
  const ons = [...text.matchAll(/(?:bus\.)?on\(\s*["']([A-Za-z:_\-]+)["']/g)].map((m) => m[1]);
  const idcUse = [...text.matchAll(/IDC\.([A-Za-z_]\w*)/g)].map((m) => m[1]);
  const idcDef = [...text.matchAll(/IDC\.([A-Za-z_]\w*)\s*=\s*(?!\{?\s*$)/g)].map((m) => m[1]);
  mods[rel] = { rel, lines, bytes: Buffer.byteLength(text), imports, emits: [...new Set(emits)], ons: [...new Set(ons)],
                idcUse: [...new Set(idcUse)], idcDef: [...new Set(idcDef)], dir: rel.split("/")[0] };
}

/* ---------------- 3. 分层（用于 SVG 布局） ---------------- */
const LAYERS = [
  { id: "shell", name: "外壳与入口", color: "#2f7fe8", items: ["index.html", "start.bat", "package.json", "src/base.css"] },
  { id: "core", name: "数据与总线", color: "#22c55e", items: ["src/data.js", "src/pointtable.js", "src/donghuan.js"] },
  { id: "lib", name: "库（图元/材质/组件）", color: "#7c6cf0", items: ["src/symbols.js", "src/textures.js", "src/props.js"] },
  { id: "view", name: "渲染与视图", color: "#22d3ee", items: ["src/scene3d.js", "src/hud.js", "src/floorplan.js"] },
  { id: "logic", name: "交互与编排", color: "#f5a524", items: ["src/app.js", "src/xiaowei.js"] },
  { id: "tools", name: "网关与工具链", color: "#8aa0bd", items: ["tools/gateway/server.mjs", "tools/gateway/alarms.mjs", "tools/gateway/ws.mjs",
      "tools/gateway/drivers/sim.mjs", "tools/gateway/drivers/modbus-tcp.mjs", "tools/gateway/drivers/snmp.mjs",
      "tools/gateway/drivers/mqtt.mjs", "tools/gateway/drivers/http-json.mjs", "tools/gateway/test.mjs",
      "scripts/start.mjs", "scripts/serve.ps1", "scripts/open-when-ready.ps1", "scripts/build.mjs", "scripts/shot.mjs", "scripts/allshots.mjs",
      "tools/arch/graph.mjs"] },
];
const known = new Set(LAYERS.flatMap((l) => l.items));
const extra = Object.keys(mods).filter((k) => !known.has(k));
if (extra.length) LAYERS.push({ id: "other", name: "文档与其它", color: "#5f7791", items: extra });

/* ---------------- 4. 解析 import 边（相对路径解析到实际文件） ---------------- */
function resolveImport(from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.posix.dirname(from);
  const p = path.posix.normalize(path.posix.join(base, spec));
  const cands = [p, p + ".js", p + ".mjs", p + "/index.js"];
  return cands.find((c) => fs.existsSync(path.join(ROOT, c))) || null;
}
const edges = [];
for (const [rel, m] of Object.entries(mods)) {
  for (const spec of m.imports) {
    const to = resolveImport(rel, spec);
    if (to && mods[to]) edges.push({ from: rel, to, kind: "import" });
    else edges.push({ from: rel, to: "外部:" + spec, kind: "ext" });
  }
}

/* ---------------- 5. 事件总线图谱 ---------------- */
const busNodes = {};
for (const [rel, m] of Object.entries(mods)) {
  m.emits.forEach((e) => { busNodes[e] = busNodes[e] || { evt: e, emit: [], on: [] }; busNodes[e].emit.push(rel); });
  m.ons.forEach((e) => { busNodes[e] = busNodes[e] || { evt: e, emit: [], on: [] }; busNodes[e].on.push(rel); });
}

/* ---------------- 6. 生成 SVG（分层布局 + 曲线边） ---------------- */
function layout() {
  const pos = {}, W = 1680, colW = W / (LAYERS.length + 0.6), padY = 66;
  LAYERS.forEach((L, ci) => {
    const x = 40 + ci * colW;
    L.items.forEach((id, ri) => { pos[id] = { x, y: 96 + ri * padY, w: colW - 60, h: 46, layer: L }; });
  });
  const H = Math.max(...LAYERS.map((L) => 96 + L.items.length * padY)) + 60;
  return { pos, W, H, colW };
}
const L = layout();
const short = (s) => s.replace(/^src\//, "").replace(/^tools\/gateway\//, "gw/").replace(/^tools\/arch\//, "").replace(/^scripts\//, "");
function nodeSvg(id) {
  const p = L.pos[id]; if (!p) return "";
  const c = p.layer.color;
  return `<g class="node" data-id="${id}">
    <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="7" fill="#0d1a29" stroke="${c}" stroke-width="1.4"/>
    <rect x="${p.x}" y="${p.y}" width="4" height="${p.h}" rx="2" fill="${c}"/>
    <text x="${p.x + 14}" y="${p.y + 20}" fill="#eaf9ff" font-size="13" font-family="Consolas,monospace">${short(id)}</text>
    <text x="${p.x + 14}" y="${p.y + 36}" fill="#7f9ab8" font-size="10">${(mods[id] ? mods[id].lines + " 行" : "")}${mods[id] && mods[id].idcDef.length ? " · 定义 " + mods[id].idcDef.join(",") : ""}</text>
  </g>`;
}
function edgeSvg(e) {
  const a = L.pos[e.from], b = L.pos[e.to]; if (!a || !b) return "";
  const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
  const mx = (x1 + x2) / 2;
  const col = e.kind === "import" ? "rgba(34,211,238,.42)" : "rgba(138,160,189,.25)";
  return `<path class="edge ${e.kind}" data-from="${e.from}" data-to="${e.to}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="${col}" stroke-width="1.2" marker-end="url(#ar)"/>`;
}
function legendSvg() {
  return LAYERS.map((l, i) => `<g><rect x="${40 + i * 178}" y="28" width="10" height="10" rx="2" fill="${l.color}"/><text x="${56 + i * 178}" y="37" fill="#9db6d4" font-size="11">${l.name}</text></g>`).join("");
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${L.W}" height="${L.H}" viewBox="0 0 ${L.W} ${L.H}" font-family="'Microsoft YaHei',sans-serif">
<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="rgba(34,211,238,.55)"/></marker></defs>
<rect width="100%" height="100%" fill="#05080f"/>
<text x="40" y="68" fill="#eaf9ff" font-size="17" letter-spacing="3">IDC 可视化运维项目 · 项目结构图谱</text>
<text x="${L.W - 40}" y="68" fill="#5f7791" font-size="11" text-anchor="end">由 tools/arch/graph.mjs 从源码静态分析生成</text>
${legendSvg()}
<g class="edges">${edges.map(edgeSvg).join("")}</g>
<g class="nodes">${LAYERS.flatMap((l) => l.items).map(nodeSvg).join("")}</g>
</svg>`;

/* ---------------- 7. 目录树 ---------------- */
function tree(dir, prefix = "", depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return [];
  const out = [];
  const ents = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .filter((e) => !SKIP.has(e.name) && !e.name.startsWith("_"))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  ents.forEach((e, i) => {
    const last = i === ents.length - 1;
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) {
      const n = fs.readdirSync(path.join(ROOT, rel)).filter((x) => !SKIP.has(x) && !x.startsWith("_")).length;
      out.push(prefix + (last ? "└── " : "├── ") + e.name + "/" + (depth < maxDepth ? "" : `  (${n} 项)`));
      if (depth < maxDepth) out.push(...tree(rel, prefix + (last ? "    " : "│   "), depth + 1, maxDepth));
    } else {
      const st = fs.statSync(path.join(ROOT, rel));
      out.push(prefix + (last ? "└── " : "├── ") + e.name + "  (" + Math.max(1, Math.round(st.size / 1024)) + " KB)");
    }
  });
  return out;
}
const treeLines = ["idc-visual-ops/", ...tree(".", "", 0, 3)];

/* ---------------- 8. Markdown 图谱 ---------------- */
const isVendor = (k) => k.startsWith("vendor/");
const srcMods = Object.entries(mods).filter(([k]) => !isVendor(k));
const totalLines = srcMods.reduce((s, [, m]) => s + m.lines, 0);
const vendorLines = Object.entries(mods).filter(([k]) => isVendor(k)).reduce((s, [, m]) => s + m.lines, 0);
function depsOf(id) { return edges.filter((e) => e.from === id && e.kind === "import").map((e) => e.to); }
const md = `# 项目结构图谱（自动生成）

> 由 \`tools/arch/graph.mjs\` 从源码静态分析生成，**请勿手工编辑**；改动代码后重新执行 \`node tools/arch/graph.mjs\` 即可刷新。
> 生成时间：${new Date().toLocaleString("zh-CN")} · 统计：**${srcMods.length} 个自研文件 / ${totalLines} 行** + 第三方 ${vendorLines} 行（不含 node_modules、ref、shots、dist）

## 1. 分层架构总览

\`\`\`mermaid
flowchart TB
  subgraph SHELL["外壳与入口"]
    IDX["index.html<br/>页签/顶栏/状态栏"]:::shell
    BAT["start.bat<br/>一键启动(静态服务+动环网关)"]:::shell
  end
  subgraph DATA["数据层"]
    DATAJS["data.js<br/>机柜/告警/工单/能耗 42 柜 256 设备"]:::data
    PT["pointtable.js<br/>动环点表 39 设备 260 测点"]:::data
    DH["donghuan.js<br/>动环接入+本地模拟+报警引擎+北向"]:::data
  end
  subgraph LIB["基础库"]
    SYM["symbols.js<br/>58 个机房图元"]:::lib
    TEX["textures.js<br/>程序化 PBR 贴图/材质"]:::lib
    PRP["props.js<br/>机房家具组件"]:::lib
  end
  subgraph VIEW["视图层"]
    SCENE["scene3d.js<br/>3D 数字孪生/动环点位/图形扩展"]:::view
    HUD["hud.js<br/>9 个页面 + Canvas 图表"]:::view
    PLAN["floorplan.js<br/>2D 机房图纸编辑器"]:::view
  end
  subgraph LOGIC["编排层"]
    APP["app.js<br/>路由/时钟/镜头/事件转发"]:::logic
    XW["xiaowei.js<br/>语音识别/播报/意图引擎"]:::logic
  end
  subgraph GW["南向网关(Node)"]
    SRV["server.mjs<br/>HTTP+WS+采集"]:::tool
    ALM["alarms.mjs<br/>报警规则引擎"]:::tool
    DRV["drivers/*<br/>sim/modbus/snmp/mqtt/http"]:::tool
  end
  IDX --> APP
  BAT --> SRV
  APP --> SCENE & HUD & PLAN & XW & DH
  HUD --> DATA & DH & SYM
  PLAN --> SYM & DATA & DH & SCENE
  SCENE --> TEX & PRP & DATA
  XW --> DH & PLAN & SCENE & HUD
  DH --> PT
  DRV --> PT
  SRV --> DRV & ALM
  DH -. "WebSocket /dh" .-> SRV
  classDef shell fill:#122840,stroke:#2f7fe8,color:#dce9ff
  classDef data fill:#0f2a1e,stroke:#22c55e,color:#dce9ff
  classDef lib fill:#1e1a33,stroke:#7c6cf0,color:#dce9ff
  classDef view fill:#0f2a33,stroke:#22d3ee,color:#dce9ff
  classDef logic fill:#33280f,stroke:#f5a524,color:#dce9ff
  classDef tool fill:#1a2230,stroke:#8aa0bd,color:#dce9ff
\`\`\`

## 2. 模块依赖图（源码 import 关系）

\`\`\`mermaid
flowchart LR
${Object.keys(mods).filter((k) => depsOf(k).length).map((k) =>
  `  ${JSON.stringify(short(k)).replace(/"/g, "").replace(/[./]/g, "_")}["${short(k)}"] --> ${depsOf(k).map((d) => JSON.stringify(short(d)).replace(/"/g, "").replace(/[./]/g, "_") + '["' + short(d) + '"]').join(" & ")}`
).join("\n")}
\`\`\`

## 3. 事件总线图谱（\`IDC.bus\`：\`emit → on\`，模块解耦的唯一通道）

\`\`\`mermaid
flowchart LR
${Object.values(busNodes).sort((a, b) => b.emit.length + b.on.length - a.emit.length - a.on.length).slice(0, 26).map((b) =>
  `  ${b.emit.map((e) => `"${short(e)}"`).join(" & ") || '"-"'} -->|${b.evt}| ${b.on.map((o) => `"${short(o)}"`).join(" & ") || '"-"'}`
).join("\n")}
\`\`\`

## 4. 数据流与接口链路

\`\`\`mermaid
flowchart LR
  DEV["动环设备<br/>UPS/空调/温湿度/浸水/烟感/配电"]:::hw -->|Modbus TCP·RTU / SNMP / MQTT / HTTP-JSON| GW["动环网关 tools/gateway<br/>采集·归一化·报警引擎"]:::gw
  GW -->|WebSocket /dh + HTTP /dh/*| DHM["src/donghuan.js<br/>点表·值·质量码·报警·北向报文"]:::sw
  SIM["sim 驱动（内置模拟器）"]:::gw --> GW
  DHM -->|bus: dh:data / dh:alarm| HUD2["动环监控页"]:::ui
  DHM --> SC3["3D 传感器点位/告警定位"]:::ui
  DHM --> XW2["语音播报"]:::ui
  DHM --> PLN["图纸图元状态/告警标红"]:::ui
  DHM -->|northbound()| UP["上级平台 /north/metrics|alarms|points|history"]:::hw
  classDef hw fill:#1a2230,stroke:#8aa0bd,color:#dce9ff
  classDef gw fill:#0f2a1e,stroke:#22c55e,color:#dce9ff
  classDef sw fill:#122840,stroke:#2f7fe8,color:#dce9ff
  classDef ui fill:#0f2a33,stroke:#22d3ee,color:#dce9ff
\`\`\`

## 5. 三个视图共用一份数据

\`\`\`mermaid
flowchart TB
  SRC["唯一数据源<br/>IDC.data.racks(42) · IDC.dh.devices(39) · IDC.symbols(58)"]:::src
  SRC --> V3D["3D 机房 scene3d.js<br/>数字孪生 / 机柜开合 / 动环点位 / 扩展物件"]:::v
  SRC --> V2D["2D 图纸 floorplan.js<br/>平面图 / 图元 / 标注 / 导出"]:::v
  SRC --> VHUD["数据大屏 hud.js<br/>总览/监控/资产/能效/告警/工单/动环"]:::v
  V2D -->|scene.setExtras 新增图元→3D| V3D
  V3D -->|plan:select 三维点选→图纸定位| V2D
  V3D -->|rack:select / device:select| VHUD
  VHUD -->|dh:select| V3D
  VHUD -->|dh:select| V2D
  classDef src fill:#33280f,stroke:#f5a524,color:#dce9ff
  classDef v fill:#0f2a33,stroke:#22d3ee,color:#dce9ff
\`\`\`

## 6. 页面 × 模块矩阵

| 页面 | key | 主要数据源 | 主要 3D 交互 |
|---|---|---|---|
| 总览 | overview | \`IDC.data.kpi/racks/alarms/energy\` | 机房等轴总览 + 告警光柱 |
| 机房监控 | monitor | \`IDC.data.racks\` + \`IDC.dh\` | 单柜特写 / 开门 / 处置态切换 |
| 资产管理 | assets | \`IDC.data.allDevices()\` | 三维定位机柜 |
| 能效管理 | energy | \`IDC.data.energy\` | — |
| 告警中心 | alarms | \`IDC.data.alarms\` | 告警机柜定位 + 光柱 |
| 运维工单 | workorder | \`IDC.data.workOrders\` | — |
| **动环监控** | donghuan | \`IDC.dh\`（260 测点） | 传感器点位 / 报警光圈光束 |
| **机房图纸** | plan | \`IDC.symbols\` + \`IDC.plan.model\` | 图纸图元 ↔ 3D 扩展/定位 |

## 7. 目录结构

\`\`\`
${treeLines.join("\n")}
\`\`\`

## 8. 源码体量

| 文件 | 行数 | 说明 |
|---|---|---|
${srcMods.filter(([, m]) => m.lines > 60).sort((a, b) => b[1].lines - a[1].lines)
  .map(([k, m]) => `| \`${k}\` | ${m.lines} | ${m.idcDef.length ? "定义 IDC." + m.idcDef.join(", ") : m.dir + (m.imports.length ? " · " + m.imports.filter((i) => i.startsWith(".")).length + " 个相对依赖" : "")} |`).join("\n")}
| **合计** | **${totalLines}** | ${srcMods.length} 个自研文件 + 第三方库 ${vendorLines} 行（vendor/three.module.js 等） |

## 9. 运行拓扑

\`\`\`mermaid
flowchart LR
  U["用户双击 start.bat"]:::u --> P1["静态服务 :8123<br/>start.mjs / serve.ps1 / python"]:::p
  U --> P2["动环网关 :8124<br/>tools/gateway/server.mjs --driver sim"]:::p
  B["浏览器 http://localhost:8123/?gw=1"]:::b --> P1
  B -.->|WebSocket ws://localhost:8124/dh| P2
  B --> S["3D 机房 + 数据大屏 + 动环页 + 机房图纸"]:::b
  classDef u fill:#33280f,stroke:#f5a524,color:#dce9ff
  classDef p fill:#122840,stroke:#2f7fe8,color:#dce9ff
  classDef b fill:#0f2a33,stroke:#22d3ee,color:#dce9ff
\`\`\`
`;
fs.writeFileSync(path.join(ROOT, "docs/项目图谱.md"), md);
fs.writeFileSync(path.join(ROOT, "docs/项目图谱.svg"), svg);

/* ---------------- 9. 交互 HTML（内嵌 SVG + 缩放/悬停高亮） ---------------- */
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>IDC 可视化运维项目 · 项目结构图谱</title>
<style>
 html,body{margin:0;height:100%;background:#05080f;color:#dce9ff;font-family:"Microsoft YaHei",sans-serif;overflow:hidden}
 #bar{height:44px;display:flex;align-items:center;gap:10px;padding:0 14px;border-bottom:1px solid rgba(64,180,255,.18);background:#0a1524}
 #bar b{letter-spacing:2px}.btn{background:rgba(34,211,238,.08);border:1px solid rgba(64,180,255,.25);color:#a9d8ef;border-radius:3px;padding:5px 10px;font-size:12px;cursor:pointer}
 .btn:hover{background:rgba(34,211,238,.2);color:#eaf9ff}
 #wrap{position:absolute;inset:44px 0 0 0;overflow:hidden;cursor:grab}
 #wrap.drag{cursor:grabbing}
 #stage{position:absolute;left:0;top:0;transform-origin:0 0}
 .node{cursor:pointer}
 .node rect{transition:filter .15s}
 .node:hover rect{filter:brightness(1.6)}
 .edge{opacity:.55}.edge.hl{opacity:1;stroke-width:2.4}
 #tip{position:absolute;right:12px;top:12px;max-width:300px;background:rgba(8,20,34,.94);border:1px solid rgba(64,180,255,.2);
      border-radius:3px;padding:10px 12px;font-size:11.5px;line-height:1.7;color:#9db6d4}
 #tip b{color:#eaf9ff}
</style></head><body>
<div id="bar"><b>项目结构图谱</b>
  <button class="btn" id="zin">放大</button><button class="btn" id="zout">缩小</button>
  <button class="btn" id="zfit">适应</button><button class="btn" id="z100">1:1</button>
  <span style="margin-left:auto;color:#5f7791;font-size:11px">节点=${Object.keys(mods).length} 文件 · 依赖边=${edges.filter((e) => e.kind === "import").length} · 事件=${Object.keys(busNodes).length} · 悬停节点高亮关联</span>
</div>
<div id="wrap"><div id="stage">${svg}</div></div>
<div id="tip"><b>用法</b><br>滚轮缩放 · 拖动平移 · 悬停节点高亮其依赖与被依赖<br>
<b>图例</b><br>青色曲线 = 源码 import · 灰虚线 = 外部依赖<br>
左侧色条为所属分层（见 README 架构章节）</div>
<script>
(function(){
  var stage=document.getElementById("stage"),wrap=document.getElementById("wrap");
  var s=1,tx=0,ty=0,drag=null;
  function apply(){stage.style.transform="translate("+tx+"px,"+ty+"px) scale("+s+")";}
  function zoom(f,cx,cy){var r=wrap.getBoundingClientRect();cx=cx==null?r.width/2:cx;cy=cy==null?r.height/2:cy;
    tx=cx-(cx-tx)*f;ty=cy-(cy-ty)*f;s=Math.max(.2,Math.min(3,s*f));apply();}
  wrap.addEventListener("wheel",function(e){e.preventDefault();var r=wrap.getBoundingClientRect();zoom(e.deltaY<0?1.12:1/1.12,e.clientX-r.left,e.clientY-r.top);},{passive:false});
  wrap.addEventListener("mousedown",function(e){drag={x:e.clientX-tx,y:e.clientY-ty};wrap.classList.add("drag");});
  addEventListener("mousemove",function(e){if(!drag)return;tx=e.clientX-drag.x;ty=e.clientY-drag.y;apply();});
  addEventListener("mouseup",function(){drag=null;wrap.classList.remove("drag");});
  document.getElementById("zin").onclick=function(){zoom(1.2);};
  document.getElementById("zout").onclick=function(){zoom(1/1.2);};
  document.getElementById("z100").onclick=function(){s=1;tx=0;ty=0;apply();};
  document.getElementById("zfit").onclick=function(){var r=wrap.getBoundingClientRect();var b=stage.querySelector("svg").getBoundingClientRect();
    var k=Math.min(r.width/(b.width/s),r.height/(b.height/s))*0.94;s=k;tx=(r.width-b.width/s*k)/2;ty=(r.height-b.height/s*k)/2;apply();};
  var nodes=wrap.querySelectorAll(".node"),edges=wrap.querySelectorAll(".edge");
  nodes.forEach(function(n){n.addEventListener("mouseenter",function(){
    var id=n.dataset.id;nodes.forEach(function(m){m.style.opacity=(m.dataset.id===id?"1":".45");});
    edges.forEach(function(ed){var on=ed.dataset.from===id||ed.dataset.to===id;ed.classList.toggle("hl",on);ed.style.opacity=on?"1":".15";});
  });n.addEventListener("mouseleave",function(){nodes.forEach(function(m){m.style.opacity="1";});
    edges.forEach(function(ed){ed.classList.remove("hl");ed.style.opacity="";});});});
  document.getElementById("zfit").click();
})();
</script></body></html>`;
fs.writeFileSync(path.join(ROOT, "docs/项目图谱.html"), html);
fs.writeFileSync(path.join(ROOT, "docs/项目图谱.html"), html);

/* ---------------- 10. 控制台摘要 ---------------- */
const byDir = {};
Object.values(mods).forEach((m) => { byDir[m.dir] = (byDir[m.dir] || 0) + 1; });
console.log("项目图谱已生成：");
console.log("  自研文件 " + srcMods.length + " · 自研行数 " + totalLines + " · 第三方行数 " + vendorLines + " · 目录 " + JSON.stringify(byDir));
console.log("  import 边 " + edges.filter((e) => e.kind === "import").length + " · 事件 " + Object.keys(busNodes).length);
console.log("  → docs/项目图谱.md（Mermaid，GitHub 可渲染）");
console.log("  → docs/项目图谱.svg（静态分层图 " + L.W + "×" + L.H + "）");
console.log("  → docs/项目图谱.html（交互式，滚轮缩放/悬停高亮）");