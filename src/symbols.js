/* SPDX-License-Identifier: AGPL-3.0-or-later
 * IDC 可视化运维项目（IDC Visual Ops）· Copyright (c) 2026 99kevindk
 * 本文件以 AGPL-3.0-or-later 开源；闭源商业集成 / SaaS 托管需另行取得商业授权（见 COMMERCIAL-LICENSE.md）。
 */
/* =============================================================================
 *  src/symbols.js — 机房图元库（2D 矢量符号库 + 可扩展注册机制）
 *  需求："机房图元元素，机房图形绘制，现有机房图形扩展"
 *  契约：docs/机房图纸与图元规范.md §1（冻结接口，签名不得改）
 *
 *  坐标/单位：mm；俯视图；+x 向右、+y 向下。
 *  调用约定：draw(ctx, it, env) 时 ctx 已【平移到图元中心】、【按 rot 旋转】、
 *            【按 scale 缩放】—— 图元只需以自身中心为原点绘制，
 *            不要在 draw 里再做整体 translate/rotate/scale。
 *
 *  对外 API：CATEGORIES / SYMBOLS / drawSymbol / listSymbols / iconCanvas /
 *            register / registerFromSvg / has
 *  同时 export 与 window.IDC.symbols 两种取用方式。
 * ========================================================================== */

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ 分类 */
export const CATEGORIES = [
  { id: "arch",   name: "建筑",     color: "#8aa0bd" },
  { id: "rack",   name: "机柜",     color: "#7fd8ff" },
  { id: "power",  name: "电力",     color: "#ffb443" },
  { id: "cool",   name: "制冷",     color: "#4fc3f7" },
  { id: "safety", name: "消防安防", color: "#ff6b6b" },
  { id: "env",    name: "环境监测", color: "#5ad18a" },
  { id: "cable",  name: "综合布线", color: "#b39ddb" },
  { id: "annot",  name: "标注",     color: "#c9d6e5" },
];

/* 图元定义表：{ [id]: SymbolDef } */
export const SYMBOLS = {};

const CAT_COLOR = {};
for (let i = 0; i < CATEGORIES.length; i++) CAT_COLOR[CATEGORIES[i].id] = CATEGORIES[i].color;

/* 分类默认配色 */
const C = {
  arch:   { fill: "#202b38", stroke: "#8aa0bd" },
  rack:   { fill: "#2b3138", stroke: "#7fd8ff" },
  power:  { fill: "#2e2a22", stroke: "#ffb443" },
  cool:   { fill: "#173040", stroke: "#4fc3f7" },
  safety: { fill: "#331f22", stroke: "#ff6b6b" },
  env:    { fill: "#16301f", stroke: "#5ad18a" },
  cable:  { fill: "#262a3a", stroke: "#b39ddb" },
  annot:  { fill: "#4a5568", stroke: "#c9d6e5" },
};

const STATUS_COLOR = { normal: "#42d392", alarm: "#ff5b5b", offline: "#8892a0", maintain: "#ffc44d" };

const EMPTY_ENV = {
  scale: 1, status: { state: "normal", level: "info", pulse: 0 }, value: null,
  label: true, selected: false, hover: false, locked: false, time: 0,
};
const ICON_ENV = {
  icon: true, scale: 1, status: { state: "normal", level: "info", pulse: 0 }, value: null,
  label: false, selected: false, hover: false, locked: false, time: 0,
};

/* 复用线型数组（避免每帧 new 数组） */
const DASH_NONE = [];
const DASH_SEL = [46, 30];
const DASH_HINT = [70, 45];
const DASH_DOT = [22, 26];

/* ------------------------------------------------------------ 基础工具 */
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lw(w, h, k) { return Math.max(10, Math.min(w, h) * (k || 0.035)); }
function rectP(ctx, x, y, w, h) { ctx.beginPath(); ctx.rect(x, y, w, h); }
function rrP(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}
function seg(ctx, x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
function dotP(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); }
function arcP(ctx, x, y, r, a0, a1) { ctx.beginPath(); ctx.arc(x, y, r, a0, a1); }
function boxPath(ctx, w, h) { rectP(ctx, -w / 2, -h / 2, w, h); }

/* 箭头（含实心箭头），使用当前 stroke/fill 色 */
function arrow(ctx, x1, y1, x2, y2, size) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const s = size || Math.max(40, Math.hypot(x2 - x1, y2 - y1) * 0.22);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - s * Math.cos(a - 0.4), y2 - s * Math.sin(a - 0.4));
  ctx.lineTo(x2 - s * Math.cos(a + 0.4), y2 - s * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fill();
}

/* 斜线填充（用于墙体 / 电缆沟 / 冷通道区域等） */
function hatch(ctx, x, y, w, h, step, deg, color, width, alpha) {
  const s = Math.max(step || 60, 24);
  const diag = Math.abs(w) + Math.abs(h) + s;
  const n = Math.ceil(diag / s) + 1;
  ctx.save();
  rectP(ctx, x, y, w, h);
  ctx.clip();
  ctx.globalAlpha = (alpha == null ? 1 : alpha);
  ctx.strokeStyle = color;
  ctx.lineWidth = width || Math.max(8, s * 0.14);
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate((deg || 45) * DEG);
  ctx.beginPath();
  for (let i = -n; i <= n; i++) { const p = i * s; ctx.moveTo(p, -diag); ctx.lineTo(p, diag); }
  ctx.stroke();
  ctx.restore();
}

/* 文字（带深色描边保证可读性）；size 单位 mm */
const FONT_CACHE = new Map();
function fontOf(size, weight) {
  const k = (weight || "") + "|" + size.toFixed(1);
  let f = FONT_CACHE.get(k);
  if (!f) { f = (weight ? weight + " " : "") + size.toFixed(1) + 'px "Microsoft YaHei","PingFang SC",Arial,sans-serif'; FONT_CACHE.set(k, f); }
  return f;
}
function text(ctx, s, x, y, size, color, align, baseline, weight) {
  if (!s && s !== 0) return;
  ctx.font = fontOf(size, weight);
  ctx.textAlign = align || "center";
  ctx.textBaseline = baseline || "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(size * 0.16, 8);
  ctx.strokeStyle = "rgba(3,9,16,0.78)";
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color || "#eaf4ff";
  ctx.fillText(s, x, y);
}

/* ==========================================================================
 *  统一装饰层
 *  编辑器 src/floorplan.js 既可能直接调用 def.draw(ctx,it,env)，
 *  也可能调用 drawSymbol(ctx,id,it,env)。两条路径都必须呈现一致的
 *  状态色 / 告警脉冲 / 悬停 / 锁定 / 选中 / 实时值，因此装饰逻辑放进
 *  def.draw 包装器，保证"恰好一次"。
 * ========================================================================== */
function wrapDraw(drawFn, dw, dh, cat, id, name, bind) {
  return function (ctx, it, env) {
    const e = env || EMPTY_ENV;
    const w = +it.w || dw || 600, h = +it.h || dh || 600;
    /* 图元面板缩略图：只画图形本体 */
    if (e.icon) {
      try { drawFn(ctx, it, e); } catch (err) { placeholder(ctx, id, w, h); }
      return;
    }
    const m = Math.min(w, h);
    const pad = Math.max(24, m * 0.10);
    const st = e.status || null;                       /* env.status 可能为 null */
    const state = (st && st.state) || "normal";
    const pulse = (st && st.level === "critical") ? clamp(+st.pulse || 0, 0, 1) : 0;
    const stateCol = STATUS_COLOR[state] || STATUS_COLOR.normal;
    const selected = !!e.selected, hover = !!e.hover, locked = !!(e.locked || it.locked);

    /* ① 告警红晕（critical 脉动；画在图形底下） */
    if (pulse > 0) {
      const grow = m * (0.25 + 0.90 * pulse);
      ctx.save();
      ctx.globalAlpha = 0.10 + 0.32 * pulse;
      ctx.fillStyle = "#ff3b3b";
      rrP(ctx, -w / 2 - pad - grow, -h / 2 - pad - grow, w + 2 * (pad + grow), h + 2 * (pad + grow), m * 0.12);
      ctx.fill();
      ctx.restore();
    }

    /* ② 图形本体 */
    try { drawFn(ctx, it, e); } catch (err) { placeholder(ctx, id, w, h); }

    /* ③ 悬停光晕 */
    if (hover && !selected) {
      ctx.save();
      ctx.globalAlpha = 0.40;
      ctx.strokeStyle = "#7fe3ff";
      ctx.lineWidth = Math.max(26, m * 0.055);
      rrP(ctx, -w / 2 - pad, -h / 2 - pad, w + 2 * pad, h + 2 * pad, m * 0.10);
      ctx.stroke();
      ctx.restore();
    }

    /* ④ 状态描边：normal 绿 / alarm 红 / offline 灰 / maintain 黄 */
    if (state !== "normal" || bind) {
      ctx.save();
      ctx.globalAlpha = (state === "normal") ? 0.62 : 0.95;
      ctx.strokeStyle = stateCol;
      ctx.lineWidth = Math.max(24, m * ((state === "normal") ? 0.038 : 0.056));
      if (state === "offline") ctx.setLineDash(DASH_SEL);
      rrP(ctx, -w / 2 - pad, -h / 2 - pad, w + 2 * pad, h + 2 * pad, m * 0.10);
      ctx.stroke();
      ctx.setLineDash(DASH_NONE);
      if (state !== "normal") {
        ctx.globalAlpha = 1;
        ctx.fillStyle = stateCol;
        dotP(ctx, w / 2 + pad, -h / 2 - pad, Math.max(26, m * 0.075));
        ctx.fill();
      }
      ctx.restore();
    }

    /* ⑤ 锁定（斜纹遮罩 + 锁形） */
    if (locked) {
      ctx.save();
      hatch(ctx, -w / 2, -h / 2, w, h, Math.max(90, m * 0.18), 45, "#c9d6e5", Math.max(10, m * 0.02), 0.22);
      ctx.restore();
      const gx = -w / 2 - pad - m * 0.05, gy = -h / 2 - pad - m * 0.02;
      const lwd = Math.max(14, m * 0.032);
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = "#d8e4f0";
      ctx.lineWidth = lwd;
      rectP(ctx, gx - m * 0.11, gy - m * 0.01, m * 0.22, m * 0.15); ctx.stroke();
      arcP(ctx, gx, gy - m * 0.01, m * 0.07, Math.PI, 0); ctx.stroke();
      ctx.restore();
    }

    /* ⑥ 选中（虚线框 + 四角控制点） */
    if (selected) {
      const sp = pad * 1.15;
      ctx.save();
      ctx.strokeStyle = "#35e0ff";
      ctx.lineWidth = Math.max(26, m * 0.035);
      ctx.setLineDash(DASH_SEL);
      rrP(ctx, -w / 2 - sp, -h / 2 - sp, w + 2 * sp, h + 2 * sp, m * 0.08);
      ctx.stroke();
      ctx.setLineDash(DASH_NONE);
      ctx.fillStyle = "#35e0ff";
      const hs = Math.max(30, m * 0.075), hh = hs / 2;
      const xs = [-w / 2 - sp, w / 2 + sp], ys = [-h / 2 - sp, h / 2 + sp];
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) ctx.fillRect(xs[i] - hh, ys[j] - hh, hs, hs);
      ctx.restore();
    }

    /* ⑦ 名称 + 实时值（值字号 = 0.8 × 名称字号） */
    if (e.label !== false && it.label !== false && cat !== "annot") {
      const base = clamp(m * 0.22, 32, 170);
      let ly = h / 2 + pad * 0.85 + base * 0.95;
      if (cat !== "rack") {                            /* 机柜已有内部名牌 */
        text(ctx, it.name || name || id, 0, ly, base, e.color || "#e8f2ff");
        ly += base * 1.20;
      }
      if (e.value != null && e.value !== "") {
        text(ctx, String(e.value), 0, ly, base * 0.8, stateCol, "center", "middle", "600");
      }
    }
  };
}

/* 图元绘制包装：把 it.w / it.h 展开为 w/h（draw 内不创建新对象） */
function shape(fn, cat, dw, dh) {
  return function (ctx, it, env) {
    fn(ctx, +it.w || dw, +it.h || dh, it, env || EMPTY_ENV);
  };
}

/* 注册一条内置图元（draw 统一包上装饰层） */
function def(o) {
  const d = {
    id: o.id, name: o.name, cat: o.cat, w: o.w, h: o.h,
    fill: o.fill || C[o.cat].fill, stroke: o.stroke || C[o.cat].stroke,
    bind: o.bind === undefined ? null : o.bind,
    anchor: o.anchor || { x: 0, y: 0 },
    ports: o.ports || [],
    params: o.params || [],
  };
  d._raw = o.draw;
  d.draw = wrapDraw(o.draw, d.w, d.h, d.cat, d.id, d.name, d.bind);
  SYMBOLS[d.id] = d;
  return d;
}
/* ==========================================================================
 *  建筑 arch
 * ========================================================================== */

/* 墙体（双线带厚度，可 45° 填充） */
function dWall(ctx, w, h, it, env) {
  const st = it.stroke || C.arch.stroke;
  const fl = it.fill || C.arch.fill;
  const t = clamp(h, 60, Math.max(80, w * 0.4));
  const lwd = Math.max(14, t * 0.16);
  rectP(ctx, -w / 2, -t / 2, w, t);
  ctx.fillStyle = fl; ctx.fill();
  if (!(it.params && it.params.hatch === "off")) {
    hatch(ctx, -w / 2, -t / 2, w, t, Math.max(90, t * 1.1), 45, st, lwd * 0.55, 0.42);
  }
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_NONE);
  rectP(ctx, -w / 2, -t / 2, w, t); ctx.stroke();
  /* 墙两端封口（区分成活墙段） */
  ctx.lineWidth = lwd * 0.7;
  seg(ctx, -w / 2, -t / 2, -w / 2, t / 2);
  seg(ctx, w / 2, -t / 2, w / 2, t / 2);
}

/* 玻璃隔断（细双线 + 玻璃斜纹） */
function dGlass(ctx, w, h, it, env) {
  const st = it.stroke || "#9fd8ff";
  const t = clamp(h, 40, 90);
  const lwd = Math.max(10, t * 0.22);
  ctx.globalAlpha = 0.5;
  rectP(ctx, -w / 2, -t / 2, w, t);
  ctx.fillStyle = "#123044"; ctx.fill();
  ctx.globalAlpha = 1;
  hatch(ctx, -w / 2, -t / 2, w, t, Math.max(70, t * 1.3), 55, st, lwd * 0.6, 0.4);
  ctx.strokeStyle = st; ctx.lineWidth = lwd;
  seg(ctx, -w / 2, -t / 2, w / 2, -t / 2);
  seg(ctx, -w / 2, t / 2, w / 2, t / 2);
  /* 立柱分格 */
  ctx.lineWidth = lwd * 0.8;
  const n = Math.max(2, Math.round(w / 1200));
  for (let i = 1; i < n; i++) {
    const x = -w / 2 + w * i / n;
    seg(ctx, x, -t / 2, x, t / 2);
  }
}

/* 门（通用绘制）；mx=1 左铰链，-1 右铰链 */
function doorLeaf(ctx, mx, w, h, t, lwd, st, fl) {
  const hy = h / 2;
  const hx = -mx * w / 2;
  /* 门垛 */
  ctx.strokeStyle = st; ctx.lineWidth = lwd;
  seg(ctx, -w / 2, hy, -w / 2, hy - t * 2.2);
  seg(ctx, w / 2, hy, w / 2, hy - t * 2.2);
  /* 门板（开启 90°） */
  rectP(ctx, mx > 0 ? hx : hx - t, hy - w, t, w);
  ctx.fillStyle = fl; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd * 0.85; ctx.stroke();
  /* 开启弧线 */
  if (mx > 0) { arcP(ctx, hx, hy, w, -Math.PI / 2, 0); }
  else { arcP(ctx, hx, hy, w, Math.PI * 1.5, Math.PI); }
  ctx.setLineDash(DASH_HINT); ctx.lineWidth = lwd * 0.7; ctx.stroke(); ctx.setLineDash(DASH_NONE);
}

function dDoorSingle(ctx, w, h, it, env) {
  const st = it.stroke || C.arch.stroke;
  const fl = it.fill || C.arch.fill;
  const t = Math.max(50, w * 0.06);
  const lwd = Math.max(12, w * 0.028);
  const mx = (it.params && it.params.swing === "R") ? -1 : 1;
  doorLeaf(ctx, mx, w, h, t, lwd, st, fl);
  if (env.label !== false && it.label !== false) {
  }
}

function dDoorDouble(ctx, w, h, it, env) {
  const st = it.stroke || C.arch.stroke;
  const fl = it.fill || C.arch.fill;
  const t = Math.max(50, w * 0.045);
  const lwd = Math.max(12, w * 0.024);
  const hw = w / 2;
  /* 左扇 */
  ctx.strokeStyle = st; ctx.lineWidth = lwd;
  seg(ctx, -w / 2, h / 2, -w / 2, h / 2 - t * 2.2);
  seg(ctx, 0, h / 2, 0, h / 2 - t * 2.2);
  seg(ctx, w / 2, h / 2, w / 2, h / 2 - t * 2.2);
  rectP(ctx, -hw, h / 2 - hw, t, hw);
  ctx.fillStyle = fl; ctx.fill(); ctx.stroke();
  rectP(ctx, hw - t, h / 2 - hw, t, hw);
  ctx.fillStyle = fl; ctx.fill(); ctx.stroke();
  ctx.setLineDash(DASH_HINT); ctx.lineWidth = lwd * 0.7;
  arcP(ctx, -hw, h / 2, hw, -Math.PI / 2, 0); ctx.stroke();
  arcP(ctx, hw, h / 2, hw, Math.PI, Math.PI * 1.5); ctx.stroke();
  ctx.setLineDash(DASH_NONE);
  if (env.label !== false && it.label !== false) {
  }
}

/* 结构柱（实心方块 + 斜纹） */
function dColumn(ctx, w, h, it, env) {
  const st = it.stroke || C.arch.stroke;
  const fl = it.fill || "#3b4b60";
  rectP(ctx, -w / 2, -h / 2, w, h);
  ctx.fillStyle = fl; ctx.fill();
  hatch(ctx, -w / 2, -h / 2, w, h, Math.max(80, Math.min(w, h) * 0.3), 45, st, Math.max(8, Math.min(w, h) * 0.05), 0.5);
  ctx.strokeStyle = st; ctx.lineWidth = Math.max(16, Math.min(w, h) * 0.06);
  rectP(ctx, -w / 2, -h / 2, w, h); ctx.stroke();
  seg(ctx, -w / 2, -h / 2, w / 2, h / 2);
  seg(ctx, w / 2, -h / 2, -w / 2, h / 2);
}

/* 楼梯（踏步 + 上行方向） */
function dStair(ctx, w, h, it, env) {
  const st = it.stroke || C.arch.stroke;
  const lwd = Math.max(14, Math.min(w, h) * 0.035);
  rectP(ctx, -w / 2, -h / 2, w, h);
  ctx.fillStyle = it.fill || C.arch.fill; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  ctx.lineWidth = lwd * 0.55; ctx.globalAlpha = 0.8;
  const n = Math.max(6, Math.round(h / 280));
  for (let i = 1; i < n; i++) { const y = -h / 2 + h * i / n; seg(ctx, -w / 2, y, w / 2, y); }
  ctx.globalAlpha = 1;
  /* 上行箭头 */
  ctx.strokeStyle = st; ctx.fillStyle = st; ctx.lineWidth = lwd * 0.8;
  arrow(ctx, 0, h * 0.36, 0, -h * 0.30, Math.min(w, h) * 0.14);
}

/* 吊顶开孔 / 预留洞（虚线方框 + 对角线） */
function dCeilingHole(ctx, w, h, it, env) {
  const st = it.stroke || "#9ad0ff";
  const lwd = Math.max(12, Math.min(w, h) * 0.045);
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_HINT);
  rectP(ctx, -w / 2, -h / 2, w, h); ctx.stroke();
  ctx.setLineDash(DASH_NONE);
  hatch(ctx, -w / 2, -h / 2, w, h, Math.max(120, Math.min(w, h) * 0.35), 45, st, Math.max(8, Math.min(w, h) * 0.04), 0.35);
  ctx.lineWidth = lwd * 0.7;
  seg(ctx, -w / 2, -h / 2, w / 2, h / 2);
  seg(ctx, -w / 2, h / 2, w / 2, -h / 2);
  if (env.label !== false && it.label !== false) {
  }
}

/* 网格基准（轴线网） */
function dGrid(ctx, w, h, it, env) {
  const st = it.stroke || "#7c8fa6";
  const lwd = Math.max(10, Math.min(w, h) * 0.006);
  const step = clamp(Math.min(w, h) / 6, 500, 2000);
  ctx.strokeStyle = st; ctx.globalAlpha = 0.5; ctx.lineWidth = lwd;
  const nx = Math.floor(w / step), ny = Math.floor(h / step);
  for (let i = -nx; i <= nx; i++) seg(ctx, i * step, -h / 2, i * step, h / 2);
  for (let j = -ny; j <= ny; j++) seg(ctx, -w / 2, j * step, w / 2, j * step);
  ctx.globalAlpha = 1;
  /* 轴线圆标 */
  ctx.lineWidth = Math.max(12, lwd * 2.4);
  arcP(ctx, 0, 0, Math.min(w, h) * 0.11, 0, TAU); ctx.stroke();
  seg(ctx, -Math.min(w, h) * 0.16, 0, Math.min(w, h) * 0.16, 0);
  seg(ctx, 0, -Math.min(w, h) * 0.16, 0, Math.min(w, h) * 0.16);
  if (env.label !== false && it.label !== false) {
  }
}

/* ==========================================================================
 *  机柜 rack
 * ========================================================================== */

const RACK_OPT = { u: 9, name: "机柜", rails: true };

/* 机柜通用：外框 + 内框 + 19"导轨 + U 位刻度 + 前门(开门方向) + 顶部线缆口 + 名牌 */
function rackDraw(ctx, w, h, it, env, opt) {
  const o = opt || RACK_OPT;
  const st = it.stroke || C.rack.stroke;
  const fl = it.fill || C.rack.fill;
  const m = Math.min(w, h);
  const L = Math.max(w, h);
  const vertical = h >= w;
  const lwd = Math.max(14, m * 0.032);
  const side = (it.params && it.params.door) || "S";
  const inset = m * 0.07;
  const band = m * 0.17;

  /* 柜体 */
  boxPath(ctx, w, h);
  ctx.fillStyle = fl; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_NONE); ctx.stroke();

  /* 内框 */
  ctx.globalAlpha = 0.4; ctx.lineWidth = lwd * 0.5;
  rectP(ctx, -w / 2 + inset, -h / 2 + inset, w - 2 * inset, h - 2 * inset); ctx.stroke();
  ctx.globalAlpha = 1;

  /* 19" 安装导轨（482mm 标准） */
  const railOff = Math.min(m * 0.40, 241);
  if (o.rails !== false) {
    ctx.lineWidth = lwd * 0.6; ctx.globalAlpha = 0.8;
    if (vertical) { seg(ctx, -railOff, -L * 0.40, -railOff, L * 0.40); seg(ctx, railOff, -L * 0.40, railOff, L * 0.40); }
    else { seg(ctx, -L * 0.40, -railOff, L * 0.40, -railOff); seg(ctx, -L * 0.40, railOff, L * 0.40, railOff); }
    ctx.globalAlpha = 1;
  }

  /* U 位刻度（>=8 条） */
  const n = Math.max(6, o.u || 9), span = L * 0.82;
  ctx.globalAlpha = 0.5; ctx.lineWidth = Math.max(8, lwd * 0.4);
  for (let i = 0; i < n; i++) {
    const p = -span / 2 + span * i / (n - 1);
    if (vertical) seg(ctx, -m * 0.33, p, m * 0.33, p);
    else seg(ctx, p, -m * 0.33, p, m * 0.33);
  }
  ctx.globalAlpha = 1;

  /* 前门（内嵌门带 + 门缝线） */
  let hx = 0, hy = 0;
  ctx.fillStyle = "#1a2027";
  if (side === "S") { ctx.fillRect(-w / 2 + inset, h / 2 - inset - band, w - 2 * inset, band); hy = h / 2 - inset - band / 2; }
  else if (side === "N") { ctx.fillRect(-w / 2 + inset, -h / 2 + inset, w - 2 * inset, band); hy = -h / 2 + inset + band / 2; }
  else if (side === "W") { ctx.fillRect(-w / 2 + inset, -h / 2 + inset, band, h - 2 * inset); hx = -w / 2 + inset + band / 2; }
  else { ctx.fillRect(w / 2 - inset - band, -h / 2 + inset, band, h - 2 * inset); hx = w / 2 - inset - band / 2; }
  ctx.strokeStyle = st; ctx.lineWidth = lwd * 0.7; ctx.globalAlpha = 0.9;
  if (side === "S") rectP(ctx, -w / 2 + inset, h / 2 - inset - band, w - 2 * inset, band);
  else if (side === "N") rectP(ctx, -w / 2 + inset, -h / 2 + inset, w - 2 * inset, band);
  else if (side === "W") rectP(ctx, -w / 2 + inset, -h / 2 + inset, band, h - 2 * inset);
  else rectP(ctx, w / 2 - inset - band, -h / 2 + inset, band, h - 2 * inset);
  ctx.stroke(); ctx.globalAlpha = 1;
  /* 门把手 */
  ctx.fillStyle = st;
  dotP(ctx, hx, hy, Math.max(14, m * 0.03)); ctx.fill();

  /* 顶部线缆口（门对侧） */
  const rearTop = (side !== "N");
  ctx.fillStyle = "#0b1219"; ctx.strokeStyle = st; ctx.lineWidth = lwd * 0.6;
  if (vertical) {
    const py = rearTop ? (-h / 2 + m * 0.10) : (h / 2 - m * 0.10 - m * 0.08);
    rectP(ctx, -m * 0.20, py, m * 0.40, m * 0.08); ctx.fill(); ctx.stroke();
    ctx.lineWidth = lwd * 0.4;
    seg(ctx, -m * 0.20, py + m * 0.04, m * 0.20, py + m * 0.04);
  } else {
    const px = rearTop ? (-w / 2 + m * 0.10) : (w / 2 - m * 0.10 - m * 0.08);
    rectP(ctx, px, -m * 0.20, m * 0.08, m * 0.40); ctx.fill(); ctx.stroke();
    ctx.lineWidth = lwd * 0.4;
    seg(ctx, px + m * 0.04, -m * 0.20, px + m * 0.04, m * 0.20);
  }

  /* 名牌 */
  if (env.label !== false && it.label !== false) {
    const fs = clamp(m * 0.19, 90, 200);
    text(ctx, (it.params && it.params.u) || (o.uLabel || "42U"), 0, h / 2 - inset * 1.5, fs * 0.62, "#7fd8ff");
  }
}

/* 列头柜 / 网络柜 / 存储柜 / 42U：靠参数微调内部结构 */
function dRack(ctx, w, h, it, env, kind) {
  rackDraw(ctx, w, h, it, env, RACK_OPT);
  const st = it.stroke || C.rack.stroke;
  const m = Math.min(w, h);
  const vertical = h >= w;
  const L = Math.max(w, h);
  ctx.strokeStyle = st; ctx.lineWidth = Math.max(12, m * 0.028); ctx.globalAlpha = 0.85;
  if (kind === "network") {
    /* 网络柜：中间一列配线模块块 */
    const bw = m * 0.34, n = 7;
    for (let i = 0; i < n; i++) {
      const p = -L * 0.36 + L * 0.72 * i / (n - 1);
      ctx.globalAlpha = 0.55;
      if (vertical) { rectP(ctx, -bw / 2, p - m * 0.02, bw, m * 0.045); ctx.fillStyle = st; ctx.fill(); }
      else { rectP(ctx, p - m * 0.02, -bw / 2, m * 0.045, bw); ctx.fillStyle = st; ctx.fill(); }
    }
  } else if (kind === "storage") {
    /* 存储柜：2 列盘位块 */
    const bw = m * 0.16, cols = [-m * 0.20, m * 0.20], n = 6;
    ctx.fillStyle = st;
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < n; i++) {
        const p = -L * 0.34 + L * 0.68 * i / (n - 1);
        ctx.globalAlpha = 0.45;
        if (vertical) rectP(ctx, cols[c] - bw / 2, p - m * 0.022, bw, m * 0.05);
        else rectP(ctx, p - m * 0.022, cols[c] - bw / 2, m * 0.05, bw);
        ctx.fill();
      }
    }
  } else if (kind === "column") {
    /* 列头柜：上下两段母线 + 计量表 */
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#0b1219";
    ctx.fillRect(-m * 0.28, -m * 0.30, m * 0.56, m * 0.24);
    ctx.globalAlpha = 0.9; ctx.lineWidth = Math.max(10, m * 0.02);
    rectP(ctx, -m * 0.28, -m * 0.30, m * 0.56, m * 0.24); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-m * 0.28, -m * 0.24); ctx.lineTo(-m * 0.28 + m * 0.56 * 0.62, -m * 0.24);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/* 空位机柜（虚线占位） */
function dRackEmpty(ctx, w, h, it, env) {
  const st = it.stroke || "#6d7f94";
  const m = Math.min(w, h);
  const lwd = Math.max(14, m * 0.032);
  ctx.globalAlpha = 0.25;
  boxPath(ctx, w, h);
  ctx.fillStyle = it.fill || C.rack.fill; ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_HINT);
  boxPath(ctx, w, h); ctx.stroke();
  ctx.setLineDash(DASH_NONE);
  ctx.lineWidth = lwd * 0.8;
  seg(ctx, -w / 2, -h / 2, w / 2, h / 2);
  seg(ctx, -w / 2, h / 2, w / 2, -h / 2);
  if (env.label !== false && it.label !== false) {
  }
}

/* 双排机柜组（成排，带"排"标注与冷通道） */
function dRackRow(ctx, w, h, it, env) {
  const st = it.stroke || C.rack.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(14, m * 0.018);
  const unitW = w / 4;
  const rowD = h * 0.28;
  /* 冷通道 */
  const gapY0 = -h / 2 + rowD, gapY1 = h / 2 - rowD;
  ctx.globalAlpha = 0.35;
  rectP(ctx, -w / 2, gapY0, w, gapY1 - gapY0);
  ctx.fillStyle = "#1c4a66"; ctx.fill();
  ctx.globalAlpha = 1;
  hatch(ctx, -w / 2, gapY0, w, gapY1 - gapY0, m * 0.10, 45, "#4fc3f7", Math.max(8, m * 0.012), 0.4);
  /* 两排机柜 */
  for (let r = 0; r < 2; r++) {
    const y0 = (r === 0) ? (-h / 2) : (h / 2 - rowD);
    for (let i = 0; i < 4; i++) {
      const x0 = -w / 2 + i * unitW;
      rectP(ctx, x0 + lwd, y0 + lwd, unitW - lwd * 2, rowD - lwd * 2);
      ctx.fillStyle = C.rack.fill; ctx.fill();
      ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
      ctx.globalAlpha = 0.55; ctx.lineWidth = lwd * 0.5;
      const n = 5;
      for (let k = 0; k < n; k++) { const p = y0 + rowD * (k + 1) / (n + 1); seg(ctx, x0 + unitW * 0.22, p, x0 + unitW * 0.78, p); }
      ctx.globalAlpha = 1;
    }
    /* 排标注 */
    text(ctx, (r === 0 ? "A" : "B") + " 排", -w / 2 + unitW * 0.5, y0 + rowD / 2, clamp(m * 0.075, 80, 200), "#e2f2ff");
  }
  /* 尺寸/冷通道标注 */
  text(ctx, "冷通道 " + Math.round(gapY1 - gapY0) + "mm", 0, (gapY0 + gapY1) / 2, clamp(m * 0.075, 80, 200), "#9fd8ff");
}

/* ------------------------------------------------------------- 注册：建筑 */
def({ id: "arch.wall",        name: "墙体",       cat: "arch", w: 4000, h: 200,
  params: [{ key: "hatch", name: "填充", type: "enum", options: ["on", "off"], def: "on" }],
  ports: [{ x: -2000, y: 0, dir: 180, name: "墙端" }, { x: 2000, y: 0, dir: 0, name: "墙端" }],
  draw: shape(dWall, "arch", 4000, 200) });
def({ id: "arch.glass",       name: "玻璃隔断",   cat: "arch", w: 3000, h: 80, fill: "#123044", stroke: "#9fd8ff",
  bind: null, draw: shape(dGlass, "arch", 3000, 80) });
def({ id: "arch.door.single", name: "单开门",     cat: "arch", w: 900,  h: 900, fill: "#2a3442",
  params: [{ key: "swing", name: "开门方向", type: "enum", options: ["L", "R"], def: "L" }],
  draw: shape(dDoorSingle, "arch", 900, 900) });
def({ id: "arch.door.double", name: "双开门",     cat: "arch", w: 1500, h: 900, fill: "#2a3442",
  params: [{ key: "swing", name: "开启方式", type: "enum", options: ["对开"], def: "对开" }],
  draw: shape(dDoorDouble, "arch", 1500, 900) });
def({ id: "arch.column",      name: "结构柱",     cat: "arch", w: 600,  h: 600, fill: "#3b4b60",
  draw: shape(dColumn, "arch", 600, 600) });
def({ id: "arch.stair",       name: "楼梯",       cat: "arch", w: 1200, h: 3000,
  draw: shape(dStair, "arch", 1200, 3000) });
def({ id: "arch.ceiling.hole", name: "吊顶开孔",  cat: "arch", w: 600,  h: 600, fill: "transparent",
  draw: shape(dCeilingHole, "arch", 600, 600) });
def({ id: "arch.grid",        name: "网格基准",   cat: "arch", w: 6000, h: 6000, fill: "transparent", stroke: "#7c8fa6",
  draw: shape(dGrid, "arch", 6000, 6000) });
/* 地面标高（▽ + 标高值） */
function dLevel(ctx, w, h, it, env) {
  const st = it.stroke || C.arch.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(12, m * 0.03);
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_NONE);
  seg(ctx, -w * 0.40, 0, w * 0.40, 0);
  ctx.beginPath();
  ctx.moveTo(-m * 0.17, 0); ctx.lineTo(m * 0.17, 0); ctx.lineTo(0, m * 0.30); ctx.closePath();
  ctx.fillStyle = "#2a3a4d"; ctx.fill();
  ctx.stroke();
  const val = (it.params && it.params.z) || "+3.600";
  text(ctx, val, 0, -m * 0.30, clamp(m * 0.30, 70, 300), "#dbe8f7");
}
def({ id: "arch.level", name: "地面标高", cat: "arch", w: 800, h: 600, fill: "transparent",
  params: [{ key: "z", name: "标高值", type: "text", def: "+3.600" }],
  draw: shape(dLevel, "arch", 800, 600) });

/* ------------------------------------------------------------- 注册：机柜 */
def({ id: "rack.42u",     name: "42U服务器机柜", cat: "rack", w: 600, h: 1200, bind: "rack",
  params: [{ key: "door", name: "开门方向", type: "enum", options: ["N", "S", "E", "W"], def: "S" },
           { key: "u", name: "U 数", type: "number", def: 42 }],
  ports: [{ x: 0, y: -600, dir: -90, name: "后部线缆" }, { x: 0, y: 600, dir: 90, name: "前门" }],
  draw: shape(function (ctx, w, h, it, env) { dRack(ctx, w, h, it, env, "42u"); }, "rack", 600, 1200) });
def({ id: "rack.network", name: "网络机柜",     cat: "rack", w: 600, h: 1000, bind: "rack",
  params: [{ key: "door", name: "开门方向", type: "enum", options: ["N", "S", "E", "W"], def: "S" }],
  draw: shape(function (ctx, w, h, it, env) { dRack(ctx, w, h, it, env, "network"); }, "rack", 600, 1000) });
def({ id: "rack.storage", name: "存储机柜",     cat: "rack", w: 600, h: 1200, bind: "rack",
  params: [{ key: "door", name: "开门方向", type: "enum", options: ["N", "S", "E", "W"], def: "S" }],
  draw: shape(function (ctx, w, h, it, env) { dRack(ctx, w, h, it, env, "storage"); }, "rack", 600, 1200) });
def({ id: "rack.column",  name: "列头柜",       cat: "rack", w: 600, h: 1200, bind: "rack",
  params: [{ key: "door", name: "开门方向", type: "enum", options: ["N", "S", "E", "W"], def: "S" }],
  draw: shape(function (ctx, w, h, it, env) { dRack(ctx, w, h, it, env, "column"); }, "rack", 600, 1200) });
def({ id: "rack.empty",   name: "空位机柜",     cat: "rack", w: 600, h: 1200, fill: "#1d242b", stroke: "#6d7f94",
  draw: shape(dRackEmpty, "rack", 600, 1200) });
def({ id: "rack.row",     name: "双排机柜组",   cat: "rack", w: 2400, h: 2400, bind: "rack",
  params: [{ key: "rows", name: "排数", type: "number", def: 2 }],
  draw: shape(dRackRow, "rack", 2400, 2400) });
/* ==========================================================================
 *  电力 power
 * ========================================================================== */

/* 电力/机柜通用柜体：外框 + 内框 + 显示屏 + 指示灯 */
function cabinetShell(ctx, w, h, it, pal, label) {
  const st = it.stroke || pal.stroke;
  const fl = it.fill || pal.fill;
  const m = Math.min(w, h);
  const lwd = Math.max(14, m * 0.035);
  boxPath(ctx, w, h);
  ctx.fillStyle = fl; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_NONE); ctx.stroke();
  const i = m * 0.07;
  ctx.globalAlpha = 0.4; ctx.lineWidth = lwd * 0.5;
  rectP(ctx, -w / 2 + i, -h / 2 + i, w - 2 * i, h - 2 * i); ctx.stroke();
  ctx.globalAlpha = 1;
  /* 显示屏 */
  const dw = w * 0.34, dh = Math.max(h * 0.09, m * 0.10);
  const dy = -h / 2 + i * 1.7;
  ctx.fillStyle = "#07161f";
  rectP(ctx, -dw / 2, dy, dw, dh); ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd * 0.5; ctx.stroke();
  ctx.strokeStyle = "#4fe3c1"; ctx.lineWidth = Math.max(8, lwd * 0.3); ctx.globalAlpha = 0.85;
  seg(ctx, -dw * 0.30, dy + dh * 0.34, dw * 0.30, dy + dh * 0.34);
  seg(ctx, -dw * 0.30, dy + dh * 0.68, dw * 0.06, dy + dh * 0.68);
  ctx.globalAlpha = 1;
  /* 指示灯 */
  const ly = dy + dh + m * 0.08, lr = Math.max(14, m * 0.035);
  ctx.fillStyle = "#42d392"; dotP(ctx, -w * 0.15, ly, lr); ctx.fill();
  ctx.fillStyle = "#ffc44d"; dotP(ctx, 0, ly, lr); ctx.fill();
  ctx.fillStyle = "#ff5b5b"; dotP(ctx, w * 0.15, ly, lr); ctx.fill();
  /* 名牌 */
  if (it && it.label !== false) {
  }
  return { st: st, m: m, lwd: lwd, i: i, top: dy + dh + m * 0.08 + lr };
}

/* UPS 柜 */
function dUps(ctx, w, h, it, env) {
  const g = cabinetShell(ctx, w, h, it, C.power, "UPS");
  const st = g.st, m = g.m;
  const y0 = h * 0.02, y1 = h / 2 - m * 0.13;
  ctx.strokeStyle = st; ctx.lineWidth = Math.max(12, m * 0.03); ctx.globalAlpha = 0.85;
  seg(ctx, 0, y0, 0, y1);
  seg(ctx, -w * 0.30, (y0 + y1) / 2, w * 0.30, (y0 + y1) / 2);
  ctx.globalAlpha = 1;
  /* 整流/逆变 模块块 */
  ctx.globalAlpha = 0.5; ctx.fillStyle = st;
  ctx.fillRect(-w * 0.26, y0 + m * 0.05, w * 0.22, m * 0.16);
  ctx.fillRect(w * 0.04, y0 + m * 0.05, w * 0.22, m * 0.16);
  ctx.globalAlpha = 1;
  /* 旁路（虚线） */
  ctx.setLineDash(DASH_DOT); ctx.lineWidth = Math.max(10, m * 0.024);
  seg(ctx, -w * 0.38, y0 - m * 0.10, w * 0.38, y0 - m * 0.10);
  ctx.setLineDash(DASH_NONE);
  /* 输出箭头 */
  ctx.strokeStyle = st; ctx.fillStyle = st; ctx.lineWidth = Math.max(14, m * 0.032);
  arrow(ctx, 0, y1 - m * 0.02, 0, h / 2 - m * 0.03, m * 0.11);
}

/* 低压配电柜 */
function dLvdp(ctx, w, h, it, env) {
  const g = cabinetShell(ctx, w, h, it, C.power, "配电柜");
  const st = g.st, m = g.m;
  const y0 = h * 0.05, y1 = h / 2 - m * 0.10;
  const rows = 4, cols = 2;
  ctx.strokeStyle = st; ctx.lineWidth = Math.max(10, m * 0.022); ctx.globalAlpha = 0.9;
  const cw = w * 0.30, ch = (y1 - y0) / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c === 0 ? -w * 0.19 : w * 0.19) - cw / 2;
      const y = y0 + r * ch + ch * 0.16;
      rectP(ctx, x, y, cw, ch * 0.62); ctx.stroke();
      ctx.globalAlpha = 0.6;
      seg(ctx, x + cw * 0.2, y + ch * 0.31, x + cw * 0.8, y + ch * 0.31);
      ctx.globalAlpha = 0.9;
      dotP(ctx, x + cw * 0.5, y + ch * 0.12, m * 0.016); ctx.fillStyle = st; ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/* 电池柜 */
function dBattery(ctx, w, h, it, env) {
  const g = cabinetShell(ctx, w, h, it, C.power, "电池柜");
  const st = g.st, m = g.m;
  const cols = 4, rows = 2;
  const y0 = h * 0.04, y1 = h / 2 - m * 0.10;
  const gw = w * 0.80, gh = y1 - y0;
  const cw = gw / cols, ch = gh / rows;
  ctx.strokeStyle = st; ctx.lineWidth = Math.max(9, m * 0.02); ctx.globalAlpha = 0.95;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = -gw / 2 + c * cw, y = y0 + r * ch;
      rectP(ctx, x + cw * 0.10, y + ch * 0.12, cw * 0.80, ch * 0.76);
      ctx.stroke();
      ctx.globalAlpha = 0.55; ctx.fillStyle = st;
      ctx.fillRect(x + cw * 0.10, y + ch * 0.12, cw * 0.80, ch * 0.20);
      ctx.globalAlpha = 0.95;
    }
  }
  /* 正负极母线 */
  ctx.globalAlpha = 0.8; ctx.lineWidth = Math.max(12, m * 0.026);
  seg(ctx, -gw / 2, y0 - m * 0.03, gw / 2, y0 - m * 0.03);
  seg(ctx, -gw / 2, y1 + m * 0.05, gw / 2, y1 + m * 0.05);
  text(ctx, "+", -gw / 2 - m * 0.06, y0 - m * 0.03, m * 0.13, "#ffd08a");
  text(ctx, "-", -gw / 2 - m * 0.06, y1 + m * 0.05, m * 0.13, "#ffd08a");
  ctx.globalAlpha = 1;
}

/* ATS 双电源 */
function dAts(ctx, w, h, it, env) {
  const g = cabinetShell(ctx, w, h, it, C.power, "ATS");
  const st = g.st, m = g.m;
  const y0 = h * 0.04, y1 = h / 2 - m * 0.12;
  ctx.strokeStyle = st; ctx.fillStyle = st; ctx.lineWidth = Math.max(14, m * 0.03);
  /* 两路输入 */
  arrow(ctx, -w / 2 - m * 0.02, y0 + m * 0.12, -m * 0.02, y0 + m * 0.12, m * 0.10);
  arrow(ctx, w / 2 + m * 0.02, y0 + m * 0.12, m * 0.02, y0 + m * 0.12, m * 0.10);
  /* 切换触点 */
  dotP(ctx, 0, y0 + m * 0.12, m * 0.05); ctx.fill();
  /* 输出 */
  arrow(ctx, 0, y0 + m * 0.17, 0, h / 2 - m * 0.02, m * 0.11);
  ctx.setLineDash(DASH_DOT); ctx.lineWidth = Math.max(10, m * 0.024);
  seg(ctx, -w * 0.36, y1 + m * 0.02, w * 0.36, y1 + m * 0.02);
  ctx.setLineDash(DASH_NONE);
}

/* PDU 列头（竖向条） */
function dPdu(ctx, w, h, it, env) {
  const st = it.stroke || C.power.stroke;
  const fl = it.fill || C.power.fill;
  const m = Math.min(w, h), L = Math.max(w, h);
  const lwd = Math.max(12, m * 0.08);
  boxPath(ctx, w, h);
  ctx.fillStyle = fl; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_NONE); ctx.stroke();
  /* 主开关 */
  const vertical = h >= w;
  const bw = vertical ? w * 0.62 : h * 0.62;
  ctx.strokeStyle = st; ctx.lineWidth = Math.max(9, m * 0.06);
  if (vertical) { rectP(ctx, -bw / 2, -h / 2 + m * 0.16, bw, m * 0.30); ctx.stroke(); }
  else { rectP(ctx, -w / 2 + m * 0.16, -bw / 2, m * 0.30, bw); ctx.stroke(); }
  /* 插座孔 */
  const n = 8;
  const span = L * 0.60;
  ctx.fillStyle = st; ctx.globalAlpha = 0.9;
  for (let i = 0; i < n; i++) {
    const p = -span / 2 + span * i / (n - 1);
    const r = m * 0.085;
    if (vertical) { dotP(ctx, -w * 0.20, p, r); ctx.fill(); dotP(ctx, w * 0.20, p, r); ctx.fill(); }
    else { dotP(ctx, p, -h * 0.20, r); ctx.fill(); dotP(ctx, p, h * 0.20, r); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = st; ctx.lineWidth = Math.max(8, m * 0.04); ctx.globalAlpha = 0.7;
  if (vertical) { seg(ctx, 0, -span / 2 - m * 0.1, 0, span / 2 + m * 0.1); }
  else { seg(ctx, -span / 2 - m * 0.1, 0, span / 2 + m * 0.1, 0); }
  ctx.globalAlpha = 1;
  if (env.label !== false && it.label !== false) {
  }
}

/* 母线槽 */
function dBusway(ctx, w, h, it, env) {
  const st = it.stroke || C.power.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(14, m * 0.12);
  const half = m * 0.28;
  rectP(ctx, -w / 2, -half, w, half * 2);
  ctx.fillStyle = it.fill || C.power.fill; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = Math.max(10, m * 0.08);
  seg(ctx, -w / 2, -half, w / 2, -half);
  seg(ctx, -w / 2, half, w / 2, half);
  /* 母线三根 */
  ctx.lineWidth = Math.max(8, m * 0.07); ctx.globalAlpha = 0.75;
  seg(ctx, -w / 2, -half * 0.34, w / 2, -half * 0.34);
  seg(ctx, -w / 2, 0, w / 2, 0);
  seg(ctx, -w / 2, half * 0.34, w / 2, half * 0.34);
  ctx.globalAlpha = 1;
  /* 插接箱 */
  ctx.fillStyle = it.fill || "#3a3324"; ctx.strokeStyle = st; ctx.lineWidth = Math.max(10, m * 0.08);
  const n = Math.max(2, Math.round(w / 1500));
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + w * (i + 0.5) / n;
    rectP(ctx, x - m * 0.30, half, m * 0.60, m * 0.5); ctx.fill(); ctx.stroke();
  }
  /* 接头 */
  ctx.lineWidth = Math.max(8, m * 0.06);
  const jn = Math.max(1, Math.round(w / 2000));
  for (let i = 1; i <= jn; i++) { const x = -w / 2 + w * i / (jn + 1); seg(ctx, x, -half, x, half); }
  if (env.label !== false && it.label !== false) {
  }
}

/* 电缆沟 / 走线槽（双线 + 斜纹填充） */
function dTrench(ctx, w, h, it, env) {
  const st = it.stroke || "#ffb443";
  const m = Math.min(w, h);
  const lwd = Math.max(14, m * 0.08);
  rectP(ctx, -w / 2, -h / 2, w, h);
  ctx.fillStyle = it.fill || "#241f17"; ctx.fill();
  hatch(ctx, -w / 2, -h / 2, w, h, Math.max(120, m * 0.55), 45, st, Math.max(9, m * 0.06), 0.4);
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_NONE);
  rectP(ctx, -w / 2, -h / 2, w, h); ctx.stroke();
  /* 内圈线（双线沟体） */
  ctx.lineWidth = lwd * 0.6; ctx.globalAlpha = 0.85;
  rectP(ctx, -w / 2 + h * 0.16, -h / 2 + h * 0.16, w - h * 0.32, h * 0.68); ctx.stroke();
  ctx.globalAlpha = 1;
  /* 中线 + 盖板分缝 */
  ctx.setLineDash(DASH_DOT); ctx.lineWidth = Math.max(8, m * 0.05); ctx.globalAlpha = 0.7;
  seg(ctx, -w / 2, 0, w / 2, 0);
  ctx.setLineDash(DASH_NONE); ctx.globalAlpha = 1;
  ctx.lineWidth = Math.max(8, m * 0.045);
  const n = Math.max(2, Math.round(w / 1000));
  for (let i = 1; i < n; i++) { const x = -w / 2 + w * i / n; seg(ctx, x, -h / 2, x, h / 2); }
  if (env.label !== false && it.label !== false) {
  }
}

def({ id: "power.ups",     name: "UPS柜",      cat: "power", w: 800, h: 850, bind: "dh",
  params: [{ key: "capacity", name: "容量kVA", type: "number", def: 200 }],
  ports: [{ x: 0, y: 425, dir: 90, name: "输出" }, { x: -400, y: -300, dir: 180, name: "输入" }],
  draw: shape(dUps, "power", 800, 850) });
def({ id: "power.lvdp",    name: "低压配电柜", cat: "power", w: 800, h: 600, bind: "dh",
  draw: shape(dLvdp, "power", 800, 600) });
def({ id: "power.battery", name: "电池柜",     cat: "power", w: 800, h: 850, bind: "dh",
  params: [{ key: "strings", name: "电池组数", type: "number", def: 4 }],
  draw: shape(dBattery, "power", 800, 850) });
def({ id: "power.ats",     name: "ATS双电源",  cat: "power", w: 600, h: 600, bind: "dh",
  draw: shape(dAts, "power", 600, 600) });
def({ id: "power.pdu",     name: "PDU列头",    cat: "power", w: 400, h: 1200, bind: "dh",
  params: [{ key: "outlets", name: "输出位数", type: "number", def: 16 }],
  draw: shape(dPdu, "power", 400, 1200) });
def({ id: "power.busway",  name: "母线槽",     cat: "power", w: 4000, h: 400, bind: null,
  params: [{ key: "phases", name: "相数", type: "enum", options: ["3P", "3P+N"], def: "3P+N" }],
  draw: shape(dBusway, "power", 4000, 400) });
def({ id: "power.trench",  name: "电缆沟",     cat: "power", w: 4000, h: 600, bind: null,
  params: [{ key: "w", name: "沟宽mm", type: "number", def: 600 }],
  draw: shape(dTrench, "power", 4000, 600) });

/* ==========================================================================
 *  制冷 cool
 * ========================================================================== */

/* 送风格栅（沿一条边画平行短线） */
function grille(ctx, x, y, len, gap, along, lwd) {
  /* 在 (x,y) 处沿 along('v'=沿 y / 'h'=沿 x) 的边上画格栅短线 */
  ctx.lineWidth = lwd;
  const n = Math.max(4, Math.round(len / gap));
  for (let i = 1; i < n; i++) {
    const p = -len / 2 + len * i / n;
    if (along === "v") seg(ctx, x - lwd * 1.8, y + p, x + lwd * 1.8, y + p);
    else seg(ctx, x + p, y - lwd * 1.8, x + p, y + lwd * 1.8);
  }
}
/* 风机（圆 + 轮毂 + 4 叶片） */
function fan(ctx, cx, cy, r, st, lwd) {
  ctx.strokeStyle = st;
  ctx.lineWidth = lwd;
  arcP(ctx, cx, cy, r, 0, TAU); ctx.stroke();
  ctx.lineWidth = lwd * 0.75;
  arcP(ctx, cx, cy, r * 0.28, 0, TAU); ctx.stroke();
  for (let k = 0; k < 4; k++) {
    const a0 = k * TAU / 4 + 0.35;
    const a1 = a0 + 1.05;
    arcP(ctx, cx, cy, r * 0.66, a0, a1); ctx.stroke();
    seg(ctx, cx + Math.cos(a0) * r * 0.28, cy + Math.sin(a0) * r * 0.28,
            cx + Math.cos(a1) * r * 0.66, cy + Math.sin(a1) * r * 0.66);
  }
}

/* 冷冻水管 */
function dPipe(ctx, w, h, it, env) {
  const st = it.stroke || "#4fc3f7";
  const m = Math.min(w, h);
  const off = Math.max(h * 0.28, m * 0.28);
  const lwd = Math.max(12, m * 0.30);
  ctx.strokeStyle = st; ctx.lineWidth = lwd;
  seg(ctx, -w / 2, -off, w / 2, -off);
  seg(ctx, -w / 2, off, w / 2, off);
  if (it.params && it.params.insulated === false) return;
  /* 流向箭头 */
  const n = Math.max(1, Math.round(w / 1500));
  ctx.fillStyle = st; ctx.lineWidth = Math.max(10, m * 0.22);
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + w * (i + 0.5) / n;
    arrow(ctx, x - w * 0.05 / n - m * 0.6, 0, x + m * 0.6, 0, m * 0.55);
  }
  /* 阀门（蝶阀） */
  ctx.lineWidth = Math.max(12, m * 0.26);
  const vx = 0, vr = m * 0.75;
  ctx.beginPath();
  ctx.moveTo(vx - vr, -vr); ctx.lineTo(vx + vr, vr);
  ctx.moveTo(vx - vr, vr); ctx.lineTo(vx + vr, -vr);
  ctx.stroke();
  if (env.label !== false && it.label !== false) {
  }
}

/* 精密空调（上送风 / 下送风） */
function dCrac(ctx, w, h, it, env, air) {
  const st = it.stroke || C.cool.stroke;
  const fl = it.fill || C.cool.fill;
  const m = Math.min(w, h), L = Math.max(w, h);
  const vertical = h > w;
  const lwd = Math.max(14, m * 0.035);
  boxPath(ctx, w, h);
  ctx.fillStyle = fl; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_NONE); ctx.stroke();

  const down = (air === "down");
  /* 盘管锯齿（沿送风对边） */
  const zigEdge = down ? h / 2 - m * 0.12 : -h / 2 + m * 0.12;
  ctx.strokeStyle = st; ctx.globalAlpha = 0.55; ctx.lineWidth = Math.max(9, lwd * 0.5);
  ctx.beginPath();
  const zn = 10, zw = w * 0.72;
  for (let i = 0; i <= zn; i++) {
    const x = -zw / 2 + zw * i / zn;
    const yy = zigEdge + ((i % 2 === 0) ? -m * 0.06 : m * 0.06);
    if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  /* 风机 */
  const fr = m * 0.17;
  if (vertical) { fan(ctx, 0, -L * 0.16, fr, st, lwd * 0.7); fan(ctx, 0, L * 0.16, fr, st, lwd * 0.7); }
  else { fan(ctx, -L * 0.20, m * 0.02, fr, st, lwd * 0.7); fan(ctx, L * 0.20, m * 0.02, fr, st, lwd * 0.7); }

  /* 送风格栅 + 气流方向（上送风 / 下送风，方向相反便于区分） */
  ctx.strokeStyle = st; ctx.lineWidth = Math.max(10, lwd * 0.6);
  const dLabel = down ? "下送风" : "上送风";
  ctx.fillStyle = st;
  if (!down) {
    const gy = -h / 2 + m * 0.05;
    for (let i = 1; i < 9; i++) { const x = -w * 0.32 + w * 0.64 * i / 9; seg(ctx, x, gy, x, gy + m * 0.10); }
    for (let i = -1; i <= 1; i++) { const x = i * w * 0.28; arrow(ctx, x, -h / 2 - m * 0.02, x, -h / 2 - m * 0.30, m * 0.13); }
    text(ctx, dLabel, 0, -h / 2 - m * 0.52, clamp(m * 0.16, 60, 200), st, "center", "middle", "600");
  } else {
    const p0 = h / 2 + m * 0.03, ph = m * 0.24;
    ctx.setLineDash(DASH_HINT);
    rectP(ctx, -w * 0.46, p0, w * 0.92, ph); ctx.stroke();
    ctx.setLineDash(DASH_NONE);
    hatch(ctx, -w * 0.46, p0, w * 0.92, ph, Math.max(60, m * 0.12), 45, st, Math.max(8, lwd * 0.4), 0.30);
    ctx.fillStyle = st;
    for (let i = -1; i <= 1; i++) { const x = i * w * 0.28; arrow(ctx, x, h / 2, x, h / 2 + m * 0.34, m * 0.13); }
    text(ctx, dLabel, 0, p0 + ph + m * 0.30, clamp(m * 0.16, 60, 200), st, "center", "middle", "600");
  }
  ctx.globalAlpha = 1;

  if (env.label !== false && it.label !== false) {
    text(ctx, down ? "下送风" : "上送风", 0, h * 0.30, clamp(m * 0.11, 80, 180), st, "center", "middle", "600");
  }
}

/* 列间空调 */
function dRowAc(ctx, w, h, it, env) {
  const st = it.stroke || C.cool.stroke;
  const fl = it.fill || C.cool.fill;
  const m = Math.min(w, h), L = Math.max(w, h);
  const lwd = Math.max(12, m * 0.05);
  boxPath(ctx, w, h); ctx.fillStyle = fl; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  const fr = m * 0.30;
  fan(ctx, 0, -L * 0.27, fr, st, lwd * 0.7);
  fan(ctx, 0, 0, fr, st, lwd * 0.7);
  fan(ctx, 0, L * 0.27, fr, st, lwd * 0.7);
  ctx.strokeStyle = st; ctx.lineWidth = Math.max(8, lwd * 0.45); ctx.globalAlpha = 0.7;
  for (let k = 0; k < 6; k++) {
    const yy = -L * 0.42 + L * 0.84 * k / 5;
    seg(ctx, -w / 2 + m * 0.06, yy, -w / 2 + m * 0.16, yy);
    seg(ctx, w / 2 - m * 0.16, yy, w / 2 - m * 0.06, yy);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = st;
  arrow(ctx, -w * 0.05, 0, -w * 0.72, 0, m * 0.30);
  arrow(ctx, w * 0.05, 0, w * 0.72, 0, m * 0.30);
  if (env.label !== false && it.label !== false) {
  }
}

/* 风机盘管 */
function dFcu(ctx, w, h, it, env) {
  const st = it.stroke || C.cool.stroke;
  const fl = it.fill || C.cool.fill;
  const m = Math.min(w, h), L = Math.max(w, h);
  const vertical = h > w;
  const lwd = Math.max(12, m * 0.05);
  boxPath(ctx, w, h); ctx.fillStyle = fl; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  /* 盘管锯齿 */
  ctx.lineWidth = Math.max(8, lwd * 0.5); ctx.globalAlpha = 0.6;
  ctx.beginPath();
  const zl = L * 0.7, zo = m * 0.30, zn = 12;
  for (let i = 0; i <= zn; i++) {
    const p = -zl / 2 + zl * i / zn;
    const q = ((i % 2 === 0) ? -1 : 1) * zo * 0.30 + (vertical ? -0 : 0);
    if (vertical) { if (i === 0) ctx.moveTo(-zo * 0.5 + q, p); else ctx.lineTo(-zo * 0.5 + q, p); }
    else { if (i === 0) ctx.moveTo(p, -zo * 0.5 + q); else ctx.lineTo(p, -zo * 0.5 + q); }
  }
  ctx.stroke(); ctx.globalAlpha = 1;
  const fr = m * 0.20;
  if (vertical) { fan(ctx, m * 0.10, -L * 0.18, fr, st, lwd * 0.7); fan(ctx, m * 0.10, L * 0.18, fr, st, lwd * 0.7); }
  else { fan(ctx, -L * 0.20, m * 0.08, fr, st, lwd * 0.7); fan(ctx, L * 0.20, m * 0.08, fr, st, lwd * 0.7); }
  /* 冷凝水管 */
  ctx.strokeStyle = "#5ad18a"; ctx.lineWidth = Math.max(9, lwd * 0.5);
  seg(ctx, -w / 2, -h / 2, -w / 2 - m * 0.18, -h / 2 - m * 0.18);
  if (env.label !== false && it.label !== false) {
  }
}

/* 新风机组 */
function dAhu(ctx, w, h, it, env) {
  const st = it.stroke || C.cool.stroke;
  const fl = it.fill || C.cool.fill;
  const m = Math.min(w, h);
  const lwd = Math.max(12, m * 0.04);
  boxPath(ctx, w, h); ctx.fillStyle = fl; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  ctx.lineWidth = Math.max(10, lwd * 0.6);
  const z1 = -w * 0.18, z2 = w * 0.16;
  seg(ctx, z1, -h * 0.34, z1, h * 0.34);
  seg(ctx, z2, -h * 0.34, z2, h * 0.34);
  /* 过滤锯齿 */
  ctx.globalAlpha = 0.65;
  ctx.beginPath();
  const n = 9;
  for (let i = 0; i <= n; i++) {
    const yy = -h * 0.30 + h * 0.60 * i / n;
    const xx = -w * 0.38 + (i % 2 ? m * 0.07 : 0);
    if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  fan(ctx, w * 0.30, 0, m * 0.22, st, lwd * 0.7);
  /* 进出风 */
  ctx.fillStyle = st;
  arrow(ctx, -w / 2 - m * 0.02, -h * 0.28, -w * 0.46, -h * 0.28, m * 0.14);
  arrow(ctx, w * 0.46, h * 0.28, w / 2 + m * 0.02, h * 0.28, m * 0.14);
  if (env.label !== false && it.label !== false) {
  }
}

/* 加湿器 */
function dHumid(ctx, w, h, it, env) {
  const st = it.stroke || C.cool.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(12, m * 0.045);
  boxPath(ctx, w, h); ctx.fillStyle = it.fill || C.cool.fill; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  /* 水滴 */
  const r = m * 0.11;
  const cy = m * 0.12;
  ctx.fillStyle = "#6fd6ff";
  ctx.beginPath();
  ctx.moveTo(0, cy - r * 2.2);
  ctx.quadraticCurveTo(r * 1.5, cy - r * 0.2, 0, cy + r);
  ctx.quadraticCurveTo(-r * 1.5, cy - r * 0.2, 0, cy - r * 2.2);
  ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = Math.max(8, lwd * 0.45); ctx.globalAlpha = 0.75;
  for (let k = 0; k < 3; k++) {
    const x = (k - 1) * m * 0.16;
    ctx.beginPath();
    ctx.moveTo(x, -h * 0.42);
    for (let s = 0; s < 4; s++) ctx.quadraticCurveTo(x + (s % 2 ? m * 0.06 : -m * 0.06), -h * 0.42 + (s + 0.5) * h * 0.055, x, -h * 0.42 + (s + 1) * h * 0.055);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (env.label !== false && it.label !== false) {
  }
}

def({ id: "cool.crac.up",   name: "精密空调(上送风)", cat: "cool", w: 850, h: 720, bind: "dh",
  params: [{ key: "air", name: "送风方式", type: "enum", options: ["up", "down"], def: "up" },
           { key: "cool", name: "制冷量kW", type: "number", def: 25 }],
  ports: [{ x: 0, y: 360, dir: 90, name: "出风" }, { x: 0, y: -360, dir: -90, name: "回风" }],
  draw: shape(function (ctx, w, h, it, env) { dCrac(ctx, w, h, it, env, "up"); }, "cool", 850, 720) });
def({ id: "cool.crac.down", name: "精密空调(下送风)", cat: "cool", w: 850, h: 720, bind: "dh",
  params: [{ key: "air", name: "送风方式", type: "enum", options: ["up", "down"], def: "down" }],
  ports: [{ x: 0, y: 360, dir: 90, name: "地板出风" }, { x: 0, y: -360, dir: -90, name: "回风" }],
  draw: shape(function (ctx, w, h, it, env) { dCrac(ctx, w, h, it, env, "down"); }, "cool", 850, 720) });
def({ id: "cool.rowac",     name: "列间空调",       cat: "cool", w: 300, h: 1200, bind: "dh",
  draw: shape(dRowAc, "cool", 300, 1200) });
def({ id: "cool.fcu",       name: "风机盘管",       cat: "cool", w: 1200, h: 600, bind: "dh",
  draw: shape(dFcu, "cool", 1200, 600) });
def({ id: "cool.ahu",       name: "新风机组",       cat: "cool", w: 1500, h: 900, bind: "dh",
  params: [{ key: "air", name: "风量m3/h", type: "number", def: 5000 }],
  draw: shape(dAhu, "cool", 1500, 900) });
def({ id: "cool.humid",     name: "加湿器",         cat: "cool", w: 600, h: 600, bind: "dh",
  draw: shape(dHumid, "cool", 600, 600) });
def({ id: "cool.pipe",      name: "冷冻水管",       cat: "cool", w: 4000, h: 150, bind: null,
  params: [{ key: "insulated", name: "保温", type: "enum", options: ["on", "off"], def: "on" }],
  draw: shape(dPipe, "cool", 4000, 150) });

/* ==========================================================================
 *  消防安防 safety
 * ========================================================================== */

/* 烟感探测器（圆 + 十字/放射线） */
function dSmoke(ctx, w, h, it, env) {
  const st = it.stroke || C.safety.stroke;
  const m = Math.min(w, h);
  const r = m * 0.42, lwd = Math.max(10, m * 0.07);
  ctx.fillStyle = it.fill || "#3a2426";
  arcP(ctx, 0, 0, r, 0, TAU); ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  arcP(ctx, 0, 0, r * 0.58, 0, TAU); ctx.stroke();
  ctx.lineWidth = lwd * 0.75;
  for (let k = 0; k < 4; k++) {
    const a = k * TAU / 4 + Math.PI / 4;
    seg(ctx, Math.cos(a) * r * 0.62, Math.sin(a) * r * 0.62, Math.cos(a) * r * 0.94, Math.sin(a) * r * 0.94);
  }
  ctx.fillStyle = st; dotP(ctx, 0, 0, r * 0.16); ctx.fill();
  if (env.label !== false && it.label !== false) {
  }
}

/* 感温探测器 */
function dHeat(ctx, w, h, it, env) {
  const st = it.stroke || C.safety.stroke;
  const m = Math.min(w, h);
  const r = m * 0.42, lwd = Math.max(10, m * 0.07);
  ctx.fillStyle = it.fill || "#3a2426";
  arcP(ctx, 0, 0, r, 0, TAU); ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.55); ctx.lineTo(r * 0.48, r * 0.40); ctx.lineTo(-r * 0.48, r * 0.40); ctx.closePath();
  ctx.stroke();
  ctx.lineWidth = lwd * 0.7;
  arcP(ctx, 0, 0, r * 0.78, -Math.PI * 0.9, -Math.PI * 0.1); ctx.stroke();
  if (env.label !== false && it.label !== false) {
  }
}

/* 灭火器（瓶身 + 提手 + 喷管） */
function dExtinguisher(ctx, w, h, it, env) {
  const st = it.stroke || C.safety.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(11, m * 0.055);
  const bw = w * 0.42, bh = h * 0.56;
  rrP(ctx, -bw / 2, -bh * 0.28, bw, bh, m * 0.10);
  ctx.fillStyle = "#7d2126"; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  /* 颈 + 提手 */
  rectP(ctx, -bw * 0.20, -bh * 0.28 - m * 0.14, bw * 0.40, m * 0.14);
  ctx.fillStyle = "#5b181d"; ctx.fill(); ctx.stroke();
  seg(ctx, -bw * 0.30, -bh * 0.28 - m * 0.20, bw * 0.30, -bh * 0.28 - m * 0.20);
  /* 压力表 */
  dotP(ctx, bw * 0.30, bh * 0.02, m * 0.055); ctx.fillStyle = "#42d392"; ctx.fill();
  ctx.strokeStyle = st; ctx.stroke();
  /* 喷管 */
  ctx.lineWidth = lwd * 0.8;
  ctx.beginPath();
  ctx.moveTo(bw * 0.5, -bh * 0.10);
  ctx.quadraticCurveTo(w * 0.48, -h * 0.30, w * 0.42, -h * 0.46);
  ctx.stroke();
  if (env.label !== false && it.label !== false) {
  }
}

/* 消防喷淋 */
function dSprinkler(ctx, w, h, it, env) {
  const st = it.stroke || C.safety.stroke;
  const m = Math.min(w, h);
  const r = m * 0.20, lwd = Math.max(10, m * 0.055);
  ctx.strokeStyle = st; ctx.lineWidth = lwd;
  arcP(ctx, 0, 0, r, 0, TAU); ctx.stroke();
  ctx.fillStyle = st; dotP(ctx, 0, 0, r * 0.30); ctx.fill();
  for (let k = 0; k < 4; k++) {
    const a = k * TAU / 4 + Math.PI / 4;
    const x1 = Math.cos(a) * r * 1.5, y1 = Math.sin(a) * r * 1.5;
    seg(ctx, Math.cos(a) * r * 1.05, Math.sin(a) * r * 1.05, x1, y1);
    dotP(ctx, Math.cos(a) * r * 2.0, Math.sin(a) * r * 2.0, r * 0.22);
    ctx.fillStyle = "#7fd8ff"; ctx.fill();
  }
  if (env.label !== false && it.label !== false) {
  }
}

/* 气体灭火钢瓶间 */
function dGas(ctx, w, h, it, env) {
  const st = it.stroke || C.safety.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(12, m * 0.035);
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_HINT);
  rectP(ctx, -w / 2, -h / 2, w, h); ctx.stroke();
  ctx.setLineDash(DASH_NONE);
  /* 钢瓶 */
  const br = Math.min(w, h) * 0.16;
  const n = 3;
  ctx.lineWidth = lwd * 0.8;
  for (let i = 0; i < n; i++) {
    const x = -w * 0.24 + w * 0.24 * i;
    const y = h * 0.10;
    ctx.fillStyle = "#5b181d";
    arcP(ctx, x, y, br, 0, TAU); ctx.fill();
    ctx.strokeStyle = st; ctx.stroke();
    seg(ctx, x, y - br, x, y - br * 1.6);
    /* 汇流管 */
    seg(ctx, x, -h * 0.30, x, y - br * 1.6);
  }
  seg(ctx, -w * 0.24, -h * 0.30, w * 0.24, -h * 0.30);
  if (env.label !== false && it.label !== false) {
  }
}

/* 应急照明 */
function dEmergency(ctx, w, h, it, env) {
  const st = it.stroke || C.safety.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(11, m * 0.05);
  boxPath(ctx, w, h); ctx.fillStyle = it.fill || C.safety.fill; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  const r = m * 0.16;
  ctx.fillStyle = "#ffe9a8";
  dotP(ctx, -m * 0.18, 0, r); ctx.fill();
  dotP(ctx, m * 0.18, 0, r); ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd * 0.7;
  for (let k = 0; k < 4; k++) {
    const a = k * TAU / 4 + Math.PI / 4;
    seg(ctx, Math.cos(a) * m * 0.34, Math.sin(a) * m * 0.34, Math.cos(a) * m * 0.46, Math.sin(a) * m * 0.46);
  }
  if (env.label !== false && it.label !== false) {
  }
}

/* 疏散指示（箭头 + 人形） */
function dExit(ctx, w, h, it, env) {
  const st = it.stroke || C.safety.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(10, m * 0.06);
  boxPath(ctx, w, h); ctx.fillStyle = "#123a26"; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  /* 人形 */
  ctx.strokeStyle = "#c8ffd8"; ctx.fillStyle = "#c8ffd8";
  const cx = -w * 0.12, cy = 0, s = m * 0.16;
  dotP(ctx, cx, cy - s * 1.5, s * 0.42); ctx.fill();
  ctx.lineWidth = lwd * 0.9;
  seg(ctx, cx, cy - s * 1.05, cx - s * 0.55, cy + s * 0.20);
  seg(ctx, cx - s * 0.55, cy + s * 0.20, cx + s * 0.45, cy + s * 0.75);
  seg(ctx, cx + s * 0.05, cy - s * 0.30, cx + s * 0.95, cy - s * 0.55);
  seg(ctx, cx - s * 0.10, cy + s * 0.05, cx - s * 1.05, cy + s * 0.60);
  /* 箭头 */
  ctx.strokeStyle = st; ctx.fillStyle = st;
  arrow(ctx, w * 0.02, 0, w * 0.44, 0, m * 0.20);
  if (env.label !== false && it.label !== false) {
  }
}

/* 摄像头（含视场角） */
function dCctv(ctx, w, h, it, env) {
  const st = it.stroke || C.safety.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(10, m * 0.05);
  /* 视场 */
  ctx.strokeStyle = st; ctx.globalAlpha = 0.5; ctx.lineWidth = lwd * 0.6; ctx.setLineDash(DASH_HINT);
  ctx.beginPath();
  ctx.moveTo(-m * 0.05, m * 0.05);
  ctx.lineTo(-m * 0.62, m * 0.52);
  ctx.moveTo(-m * 0.05, m * 0.05);
  ctx.lineTo(m * 0.42, m * 0.62);
  ctx.stroke();
  ctx.setLineDash(DASH_NONE); ctx.globalAlpha = 1;
  /* 机身 */
  rrP(ctx, -m * 0.34, -m * 0.26, m * 0.62, m * 0.42, m * 0.06);
  ctx.fillStyle = it.fill || "#3a2426"; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  /* 镜头 */
  ctx.fillStyle = "#0d1620";
  arcP(ctx, m * 0.28, -m * 0.05, m * 0.17, 0, TAU); ctx.fill();
  ctx.strokeStyle = st; ctx.stroke();
  ctx.fillStyle = "#7fd8ff";
  dotP(ctx, m * 0.28, -m * 0.05, m * 0.07); ctx.fill();
  /* 支架 */
  ctx.strokeStyle = st; ctx.lineWidth = lwd * 0.8;
  seg(ctx, -m * 0.03, m * 0.16, -m * 0.03, m * 0.42);
  seg(ctx, -m * 0.20, m * 0.42, m * 0.14, m * 0.42);
  if (env.label !== false && it.label !== false) {
  }
}

/* 门禁读卡器 */
function dAccess(ctx, w, h, it, env) {
  const st = it.stroke || C.safety.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(10, m * 0.07);
  boxPath(ctx, w, h); ctx.fillStyle = it.fill || C.safety.fill; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  ctx.fillStyle = "#6fe3a6";
  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) { dotP(ctx, -w * 0.10 + c * w * 0.20, -h * 0.16 + r * h * 0.16, m * 0.05); ctx.fill(); }
  /* 刷卡 */
  ctx.strokeStyle = st; ctx.lineWidth = lwd * 0.7;
  rectP(ctx, -w * 0.30, h * 0.22, w * 0.34, h * 0.16); ctx.stroke();
  if (env.label !== false && it.label !== false) {
  }
}

/* 入侵探测（PIR 半球） */
function dIntrusion(ctx, w, h, it, env) {
  const st = it.stroke || C.safety.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(10, m * 0.055);
  ctx.fillStyle = it.fill || "#3a2426";
  ctx.beginPath();
  ctx.arc(0, m * 0.12, m * 0.34, Math.PI, 0);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  ctx.globalAlpha = 0.65; ctx.lineWidth = lwd * 0.7;
  arcP(ctx, 0, m * 0.12, m * 0.52, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
  arcP(ctx, 0, m * 0.12, m * 0.72, Math.PI * 1.22, Math.PI * 1.78); ctx.stroke();
  ctx.globalAlpha = 1;
  seg(ctx, 0, -m * 0.28, 0, -m * 0.12);
  if (env.label !== false && it.label !== false) {
  }
}

def({ id: "safety.smoke",       name: "烟感探测器",   cat: "safety", w: 100, h: 100, bind: "dh",
  params: [{ key: "addr", name: "地址", type: "text", def: "" }],
  draw: shape(dSmoke, "safety", 100, 100) });
def({ id: "safety.heat",        name: "感温探测器",   cat: "safety", w: 100, h: 100, bind: "dh",
  draw: shape(dHeat, "safety", 100, 100) });
def({ id: "safety.extinguisher", name: "灭火器",      cat: "safety", w: 200, h: 200, bind: null,
  params: [{ key: "type", name: "类型", type: "enum", options: ["干粉", "CO2", "七氟丙烷"], def: "七氟丙烷" }],
  draw: shape(dExtinguisher, "safety", 200, 200) });
def({ id: "safety.sprinkler",   name: "消防喷淋",     cat: "safety", w: 200, h: 200, bind: null,
  draw: shape(dSprinkler, "safety", 200, 200) });
def({ id: "safety.gas",         name: "气体灭火钢瓶间", cat: "safety", w: 2000, h: 1500, bind: null,
  draw: shape(dGas, "safety", 2000, 1500) });
def({ id: "safety.emergency",   name: "应急照明",     cat: "safety", w: 300, h: 300, bind: null,
  draw: shape(dEmergency, "safety", 300, 300) });
def({ id: "safety.exit",        name: "疏散指示",     cat: "safety", w: 400, h: 200, bind: null,
  draw: shape(dExit, "safety", 400, 200) });
def({ id: "safety.cctv",        name: "摄像头",       cat: "safety", w: 200, h: 200, bind: "dh",
  params: [{ key: "fov", name: "视场角", type: "number", def: 90 }],
  draw: shape(dCctv, "safety", 200, 200) });
def({ id: "safety.access",      name: "门禁读卡器",   cat: "safety", w: 150, h: 100, bind: "dh",
  draw: shape(dAccess, "safety", 150, 100) });
def({ id: "safety.intrusion",   name: "入侵探测",     cat: "safety", w: 150, h: 150, bind: "dh",
  draw: shape(dIntrusion, "safety", 150, 150) });
/* ==========================================================================
 *  环境监测 env
 * ========================================================================== */

/* 温湿度传感器（方形 + 波形） */
function dTh(ctx, w, h, it, env) {
  const st = it.stroke || C.env.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(10, m * 0.07);
  boxPath(ctx, w, h); ctx.fillStyle = it.fill || C.env.fill; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  /* 温度波形 */
  ctx.lineWidth = lwd * 0.7;
  ctx.beginPath();
  const n = 8, amp = h * 0.16;
  for (let i = 0; i <= n; i++) {
    const x = -w * 0.32 + w * 0.64 * i / n;
    const y = amp * Math.sin(i / n * TAU * 1.25);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  /* 湿度点 */
  ctx.fillStyle = st;
  dotP(ctx, w * 0.30, -h * 0.28, m * 0.07); ctx.fill();
  dotP(ctx, w * 0.30, h * 0.28, m * 0.07); ctx.fill();
  if (env.label !== false && it.label !== false) {
  }
}

/* 浸水检测（绳式） */
function dWaterRope(ctx, w, h, it, env) {
  const st = it.stroke || C.env.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(10, m * 0.16);
  const vertical = h > w;
  const L = Math.max(w, h);
  /* 绳体 */
  ctx.strokeStyle = st; ctx.lineWidth = lwd;
  for (let k = -1; k <= 1; k += 2) {
    if (vertical) seg(ctx, k * w * 0.22, -h / 2, k * w * 0.22, h / 2);
    else seg(ctx, -w / 2, k * h * 0.22, w / 2, k * h * 0.22);
  }
  /* 波浪感应线 */
  ctx.lineWidth = lwd * 0.7;
  ctx.beginPath();
  const n = Math.max(6, Math.round(L / 160));
  for (let i = 0; i <= n; i++) {
    const p = -L * 0.46 + L * 0.92 * i / n;
    const q = Math.sin(i / n * TAU * 2.5) * m * 0.30;
    if (vertical) { if (i === 0) ctx.moveTo(q, p); else ctx.lineTo(q, p); }
    else { if (i === 0) ctx.moveTo(p, q); else ctx.lineTo(p, q); }
  }
  ctx.stroke();
  if (env.label !== false && it.label !== false) {
  }
}

/* 浸水检测（点式 / 浸水盒） */
function dWaterPoint(ctx, w, h, it, env) {
  const st = it.stroke || C.env.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(9, m * 0.13);
  boxPath(ctx, w, h); ctx.fillStyle = it.fill || C.env.fill; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  ctx.lineWidth = lwd * 0.8;
  for (let k = 0; k < 2; k++) {
    const y = -h * 0.14 + k * h * 0.28;
    ctx.beginPath();
    for (let i = 0; i <= 8; i++) {
      const x = -w * 0.32 + w * 0.64 * i / 8;
      const yy = y + Math.sin(i / 8 * TAU * 2) * h * 0.08;
      if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  ctx.fillStyle = "#7fd8ff";
  dotP(ctx, w * 0.34, -h * 0.34, m * 0.09); ctx.fill();
  if (env.label !== false && it.label !== false) {
  }
}

/* 漏水感应绳走向（带定位点） */
function dLeak(ctx, w, h, it, env) {
  const st = it.stroke || "#5ad18a";
  const m = Math.min(w, h);
  const lwd = Math.max(9, m * 0.16);
  const vertical = h > w;
  const L = Math.max(w, h);
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_HINT);
  if (vertical) seg(ctx, 0, -h / 2, 0, h / 2); else seg(ctx, -w / 2, 0, w / 2, 0);
  ctx.setLineDash(DASH_NONE);
  const n = 4;
  for (let i = 0; i < n; i++) {
    const p = -L * 0.36 + L * 0.72 * i / (n - 1);
    const x = vertical ? 0 : p, y = vertical ? p : 0;
    ctx.fillStyle = "#7fd8ff";
    dotP(ctx, x, y, m * (i === 1 ? 0.28 : 0.18)); ctx.fill();
    if (i === 1) { ctx.strokeStyle = "#7fd8ff"; ctx.lineWidth = lwd * 0.8; arcP(ctx, x, y, m * 0.55, 0, TAU); ctx.stroke(); }
  }
  if (env.label !== false && it.label !== false) {
  }
}

/* 压差传感器 */
function dDiff(ctx, w, h, it, env) {
  const st = it.stroke || C.env.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(9, m * 0.07);
  boxPath(ctx, w, h); ctx.fillStyle = it.fill || C.env.fill; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  /* 两个取压管 */
  ctx.lineWidth = lwd * 0.8;
  seg(ctx, -w / 2, -h * 0.22, -w * 0.34, -h * 0.22);
  seg(ctx, w / 2, h * 0.22, w * 0.34, h * 0.22);
  ctx.fillStyle = st;
  dotP(ctx, -w / 2, -h * 0.22, lwd * 0.7); ctx.fill();
  dotP(ctx, w / 2, h * 0.22, lwd * 0.7); ctx.fill();
  text(ctx, "ΔP", 0, -h * 0.12, clamp(m * 0.24, 32, 200), "#c9ffe4", "center", "middle", "700");
  arrow(ctx, -w * 0.22, h * 0.26, w * 0.22, h * 0.26, m * 0.16);
  if (env.label !== false && it.label !== false) {
  }
}

/* 空气质量 */
function dAir(ctx, w, h, it, env) {
  const st = it.stroke || C.env.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(9, m * 0.06);
  boxPath(ctx, w, h); ctx.fillStyle = it.fill || C.env.fill; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  /* 风曲线 */
  ctx.lineWidth = lwd * 0.8;
  for (let k = -1; k <= 1; k++) {
    const y = k * h * 0.22;
    ctx.beginPath();
    ctx.moveTo(-w * 0.30, y);
    ctx.quadraticCurveTo(0, y + k * h * 0.10, w * 0.30, y);
    ctx.stroke();
  }
  ctx.fillStyle = "#7fd8ff";
  dotP(ctx, w * 0.26, -h * 0.30, m * 0.06); ctx.fill();
  dotP(ctx, -w * 0.30, h * 0.30, m * 0.05); ctx.fill();
  if (env.label !== false && it.label !== false) {
  }
}

def({ id: "env.th",         name: "温湿度传感器", cat: "env", w: 150, h: 150, bind: "dh",
  params: [{ key: "temp", name: "温度阈值℃", type: "number", def: 27 }],
  draw: shape(dTh, "env", 150, 150) });
def({ id: "env.water.rope", name: "浸水检测(绳式)", cat: "env", w: 2000, h: 80, bind: "dh",
  draw: shape(dWaterRope, "env", 2000, 80) });
def({ id: "env.water.point", name: "浸水检测(点式)", cat: "env", w: 120, h: 80, bind: "dh",
  draw: shape(dWaterPoint, "env", 120, 80) });
def({ id: "env.leak",       name: "漏水感应绳走向", cat: "env", w: 3000, h: 60, bind: "dh",
  draw: shape(dLeak, "env", 3000, 60) });
def({ id: "env.diff",       name: "压差传感器",   cat: "env", w: 150, h: 150, bind: "dh",
  draw: shape(dDiff, "env", 150, 150) });
def({ id: "env.air",        name: "空气质量",     cat: "env", w: 150, h: 150, bind: "dh",
  draw: shape(dAir, "env", 150, 150) });

/* ==========================================================================
 *  综合布线 cable
 * ========================================================================== */

/* 桥架 / 走线架（双线 + 横向梯档） */
function trayDraw(ctx, w, h, it, env, ladder) {
  const st = it.stroke || C.cable.stroke;
  const fl = it.fill || C.cable.fill;
  const m = Math.min(w, h), L = Math.max(w, h);
  const vertical = h > w;
  const lwd = Math.max(10, m * 0.10);
  const half = (it.params && it.params.bw ? +it.params.bw : m) / 2;
  /* 底槽 */
  ctx.globalAlpha = 0.45;
  rectP(ctx, -w / 2, -h / 2, w, h);
  ctx.fillStyle = fl; ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_NONE);
  if (vertical) { seg(ctx, -w / 2, -h / 2, -w / 2, h / 2); seg(ctx, w / 2, -h / 2, w / 2, h / 2); }
  else { seg(ctx, -w / 2, -h / 2, w / 2, -h / 2); seg(ctx, -w / 2, h / 2, w / 2, h / 2); }
  /* 梯档 */
  ctx.lineWidth = Math.max(8, lwd * 0.7);
  const step = ladder ? 300 : 250;
  const n = Math.max(3, Math.round(L / step));
  for (let i = 1; i < n; i++) {
    const p = -L / 2 + L * i / n;
    if (vertical) seg(ctx, -w / 2, p, w / 2, p);
    else seg(ctx, p, -h / 2, p, h / 2);
  }
  /* 中心虚线（线缆走向） */
  ctx.setLineDash(DASH_DOT); ctx.lineWidth = Math.max(7, lwd * 0.5); ctx.globalAlpha = 0.7;
  if (vertical) seg(ctx, 0, -h * 0.44, 0, h * 0.44); else seg(ctx, -w * 0.44, 0, w * 0.44, 0);
  ctx.setLineDash(DASH_NONE); ctx.globalAlpha = 1;
  if (ladder) {
    /* 走线架侧支架 */
    ctx.lineWidth = Math.max(8, lwd * 0.6);
    if (vertical) { seg(ctx, -w / 2 - m * 0.30, -h * 0.30, -w / 2 - m * 0.30, h * 0.30); seg(ctx, w / 2 + m * 0.30, -h * 0.30, w / 2 + m * 0.30, h * 0.30); }
    else { seg(ctx, -w * 0.30, -h / 2 - m * 0.30, w * 0.30, -h / 2 - m * 0.30); seg(ctx, -w * 0.30, h / 2 + m * 0.30, w * 0.30, h / 2 + m * 0.30); }
  }
  if (env.label !== false && it.label !== false) {
    const fs = clamp(Math.min(m, L * 0.3) * 0.34, 90, 220);
  }
}

/* 机柜顶部走线 */
function dRackTop(ctx, w, h, it, env) {
  const st = it.stroke || C.cable.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(9, m * 0.10);
  ctx.globalAlpha = 0.4;
  rectP(ctx, -w / 2, -h / 2, w, h); ctx.fillStyle = it.fill || C.cable.fill; ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = st; ctx.lineWidth = lwd;
  rectP(ctx, -w / 2, -h / 2, w, h); ctx.stroke();
  ctx.lineWidth = lwd * 0.7;
  for (let i = 1; i < 3; i++) { const x = -w / 2 + w * i / 3; seg(ctx, x, -h / 2, x, h / 2); }
  if (env.label !== false && it.label !== false) {
  }
}

/* 光缆终端盒 ODF */
function dOdf(ctx, w, h, it, env) {
  const st = it.stroke || C.cable.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(10, m * 0.05);
  boxPath(ctx, w, h); ctx.fillStyle = it.fill || C.cable.fill; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  /* 光纤曲线 */
  ctx.lineWidth = Math.max(7, lwd * 0.45);
  const n = 6;
  for (let i = 0; i < n; i++) {
    const y = -h * 0.30 + h * 0.60 * i / (n - 1);
    ctx.beginPath();
    ctx.moveTo(-w / 2, y);
    ctx.quadraticCurveTo(-w * 0.16, y * 1.5, w * 0.02, y);
    ctx.stroke();
    ctx.fillStyle = i % 2 ? "#7fd8ff" : "#ffd08a";
    dotP(ctx, w * 0.02, y, Math.max(9, m * 0.035)); ctx.fill();
  }
  ctx.strokeStyle = st; ctx.lineWidth = Math.max(8, lwd * 0.5);
  seg(ctx, w * 0.02, -h * 0.34, w * 0.02, h * 0.34);
  /* 端口 */
  const pn = 5;
  for (let i = 0; i < pn; i++) {
    const y = -h * 0.32 + h * 0.64 * i / (pn - 1);
    rectP(ctx, w * 0.30, y - m * 0.05, w * 0.14, m * 0.10); ctx.stroke();
  }
  if (env.label !== false && it.label !== false) {
  }
}

/* 配线架 */
function dPatch(ctx, w, h, it, env) {
  const st = it.stroke || C.cable.stroke;
  const m = Math.min(w, h), L = Math.max(w, h);
  const lwd = Math.max(9, m * 0.10);
  boxPath(ctx, w, h); ctx.fillStyle = it.fill || C.cable.fill; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  const vertical = h > w;
  const n = 12;
  ctx.lineWidth = Math.max(7, lwd * 0.5);
  ctx.fillStyle = "#0d1620";
  for (let i = 0; i < n; i++) {
    if (vertical) {
      const y = -h * 0.38 + h * 0.76 * i / (n - 1);
      rectP(ctx, -w * 0.30, y - m * 0.14, w * 0.24, m * 0.24); ctx.fill(); ctx.stroke();
      rectP(ctx, w * 0.06, y - m * 0.14, w * 0.24, m * 0.24); ctx.fill(); ctx.stroke();
    } else {
      const x = -w * 0.40 + w * 0.80 * i / (n - 1);
      rectP(ctx, x - m * 0.20, -h * 0.30, m * 0.40, h * 0.24); ctx.fill(); ctx.stroke();
      rectP(ctx, x - m * 0.20, h * 0.06, m * 0.40, h * 0.24); ctx.fill(); ctx.stroke();
    }
  }
  if (env.label !== false && it.label !== false) {
  }
}

def({ id: "cable.tray.v",  name: "桥架(纵向)",   cat: "cable", w: 300, h: 2000, bind: null,
  params: [{ key: "bw", name: "桥架宽mm", type: "number", def: 300 }],
  draw: shape(function (ctx, w, h, it, env) { trayDraw(ctx, w, h, it, env, false); }, "cable", 300, 2000) });
def({ id: "cable.tray.h",  name: "桥架(横向)",   cat: "cable", w: 2000, h: 300, bind: null,
  params: [{ key: "bw", name: "桥架宽mm", type: "number", def: 300 }],
  draw: shape(function (ctx, w, h, it, env) { trayDraw(ctx, w, h, it, env, false); }, "cable", 2000, 300) });
def({ id: "cable.ladder",  name: "走线架",       cat: "cable", w: 400, h: 2000, bind: null,
  draw: shape(function (ctx, w, h, it, env) { trayDraw(ctx, w, h, it, env, true); }, "cable", 400, 2000) });
def({ id: "cable.racktop", name: "机柜顶部走线", cat: "cable", w: 600, h: 200, bind: null,
  draw: shape(dRackTop, "cable", 600, 200) });
def({ id: "cable.odf",     name: "光缆终端盒",   cat: "cable", w: 400, h: 300, bind: null,
  draw: shape(dOdf, "cable", 400, 300) });
def({ id: "cable.patch",   name: "配线架",       cat: "cable", w: 482, h: 120, bind: null,
  params: [{ key: "ports", name: "端口数", type: "number", def: 24 }],
  draw: shape(dPatch, "cable", 482, 120) });

/* ==========================================================================
 *  标注 annot
 * ========================================================================== */

/* 文字标注 */
function dTextAnnot(ctx, w, h, it, env) {
  const st = it.stroke || C.annot.stroke;
  const m = Math.min(w, h);
  const s = (it.params && it.params.text) || it.user && it.user.text || it.name || "文字标注";
  const fs = clamp(m * 0.62, 100, 900);
  text(ctx, s, 0, 0, fs, env.color || "#eaf4ff", "center", "middle");
  /* 基线 + 引出 */
  const tw = fs * String(s).length * 0.6;
  ctx.strokeStyle = st; ctx.lineWidth = Math.max(10, fs * 0.07);
  seg(ctx, -tw / 2, fs * 0.78, tw / 2, fs * 0.78);
  seg(ctx, -tw / 2 - fs * 0.8, -fs * 0.9, -tw / 2, -fs * 0.9);
  dotP(ctx, -tw / 2 - fs * 0.8, -fs * 0.9, fs * 0.16); ctx.fillStyle = st; ctx.fill();
}

/* 直线尺寸标注 */
function dDim(ctx, w, h, it, env) {
  const st = it.stroke || C.annot.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(10, m * 0.06);
  const y = 0;
  const ext = h * 0.34;
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_NONE);
  /* 尺寸界线（建筑制图习惯：细线 + 45° 斜短划） */
  seg(ctx, -w / 2, y - ext, -w / 2, y + ext * 0.5);
  seg(ctx, w / 2, y - ext, w / 2, y + ext * 0.5);
  /* 尺寸线 */
  seg(ctx, -w / 2, y, w / 2, y);
  /* 箭头 */
  ctx.fillStyle = st;
  arrow(ctx, -w / 2 + m * 0.6, y, -w / 2, y, m * 0.30);
  arrow(ctx, w / 2 - m * 0.6, y, w / 2, y, m * 0.30);
  /* 尺寸数字 */
  const label = (it.params && it.params.text) || it.user && it.user.text || (Math.round(w) + "");
  text(ctx, label, 0, -m * 0.40, clamp(m * 0.34, 110, 320), "#eaf4ff", "center", "middle", "600");
}

/* 指北针 */
function dNorth(ctx, w, h, it, env) {
  const st = it.stroke || C.annot.stroke;
  const m = Math.min(w, h);
  const r = m * 0.38, lwd = Math.max(12, m * 0.035);
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_NONE);
  arcP(ctx, 0, 0, r, 0, TAU); ctx.stroke();
  /* 四向刻度 */
  for (let k = 0; k < 4; k++) {
    const a = k * TAU / 4 + Math.PI / 2;
    seg(ctx, Math.cos(a) * r, Math.sin(a) * r, Math.cos(a) * r * 1.14, Math.sin(a) * r * 1.14);
  }
  /* 指北箭头（描黑一半） */
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.86);
  ctx.lineTo(r * 0.30, r * 0.62);
  ctx.lineTo(0, r * 0.30);
  ctx.lineTo(-r * 0.30, r * 0.62);
  ctx.closePath();
  ctx.fillStyle = "#ff6b6b"; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd * 0.7; ctx.stroke();
  text(ctx, "N", 0, -r * 1.34, m * 0.34, "#eaf4ff", "center", "middle", "700");
  text(ctx, it.name || "指北针", 0, r * 1.30, m * 0.20, "#b9c8db");
}

/* 比例尺（分段尺 + "0 1 2 3m"） */
function dScaleBar(ctx, w, h, it, env) {
  const st = it.stroke || C.annot.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(10, m * 0.05);
  const segs = 4, segW = w / segs, bh = h * 0.34, by = -bh / 2 - h * 0.04;
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_NONE);
  for (let i = 0; i < segs; i++) {
    const x = -w / 2 + i * segW;
    ctx.fillStyle = (i % 2 === 0) ? "#e8f1ff" : "#3d4c60";
    ctx.fillRect(x, by, segW, bh);
    ctx.strokeRect(x, by, segW, bh);
  }
  /* 刻度数字 0 1 2 3 m */
  for (let i = 0; i <= 3; i++) {
    const x = -w / 2 + i * segW;
    text(ctx, String(i), x, by + bh + m * 0.30, clamp(m * 0.34, 110, 300), "#eaf4ff");
  }
  text(ctx, "m", w / 2 + m * 0.24, by + bh + m * 0.30, clamp(m * 0.34, 110, 300), "#eaf4ff");
  text(ctx, it.name || "比例尺 1:100", 0, by - m * 0.32, clamp(m * 0.30, 90, 260), "#b9c8db");
}

/* 图例框 */
function dLegend(ctx, w, h, it, env) {
  const st = it.stroke || C.annot.stroke;
  const m = Math.min(w, h);
  const lwd = Math.max(10, m * 0.012);
  boxPath(ctx, w, h); ctx.fillStyle = it.fill || "#131c27"; ctx.fill();
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.stroke();
  const th = h * 0.16;
  rectP(ctx, -w / 2, -h / 2, w, th); ctx.stroke();
  text(ctx, it.name || "图例", 0, -h / 2 + th / 2, th * 0.62, "#eaf4ff", "center", "middle", "600");
  const rows = [
    ["#7fd8ff", "机柜"], ["#ffb443", "UPS/配电"], ["#ff6b6b", "烟感/消防"], ["#b39ddb", "桥架/走线"]
  ];
  const availH = h - th;
  for (let i = 0; i < rows.length; i++) {
    const ry = -h / 2 + th + availH * (i + 0.5) / rows.length;
    const sw = w * 0.10, sh = availH / rows.length * 0.5;
    ctx.fillStyle = rows[i][0]; ctx.globalAlpha = 0.75;
    ctx.fillRect(-w * 0.40, ry - sh / 2, sw, sh);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = st; ctx.lineWidth = lwd * 0.7;
    ctx.strokeRect(-w * 0.40, ry - sh / 2, sw, sh);
    seg(ctx, -w * 0.40 + sw * 1.3, ry, -w * 0.40 + sw * 2.0, ry);
    text(ctx, rows[i][1], -w * 0.40 + sw * 2.2, ry, sh * 0.85, "#dbe8f7", "left", "middle");
  }
}

/* 标题栏 */
function dTitleBlock(ctx, w, h, it, env) {
  const st = it.stroke || C.annot.stroke;
  const lwd = Math.max(12, Math.min(w, h) * 0.012);
  ctx.strokeStyle = st; ctx.lineWidth = lwd; ctx.setLineDash(DASH_NONE);
  boxPath(ctx, w, h); ctx.fillStyle = it.fill || "#101a25"; ctx.fill(); ctx.stroke();
  const lw = w * 0.46;               /* 左栏（图名） */
  const rx = -w / 2 + lw;
  seg(ctx, rx, -h / 2, rx, h / 2);
  const rows = 4, rh = h / rows;
  for (let i = 1; i < rows; i++) seg(ctx, rx, -h / 2 + rh * i, w / 2, -h / 2 + rh * i);
  text(ctx, it.name || "IDC 机房平面图", -w / 2 + lw / 2, 0, Math.min(lw * 0.13, h * 0.30), "#eaf4ff", "center", "middle", "700");
  text(ctx, "图名", -w / 2 + lw / 2, h / 2 - rh * 0.35, Math.min(lw * 0.07, h * 0.16), "#8fa2b8");
  text(ctx, "图名", -w / 2 + lw / 2, h / 2 - rh * 0.35, Math.min(lw * 0.07, h * 0.16), "#8fa2b8");
  const info = [
    ["站点", "上海一号数据中心"],
    ["比例", "1:100"],
    ["日期", "2026-11-02"],
    ["图号", "IDC-PLAN-001"],
  ];
  const rw = w / 2 - rx;
  for (let i = 0; i < 4; i++) {
    const cy = -h / 2 + rh * (i + 0.5);
    text(ctx, info[i][0], rx + rw * 0.10, cy, Math.min(rw * 0.14, h * 0.14), "#8fa2b8", "left", "middle");
    text(ctx, info[i][1], rx + rw * 0.62, cy, Math.min(rw * 0.16, h * 0.16), "#dbe8f7", "left", "middle");
  }
}

/* 区域填充（冷通道 / 热通道） */
function dZone(ctx, w, h, it, env) {
  const type = (it.params && it.params.type) || "cold";
  const cold = type !== "hot";
  const st = cold ? "#4fc3f7" : "#ff9f43";
  boxPath(ctx, w, h);
  ctx.fillStyle = cold ? "rgba(30,90,130,0.30)" : "rgba(130,70,20,0.30)";
  ctx.fill();
  hatch(ctx, -w / 2, -h / 2, w, h, Math.max(140, Math.min(w, h) * 0.16), 45, st, Math.max(10, Math.min(w, h) * 0.012), 0.38);
  ctx.strokeStyle = st; ctx.lineWidth = Math.max(12, Math.min(w, h) * 0.02); ctx.setLineDash(DASH_HINT);
  boxPath(ctx, w, h); ctx.stroke();
  ctx.setLineDash(DASH_NONE);
  if (env.label !== false && it.label !== false) {
  }
}

def({ id: "annot.text",    name: "文字标注",   cat: "annot", w: 2000, h: 500, fill: "transparent",
  params: [{ key: "text", name: "文字", type: "text", def: "" }],
  draw: shape(dTextAnnot, "annot", 2000, 500) });
def({ id: "annot.dim",     name: "直线尺寸标注", cat: "annot", w: 3000, h: 400, fill: "transparent",
  params: [{ key: "text", name: "尺寸文本", type: "text", def: "" }],
  draw: shape(dDim, "annot", 3000, 400) });
def({ id: "annot.north",   name: "指北针",     cat: "annot", w: 1200, h: 1200, fill: "transparent",
  draw: shape(dNorth, "annot", 1200, 1200) });
def({ id: "annot.scale",   name: "比例尺",     cat: "annot", w: 4000, h: 600, fill: "transparent",
  draw: shape(dScaleBar, "annot", 4000, 600) });
def({ id: "annot.legend",  name: "图例框",     cat: "annot", w: 3000, h: 2200, fill: "#131c27",
  draw: shape(dLegend, "annot", 3000, 2200) });
def({ id: "annot.title",   name: "标题栏",     cat: "annot", w: 6000, h: 1600, fill: "#101a25",
  draw: shape(dTitleBlock, "annot", 6000, 1600) });
def({ id: "annot.zone",    name: "区域填充(冷通道)", cat: "annot", w: 1200, h: 3000, fill: "transparent",
  params: [{ key: "type", name: "通道类型", type: "enum", options: ["cold", "hot"], def: "cold" }],
  draw: shape(dZone, "annot", 1200, 3000) });
/* ==========================================================================
 *  SVG path：注册自定义图元用
 * ========================================================================== */

/* 简单 SVG path 的手工描边（Path2D 不可用时的回退；不支持的命令按直线近似） */
function traceSvg(ctx, d) {
  const re = /[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
  const tok = String(d).match(re);
  if (!tok) throw new Error("bad path");
  ctx.beginPath();
  let cmd = "", cx = 0, cy = 0, sx = 0, sy = 0, px = 0, py = 0, ptype = "";
  let i = 0;
  while (i < tok.length) {
    if (!/^[-\d.]/.test(tok[i])) { cmd = tok[i]; i++; continue; }
    if (!cmd) { i++; continue; }
    const up = cmd.toUpperCase(), rel = (cmd !== up);
    const X = (v) => rel ? cx + v : v, Y = (v) => rel ? cy + v : v;
    const num = (k) => parseFloat(tok[i + k]);
    const has = (k) => (i + k) < tok.length && /^[-\d.]/.test(tok[i + k]);
    if (up === "Z") { ctx.closePath(); cx = sx; cy = sy; ptype = "Z"; continue; }
    if (up === "M") {
      if (!has(1)) break;
      cx = X(num(0)); cy = Y(num(1)); ctx.moveTo(cx, cy); sx = cx; sy = cy; i += 2; ptype = "M";
    } else if (up === "L") {
      if (!has(1)) break;
      cx = X(num(0)); cy = Y(num(1)); ctx.lineTo(cx, cy); i += 2; ptype = "L";
    } else if (up === "H") {
      if (!has(0)) break;
      cx = X(num(0)); ctx.lineTo(cx, cy); i += 1; ptype = "L";
    } else if (up === "V") {
      if (!has(0)) break;
      cy = Y(num(0)); ctx.lineTo(cx, cy); i += 1; ptype = "L";
    } else if (up === "C") {
      if (!has(5)) break;
      const x1 = X(num(0)), y1 = Y(num(1)), x2 = X(num(2)), y2 = Y(num(3));
      cx = X(num(4)); cy = Y(num(5));
      ctx.bezierCurveTo(x1, y1, x2, y2, cx, cy);
      px = x2; py = y2; i += 6; ptype = "C";
    } else if (up === "S") {
      if (!has(3)) break;
      const rx = (ptype === "C") ? (2 * cx - px) : cx, ry = (ptype === "C") ? (2 * cy - py) : cy;
      const x2 = X(num(0)), y2 = Y(num(1));
      cx = X(num(2)); cy = Y(num(3));
      ctx.bezierCurveTo(rx, ry, x2, y2, cx, cy);
      px = x2; py = y2; i += 4; ptype = "C";
    } else if (up === "Q") {
      if (!has(3)) break;
      const x1 = X(num(0)), y1 = Y(num(1));
      cx = X(num(2)); cy = Y(num(3));
      ctx.quadraticCurveTo(x1, y1, cx, cy);
      px = x1; py = y1; i += 4; ptype = "Q";
    } else if (up === "T") {
      if (!has(1)) break;
      const rx = (ptype === "Q") ? (2 * cx - px) : cx, ry = (ptype === "Q") ? (2 * cy - py) : cy;
      cx = X(num(0)); cy = Y(num(1));
      ctx.quadraticCurveTo(rx, ry, cx, cy);
      px = rx; py = ry; i += 2; ptype = "Q";
    } else if (up === "A") {
      if (!has(6)) break;
      cx = X(num(5)); cy = Y(num(6)); ctx.lineTo(cx, cy); i += 7; ptype = "L";
    } else { i++; }
  }
}

/* 只含 M/L/H/V/Z 的简单 path 求包围盒（用于自动缩放到图元 w/h） */
function svgBounds(d) {
  const s = String(d);
  if (/[CcSsQqTtAa]/.test(s)) return null;
  const tok = s.match(/[MmLlHhVvZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  if (!tok) return null;
  let cmd = "", cx = 0, cy = 0, i = 0, any = false;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const put = (x, y) => { any = true; if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y; };
  while (i < tok.length) {
    if (!/^[-\d.]/.test(tok[i])) { cmd = tok[i]; i++; continue; }
    if (!cmd) { i++; continue; }
    const up = cmd.toUpperCase(), rel = (cmd !== up);
    const g = (k) => parseFloat(tok[i + k]);
    const has = (k) => (i + k) < tok.length && /^[-\d.]/.test(tok[i + k]);
    if (up === "Z") { i++; continue; }
    if (up === "M" || up === "L") { if (!has(1)) break; cx = rel ? cx + g(0) : g(0); cy = rel ? cy + g(1) : g(1); put(cx, cy); i += 2; }
    else if (up === "H") { if (!has(0)) break; cx = rel ? cx + g(0) : g(0); put(cx, cy); i += 1; }
    else if (up === "V") { if (!has(0)) break; cy = rel ? cy + g(0) : g(0); put(cx, cy); i += 1; }
    else { i++; }
  }
  return any ? { minx: minx, miny: miny, maxx: maxx, maxy: maxy } : null;
}

/* 未知图元 / 失败回退 */
function placeholder(ctx, id, w, h) {
  const m = Math.min(w, h);
  ctx.save();
  ctx.strokeStyle = "#8892a0"; ctx.lineWidth = Math.max(20, m * 0.035);
  ctx.setLineDash(DASH_HINT);
  rectP(ctx, -w / 2, -h / 2, w, h); ctx.stroke();
  ctx.setLineDash(DASH_NONE);
  text(ctx, "?", 0, -m * 0.06, clamp(m * 0.46, 90, 900), "#c9d6e5", "center", "middle", "700");
  text(ctx, String(id == null ? "unknown" : id), 0, m * 0.36, clamp(m * 0.14, 70, 300), "#8892a0");
  ctx.restore();
}

/* ==========================================================================
 *  对外 API
 * ========================================================================== */

/** 列出图元（图元面板用）；cat 省略时返回全部 */
export function listSymbols(cat) {
  const out = [];
  for (const id in SYMBOLS) { const d = SYMBOLS[id]; if (!cat || d.cat === cat) out.push(d); }
  return out;
}

/** 是否存在某图元 */
export function has(id) { return !!SYMBOLS[id]; }

/**
 * 统一绘制入口。
 * 约定：调用前 ctx 已完成 translate(图元中心) + rotate(rot) + scale(env.scale)，
 *       本函数及 def.draw 只画以 (0,0) 为中心的图形，不再做任何整体变换。
 */
export function drawSymbol(ctx, id, it, env) {
  if (!ctx || !it) return;
  const e = env || EMPTY_ENV;
  const def = SYMBOLS[id] || null;
  const w = +it.w || (def && def.w) || 600;
  const h = +it.h || (def && def.h) || 600;
  if (def) { try { def.draw(ctx, it, e); } catch (err) { placeholder(ctx, id, w, h); } }
  else { placeholder(ctx, id, w, h); }
}
/* ------------------------------------------------------------------ 缩略图 */
const ICON_CACHE = new Map();

/** 图元面板缩略图：返回离屏 canvas（同一 id+px 只生成一次并缓存） */
export function iconCanvas(id, px) {
  const size = Math.max(16, Math.round(px || 48));
  const key = id + "@" + size;
  const hit = ICON_CACHE.get(key);
  if (hit) return hit;
  if (typeof document === "undefined") return null;
  const ss = (size <= 64) ? 2 : 1;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size * ss;
  const ctx = cv.getContext("2d");
  const def = SYMBOLS[id] || null;
  const accent = def ? (CAT_COLOR[def.cat] || "#8892a0") : "#8892a0";
  /* 淡色底 + 描边 */
  ctx.fillStyle = "#0d1620";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1, ss);
  ctx.strokeRect(ss / 2, ss / 2, cv.width - ss, cv.height - ss);
  if (def) {
    const w = +def.w || 600, h = +def.h || 600;
    const pad = cv.width * 0.16;
    const s = Math.min((cv.width - 2 * pad) / w, (cv.height - 2 * pad) / h);
    ctx.save();
    ctx.translate(cv.width / 2, cv.height / 2);
    ctx.scale(s, s);
    ctx.lineJoin = "round";
    try { def.draw(ctx, { w: w, h: h, params: {}, name: def.name, label: false, user: {} }, ICON_ENV); }
    catch (err) { /* 回退：保持已画内容 */ }
    ctx.restore();
  }
  ICON_CACHE.set(key, cv);
  return cv;
}

/* ------------------------------------------------------------------ 扩展 */
function defaultDraw(ctx, it) {
  const w = +it.w || 600, h = +it.h || 600;
  boxPath(ctx, w, h);
  ctx.fillStyle = "#2b3138"; ctx.fill();
  ctx.strokeStyle = "#c9d6e5"; ctx.lineWidth = Math.max(18, Math.min(w, h) * 0.03); ctx.stroke();
}

/**
 * ★ 扩展：注册自定义图元
 * register({ id, name, cat, w, h, fill, stroke, bind, anchor, ports, params, draw(ctx,it,env) })
 * draw 收到的是"已 translate(中心)+rotate+scale"的 ctx，只需从原点画。
 * 返回规范化后的 SymbolDef。
 */
export function register(d) {
  if (!d || !d.id) throw new Error("symbols.register(def): def.id 必填");
  const id = String(d.id);
  const base = SYMBOLS[id] || null;
  const cat = d.cat || (base && base.cat) || "annot";
  const pal = C[cat] || C.annot;
  const out = {
    id: id,
    name: d.name || (base && base.name) || id,
    cat: cat,
    w: +d.w || (base && base.w) || 600,
    h: +d.h || (base && base.h) || 600,
    fill: d.fill || (base && base.fill) || pal.fill,
    stroke: d.stroke || (base && base.stroke) || CAT_COLOR[cat] || pal.stroke,
    bind: d.bind === undefined ? (base ? base.bind : null) : d.bind,
    anchor: d.anchor || { x: 0, y: 0 },
    ports: d.ports || [],
    params: d.params || [],
    custom: true,
  };
  const raw = (typeof d.draw === "function") ? d.draw : ((base && base._raw) || defaultDraw);
  out._raw = raw;
  out.draw = wrapDraw(raw, out.w, out.h, out.cat, out.id, out.name, out.bind);
  SYMBOLS[id] = out;
  ICON_CACHE.clear();
  return out;
}

/**
 * ★ 扩展：用 SVG path 数据注册图元（Path2D；不支持时手工解析；都失败则矩形占位）
 * registerFromSvg('custom.tri', { name:'三角形', cat:'annot', w:600, h:600, fill:'#2b3138', stroke:'#7fd8ff' },
 *                 'M0-50 L50 50 L-50 50 Z')
 */
export function registerFromSvg(id, meta, pathD) {
  const m = meta || {};
  const w = +m.w || 600, h = +m.h || 600;
  const cat = m.cat || "annot";
  const pal = C[cat] || C.annot;
  const fill = m.fill || pal.fill;
  const stroke = m.stroke || pal.stroke;
  let path = null;
  if (typeof Path2D !== "undefined") { try { path = new Path2D(pathD); } catch (e) { path = null; } }
  const bounds = path ? svgBounds(pathD) : null;
  const raw = function (ctx, it) {
    const iw = +it.w || w, ih = +it.h || h;
    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(14, Math.min(iw, ih) * 0.035);
    ctx.lineJoin = "round";
    if (path) {
      if (bounds) {
        const bw = Math.max(1e-6, bounds.maxx - bounds.minx), bh = Math.max(1e-6, bounds.maxy - bounds.miny);
        const s = Math.min(iw / bw, ih / bh) * 0.88;
        const cx = (bounds.minx + bounds.maxx) / 2, cy = (bounds.miny + bounds.maxy) / 2;
        ctx.translate(-cx * s, -cy * s);
        ctx.scale(s, s);
      } else {
        const s = Math.min(iw, ih) / 600;
        ctx.scale(s, s);
      }
      if (fill !== "transparent" && fill !== "none") ctx.fill(path);
      if (stroke && stroke !== "none") ctx.stroke(path);
    } else {
      try {
        if (bounds) {
          const bw = Math.max(1e-6, bounds.maxx - bounds.minx), bh = Math.max(1e-6, bounds.maxy - bounds.miny);
          const s = Math.min(iw / bw, ih / bh) * 0.88;
          const cx = (bounds.minx + bounds.maxx) / 2, cy = (bounds.miny + bounds.maxy) / 2;
          ctx.translate(-cx * s, -cy * s);
          ctx.scale(s, s);
        } else { const s = Math.min(iw, ih) / 600; ctx.scale(s, s); }
        traceSvg(ctx, pathD);
        if (fill !== "transparent" && fill !== "none") ctx.fill();
        if (stroke && stroke !== "none") ctx.stroke();
      } catch (e) {
        const mm = Math.min(iw, ih);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = Math.max(14, mm * 0.03);
        rectP(ctx, -iw / 2, -ih / 2, iw, ih); ctx.stroke();
        seg(ctx, -iw / 2, -ih / 2, iw / 2, ih / 2);
      }
    }
    ctx.restore();
  };
  const d = {
    id: String(id), name: m.name || String(id), cat: cat, w: w, h: h,
    fill: fill, stroke: stroke,
    bind: m.bind === undefined ? null : m.bind,
    anchor: m.anchor || { x: 0, y: 0 },
    ports: m.ports || [],
    params: m.params || [],
    svg: true, custom: true,
  };
  d._raw = raw;
  d.draw = wrapDraw(raw, w, h, cat, d.id, d.name, d.bind);
  SYMBOLS[d.id] = d;
  ICON_CACHE.clear();
  return d;
}

/* ------------------------------------------------------------------ 汇总 */
const api = {
  CATEGORIES: CATEGORIES,
  SYMBOLS: SYMBOLS,
  drawSymbol: drawSymbol,
  listSymbols: listSymbols,
  iconCanvas: iconCanvas,
  register: register,
  registerFromSvg: registerFromSvg,
  has: has,
  get count() { return Object.keys(SYMBOLS).length; },
  version: "1.0.0",
};

if (typeof window !== "undefined") {
  const IDC = window.IDC || (window.IDC = {});
  IDC.symbols = api;
}

export default api;