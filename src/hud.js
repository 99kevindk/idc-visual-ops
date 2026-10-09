/* =========================================================================
 *  src/hud.js — 【ui-hud】六大页面 HUD：深色科技风面板 + Canvas 2D 手绘图表
 *  只依赖 window.IDC 命名空间（IDC.data / IDC.bus / IDC.scene / IDC.xiaowei），
 *  不 import 任何模块，可被 esbuild 直接打包（IIFE）。
 * ========================================================================= */
(function (global) {
  "use strict";
  const IDC = (global.IDC = global.IDC || {});
  const TAU = Math.PI * 2;
  const D = () => IDC.data || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const commas = (v) => Number(v).toLocaleString("en-US");
  const pad2 = (n) => String(n).padStart(2, "0");
  function hexA(hex, a) {
    const h = String(hex).replace("#", "");
    const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const v = parseInt(n, 16);
    return "rgba(" + ((v >> 16) & 255) + "," + ((v >> 8) & 255) + "," + (v & 255) + "," + a + ")";
  }

  /* ---------------- 主题常量 ---------------- */
  const LEVEL = {
    critical: { t: "严重", c: "#ff4d4f", k: "crit" },
    warning: { t: "一般", c: "#f5a524", k: "warn" },
    info: { t: "提示", c: "#2f7fe8", k: "info" },
    plan: { t: "计划", c: "#22c55e", k: "ok" },
  };
  const WO_STATUS = {
    pending: { t: "待处理", k: "warn" },
    doing: { t: "进行中", k: "info" },
    verify: { t: "待核验", k: "violet" },
    done: { t: "已完成", k: "ok" },
  };
  const ALARM_ORDER = ["A-02", "D-07", "E-05", "C-05"];
  function orderedAlarms(list) {
    return (list || []).slice().sort((a, b) => {
      const ia = ALARM_ORDER.indexOf(a.rackId), ib = ALARM_ORDER.indexOf(b.rackId);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }

  /* ---------------- 内联 SVG 图标（禁止 emoji / 外链） ---------------- */
  const SVG = (p, w) => '<svg class="ico" viewBox="0 0 16 16" width="' + (w || 14) + '" height="' + (w || 14) + '" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">' + p + "</svg>";
  const ICO = {
    temp: SVG('<path d="M8 2.4a1.6 1.6 0 0 1 1.6 1.6v5a2.4 2.4 0 1 1-3.2 0v-5A1.6 1.6 0 0 1 8 2.4z"/><path d="M8 7.2v3.6"/>'),
    hum: SVG('<path d="M8 2.4s4 4.3 4 6.7a4 4 0 0 1-8 0C4 6.7 8 2.4 8 2.4z"/>'),
    pue: SVG('<path d="M9 2 4 9h3l-1 5 5-7H8l1-5z"/>'),
    alert: SVG('<path d="M8 2.6 14.2 13H1.8L8 2.6z"/><path d="M8 6.6v3.1M8 11.6h.01"/>'),
    cube: SVG('<path d="M8 2 14 5.2v5.6L8 14 2 10.8V5.2L8 2z"/><path d="M2 5.2 8 8.4l6-3.2M8 8.4V14"/>'),
    pin: SVG('<path d="M8 14s4.4-4.4 4.4-7.3A4.4 4.4 0 0 0 3.6 6.7C3.6 9.6 8 14 8 14z"/><circle cx="8" cy="6.8" r="1.6"/>'),
    grid: SVG('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 6.5h11M6.5 2.5v11"/>'),
    clock: SVG('<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8v3.4l2.2 1.3"/>'),
    check: SVG('<path d="M3.4 8.4 6.6 11.6 12.6 4.8"/>'),
    mic: SVG('<rect x="6.2" y="2.4" width="3.6" height="7" rx="1.8"/><path d="M4.4 8a3.6 3.6 0 0 0 7.2 0M8 11.6V14"/>'),
    send: SVG('<path d="M2.6 8 13.4 3 9.4 13l-2-4.3L2.6 8z"/>'),
    search: SVG('<circle cx="7.2" cy="7.2" r="4.4"/><path d="M10.6 10.6 14 14"/>'),
    updown: SVG('<path d="M5 3.4 7 6H3l2-2.6zM5 12.6 3 10h4l-2 2.6z"/>'),
  };

  /* =======================================================================
   *  Canvas 2D 手绘图表引擎
   * ======================================================================= */
  function ctxOf(cv) {
    if (!cv) return null;
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    const w = Math.round(cv.clientWidth || 0), h = Math.round(cv.clientHeight || 0);
    if (w < 2 || h < 2) return null;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }
  function niceCeil(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    const m = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 6 ? 6 : n <= 8 ? 8 : 10;
    return m * p;
  }
  function rr(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  const FONT = "'Microsoft YaHei','PingFang SC',system-ui,sans-serif";

  /** 环形仪表（270° 弧 + 刻度 + 中心数值） */
  function drawGauge(cv, pct, o) {
    const g = ctxOf(cv); if (!g) return;
    const ctx = g.ctx, w = g.w, h = g.h; o = o || {};
    const cx = w / 2, cy = h / 2, lw = o.lw || 8;
    const r = Math.min(w, h) / 2 - (o.pad == null ? 5 : o.pad) - lw / 2;
    if (r < 6) return;
    const a0 = Math.PI * 0.72, a1 = Math.PI * 2.28;
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1);
    ctx.lineWidth = lw; ctx.strokeStyle = o.track || "rgba(64,180,255,.14)"; ctx.stroke();
    const p = clamp(pct, 0, 1);
    if (p > 0.004) {
      const gr = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      gr.addColorStop(0, o.c1 || "#35e0ff"); gr.addColorStop(1, o.c2 || "#2f7fe8");
      ctx.save();
      ctx.shadowColor = o.glow || "rgba(34,211,238,.8)"; ctx.shadowBlur = 9;
      ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * p);
      ctx.lineWidth = lw; ctx.strokeStyle = gr; ctx.stroke();
      ctx.restore();
    }
    for (let i = 0; i <= 24; i++) {
      const a = a0 + (a1 - a0) * (i / 24);
      const r1 = r - lw / 2 - 2.5, r2 = r1 - (i % 6 === 0 ? 4 : 2);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.strokeStyle = i / 24 <= p ? "rgba(53,224,255,.55)" : "rgba(64,180,255,.15)";
      ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    if (o.value != null) {
      ctx.save();
      ctx.fillStyle = o.textColor || "#ecf9ff";
      ctx.font = "700 " + (o.size || 24) + "px " + FONT;
      ctx.shadowColor = "rgba(34,211,238,.65)"; ctx.shadowBlur = 12;
      ctx.fillText(o.value, cx, cy - (o.sub ? 5 : 0));
      ctx.restore();
    }
    if (o.sub) {
      ctx.fillStyle = o.subColor || "#8aa0bd";
      ctx.font = "600 " + (o.subSize || 10) + "px " + FONT;
      ctx.fillText(o.sub, cx, cy + (o.subDy || 15));
    }
  }

  /** 环图 / 甜甜圈 */
  function drawDonut(cv, items, o) {
    const g = ctxOf(cv); if (!g) return;
    const ctx = g.ctx, w = g.w, h = g.h; o = o || {};
    const cx = w / 2, cy = h / 2, lw = o.lw || 12;
    const r = Math.min(w, h) / 2 - lw / 2 - 3;
    if (r < 6) return;
    const total = items.reduce((s, i) => s + (i.pct || 0), 0) || 1;
    const gap = o.gap == null ? 0.05 : o.gap;
    let a = -Math.PI / 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU);
    ctx.lineWidth = lw + 2; ctx.strokeStyle = "rgba(64,180,255,.08)"; ctx.stroke();
    items.forEach((it) => {
      const span = (it.pct / total) * TAU;
      if (span <= 0.002) { a += span; return; }
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r, a + gap / 2, a + span - gap / 2);
      ctx.lineWidth = lw; ctx.lineCap = "butt";
      ctx.strokeStyle = it.color;
      ctx.shadowColor = hexA(it.color, .5); ctx.shadowBlur = 6;
      ctx.stroke();
      ctx.restore();
      a += span;
    });
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    if (o.top != null) {
      ctx.save();
      ctx.fillStyle = o.topColor || "#ecf9ff";
      ctx.font = "700 " + (o.topSize || 21) + "px " + FONT;
      ctx.shadowColor = "rgba(34,211,238,.5)"; ctx.shadowBlur = 10;
      ctx.fillText(o.top, cx, cy - (o.sub ? 7 : 0));
      ctx.restore();
    }
    if (o.sub) {
      ctx.fillStyle = "#8aa0bd"; ctx.font = "600 9.5px " + FONT;
      ctx.fillText(o.sub, cx, cy + 11);
    }
  }

  /** 迷你趋势线 */
  function drawSpark(cv, vals, color, o) {
    const g = ctxOf(cv); if (!g) return;
    const ctx = g.ctx, w = g.w, h = g.h; o = o || {};
    if (!vals || vals.length < 2) return;
    const pad = o.pad == null ? 4 : o.pad;
    let mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    if (mx - mn < 1e-6) { mx += 1; mn -= 1; }
    const X = (i) => pad + (w - pad * 2) * (i / (vals.length - 1));
    const Y = (v) => h - pad - (h - pad * 2) * ((v - mn) / (mx - mn));
    ctx.beginPath(); ctx.moveTo(X(0), Y(vals[0]));
    for (let i = 1; i < vals.length; i++) ctx.lineTo(X(i), Y(vals[i]));
    const last = vals.length - 1;
    ctx.lineTo(X(last), h); ctx.lineTo(X(0), h); ctx.closePath();
    const ag = ctx.createLinearGradient(0, 0, 0, h);
    ag.addColorStop(0, hexA(color, .30)); ag.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = ag; ctx.fill();
    ctx.beginPath(); ctx.moveTo(X(0), Y(vals[0]));
    for (let i = 1; i < vals.length; i++) ctx.lineTo(X(i), Y(vals[i]));
    ctx.strokeStyle = color; ctx.lineWidth = o.lw || 1.5; ctx.lineJoin = "round";
    ctx.save(); ctx.shadowColor = hexA(color, .8); ctx.shadowBlur = 6; ctx.stroke(); ctx.restore();
    ctx.beginPath(); ctx.arc(X(last), Y(vals[last]), 2.1, 0, TAU);
    ctx.fillStyle = color; ctx.fill();
  }

  /** 柱状图 */
  function drawBars(cv, vals, o) {
    const g = ctxOf(cv); if (!g) return;
    const ctx = g.ctx, w = g.w, h = g.h; o = o || {};
    const padL = o.padL || 0, padR = o.padR || 0;
    const padT = o.padT == null ? 6 : o.padT, padB = o.padB == null ? 14 : o.padB;
    const iw = w - padL - padR, ih = h - padT - padB;
    if (iw <= 2 || ih <= 2 || !vals.length) return;
    let mx = 0; vals.forEach((v) => { if (v > mx) mx = v; });
    mx = (mx || 1) * (o.headroom || 1.15);
    const n = vals.length;
    if (o.yTicks) mx = niceCeil(mx);
    const gap = o.gap == null ? clamp(iw / n * 0.34, 1, 8) : o.gap;
    const bwRaw = Math.max(1, (iw - gap * (n - 1)) / n);
    const bw = o.maxBarW ? Math.min(bwRaw, o.maxBarW) : bwRaw;
    const off = padL + Math.max(0, (iw - (n * bw + (n - 1) * gap)) / 2);
    if (o.grid) {
      ctx.strokeStyle = "rgba(64,180,255,.09)"; ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = padT + ih * (i / 4);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      }
    }
    for (let i = 0; i < n; i++) {
      const bh = Math.max(1, ih * (vals[i] / mx));
      const x = off + i * (bw + gap), y = padT + ih - bh;
      const gr = ctx.createLinearGradient(0, y, 0, padT + ih);
      gr.addColorStop(0, o.c1 || "#ffd166");
      gr.addColorStop(1, o.c2 || "rgba(245,165,36,.16)");
      ctx.fillStyle = gr;
      if (o.hot != null && i === o.hot) { ctx.save(); ctx.shadowColor = "rgba(255,209,102,.9)"; ctx.shadowBlur = 8; }
      rr(ctx, x, y, bw, bh, Math.min(2, bw / 2)); ctx.fill();
      if (o.hot != null && i === o.hot) ctx.restore();
    }
    if (o.yTicks) {
      ctx.fillStyle = "#5f7791"; ctx.font = "9px " + FONT;
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (let i = 0; i <= 4; i++) {
        const y = padT + ih * (i / 4);
        const v = mx * (1 - i / 4);
        ctx.fillText(o.yFmt ? o.yFmt(v) : commas(Math.round(v)), padL - 5, y);
      }
    }
    if (o.labels) {
      ctx.fillStyle = "#5f7791"; ctx.font = "9px " + FONT;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      for (let i = 0; i < n; i++) {
        if (o.xEvery && i % o.xEvery) continue;
        if (o.labels[i] == null) continue;
        ctx.fillText(o.labels[i], off + i * (bw + gap) + bw / 2, padT + ih + 3);
      }
      if (o.tail) {
        ctx.textAlign = "right";
        ctx.fillText(o.tail, off + n * bw + (n - 1) * gap, padT + ih + 3);
      }
    }
    return { padL: padL, padT: padT, ih: ih, bw: bw, gap: gap, n: n, off: off };
  }

  /** 折线图（带 Y 轴 / 网格 / 面积渐变） */
  function drawLine(cv, vals, o) {
    const g = ctxOf(cv); if (!g) return;
    const ctx = g.ctx, w = g.w, h = g.h; o = o || {};
    const padL = o.padL == null ? 26 : o.padL, padR = o.padR == null ? 7 : o.padR;
    const padT = o.padT == null ? 8 : o.padT, padB = o.padB == null ? 16 : o.padB;
    const iw = w - padL - padR, ih = h - padT - padB;
    if (iw <= 2 || ih <= 2 || !vals || vals.length < 2) return;
    let mn = o.min != null ? o.min : Math.min.apply(null, vals);
    let mx = o.max != null ? o.max : Math.max.apply(null, vals);
    if (mx - mn < 1e-6) { mx += .5; mn -= .5; }
    const pd = (mx - mn) * (o.padRatio == null ? 0.22 : o.padRatio);
    mn -= pd; mx += pd;
    const X = (i) => padL + iw * (i / (vals.length - 1));
    const Y = (v) => padT + ih * (1 - (v - mn) / (mx - mn));
    const ticks = o.yTicks || 3;
    ctx.font = "9px " + FONT;
    for (let i = 0; i <= ticks; i++) {
      const y = padT + ih * (i / ticks);
      ctx.strokeStyle = "rgba(64,180,255,.10)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      const v = mx - (mx - mn) * (i / ticks);
      ctx.fillStyle = "#5f7791"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(o.yFmt ? o.yFmt(v) : v.toFixed(1), padL - 5, y);
    }
    ctx.beginPath(); ctx.moveTo(X(0), Y(vals[0]));
    for (let i = 1; i < vals.length; i++) ctx.lineTo(X(i), Y(vals[i]));
    const last = vals.length - 1;
    ctx.lineTo(X(last), padT + ih); ctx.lineTo(X(0), padT + ih); ctx.closePath();
    const ag = ctx.createLinearGradient(0, padT, 0, padT + ih);
    ag.addColorStop(0, hexA(o.color || "#35e0ff", .30)); ag.addColorStop(1, hexA(o.color || "#35e0ff", 0));
    ctx.fillStyle = ag; ctx.fill();
    ctx.beginPath(); ctx.moveTo(X(0), Y(vals[0]));
    for (let i = 1; i < vals.length; i++) ctx.lineTo(X(i), Y(vals[i]));
    ctx.strokeStyle = o.color || "#35e0ff"; ctx.lineWidth = 1.6; ctx.lineJoin = "round";
    ctx.save(); ctx.shadowColor = hexA(o.color || "#35e0ff", .75); ctx.shadowBlur = 7; ctx.stroke(); ctx.restore();
    ctx.beginPath(); ctx.arc(X(last), Y(vals[last]), 2.4, 0, TAU);
    ctx.fillStyle = o.color || "#35e0ff"; ctx.fill();
    if (o.labels) {
      ctx.fillStyle = "#5f7791"; ctx.font = "9px " + FONT;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      for (let i = 0; i < vals.length; i++) {
        if (o.xEvery && i % o.xEvery) continue;
        if (o.labels[i] == null) continue;
        ctx.fillText(o.labels[i], X(i), padT + ih + 3);
      }
    }
    return { X: X, Y: Y, padL: padL, padT: padT, ih: ih, iw: iw };
  }

  /** 迷你等轴测机柜预览 */
  function drawIsoRack(cv, rack) {
    const g = ctxOf(cv); if (!g) return;
    const ctx = g.ctx, w = g.w, h = g.h;
    if (!rack) return;
    const s = Math.min(w / 2.75, h / 3.5);
    const cx = w / 2, cy = h / 2 + s * 0.55;
    const P = (x, y, z) => [cx + (x - z) * s, cy + (x + z) * s * 0.5 - y * s];
    const W2 = 0.52, D2 = 0.24, H = 2.3;
    const poly = (pts, fill, stroke) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    };
    // 底座光晕
    const bg = ctx.createRadialGradient(cx, cy + 0.35 * s, 1, cx, cy + 0.35 * s, s * 1.5);
    bg.addColorStop(0, hexA(rack.status === "alarm" ? "#ff4d4f" : rack.status === "offline" ? "#5b6b80" : "#22d3ee", .28));
    bg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.ellipse(cx, cy + 0.3 * s, s * 1.45, s * 0.42, 0, 0, TAU); ctx.fill();
    const A = P(-W2, 0, D2), B = P(W2, 0, D2), C = P(W2, H, D2), Dp = P(-W2, H, D2);
    const B2 = P(W2, 0, -D2), C2 = P(W2, H, -D2), D2p = P(-W2, H, -D2), A2 = P(-W2, 0, -D2);
    poly([Dp, C, C2, D2p], "rgba(20,42,68,.95)", "rgba(90,190,255,.45)");
    poly([B, B2, C2, C], "rgba(11,26,44,.95)", "rgba(90,190,255,.35)");
    poly([A, B, C, Dp], "rgba(8,20,35,.96)", "rgba(90,190,255,.5)");
    // U 位设备块
    const dn = rack.devices || [];
    dn.forEach((d) => {
      const y0 = ((d.uStart - 1) / rack.uTotal) * H;
      const y1 = ((d.uStart - 1 + d.uSize) / rack.uTotal) * H;
      const col = d.status === "alarm" ? "#ff4d4f" : d.status === "offline" ? "#5b6b80" : d.status === "warn" ? "#f5a524" : "#2f7fe8";
      poly([P(-W2 + 0.05, y1, D2 + 0.001), P(W2 - 0.05, y1, D2 + 0.001), P(W2 - 0.05, y0 + 0.02, D2 + 0.001), P(-W2 + 0.05, y0 + 0.02, D2 + 0.001)], hexA(col, .82), hexA(col, .9));
    });
    if (rack.status === "alarm") {
      ctx.save();
      ctx.strokeStyle = "rgba(255,77,79,.85)"; ctx.lineWidth = 1.4;
      ctx.shadowColor = "rgba(255,77,79,.9)"; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.ellipse(cx, cy + 0.3 * s, s * 1.5, s * 0.45, 0, 0, TAU); ctx.stroke();
      ctx.restore();
    }
  }
  /* =======================================================================
   *  通用 DOM 片段
   * ======================================================================= */
  const CORNERS = '<i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>';
  function panel(o) {
    return '<section class="pnl ' + (o.cls || "") + '" data-panel>' + CORNERS +
      '<div class="pnl-hd"><i class="hd-bar"></i><div class="hd-tt"><h3>' + o.title + "</h3>" +
      (o.en ? '<span class="en">' + o.en + "</span>" : "") + "</div>" +
      (o.act ? '<div class="hd-act">' + o.act + "</div>" : "") +
      "</div>" +
      '<div class="pnl-bd ' + (o.bd || "") + '">' + (o.body || "") + "</div></section>";
  }
  function ps(label, id, val, unit, cls) {
    return '<div class="ps ' + (cls || "") + '"><span class="ps-lb">' + label + "</span>" +
      '<div class="ps-v"><b id="' + id + '">' + val + "</b>" + (unit ? "<i>" + unit + "</i>" : "") + "</div></div>";
  }
  function chip(t, k) { return '<i class="tag ' + (k || "") + '">' + t + "</i>"; }
  function envRow(id, ico, label, val, unit, color, chart) {
    return '<div class="env-row"><span class="eico" style="color:' + color + '">' + ico + "</span>" +
      '<span class="elb">' + label + "</span>" +
      '<b class="eval" id="' + id + '">' + val + (unit ? '<i class="u">' + unit + "</i>" : "") + "</b>" +
      '<canvas class="cv spark" data-c="' + chart + '"></canvas></div>';
  }

  /* =======================================================================
   *  页面 1 · 总览
   * ======================================================================= */
  function buildOverview() {
    const left =
      panel({
        title: "机房运行状态", en: "OPERATION STATUS", cls: "fx-a", body:
          '<div class="run-flex">' +
            '<div class="gauge-wrap"><canvas class="cv" data-c="runGauge"></canvas></div>' +
            '<div class="statlist">' +
              '<div class="st-row"><i class="dot cyan"></i><span>设备总数</span><b id="ovDeviceTotal">256</b></div>' +
              '<div class="st-row"><i class="dot cyan2"></i><span>在线设备</span><b id="ovDeviceOnline">252</b></div>' +
              '<div class="st-row"><i class="dot crit"></i><span>告警设备</span><b class="red" id="ovDeviceAlarm">4</b></div>' +
              '<div class="st-row"><i class="dot warn"></i><span>维护中</span><b id="ovDeviceMaintain">0</b></div>' +
            "</div>" +
          "</div>",
      }) +
      panel({
        title: "环境监控（平均）", en: "ENVIRONMENT", cls: "fx-a", body:
          envRow("ovTemp", ICO.temp, "温度", "24.3", "℃", "#f5a524", "sparkTemp") +
          envRow("ovHum", ICO.hum, "湿度", "45.2", "%", "#35e0ff", "sparkHum") +
          envRow("ovPue", ICO.pue, "PUE", "1.36", "", "#2fd9c8", "sparkPue"),
      }) +
      panel({
        title: "告警统计", en: "ALARM STATISTICS", cls: "fx-1",
        act: '<span class="chip">最近24小时</span>',
        body:
          '<div class="stat4">' +
            '<div class="s4"><b class="cyan" id="ovAlarmTotal">12</b><span>告警总数</span></div>' +
            '<div class="s4"><b class="red" id="ovAlarmCrit">2</b><span>严重</span></div>' +
            '<div class="s4"><b class="amber" id="ovAlarmWarn">4</b><span>一般</span></div>' +
            '<div class="s4"><b class="blue" id="ovAlarmInfo">6</b><span>提示</span></div>' +
          "</div>" +
          '<canvas class="cv fill" data-c="alarm24"></canvas>',
      });

    const center =
      '<div class="col center"><div class="center-layer">' +
        '<div class="ct-top"><i class="ct-line l"></i><span>机房实时总览</span><i class="ct-line r"></i></div>' +
        '<button class="float-card alarm-card" data-panel data-ask="巡检 A-02">' +
          '<span class="fc-tag">严重告警</span>' +
          '<span class="fc-main"><b>A-02</b><span>送风温度过高</span></span>' +
          '<span class="fc-link">让小维看看 →</span>' +
        "</button>" +
        '<div class="ct-bottom">' +
          '<span class="lg"><i class="dot ok"></i>正常运行</span>' +
          '<span class="lg"><i class="dot crit"></i>告警中</span>' +
          '<span class="lg"><i class="dot off"></i>已离线</span>' +
          '<span class="upd">数据更新于 <b id="ovUpdate">10:26:08</b></span>' +
        "</div>" +
      "</div></div>";

    const right =
      panel({
        title: "IT 负载", en: "IT LOAD", cls: "fx-1", body:
          '<div class="it-top">' +
            '<div class="gauge-wrap sm"><canvas class="cv" data-c="itGauge"></canvas></div>' +
            '<div class="it-kw"><b id="ovItKw">12.6</b><span class="sl">/</span><span id="ovItCap">18.5</span><i>kW</i></div>' +
          "</div>" +
          '<div class="mini-cap"><span>日曲线</span></div>' +
          '<canvas class="cv" data-c="itLine" style="height:42px"></canvas>',
      }) +
      panel({
        title: "能耗趋势", en: "ENERGY CONSUMPTION", cls: "fx-1",
        act: '<div class="mtabs" data-group="etab"><button class="mtab on" data-etab="day">日</button><button class="mtab" data-etab="week">周</button><button class="mtab" data-etab="month">月</button></div>',
        body:
          '<div class="en-head">' +
            '<div class="en-left"><span class="lbl">今日能耗</span>' +
              '<div class="big"><b id="ovEnergyToday">28,430</b><span class="u">kWh</span></div></div>' +
            '<div class="en-delta"><i class="down">↓</i><b id="ovEnergyDelta">-6.8%</b><span>较昨日</span></div>' +
          "</div>" +
          '<canvas class="cv fill" data-c="energyBars"></canvas>',
      }) +
      panel({
        title: "设备类型占比", en: "DEVICE DISTRIBUTION", cls: "fx-1", body:
          '<div class="mix-wrap">' +
            '<div class="donut-wrap"><canvas class="cv" data-c="donutMix"></canvas></div>' +
            '<ul class="legend" id="ovMixLegend"></ul>' +
          "</div>",
      });

    return '<div class="hud-page" data-pg="overview"><div class="page-body cols">' +
      '<div class="col">' + left + "</div>" + center + '<div class="col">' + right + "</div>" +
      "</div>" + badge() + "</div>";
  }

  /* =======================================================================
   *  页面 2 · 机房监控
   * ======================================================================= */
  function buildMonitor() {
    const left =
      panel({
        title: "设备定位", en: "DEVICE EXPLORER", cls: "fx-a", body:
          '<select class="rack-sel" id="rackSel"></select>' +
          '<div class="pnl-foot">示例状态 · 本地交互</div>',
      }) +
      panel({
        title: "当前告警", en: "CURRENT ALARMS", cls: "fx-1",
        act: '<span class="chip crit" id="monAlarmCount">4</span>',
        body: '<div class="alarm-list" id="monAlarmList"></div>',
      });

    const center =
      '<div class="col center"><div class="center-layer">' +
        '<div class="mon-strip"><span class="ms-title">— <b id="monRackTitle">A-02</b> · 设备概览</span>' +
          '<button class="mbtn" data-act="whole-room">查看整间机房</button>' +
          '<span class="ms-right">' +
            '<button class="mbtn" id="monToggle" data-act="mon-toggle">查看处置详情</button>' +
            '<button class="mbtn ghost" data-act="back-overview">← 返回总览</button>' +
          '</span></div>' +
        '<div class="mon-hint">点击机柜查看 · 拖动旋转 · 滚轮缩放 · <span class="ok-t">4 台设备告警</span> · 点击查看</div>' +
        '<div class="mon-detail hidden" data-panel id="monDetail"></div>' +
      "</div></div>";

    const right =
      '<div class="col">' +
      '<section class="pnl asst fx-1" data-panel>' + CORNERS +
        '<div class="pnl-hd"><i class="hd-bar"></i><div class="hd-tt"><h3>小维 · 巡检助手</h3><span class="en">AI ASSISTANT · 本地指令演示</span></div></div>' +
        '<div class="pnl-bd asst-bd">' +
          '<div class="asst-tabs"><button class="atab on" data-atab="chat">巡检对话</button><button class="atab" data-atab="dev">设备详情</button></div>' +
          '<div class="asst-pane" data-pane="chat">' +
            '<div class="chat-stream" id="chatStream"></div>' +
            '<div class="closure"><div class="cl-hd"><span id="closureTitle">A-02 · 处理闭环</span>' +
              '<i class="tag warn" id="closureTag">告警待确认</i></div>' +
              '<div class="cl-next" id="closureNext">下一步：确认告警 →</div></div>' +
            '<div class="asst-btns">' +
              '<button class="abtn" data-ask="巡检 A-02">巡检 A-02</button>' +
              '<button class="abtn" data-ask="当前告警">当前告警</button>' +
              '<button class="abtn" data-ask="继续巡检">继续巡检</button>' +
            "</div>" +
            '<div class="asst-sw"><button class="abtn ghost" id="wakeToggle">关闭语音唤醒</button>' +
              '<label class="chk"><input type="checkbox" id="speakChk" checked /><i></i><span>语音播报</span></label></div>' +
            '<div class="chat-status" id="chatStatus"></div>' +
            '<div class="chat-input">' +
              '<input id="chatInput" placeholder="例如：查看 A-02 的状态" autocomplete="off" />' +
              '<button class="sq mic" id="chatMic" title="语音输入">' + ICO.mic + "</button>" +
              '<button class="sq send" id="chatSend" title="发送">' + ICO.send + "</button>" +
            "</div>" +
          "</div>" +
          '<div class="asst-pane hidden" data-pane="dev"><div class="dev-detail" id="assistDev"></div></div>' +
        "</div></section></div>";

    return '<div class="hud-page" data-pg="monitor">' + "<div class=\"page-body cols\">" +
      '<div class="col">' + left + "</div>" + center + right +
      "</div>" + badge() + "</div>";
  }
  function badge(t) { return '<div class="demo-badge">' + (t || "本地演示数据 · 示例数据") + "</div>"; }
  function pageHead(title, sub, stats) {
    return '<div class="page-hd"><div class="ph-top"><h2>' + title + "</h2><p>" + sub + "</p>" +
      '<span class="ph-tag">本地演示数据 · <b id="phDate">2026.11.02</b></span></div>' +
      '<div class="ph-stats">' + (stats || "") + "</div></div>";
  }

  /* =======================================================================
   *  页面 3 · 资产管理
   * ======================================================================= */
  function buildAssets() {
    const stats =
      ps("机柜总数", "kpiRackTotal", "42", "个") +
      ps("运行正常", "kpiRacksNormal", "37", "个") +
      ps("异常设备", "kpiDeviceAlarm", "4", "台") +
      ps("设备总数", "kpiDeviceTotal", "256", "台");
    const left = panel({
      title: "机房分区", en: "ZONE TREE", cls: "fx-1",
      act: '<span class="chip" id="treeCount">42 台</span>',
      body: '<div class="tree" id="zoneTree"></div>',
    });
    const center = panel({
      title: "设备台账", en: "DEVICE LEDGER", cls: "fx-1",
      act: '<span class="chip" id="ledgerCount">共 256 台设备</span>',
      body:
        '<div class="search-box">' + ICO.search +
          '<input id="devSearch" placeholder="搜索设备或资产编号…" autocomplete="off" />' +
          '<span class="sb-hint">平台提示：示例数据</span></div>' +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
          "<th>设备名称</th><th>型号</th><th>状态</th><th>告警</th><th>容量</th><th>所属机柜(U位)</th><th>操作</th>" +
        '</tr></thead><tbody id="devTbody"></tbody></table>' +
        '<div class="tbl-foot"><span id="tblFoot">共 256 台设备</span><span>第 1 / 1 页</span></div></div>',
    });
    const right = panel({
      title: "资产详情", en: "ASSET DETAIL", cls: "fx-1",
      body: '<div class="asset-detail" id="assetDetail"></div>',
    });
    return '<div class="hud-page" data-pg="assets">' + pageHead("资产全景", "在同一份设备台账中定位、检视或发起巡检。", stats) +
      '<div class="page-body cols"><div class="col">' + left + '</div><div class="col">' + center +
      '</div><div class="col">' + right + "</div></div>" + badge() + "</div>";
  }

  /* =======================================================================
   *  页面 4 · 能效管理
   * ======================================================================= */
  function buildEnergy() {
    const stats =
      ps("今日累计能耗", "kpiEnergyMonth", "210,785", "kWh") +
      ps("当前 PUE", "kpiPue", "1.36", "") +
      ps("节能率", "kpiSaving", "-6.8", "%") +
      ps("PUE 目标", "kpiPueTarget", "1.40", "");
    const trend = panel({
      title: "用电趋势", en: "POWER TREND", cls: "fx-1",
      act: '<div class="mtabs" data-group="pwr"><button class="mtab" data-pwr="day">今日</button><button class="mtab on" data-pwr="week">近7天</button></div>',
      body:
        '<div class="trend-unit">单位 kWh</div>' +
        '<div class="trend-wrap"><canvas class="cv fill" data-c="pwrBars" id="pwrBars"></canvas>' +
          '<div class="chart-tip hidden" id="pwrTip"></div></div>' +
        '<div class="trend-foot"><div class="tf-left"><b>用电量逐步回落</b>' +
          '<canvas class="cv" data-c="pwrSpark" style="height:26px"></canvas></div>' +
          '<span class="tf-note">近 7 天示例记录可随筛选切换查看。</span></div>',
    });
    const pue = panel({
      title: "PUE 变化", en: "PUE TREND", cls: "fx-1",
      body:
        '<div class="pue-head"><div class="big"><b id="enPueNow">1.36</b></div>' +
          '<span class="pue-badge">优于目标 1.40</span></div>' +
        '<canvas class="cv fill" data-c="pueLine" id="pueLine"></canvas>',
    });
    const mix = panel({
      title: "用能构成", en: "ENERGY MIX", cls: "fx-1",
      body: '<div class="mix-wrap"><div class="donut-wrap"><canvas class="cv" data-c="enMixDonut"></canvas></div>' +
        '<ul class="legend" id="enMixLegend"></ul></div>',
    });
    return '<div class="hud-page" data-pg="energy">' + pageHead("能效分析", "跟踪电量与 PUE，识别机房能源使用结构。", stats) +
      '<div class="page-body cols"><div class="col span2">' + trend + '</div>' +
      '<div class="col">' + pue + mix + "</div></div>" + badge() + "</div>";
  }

  /* =======================================================================
   *  页面 5 · 告警中心
   * ======================================================================= */
  function buildAlarms() {
    const stats =
      ps("严重", "kpiAlarmCrit", "2", "条", "red") +
      ps("一般", "kpiAlarmWarn", "2", "条", "amber") +
      ps("已确认", "kpiAlarmAcked", "0", "条") +
      ps("未确认", "kpiAlarmUnacked", "4", "条") +
      '<div class="ps trend-ps"><span class="ps-lb">最近24小时</span>' +
        '<canvas class="cv" data-c="alarmTrend" style="height:30px"></canvas></div>';
    const left = panel({
      title: "告警列表", en: "ALARM LIST", cls: "fx-1",
      act: '<span class="chip crit" id="alarmCount">4 条</span>',
      body: '<div class="alarm-list tall" id="alarmList"></div>',
    });
    const center =
      '<div class="col center"><div class="center-layer">' +
        '<div class="ct-top"><i class="ct-line l"></i><span>3D 机房 · 告警定位</span><i class="ct-line r"></i></div>' +
        '<div class="alarm-locate" data-panel id="alarmLocate">' +
          '<span class="al-title"><i class="dot crit"></i>已定位 <b id="alarmLocRack">A-02</b></span>' +
          '<span class="al-sub">红色脉冲光圈已标记 · <b id="alarmLocTxt">进风温度过高</b></span>' +
        "</div>" +
        '<div class="ct-bottom"><span class="lg"><i class="dot crit"></i>严重</span>' +
          '<span class="lg"><i class="dot warn"></i>一般</span>' +
          '<span class="upd">点击左侧告警可自动定位机柜</span></div>' +
      "</div></div>";
    const right = panel({
      title: "告警详情", en: "ALARM DETAIL", cls: "fx-1",
      body: '<div class="alarm-detail" id="alarmDetail"></div>',
    });
    return '<div class="hud-page" data-pg="alarms">' + pageHead("告警中心", "集中查看告警、确认状态并生成处置工单。", stats) +
      '<div class="page-body cols"><div class="col">' + left + "</div>" + center +
      '<div class="col">' + right + "</div></div>" + badge() + "</div>";
  }

  /* =======================================================================
   *  页面 6 · 运维工单
   * ======================================================================= */
  function buildWorkorder() {
    const stats =
      ps("全部工单", "kpiWoAll", "4", "项") +
      ps("待处理", "kpiWoPending", "1", "项", "amber") +
      ps("进行中", "kpiWoDoing", "1", "项", "cyan") +
      ps("待核验", "kpiWoVerify", "1", "项", "violet") +
      ps("已完成", "kpiWoDone", "1", "项", "ok");
    const left = panel({
      title: "维保任务", en: "MAINTENANCE TASKS", cls: "fx-1",
      act: '<div class="mtabs" data-group="wof">' +
        '<button class="mtab on" data-wof="all">全部</button>' +
        '<button class="mtab" data-wof="pending">待处理</button>' +
        '<button class="mtab" data-wof="doing">进行中</button>' +
        '<button class="mtab" data-wof="verify">待核验</button>' +
        '<button class="mtab" data-wof="done">已完成</button></div>',
      body: '<div class="wo-grid" id="woGrid"></div>',
    });
    const right = panel({
      title: "任务详情", en: "TASK DETAIL", cls: "fx-1",
      body: '<div class="wo-detail" id="woDetail"></div>',
    });
    return '<div class="hud-page" data-pg="workorder">' + pageHead("运维工作台", "查看维保任务，推进接单、处理与完成状态。", stats) +
      '<div class="page-body wo-body"><div class="col">' + left + "</div>" +
      '<div class="col">' + right + "</div></div>" + badge() + "</div>";
  }
  /* =======================================================================
   *  运行时状态
   * ======================================================================= */
  const state = {
    page: "overview", rackId: "A-02", alarmId: null, woId: "WO-1102-001",
    wof: "all", etab: "day", pwr: "week", devSel: null, devQ: "", devSig: "",
    mdTab: null, mdManual: false, listening: false, monView: "3d",
    dhTab: "ups", dhDev: null, dhHist: [],
  };
  const hist = { temp: [], hum: [], pue: [], it: [] };
  function seedHist() {
    if (hist.temp.length) return;
    for (let i = 0; i < 18; i++) {
      hist.temp.push(24.3 + Math.sin(i / 2.2) * 0.42 + (i % 3) * 0.07);
      hist.hum.push(45.2 + Math.sin(i / 1.7 + 1) * 1.5);
      hist.pue.push(1.36 + Math.sin(i / 3.1) * 0.018);
      hist.it.push(12.6 + Math.sin(i / 2.6) * 1.05);
    }
  }
  function pushHist() {
    seedHist();
    const k = D().kpi || {};
    const add = (a, v, n) => { a.push(v); while (a.length > n) a.shift(); };
    add(hist.temp, k.tempAvg != null ? k.tempAvg : 24.3, 18);
    add(hist.hum, k.humAvg != null ? k.humAvg : 45.2, 18);
    add(hist.pue, k.pue != null ? k.pue : 1.36, 18);
    add(hist.it, k.itLoadKW != null ? k.itLoadKW : 12.6, 18);
  }
  const setTxt = (sel, v) => { const el = $(sel); if (el) el.textContent = v == null ? "" : String(v); };
  const shortClock = () => { const c = D().clockShort ? D().clockShort() : "--:--:--"; return c; };

  /* =======================================================================
   *  渲染 · 总览
   * ======================================================================= */
  function renderOverview() {
    const d = D(), k = d.kpi || {};
    setTxt("#ovDeviceTotal", k.deviceTotal);
    setTxt("#ovDeviceOnline", k.deviceOnline);
    setTxt("#ovDeviceAlarm", k.deviceAlarm);
    setTxt("#ovDeviceMaintain", k.deviceMaintain);
    $("#ovTemp").innerHTML = (k.tempAvg != null ? k.tempAvg : 24.3) + '<i class="u">℃</i>';
    $("#ovHum").innerHTML = (k.humAvg != null ? k.humAvg : 45.2) + '<i class="u">%</i>';
    $("#ovPue").innerHTML = (k.pue != null ? k.pue : 1.36);
    setTxt("#ovItKw", k.itLoadKW);
    setTxt("#ovItCap", k.itLoadCapKW);
    setTxt("#ovEnergyToday", commas(k.energyTodayKWh != null ? k.energyTodayKWh : 28430));
    const dp = k.energyDeltaPct != null ? k.energyDeltaPct : -6.8;
    setTxt("#ovEnergyDelta", (dp > 0 ? "+" : "") + dp + "%");
    const as = d.alarmStats || {};
    setTxt("#ovAlarmTotal", as.total);
    setTxt("#ovAlarmCrit", as.critical);
    setTxt("#ovAlarmWarn", as.warning);
    setTxt("#ovAlarmInfo", as.info);
    setTxt("#ovUpdate", shortClock());
    const mix = d.deviceMix || [];
    const lg = $("#ovMixLegend");
    if (lg) lg.innerHTML = mix.map((m) => '<li><i style="background:' + m.color + '"></i><span>' + esc(m.name) + "</span><b>" + m.pct + "%</b></li>").join("");
  }

  /* =======================================================================
   *  渲染 · 机房监控
   * ======================================================================= */
  function alarmItem(a, on) {
    const lv = LEVEL[a.level] || LEVEL.info;
    return '<button class="al-item ' + lv.k + (on ? " on" : "") + '" data-alarm="' + a.id + '" data-panel>' +
      '<span class="al-bar"></span>' +
      '<span class="al-top"><b class="al-rack">' + esc(a.rackId) + "</b>" + chip(lv.t, lv.k) + "</span>" +
      '<span class="al-title">' + esc(a.title) + "</span>" +
      '<span class="al-bot"><span class="al-time">' + esc(a.time) + "</span>" +
      '<span class="al-locate" data-locate="' + esc(a.rackId) + '">定位 →</span></span></button>';
  }
  function renderMonitor() {
    const d = D();
    const list = orderedAlarms(d.alarms);
    const sel = $("#rackSel");
    if (sel && !sel.options.length) {
      sel.innerHTML = (d.racks || []).map((r) =>
        '<option value="' + r.id + '">' + r.id + " · " + esc(r.zoneLabel) + " " + pad2(r.rowIndex) + " 号机柜</option>").join("");
    }
    if (sel) sel.value = state.rackId;
    setTxt("#monAlarmCount", list.length);
    const ml = $("#monAlarmList");
    if (ml) ml.innerHTML = list.map((a) => alarmItem(a, false)).join("");
    renderMonitorDetail();
  }  function renderMonitorDetail() {
    const d = D(), box = $("#monDetail");
    if (!box) return;
    const rack = d.getRack ? d.getRack(state.rackId) : null;
    if (!rack) { box.innerHTML = ""; return; }
    const wo2 = d.woOfRack ? d.woOfRack(rack.id) : null;
    const st = wo2 ? wo2.status : "pending";
    if (!state.mdManual) state.mdTab = st === "pending" ? "analyze" : st === "doing" ? "arrange" : "verify";
    const pane = state.mdTab || "analyze";
    const done = st === "verify" || st === "done";
    const temp = done ? 24.2 : rack.tempIn;
    const tempCls = done ? "ok" : "hot";
    const stateTxt = st === "pending" ? "先看清异常，再决定处置" : "处理已安排，等待现场结果";
    const woId = wo2 ? wo2.id : "--";
    const owner = wo2 ? wo2.owner : "--";
    const stTxt = wo2 ? (WO_STATUS[st] || {}).t : "--";
    const tCls = wo2 ? (WO_STATUS[st] || {}).k : "";
    const L1 = '<div class="md-pane" data-mdview="analyze"><div class="md-grid">' +
      '<div class="md-col"><div class="md-k">温度</div>' +
      '<div class="md-temp ' + tempCls + "\"><b>" + temp + '</b><i>℃</i></div>' +
      '<div class="md-thr' + (done ? " ok" : "") + "\">参考阈值 ≤ 28 ℃ · " + (done ? "已恢复正常" : "告警仍在监控") +
      '</div><div class="md-basis"><span class="md-bh">告警依据</span>进风温度过高，这是异常信号，尚不能仅凭该指标确定故障根因。</div></div>' +
      '<div class="md-col"><div class="md-k">建议的现场检查</div>' +
      '<div class="md-note">检查进风通道与冷通道送风，确认温度传感器读数。</div>' +
      '<div class="md-kv"><span>关联工单</span><b class="ok">' + woId + '</b></div>' +
      '<div class="md-kv"><span>负责人</span><b>' + esc(owner) + '</b></div>' +
      '<div class="md-kv"><span>处理状态</span><b class="' + tCls + "\">" + stTxt + '</b></div>' +
      '<div class="md-kv"><span>处置标记</span><b class="ok">已生成工单</b></div></div>' +
      '<div class="md-foot"><span>需要现场人员实际检查：助手不会把派单当作维修完成。</span></div></div>';
    const L2 = '<div class="md-pane" data-mdview="arrange"><div class="md-grid">' +
      '<div class="md-col"><div class="md-k">流程清单</div>' +
      '<ol class="md-ol"><li>告警生成工单</li><li>维保人员接单（演示）</li>' +
      '<li>用户确认处置方案后，助手关联工单并安排处理（演示）</li></ol>' +
      '<div class="md-tip">真人确认后展示处置进度</div></div>' +
      '<div class="md-col">' +
      '<div class="md-kv"><span>关联工单</span><b class="ok">' + woId + '</b></div>' +
      '<div class="md-kv"><span>负责人</span><b>' + esc(owner) + '</b></div>' +
      '<div class="md-kv"><span>处理状态</span><b class="' + tCls + "\">" + stTxt + '</b></div>' +
      '<div class="md-kv"><span>处置标记</span><b>已安排处理</b></div></div></div>' +
      '<div class="md-foot"><span>确认后，助手关联已有工单并安排处理，当前为本地演示。</span>' +
      '<button class="mbtn primary" data-act="confirm-plan">确认方案，安排处理</button></div>' +
      '<div class="md-sub">也可说 \u201C把方案安排处理\u201D</div></div>';
    const L3 = '<div class="md-pane" data-mdview="verify"><div class="md-grid">' +
      '<div class="md-col"><div class="md-k">温度</div>' +
      '<div class="md-temp ' + tempCls + "\"><b>" + temp + '</b><i>℃</i></div>' +
      '<div class="md-thr' + (done ? " ok" : "") + "\">" + (done ? "已恢复正常" : "参考阈值 ≤ 28 ℃ · 告警仍在监控") +
      '</div><div class="md-basis"><span class="md-bh">告警依据</span>进风温度过高，这是异常信号，尚不能仅凭该指标确定故障根因。</div></div>' +
      '<div class="md-col"><div class="md-k">核验记录</div>' +
      '<div class="md-kv"><span>关联工单</span><b class="ok">' + woId + '</b></div>' +
      '<div class="md-kv"><span>负责人</span><b>' + esc(owner) + '</b></div>' +
      '<div class="md-kv"><span>处理状态</span><b class="' + tCls + "\">" + (done ? "待核验 / 已完成" : stTxt) + '</b></div>' +
      '<div class="md-kv"><span>现场结论</span><b>' + (done ? "温度回落至 24.2 ℃" : "等待现场回填") + '</b></div></div></div>' +
      '<div class="md-foot"><span>' + (done ? "现场处理已完成，可复核并归档。" : "需要现场人员实际检查：助手不会把派单当作维修完成。") + '</span>' +
      '<div class="md-acts"><button class="mbtn" data-act="verify-wo">复核并归档</button>' +
      '<button class="mbtn ghost" data-act="view-alarm">查看关联告警</button></div></div></div>';
    const paneHtml = { analyze: L1, arrange: L2, verify: L3 };
    box.innerHTML =
      '<div class="md-hd"><span class="md-id">' + rack.id + " · " + esc(rack.zoneLabel) + " " + pad2(rack.rowIndex) + ' 号机柜</span>' +
      '<button class="mbtn sm" data-act="focus-rack">查看三维设备</button></div>' +
      '<div class="md-state">' + stateTxt + '</div>' +
      '<div class="md-tabs">' +
      '<button class="mtab' + (pane === "analyze" ? " on" : "") + '" data-mdpane="analyze">分析异常</button>' +
      '<button class="mtab' + (pane === "arrange" ? " on" : "") + '" data-mdpane="arrange">安排处理</button>' +
      '<button class="mtab' + (pane === "verify" ? " on" : "") + '" data-mdpane="verify">核验结果</button>' +
      '</div>' + (paneHtml[pane] || L1);
    const ct = $("#closureTitle");
    if (ct) ct.textContent = rack.id + " · 处理闭环";
    const cg = $("#closureTag");
    if (cg) {
      cg.textContent = done ? "已完成" : st === "doing" ? "处理中" : "告警待确认";
      cg.className = "tag " + (done ? "ok" : st === "doing" ? "info" : "warn");
    }
    renderAssistDev();
  }  function renderAssistDev() {
    const d = D(), box = $("#assistDev");
    if (!box) return;
    const rack = d.getRack ? d.getRack(state.rackId) : null;
    if (!rack) { box.innerHTML = ""; return; }
    const rows = [
      ["机柜编号", rack.id], ["所属分区", rack.zoneLabel + " · " + rack.row + " 排"],
      ["运行状态", { normal: "正常运行", alarm: "告警", offline: "已离线" }[rack.status] || "--"],
      ["进风温度", rack.tempIn + " ℃"], ["出风温度", rack.tempOut + " ℃"],
      ["湿度", rack.humidity + " %"], ["负载", rack.powerKW + " / " + rack.powerRatedKW + " kW"],
      ["U 位使用", rack.uUsed + " / " + rack.uTotal + " U"],
      ["上次维保", rack.maintain ? rack.maintain.last : "--"],
      ["下次计划", rack.maintain ? rack.maintain.next : "--"],
      ["负责班组", rack.maintain ? rack.maintain.team : "--"],
    ];
    box.innerHTML = '<div class="dd-hd"><span>' + rack.id + ' · 设备详情</span>' +
      chip(rack.devices.length + " 台设备", "info") + '</div>' +
      '<div class="dd-rows">' + rows.map((r) => '<div class="md-kv"><span>' + r[0] + '</span><b>' + esc(r[1]) + '</b></div>').join("") + '</div>' +
      '<div class="dd-list">' + (rack.devices || []).map((dv) => {
        const lv = dv.status === "alarm" ? "crit" : dv.status === "offline" ? "off" : dv.status === "warn" ? "warn" : "ok";
        return '<div class="dd-dev"><i class="dot ' + lv + '"></i><span class="dd-name">' + esc(dv.name) + '</span>' +
          '<span class="dd-u">U' + pad2(dv.uStart) + '</span><b>' + dv.temp + '℃</b></div>';
      }).join("") + '</div>';
  }

  /* =======================================================================
   *  渲染 · 资产管理
   * ======================================================================= */
  function statusTag(s) {
    const m = { normal: ["运行正常", "ok"], alarm: ["严重告警", "crit"], warn: ["告警", "warn"], offline: ["已离线", "off"] };
    const v = m[s] || ["未知", ""];
    return chip(v[0], v[1]);
  }
  function renderZoneTree() {
    const d = D(), box = $("#zoneTree");
    if (!box) return;
    const rows = d.rows || [];
    const zones = {};
    (d.racks || []).forEach((r) => { (zones[r.zoneLabel] = zones[r.zoneLabel] || []).push(r); });
    let html = '<div class="tree-node zone open" data-zone="ALL"><span class="tn-caret"></span>' +
      '<span class="tn-name">全部区域</span><b>' + (d.racks || []).length + '</b></div>' +
      '<div class="tree-kids">';
    Object.keys(zones).forEach((z) => {
      html += '<div class="tree-node zone open" data-zone="' + esc(z) + '"><span class="tn-caret"></span>' +
        '<span class="tn-name">' + esc(z) + '</span><b>' + zones[z].length + '</b></div><div class="tree-kids">';
      rows.forEach((rw) => {
        const list = zones[z].filter((r) => r.row === rw);
        if (!list.length) return;
        html += '<div class="tree-node row" data-row="' + rw + '"><span class="tn-caret"></span>' +
          '<span class="tn-name">' + rw + ' 排</span><b>' + list.length + '</b></div><div class="tree-kids">';
        list.forEach((r) => {
          html += '<div class="tree-node rack' + (r.id === state.rackId ? " on" : "") + '" data-rack="' + r.id + '">' +
            '<i class="dot ' + (r.status === "alarm" ? "crit" : r.status === "offline" ? "off" : "ok") + '"></i>' +
            '<span class="tn-name">' + r.id + '</span><b>' + r.uUsed + '/' + r.uTotal + 'U</b></div>';
        });
        html += '</div>';
      });
      html += '</div>';
    });
    box.innerHTML = html + '</div>';
  }
  function renderDeviceTable(force) {
    const d = D(), tb = $("#devTbody");
    if (!tb) return;
    const q = (state.devQ || "").trim().toLowerCase();
    let list = d.allDevices ? d.allDevices() : [];
    if (q) list = list.filter((x) => (x.name + x.model + x.id + x.rackId).toLowerCase().indexOf(q) >= 0);
    const sig = q + "|" + list.length + "|" + state.devSel;
    if (!force && sig === state.devSig) return;
    state.devSig = sig;
    if (!state.devSel && list.length) state.devSel = list[0].id + "@" + list[0].rackId;
    const max = 120;
    const view = list.slice(0, max);
    tb.innerHTML = view.map((dv) => {
      const key = dv.id + "@" + dv.rackId;
      const al = (d.alarmOfRack && d.alarmOfRack(dv.rackId)) || null;
      const alarmCell = dv.status === "alarm" && al ? chip(LEVEL[al.level].t, LEVEL[al.level].k) : '<span class="muted">--</span>';
      return '<tr class="' + (state.devSel === key ? "on" : "") + '" data-dev="' + esc(key) + '">' +
        '<td class="c-name" title="' + esc(dv.name) + '"><b>' + esc(dv.name) + '</b><span>' + esc(dv.id) + '</span></td>' +
        '<td class="c-model" title="' + esc(dv.model) + '">' + esc(dv.model) + '</td>' +
        '<td>' + statusTag(dv.status) + '</td>' +
        '<td>' + alarmCell + '</td>' +
        '<td class="c-cap"><span class="cap-bar"><i style="width:' + dv.capacityPct + '%"></i></span><b>' + dv.capacityPct + '%</b></td>' +
        '<td class="c-loc">' + esc(dv.rackId) + ' · U' + pad2(dv.uStart) + '-' + pad2(dv.uStart + dv.uSize - 1) + '</td>' +
        '<td class="c-act"><button class="link" data-locate="' + esc(dv.rackId) + '">定位</button>' +
        '<button class="link" data-dev-edit="' + esc(key) + '">编辑</button></td></tr>';
    }).join("");
    setTxt("#tblFoot", "共 " + (d.kpi ? d.kpi.deviceTotal : list.length) + " 台设备" + (list.length > max ? "（显示前 " + max + " 台）" : ""));
    setTxt("#ledgerCount", "共 " + (d.kpi ? d.kpi.deviceTotal : list.length) + " 台设备");
    renderAssetDetail(list);
  }
  function renderAssetDetail(list) {
    const d = D(), box = $("#assetDetail");
    if (!box) return;
    const all = list || (d.allDevices ? d.allDevices() : []);
    let dv = null;
    if (state.devSel) {
      const parts = state.devSel.split("@");
      dv = all.filter((x) => x.id === parts[0] && x.rackId === parts[1])[0];
    }
    if (!dv) dv = all[0];
    if (!dv) { box.innerHTML = ""; return; }
    const rack = d.getRack ? d.getRack(dv.rackId) : null;
    box.innerHTML =
      '<div class="ad-preview"><canvas class="cv" data-c="assetIso"></canvas>' +
      '<span class="ad-badge">' + esc(dv.rackId) + '</span></div>' +
      '<div class="ad-hd"><b>' + esc(dv.name) + '</b>' + statusTag(dv.status) + '</div>' +
      '<div class="ad-model">' + esc(dv.model) + '</div>' +
      '<div class="ad-rows">' +
      '<div class="md-kv"><span>所属机柜</span><b>' + esc(dv.rackId) + ' · U' + pad2(dv.uStart) + '</b></div>' +
      '<div class="md-kv"><span>U 位占用</span><b>' + dv.uSize + ' U（' + (rack ? rack.uUsed + '/' + rack.uTotal : "--") + '）</b></div>' +
      '<div class="md-kv"><span>设备温度</span><b>' + dv.temp + ' ℃</b></div>' +
      '<div class="md-kv"><span>容量占用</span><b>' + dv.capacityPct + ' %</b></div>' +
      '<div class="md-kv"><span>设备类型</span><b>' + ({ server: "服务器", storage: "存储设备", network: "网络设备", security: "安全设备" }[dv.type] || dv.type) + '</b></div>' +
      '<div class="md-kv"><span>所在分区</span><b>' + esc(dv.zone || "--") + '</b></div>' +
      '</div>' +
      '<div class="ad-note">暂无历史工单 · 示例数据</div>' +
      '<button class="mbtn primary block" data-locate="' + esc(dv.rackId) + '">在三维中定位</button>';
    state.isoRack = rack;
  }

  /* =======================================================================
   *  渲染 · 能效管理
   * ======================================================================= */
  function renderEnergy() {
    const d = D(), k = d.kpi || {};
    setTxt("#kpiEnergyMonth", commas(k.energyMonthKWh != null ? k.energyMonthKWh : 210785));
    setTxt("#kpiPue", k.pue);
    setTxt("#kpiSaving", k.savingPct);
    setTxt("#kpiPueTarget", (k.pueTarget != null ? k.pueTarget : 1.4).toFixed(2));
    setTxt("#enPueNow", k.pue != null ? k.pue : 1.36);
    const mx = d.energy ? d.energy.mix : [];
    const lg = $("#enMixLegend");
    if (lg) lg.innerHTML = mx.map((m) => '<li><i style="background:' + m.color + '"></i><span>' + esc(m.name) + "</span><b>" + m.pct + "%</b></li>").join("");
  }
  function energySeries() {
    const e = D().energy || {};
    if (state.pwr === "day") {
      const h = e.hourly || [];
      return { vals: h.map((x) => x.kwh), labels: h.map((x) => x.label), every: 2, unit: "今日" };
    }
    if (state.pwr === "month") {
      const w = e.week || [];
      const vals = [], labels = [];
      for (let i = 0; i < 30; i++) {
        const b = w[i % (w.length || 1)] || { kwh: 220000 };
        vals.push(Math.round(b.kwh * (0.88 + ((i * 37) % 23) / 100)));
        labels.push((i + 1) + "日");
      }
      return { vals: vals, labels: labels, every: 3, unit: "近30天" };
    }
    const w = e.week || [];
    const base = ["10/27", "10/28", "10/29", "10/30", "10/31", "11/01", "11/02"];
    return { vals: w.map((x) => x.kwh), labels: w.map((x, i) => (base[i] || x.label)), every: 1, unit: "近7天" };
  }

  /* =======================================================================
   *  渲染 · 告警中心 / 运维工单
   * ======================================================================= */
  function renderAlarms() {
    const d = D(), list = d.alarms || [];
    const crit = list.filter((a) => a.level === "critical").length;
    const warn = list.filter((a) => a.level === "warning").length;
    const acked = list.filter((a) => a.acked).length;
    setTxt("#kpiAlarmCrit", crit);
    setTxt("#kpiAlarmWarn", warn);
    setTxt("#kpiAlarmAcked", acked);
    setTxt("#kpiAlarmUnacked", list.length - acked);
    setTxt("#alarmCount", list.length + " 条");
    const box = $("#alarmList");
    if (box) box.innerHTML = list.map((a) => alarmItem(a, state.alarmId === a.id)).join("");
    if (!state.alarmId && list.length) state.alarmId = list[0].id;
    renderAlarmDetail();
  }
  function renderAlarmDetail() {
    const d = D(), box = $("#alarmDetail");
    if (!box) return;
    const a = d.getAlarm ? d.getAlarm(state.alarmId) : null;
    if (!a) { box.innerHTML = ""; return; }
    const lv = LEVEL[a.level] || LEVEL.info;
    const rack = d.getRack ? d.getRack(a.rackId) : null;
    const wo = d.woOfRack ? d.woOfRack(a.rackId) : null;
    box.innerHTML =
      '<div class="ad-hd big"><b>' + esc(a.title) + '</b>' + chip(lv.t, lv.k) + '</div>' +
      '<div class="al-meta"><span>' + esc(a.rackId) + (rack ? " · " + esc(rack.zoneLabel) : "") + '</span>' +
      '<span class="al-time">' + esc(a.time) + '</span></div>' +
      '<div class="al-detail">' + esc(a.detail) + '</div>' +
      '<div class="md-kv"><span>处理状态</span><b>' + esc(a.status || "待确认") + '</b></div>' +
      '<div class="md-kv"><span>关联工单</span><b class="ok">' + (wo ? wo.id : (a.woId || "--")) + '</b></div>' +
      '<div class="md-kv"><span>告警编号</span><b>' + esc(a.id) + '</b></div>' +
      '<div class="md-basis"><span class="md-bh">处置建议</span>' + esc(a.suggest || "待补充处置建议。") + '</div>' +
      '<div class="al-acts">' +
      '<button class="mbtn primary" data-act="gen-wo" data-alarm-id="' + esc(a.id) + '">生成工单</button>' +
      '<button class="mbtn" data-act="ack-alarm" data-alarm-id="' + esc(a.id) + '">确认告警</button>' +
      '<button class="mbtn ghost" data-locate="' + esc(a.rackId) + '">三维定位</button></div>';
    setTxt("#alarmLocRack", a.rackId);
    setTxt("#alarmLocTxt", a.title);
  }
  function woCard(w) {
    const lv = LEVEL[w.level] || LEVEL.plan;
    const st = WO_STATUS[w.status] || WO_STATUS.pending;
    return '<button class="wo-card ' + (w.id === state.woId ? "on" : "") + '" data-wo="' + esc(w.id) + '" data-panel>' +
      '<span class="wo-top"><b class="wo-id">' + esc(w.id) + '</b>' + chip(lv.t, lv.k) + '</span>' +
      '<span class="wo-title">' + esc(w.title) + '</span>' +
      '<span class="wo-meta"><span class="wo-rack">' + esc(w.rackId) + '</span><span class="wo-owner">' + esc(w.owner) + '</span>' + chip(st.t, st.k) + '</span>' +
      '<span class="wo-time">' + esc(w.created) + '</span></button>';
  }
  function renderWorkorder() {
    const d = D(), list = d.workOrders || [];
    setTxt("#kpiWoAll", Math.max(4, list.length));
    setTxt("#kpiWoPending", 1);
    setTxt("#kpiWoDoing", 1);
    setTxt("#kpiWoVerify", 1);
    setTxt("#kpiWoDone", 1);
    const grid = $("#woGrid");
    if (grid) {
      const f = state.wof;
      const fl = f === "all" ? list : list.filter((w) => w.status === f);
      grid.innerHTML = fl.length ? fl.map(woCard).join("") : '<div class="wo-empty">暂无该状态的工单（示例数据）</div>';
    }
    if (!d.getWorkOrder(state.woId)) state.woId = list.length ? list[0].id : null;
    renderWoDetail();
  }
  function renderWoDetail() {
    const d = D(), box = $("#woDetail");
    if (!box) return;
    const w = d.getWorkOrder ? d.getWorkOrder(state.woId) : null;
    if (!w) { box.innerHTML = ""; return; }
    const lv = LEVEL[w.level] || LEVEL.plan;
    const st = WO_STATUS[w.status] || WO_STATUS.pending;
    box.innerHTML =
      '<div class="wd-hd"><span class="wd-id">' + esc(w.id) + '</span>' + chip(lv.t, lv.k) + chip(st.t, st.k) + '</div>' +
      '<div class="wd-title">' + esc(w.title) + '</div>' +
      '<div class="wd-rows">' +
      '<div class="md-kv"><span>关联机柜</span><b>' + esc(w.rackId) + '</b></div>' +
      '<div class="md-kv"><span>负责人</span><b>' + esc(w.owner) + '</b></div>' +
      '<div class="md-kv"><span>创建时间</span><b>' + esc(w.created) + '</b></div>' +
      '</div>' +
      '<div class="wd-lbl">处理说明</div>' +
      '<div class="wd-note">' + esc(w.note || "--") + '</div>' +
      '<div class="wd-sec">处理记录</div>' +
      '<ol class="timeline">' + (w.timeline || []).map((t) => '<li><span class="tl-time">' + esc(t.time) + '</span><span class="tl-dot"></span><span class="tl-txt">' + esc(t.text) + '</span></li>').join("") + '</ol>' +
      '<div class="wd-foot">' + esc(w.footer || "") + '</div>' +
      '<div class="wd-acts"><button class="mbtn" data-act="close-wo" data-wo-id="' + esc(w.id) + '">关闭工单</button>' +
      '<button class="mbtn ghost" data-locate="' + esc(w.rackId) + '">查看关联告警</button></div>';
  }
  /* =======================================================================
   *  图表绘制映射
   * ======================================================================= */
  const PAINT = {
    runGauge(cv) {
      const k = D().kpi || {};
      const score = k.runScore != null ? k.runScore : 98;
      drawGauge(cv, score / 100, { value: String(score), sub: k.runState || "运行良好", size: 25, subDy: 19, lw: 8, c1: "#35e0ff", c2: "#2f7fe8" });
    },
    sparkTemp(cv) { drawSpark(cv, hist.temp, "#f5a524"); },
    sparkHum(cv) { drawSpark(cv, hist.hum, "#35e0ff"); },
    sparkPue(cv) { drawSpark(cv, hist.pue, "#2fd9c8"); },
    itGauge(cv) {
      const k = D().kpi || {};
      const p = k.itLoadPct != null ? k.itLoadPct : 68;
      drawGauge(cv, p / 100, { value: p + "%", size: 17, lw: 7, c1: "#a98bff", c2: "#2f7fe8", glow: "rgba(124,108,240,.85)" });
    },
    itLine(cv) {
      const e = D().energy || {};
      const h = e.hourly || [];
      drawLine(cv, h.map((x) => x.kwh * 0.00042), {
        color: "#7c6cf0", padL: 18, padR: 5, padT: 5, padB: 11, yTicks: 2,
        labels: h.map((x) => x.label), xEvery: 8, yFmt: (v) => v.toFixed(1),
      });
    },
    alarm24(cv) {
      const as = D().alarmStats || {};
      const hs = as.hourly || [];
      drawBars(cv, hs.map((x) => x.v), {
        c1: "#35e0ff", c2: "rgba(53,224,255,.15)", padT: 8, padB: 14,
        labels: hs.map((x) => x.label + ":00"), xEvery: 4, tail: "24:00", maxBarW: 8,
      });
    },
    energyBars(cv) {
      const e = D().energy || {};
      let vals = [], labels = [], every = 4, tail = "";
      if (state.etab === "week") {
        const w = e.week || [];
        vals = w.map((x) => x.kwh); labels = w.map((x) => x.label); every = 1;
      } else if (state.etab === "month") {
        const w = e.week || [];
        for (let i = 0; i < 30; i++) {
          const b = w[i % (w.length || 1)] || { kwh: 220000 };
          vals.push(Math.round(b.kwh * (0.9 + ((i * 29) % 17) / 100)));
          labels.push(i + 1 + "日");
        }
        every = 5;
      } else {
        const h = e.hourly || [];
        vals = h.map((x) => x.kwh); labels = h.map((x) => x.label); every = 4; tail = "24:00";
      }
      drawBars(cv, vals, {
        labels: labels, xEvery: every, tail: tail, padL: 24, padT: 8, padB: 14,
        c1: "#ffd166", c2: "rgba(245,165,36,.15)", yTicks: true, maxBarW: 16,
        yFmt: (v) => (v / 10000).toFixed(1) + "万",
      });
    },
    donutMix(cv) {
      const d = D();
      drawDonut(cv, d.deviceMix || [], {
        top: String((d.kpi || {}).deviceTotal || 256), sub: "设备总数", lw: 11, topSize: 19,
      });
    },
    pwrBars(cv) {
      const s = energySeries();
      const geo = drawBars(cv, s.vals, {
        labels: s.labels, xEvery: s.every, yTicks: true,
        yFmt: (v) => commas(Math.round(v)), padL: 44, padR: 10, padT: 12, padB: 18,
        c1: "#ffd166", c2: "rgba(245,165,36,.16)", maxBarW: 52,
      });
      cv._geo = geo; cv._data = s;
    },
    pwrSpark(cv) { drawSpark(cv, energySeries().vals.slice(-14), "#f5a524", { lw: 1.4 }); },
    pueLine(cv) {
      const ps = (D().energy || {}).pueSeries || [];
      drawLine(cv, ps.map((x) => x.v), {
        color: "#35e0ff", min: 1.3, max: 1.5, yTicks: 3, padL: 28, padR: 8, padT: 10, padB: 15,
        yFmt: (v) => v.toFixed(1), labels: ps.map((x) => x.label), xEvery: 6,
      });
    },
    enMixDonut(cv) {
      drawDonut(cv, (D().energy || {}).mix || [], { top: null, sub: null, lw: 12 });
    },
    alarmTrend(cv) {
      const hs = (D().alarmStats || {}).hourly || [];
      drawSpark(cv, hs.map((x) => x.v).concat([hs.length ? hs[0].v : 0]), "#ff8082", { lw: 1.4, pad: 3 });
    },
    assetIso(cv) {
      const rack = state.isoRack || (D().getRack ? D().getRack(state.rackId) : null);
      drawIsoRack(cv, rack);
    },
    dhUpsLoad0(cv) { dhRingPaint(cv, 0); },
    dhUpsLoad1(cv) { dhRingPaint(cv, 1); },
    dhThTrend(cv) { dhThTrendPaint(cv); },
    dhThBars(cv) { dhThBarsPaint(cv); },
  };
  function paint(page) {
    const scope = $('.hud-page[data-pg="' + page + '"]');
    if (!scope) return;
    $$("[data-c]", scope).forEach((cv) => {
      const fn = PAINT[cv.getAttribute("data-c")];
      if (!fn) return;
      try { fn(cv); } catch (e) { console.warn("[hud] paint " + cv.getAttribute("data-c"), e); }
    });
  }
  function renderAssets() {
    const k = D().kpi || {};
    setTxt("#kpiRackTotal", k.rackTotal);
    setTxt("#kpiRacksNormal", k.racksNormal);
    setTxt("#kpiDeviceAlarm", k.deviceAlarm);
    setTxt("#kpiDeviceTotal", k.deviceTotal);
    setTxt("#treeCount", (k.rackTotal || 42) + " 台");
    renderZoneTree();
    renderDeviceTable(false);
  }
  function render(page) {
    const d = D();
    if (!d || !d.kpi) return;
    page = page || state.page;
    state.page = page;
    pushHist();
    api.updateShell();
    if (page === "overview") renderOverview();
    else if (page === "monitor") renderMonitor();
    else if (page === "assets") renderAssets();
    else if (page === "energy") renderEnergy();
    else if (page === "alarms") renderAlarms();
    else if (page === "workorder") renderWorkorder();
    else if (page === "donghuan") renderDonghuan();
    paint(page);
  }
  /* =======================================================================
   *  交互
   * ======================================================================= */
  function askXiaowei(text) {
    const xw = IDC.xiaowei;
    if (xw && xw.ask) { xw.ask(text); return true; }
    return false;
  }
  function locateRack(id) {
    if (!id) return;
    state.rackId = id;
    const sc = IDC.scene;
    if (sc && sc.focusRack) { try { sc.focusRack(id, { open: true, duration: 1.2 }); } catch (e) {} }
    else if (IDC.bus) IDC.bus.emit("rack:select", id);
    const sel = $("#rackSel"); if (sel) sel.value = id;
    setTxt("#monRackTitle", id);
    if (state.page === "monitor") renderMonitorDetail();
    else if (state.page === "assets") { renderZoneTree(); }
    api.toast("已定位机柜 " + id, "ok");
  }
  function setMonView(v, silent) {
    state.monView = v === "detail" ? "detail" : "3d";
    const det = $("#monDetail");
    if (det) det.classList.toggle("hidden", state.monView !== "detail");
    const tg = $("#monToggle");
    if (tg) tg.textContent = state.monView === "detail" ? "查看三维设备" : "查看处置详情";
    const hint = $(".mon-hint");
    if (hint) hint.classList.toggle("hidden", state.monView === "detail");
    if (!silent && IDC.bus) IDC.bus.emit("monitor:view", state.monView);
  }
  function doAct(el) {
    const a = el.getAttribute("data-act");
    const d = D();
    if (a === "dh-connect") {
      const dh = IDC.dh;
      if (!dh) { api.toast("动环模块未就绪", "warning"); return; }
      if (dh.connected) { dh.disconnect(); api.toast("已断开动环网关，保持本地模拟", "info"); }
      else {
        const url = (dh.gw && dh.gw.url) || "";
        api.toast("正在尝试接入动环网关 " + url + "（连不上会自动保持本地模拟）", "info");
      }
      setTimeout(() => { if (state.page === "donghuan") renderDonghuan(); }, 500);
    } else if (a === "dh-export") { dhExportCsv(); }
    else if (a === "mon-toggle") {
      setMonView(state.monView === "detail" ? "3d" : "detail");
      if (state.monView === "3d") {
        const sc = IDC.scene;
        if (sc && sc.focusRack) { try { sc.focusRack(state.rackId, { open: true, duration: 1.2 }); } catch (e) {} }
      }
      api.toast(state.monView === "detail" ? "已切换到处置详情视图" : "已切换到三维设备视图", "info");
    } else if (a === "back-overview") { if (IDC.app && IDC.app.goto) IDC.app.goto("overview"); else api.setPage("overview"); }
    else if (a === "whole-room") {
      const sc = IDC.scene;
      if (sc && sc.setView) { try { sc.setView("roomOrbit", { page: "monitor" }); } catch (e) {} }
      api.toast("已切换到整间机房视角（示例）", "ok");
    } else if (a === "focus-rack") {
      const sc = IDC.scene;
      if (sc && sc.focusRack) { try { sc.focusRack(state.rackId, { open: true, duration: 1.2 }); } catch (e) {} }
      api.toast("镜头已对准 " + state.rackId, "ok");
    } else if (a === "confirm-plan") {
      const wo = d.woOfRack ? d.woOfRack(state.rackId) : null;
      const id = wo ? wo.id : "WO-1102-001";
      if (d.updateWorkOrder) d.updateWorkOrder(id, { status: "doing" });
      if (d.pushTimeline) d.pushTimeline(id, "用户确认处置方案后，助手关联工单并安排处理（演示）");
      state.mdManual = false;
      api.toast("已确认处置方案：" + id + " 安排处理中（演示）", "ok");
      renderMonitorDetail();
      renderWorkorder();
    } else if (a === "verify-wo") {
      const wo = d.woOfRack ? d.woOfRack(state.rackId) : null;
      const id = wo ? wo.id : "WO-1102-001";
      if (d.coolRack) d.coolRack(state.rackId, 24.2);
      if (d.updateWorkOrder) d.updateWorkOrder(id, { status: "done" });
      if (d.ackAlarm) { const al = d.alarmOfRack ? d.alarmOfRack(state.rackId) : null; if (al) d.ackAlarm(al.id); }
      state.mdManual = false;
      api.toast("已复核并归档：" + state.rackId + " 温度回落至 24.2 ℃", "ok");
      renderMonitor();
      renderWorkorder();
    } else if (a === "view-alarm") { if (IDC.app && IDC.app.goto) IDC.app.goto("alarms"); else api.setPage("alarms"); }
    else if (a === "gen-wo") {
      const alId = el.getAttribute("data-alarm-id");
      const al = d.getAlarm ? d.getAlarm(alId) : null;
      if (al && d.addWorkOrder) {
        const wo = d.addWorkOrder({
          level: al.level, title: al.title, rackId: al.rackId, owner: "张工",
          note: al.suggest, footer: "需要现场人员实际检查：助手不会把派单当作维修完成。",
          timeline: [{ time: (d.clockShort ? d.clockShort().slice(0, 5) : "14:30"), text: "告警生成工单" }],
        });
        state.woId = wo.id;
        api.toast("已生成工单 " + wo.id + " · " + al.rackId, "ok");
        renderAlarms();
      }
    } else if (a === "ack-alarm") {
      if (d.ackAlarm) d.ackAlarm(el.getAttribute("data-alarm-id"));
      api.toast("已确认告警（演示）", "ok");
      renderAlarms();
    } else if (a === "close-wo") {
      const id = el.getAttribute("data-wo-id");
      if (d.updateWorkOrder) d.updateWorkOrder(id, { status: "done" });
      api.toast("工单 " + id + " 已关闭（演示）", "ok");
      renderWorkorder();
    }
  }
  function sendChat() {
    const inp = $("#chatInput");
    if (!inp) return;
    const t = (inp.value || "").trim();
    if (!t) return;
    inp.value = "";
    api.chat.add({ role: "user", text: t });
    if (!askXiaowei(t)) {
      api.chat.add({ role: "assistant", text: "已收到指令（示例）：" + t + "。当前为本地演示数据，语音助手模块未接入时会给出示例回复。" });
      api.chat.setStatus("");
    }
  }
  function onPwrMove(e) {
    const cv = e.currentTarget, geo = cv._geo, dat = cv._data, tip = $("#pwrTip");
    if (!geo || !dat || !tip) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (x < geo.off - 8 || x > geo.off + geo.n * (geo.bw + geo.gap) + 8) { tip.classList.add("hidden"); return; }
    let i = clamp(Math.floor((x - geo.off) / (geo.bw + geo.gap)), 0, geo.n - 1);
    tip.classList.remove("hidden");
    tip.innerHTML = "<b>" + esc(dat.labels[i]) + "</b><span>" + commas(dat.vals[i]) + " kWh</span>";
    const wrap = cv.parentNode.getBoundingClientRect();
    tip.style.left = (r.left - wrap.left + geo.off + i * (geo.bw + geo.gap) + geo.bw / 2) + "px";
    tip.style.top = (r.top - wrap.top + 4) + "px";
  }
  function wire(root) {
    root.addEventListener("click", (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      let el;
      if ((el = t.closest("[data-ask]"))) { askXiaowei(el.getAttribute("data-ask")); return; }
      if ((el = t.closest("[data-locate]"))) { locateRack(el.getAttribute("data-locate")); return; }
      if ((el = t.closest("[data-dhtab]"))) {
        state.dhTab = el.getAttribute("data-dhtab"); renderDonghuan(); return;
      }
      if ((el = t.closest("[data-dhack]"))) {
        const id = el.getAttribute("data-dhack");
        if (IDC.dh && IDC.dh.ack) IDC.dh.ack(id);
        api.toast("已确认动环报警", "ok");
        renderDonghuan(); return;
      }
      if ((el = t.closest("[data-dhclear]"))) {
        const id = el.getAttribute("data-dhclear");
        if (IDC.dh && IDC.dh.clear) IDC.dh.clear(id);
        api.toast("已清除动环报警", "ok");
        renderDonghuan(); return;
      }
      if ((el = t.closest("[data-dhdev]"))) {
        const id = el.getAttribute("data-dhdev");
        state.dhDev = id;
        if (IDC.bus) IDC.bus.emit("dh:select", { devId: id });
        renderDonghuan();
        api.toast("已选中动环设备 " + id, "info");
        return;
      }
      if ((el = t.closest("[data-dev-edit]"))) {
        const k = el.getAttribute("data-dev-edit"); state.devSel = k;
        renderDeviceTable(true); paint("assets");
        api.toast("编辑设备（演示）：" + k.split("@")[0], "info"); return;
      }
      if ((el = t.closest("[data-dev]"))) {
        state.devSel = el.getAttribute("data-dev");
        renderDeviceTable(true); paint("assets"); return;
      }
      if ((el = t.closest("[data-wo]"))) { state.woId = el.getAttribute("data-wo"); renderWorkorder(); return; }
      if ((el = t.closest("[data-alarm]"))) {
        state.alarmId = el.getAttribute("data-alarm");
        const a = D().getAlarm ? D().getAlarm(state.alarmId) : null;
        if (a) locateRackSilent(a.rackId);
        renderAlarms(); return;
      }
      if ((el = t.closest("[data-mdpane]"))) { state.mdManual = true; state.mdTab = el.getAttribute("data-mdpane"); renderMonitorDetail(); return; }
      if ((el = t.closest("[data-atab]"))) {
        const v = el.getAttribute("data-atab");
        $$("[data-atab]").forEach((b) => b.classList.toggle("on", b === el));
        $$("[data-pane]").forEach((p) => p.classList.toggle("hidden", p.getAttribute("data-pane") !== v));
        return;
      }
      if ((el = t.closest("[data-wof]"))) {
        state.wof = el.getAttribute("data-wof");
        $$("[data-wof]").forEach((b) => b.classList.toggle("on", b === el));
        renderWorkorder(); return;
      }
      if ((el = t.closest("[data-etab]"))) {
        state.etab = el.getAttribute("data-etab");
        $$("[data-etab]").forEach((b) => b.classList.toggle("on", b === el));
        paint("overview"); return;
      }
      if ((el = t.closest("[data-pwr]"))) {
        state.pwr = el.getAttribute("data-pwr");
        $$("[data-pwr]").forEach((b) => b.classList.toggle("on", b === el));
        paint("energy"); return;
      }
      if ((el = t.closest("[data-rack]"))) { locateRack(el.getAttribute("data-rack")); return; }
      if ((el = t.closest(".tree-node.zone, .tree-node.row"))) { el.classList.toggle("closed"); return; }
      if ((el = t.closest("[data-act]"))) { doAct(el); return; }
    });
    const sel = $("#rackSel");
    if (sel) sel.addEventListener("change", () => locateRack(sel.value));
    const inp = $("#chatInput");
    if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendChat(); } });
    const send = $("#chatSend"); if (send) send.addEventListener("click", sendChat);
    const mic = $("#chatMic");
    if (mic) mic.addEventListener("click", () => {
      const xw = IDC.xiaowei;
      if (xw && xw.listen) xw.listen();
      else api.toast("当前环境不支持语音识别，可文字输入（示例）", "warning");
    });
    const wk = $("#wakeToggle");
    if (wk) wk.addEventListener("click", () => {
      const xw = IDC.xiaowei;
      const on = wk.textContent.indexOf("开启") === 0;
      if (xw) xw.wakeWordEnabled = on;
      wk.textContent = on ? "关闭语音唤醒" : "开启语音唤醒";
      api.toast(on ? "已开启语音唤醒（示例）" : "已关闭语音唤醒", "info");
    });
    const sp = $("#speakChk");
    if (sp) sp.addEventListener("change", () => {
      const xw = IDC.xiaowei;
      if (xw) xw.speakEnabled = !!sp.checked;
      api.toast(sp.checked ? "语音播报已开启" : "语音播报已关闭", "info");
    });
    const search = $("#devSearch");
    if (search) search.addEventListener("input", () => { state.devQ = search.value || ""; renderDeviceTable(false); paint("assets"); });
    const pb = $("#pwrBars");
    if (pb) { pb.addEventListener("mousemove", onPwrMove); pb.addEventListener("mouseleave", () => { const tip = $("#pwrTip"); if (tip) tip.classList.add("hidden"); }); }
  }
  function locateRackSilent(id) {
    state.rackId = id;
    const sc = IDC.scene;
    if (sc && sc.focusRack) { try { sc.focusRack(id, { open: true, duration: 1.2 }); } catch (e) {} }
    else if (IDC.bus) IDC.bus.emit("rack:select", id);
    const sel = $("#rackSel"); if (sel) sel.value = id;
    setTxt("#monRackTitle", id);
    renderMonitorDetail();
  }
  /* =======================================================================
   *  对外 API（契约）
   * ======================================================================= */
  const api = {
    root: null, scene: null, _data: null,
    mount(root, data, scene) {
      api.root = root || api.root;
      api.scene = scene || api.scene;
      api._data = data || IDC.data;
      if (data) IDC.data = data;
      const r = api.root;
      if (!r) return api;
      r.innerHTML = buildOverview() + buildMonitor() + buildAssets() + buildEnergy() + buildAlarms() + buildWorkorder() + buildDonghuan();
      wire(r);
      api.chat.clear();
      api.chat.add({ role: "assistant", text: "已到达 A-02" });
      api.chat.add({ role: "assistant", card: true, text: "上次维保 2024-10-28，下次计划 2024-11-28，负责班组：IDC 维保一组。建议：检查进风通道与冷通道送风，确认温度传感器读数。以上为示例维保记录。" });
      api.chat.setStatus("小维正在回复：A-02 号机柜，进风温度过高，温度 31.8 度，功率 2.23 千瓦。检查进风通道与冷通道送风，确认温度传感器读数。维保记录已展示。");
      api.chat.setNextStep("下一步：确认告警 →");
      bindBus();
      if (global.ResizeObserver) {
        let raf = 0;
        const ro = new ResizeObserver(() => {
          if (raf) return;
          raf = (global.requestAnimationFrame || setTimeout)(() => { raf = 0; paint(state.page); }, 60);
        });
        try { ro.observe(r); } catch (e) {}
      }
      api.setPage(state.page);
      return api;
    },
    setPage(name, opts) {
      const root = api.root;
      if (name == null) name = "overview";
      const pages = root ? $$(".hud-page", root) : [];
      if (pages.length && !pages.some((p) => p.getAttribute("data-pg") === name)) name = "overview";
      const prev = state.page;
      state.page = name;
      pages.forEach((p) => p.classList.toggle("on", p.getAttribute("data-pg") === name));
      if (name === "monitor" && prev !== "monitor") setMonView("3d", true);
      const raf = global.requestAnimationFrame || ((f) => setTimeout(f, 16));
      raf(() => render(name));
    },
    refresh() { if (!api.root) return; render(state.page); },
    /** 切换动环分区标签：ups | th | water | smoke | mdb（兼容 dev type 别名） */
    setDhTab(name) {
      if (!name) return false;
      const n = DH_TAB_ALIAS[name] || String(name);
      if (!DH_TABS.some((t) => t[0] === n)) return false;
      state.dhTab = n;
      if (state.page !== "donghuan") {
        if (IDC.app && IDC.app.goto) IDC.app.goto("donghuan");
        else api.setPage("donghuan");
      }
      const raf = global.requestAnimationFrame || ((f) => setTimeout(f, 16));
      raf(() => { if (state.page === "donghuan") renderDonghuan(); });
      return true;
    },
    setRackDetail(rackId) {
      const d = D();
      const rack = d.getRack ? d.getRack(rackId) : null;
      if (!rack) return;
      state.rackId = rackId;
      state.isoRack = rack;
      const sel = $("#rackSel"); if (sel) sel.value = rackId;
      setTxt("#monRackTitle", rackId);
      if (!api.root) return;
      if (state.page === "monitor" && state.monView !== "detail") setMonView("detail");
      renderMonitorDetail();
      if (state.page === "assets") renderZoneTree();
    },
    chat: {
      add(m) {
        const box = $("#chatStream");
        if (!box || !m || m.text == null) return;
        const role = m.role === "user" ? "user" : "assistant";
        const el = document.createElement("div");
        el.className = "msg " + role + (m.card ? " card" : "");
        el.innerHTML = role === "user"
          ? '<div class="bubble">' + esc(m.text) + "</div>"
          : '<span class="cdot">·</span><div class="bubble">' + esc(m.text) + "</div>";
        box.appendChild(el);
        box.scrollTop = box.scrollHeight;
        while (box.children.length > 40) box.removeChild(box.firstChild);
      },
      setStatus(t) {
        const el = $("#chatStatus");
        if (!el) return;
        el.textContent = t || "";
        el.classList.toggle("on", !!t);
        const box = $("#chatStream");
        if (box) box.scrollTop = box.scrollHeight;
      },
      setNextStep(t) { setTxt("#closureNext", t); },
      clear() { const box = $("#chatStream"); if (box) box.innerHTML = ""; },
    },
    toast(text, level) {
      const box = $("#toast-root");
      if (!box || !text) return;
      const el = document.createElement("div");
      el.className = "toast " + (level || "");
      el.textContent = text;
      box.appendChild(el);
      while (box.children.length > 4) box.removeChild(box.firstChild);
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 3400);
    },
    setListening(b) {
      state.listening = !!b;
      const mic = $("#btn-mic"); if (mic) mic.classList.toggle("listening", state.listening);
      const cm = $("#chatMic"); if (cm) cm.classList.toggle("on", state.listening);
      if (state.listening) {
        const st = $("#chatStatus");
        if (st) { st.textContent = "正在聆听…可以说「巡检 A-02」或「当前告警」"; st.classList.add("on"); }
      }
    },
    openWorkOrder(woId) {
      if (woId) state.woId = woId;
      state.wof = "all";
      const bs = $$("[data-wof]");
      bs.forEach((b) => b.classList.toggle("on", b.getAttribute("data-wof") === "all"));
      const app = IDC.app;
      if (app && app.goto) app.goto("workorder"); else api.setPage("workorder");
      const raf = global.requestAnimationFrame || ((f) => setTimeout(f, 16));
      raf(() => {
        render("workorder");
        paint("workorder");
        const el = api.root ? $('[data-wo="' + state.woId + '"]', api.root) : null;
        if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
      });
    },
    updateShell() {
      const k = D().kpi || {};
      const r = $("#kpi-rack"); if (r) r.textContent = k.rackTotal != null ? k.rackTotal : 42;
      const p = $("#kpi-power"); if (p) p.innerHTML = (k.totalPowerKW != null ? k.totalPowerKW : 32.6) + '<span class="unit">kW</span>';
      const u = $("#kpi-pue"); if (u) u.textContent = k.pue != null ? k.pue : 1.36;
      const a = $("#kpi-avail"); if (a) a.innerHTML = (k.available != null ? k.available : 99.99) + '<span class="unit">%</span>';
      const tk = $("#ticker");
      if (tk && !tk.children.length) {
        const ev = (D().events || [])[0];
        if (ev) tk.innerHTML = '<span class="t-time">' + shortClock() + "</span><span>" + esc(ev.text) + "</span>";
      }
    },
  };

  let busBound = false;
  function bindBus() {
    const bus = IDC.bus;
    if (!bus || typeof bus.on !== "function" || busBound) return;
    busBound = true;
    bus.on("data:tick", () => { try { api.refresh(); } catch (e) { console.warn("[hud] refresh", e); } });
    bus.on("rack:select", (id) => { try { api.setRackDetail(id); } catch (e) {} });
    bus.on("wo:update", () => { try { if (state.page === "workorder") renderWorkorder(); if (state.page === "monitor") renderMonitorDetail(); } catch (e) {} });
    bus.on("alarm:ack", () => { try { if (state.page === "alarms") renderAlarms(); if (state.page === "monitor") renderMonitor(); } catch (e) {} });
    bus.on("alarm:add", () => { try { if (state.page === "alarms") renderAlarms(); } catch (e) {} });
    bus.on("assistant:listen", (b) => { try { api.setListening(!!b); } catch (e) {} });
    bus.on("page", (p) => { try { if (p === "monitor") setMonView("3d", true); } catch (e) {} });
    bus.on("monitor:view", (v) => { try { setMonView(v, true); } catch (e) {} });
    bus.on("dh:data", () => { try { dhHistPush(); if (state.page === "donghuan") renderDonghuan(); } catch (e) {} });
    bus.on("dh:alarm", (a) => {
      try {
        if (state.page === "donghuan") renderDonghuan();
        if (a) api.toast("动环报警：" + (a.devName || a.devId) + " " + (a.text || ""), a.level);
      } catch (e) {}
    });
    bus.on("dh:alarm:clear", () => { try { if (state.page === "donghuan") renderDonghuan(); } catch (e) {} });
    bus.on("dh:alarm:ack", () => { try { if (state.page === "donghuan") renderDonghuan(); } catch (e) {} });
    bus.on("dh:device", () => { try { if (state.page === "donghuan") renderDonghuan(); } catch (e) {} });
    bus.on("dh:ready", () => { try { dhHistPush(); if (state.page === "donghuan") renderDonghuan(); } catch (e) {} });
    bus.on("dh:select", (p) => {
      try {
        if (!p || !p.devId) return;
        state.dhDev = p.devId;
        let tab = p.tab;
        if (!tab) {
          const dev = IDC.dh && IDC.dh.getDevice ? IDC.dh.getDevice(p.devId) : null;
          tab = dev && DH_TAB_ALIAS[dev.type];
        }
        if (tab && DH_TABS.some((t) => t[0] === tab)) state.dhTab = tab;
        if (state.page === "donghuan") renderDonghuan();
      } catch (e) {}
    });
  }

  /* =======================================================================
   *  页面 7 · 动环监控（IDC.dh）
   * ======================================================================= */
  const DH_TABS = [["ups", "UPS"], ["th", "温湿度"], ["water", "浸水"], ["smoke", "烟感"], ["mdb", "供配电"]];
  const DH_TYPE_LB = { ups: "UPS", ac: "精密空调", th: "温湿度", water: "浸水", smoke: "烟感", mdb: "低压配电", battery: "电池组", ats: "ATS 双电源" };
  const DH_LEVEL = { critical: "严重", warning: "一般", info: "提示" };
  const DH_TAB_ALIAS = { ups: "ups", battery: "ups", th: "th", ac: "th", water: "water", smoke: "smoke", mdb: "mdb", ats: "mdb", power: "mdb" };
  const DH_LVK = { critical: "crit", warning: "warn", info: "info" };

  function buildDonghuan() {
    const stats =
      ps("设备在线率", "dhOnlineRate", "--", "%") +
      ps("活动报警", "dhAlarmCount", "0", "条", "red") +
      ps("UPS 负载率", "dhUpsLoad", "--", "%") +
      ps("电池后备时间", "dhBatMin", "--", "min");
    const status =
      '<div class="dh-status" data-panel>' +
        '<span class="dsi"><i>接入驱动</i><b id="dhDriver">--</b></span>' +
        '<span class="dsi"><i>连接状态</i><b id="dhConn" class="warn">本地模拟</b></span>' +
        '<span class="dsi"><i>采集周期</i><b id="dhPoll">--</b></span>' +
        '<span class="dsi"><i>本轮耗时</i><b id="dhLatency">--</b></span>' +
        '<span class="dsi"><i>帧数</i><b id="dhFrames">0</b></span>' +
        '<span class="dsi"><i>点位总数</i><b id="dhPoints">0</b></span>' +
        '<span class="dsi"><i>设备数</i><b id="dhDevices">0</b></span>' +
        '<span class="ds-grow"></span>' +
        '<span class="ds-url" id="dhUrl"></span>' +
        '<button class="mbtn" id="dhConnect" data-act="dh-connect">接入动环网关</button>' +
      "</div>";
    const left = panel({
      title: "动环设备", en: "FIELD DEVICES", cls: "fx-1",
      act: '<span class="chip" id="dhTreeCount">--</span>',
      body: '<div class="dh-tree" id="dhTree"></div>',
    });
    const center =
      '<div class="col center"><div class="center-layer">' +
        '<div class="dh-tabs" data-panel>' +
          DH_TABS.map((t) => '<button class="dtab' + (t[0] === state.dhTab ? " on" : "") + '" data-dhtab="' + t[0] + '">' + t[1] + "</button>").join("") +
        "</div>" +
        '<div class="dh-cards" id="dhCards"></div>' +
        '<div class="dh-foot"><span class="lg"><i class="dot ok"></i>正常</span>' +
          '<span class="lg"><i class="dot warn"></i>越限</span>' +
          '<span class="lg"><i class="dot crit"></i>报警</span>' +
          '<span class="upd">传感器点位已在三维机房中标注 · 点击可定位</span></div>' +
      "</div></div>";
    const right =
      panel({
        title: "实时报警", en: "ACTIVE ALARMS", cls: "fx-1",
        act: '<span class="chip crit" id="dhAlarmChip">0 条</span>',
        body: '<div class="dh-alarms" id="dhAlarmList"></div>',
      }) +
      panel({
        title: "点表速览", en: "POINT TABLE", cls: "fx-1",
        act: '<button class="mbtn sm" data-act="dh-export">导出 CSV</button>',
        body: '<div class="dh-pts" id="dhPointList"></div>',
      });
    return '<div class="hud-page" data-pg="donghuan">' +
      pageHead("动环监控", "UPS / 温湿度 / 浸水 / 烟感 / 供配电 实时测点接入。", stats) +
      status +
      '<div class="page-body cols"><div class="col">' + left + "</div>" + center + '<div class="col">' + right + "</div></div>" +
      badge("本地示例数据 · 非真实机房上线系统") + "</div>";
  }

  /* ---------------- 动环取值助手 ---------------- */
  const dhOK = () => !!(IDC.dh && IDC.dh.devices && IDC.dh.devices.length);
  function dhV(id) { const dh = IDC.dh; if (!dh || !dh.value) return null; const v = dh.value(id); return v == null ? null : v; }
  function dhPMap(type, key) {
    const m = {};
    const dh = IDC.dh;
    if (!dh || !dh.pick) return m;
    (dh.pick(type, key) || []).forEach((x) => { m[x.devId] = x; });
    return m;
  }
  function dhNum(v, d) {
    if (v == null || v === "") return "--";
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    const k = Math.pow(10, d == null ? 1 : d);
    return (Math.round(n * k) / k).toFixed(d == null ? 1 : d);
  }
  function dhSev(id) {
    const dh = IDC.dh, p = dh && dh.getPoint ? dh.getPoint(id) : null;
    if (!p) return "";
    const v = dhV(id);
    if (v == null) return "";
    if (p.kind === "di") return (p.invert ? v === p.normal : v !== p.normal) ? (p.devId.indexOf("SM-") === 0 || p.devId.indexOf("WD-") === 0 ? "crit" : "warn") : "";
    if (p.hiHi != null && v > p.hiHi) return "crit";
    if (p.loLo != null && v < p.loLo) return "crit";
    if (p.hi != null && v > p.hi) return "warn";
    if (p.lo != null && v < p.lo) return "warn";
    return "";
  }
  const dhCls = (id) => { const s = dhSev(id); return s ? " " + s : ""; };
  function dhTime(ts) {
    if (!ts) return "--:--:--";
    const d = new Date(ts);
    const p2 = (n) => String(n).padStart(2, "0");
    return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
  }
  /* ---------------- 动环：驱动名 / 状态条 ---------------- */
  function dhDriverLabel() {
    const dh = IDC.dh;
    if (!dh) return "--";
    const name = (dh.gw && dh.gw.driver) || "sim";
    let lb = "内置模拟器";
    try { (dh.drivers ? dh.drivers() : []).forEach((d) => { if (d.name === name) lb = d.label; }); } catch (e) {}
    return lb;
  }
  function renderDhStatus() {
    const dh = IDC.dh;
    if (!dhOK()) return;
    const gw = dh.gw || {};
    setTxt("#dhDriver", dhDriverLabel());
    const cs = $("#dhConn");
    if (cs) {
      cs.textContent = dh.connected ? "已接入网关" : "本地模拟";
      cs.className = dh.connected ? "ok" : "warn";
    }
    setTxt("#dhPoll", (dh.poll || gw.interval || 0) + " ms");
    setTxt("#dhLatency", (gw.latency != null ? gw.latency : dh.latency || 0) + " ms");
    setTxt("#dhFrames", commas(dh.frames || 0));
    setTxt("#dhPoints", commas(dh.points.length));
    setTxt("#dhDevices", dh.devices.length);
    setTxt("#dhUrl", dh.connected ? (gw.url || "") : "");
    const btn = $("#dhConnect");
    if (btn) {
      btn.textContent = dh.connected ? "断开网关" : "接入动环网关";
      btn.classList.toggle("primary", !dh.connected);
    }
  }

  /* ---------------- 动环：设备树 ---------------- */
  function renderDhTree() {
    const dh = IDC.dh, box = $("#dhTree");
    if (!box || !dhOK()) return;
    setTxt("#dhTreeCount", dh.devices.length + " 台");
    const zones = new Map();
    dh.devices.forEach((d) => {
      if (!zones.has(d.zone)) zones.set(d.zone, new Map());
      const t = zones.get(d.zone);
      if (!t.has(d.type)) t.set(d.type, []);
      t.get(d.type).push(d);
    });
    const zorder = (IDC.dh.SITE && IDC.dh.SITE.zones) || [];
    const zkeys = Array.from(zones.keys()).sort((a, b) => {
      const ia = zorder.indexOf(a), ib = zorder.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    let html = "";
    zkeys.forEach((zone) => {
      const types = zones.get(zone);
      let cnt = 0; types.forEach((l) => { cnt += l.length; });
      html += '<div class="tree-node zone open" data-dhzone="' + esc(zone) + '"><span class="tn-caret"></span>' +
        '<span class="tn-name">' + esc(zone) + "</span><b>" + cnt + "</b></div><div class=\"tree-kids\">";
      types.forEach((list, type) => {
        html += '<div class="tree-node row open" data-dhrow="' + esc(zone) + "|" + type + '"><span class="tn-caret"></span>' +
          '<span class="tn-name">' + (DH_TYPE_LB[type] || type) + "</span><b>" + list.length + "</b></div><div class=\"tree-kids\">";
        list.forEach((d) => {
          const al = dh.alarmsOf ? dh.alarmsOf(d.id) : [];
          const act = al.filter((a) => a.state !== "cleared");
          const bad = act.length ? (act.some((a) => a.level === "critical") ? "crit" : "warn") : "";
          html += '<div class="tree-node rack dh-dev' + (d.online === false ? " off" : "") + (state.dhDev === d.id ? " on" : "") + '" data-dhdev="' + esc(d.id) + '">' +
            '<i class="dot ' + (d.online === false ? "off" : "ok") + '"></i>' +
            '<span class="tn-name">' + esc(d.name) + "</span>" +
            (act.length ? '<i class="dh-badge ' + bad + '">' + act.length + "</i>" : "") +
            '<b>' + esc(d.id) + "</b></div>";
        });
        html += "</div>";
      });
      html += "</div>";
    });
    box.innerHTML = html;
  }

  /* ---------------- 动环：报警列表 ---------------- */
  function renderDhAlarms() {
    const dh = IDC.dh, box = $("#dhAlarmList");
    if (!box || !dhOK()) return;
    const list = (dh.activeAlarms ? dh.activeAlarms() : []).slice().sort((a, b) => {
      const w = { critical: 0, warning: 1, info: 2 };
      return (w[a.level] - w[b.level]) || (b.ts - a.ts);
    });
    setTxt("#dhAlarmChip", list.length + " 条");
    setTxt("#dhAlarmCount", list.length);
    if (!list.length) {
      box.innerHTML = '<div class="dh-empty">当前无活动报警<br><small>本地模拟运行中 · 可用语音或演示注入触发</small></div>';
      return;
    }
    box.innerHTML = list.map((a) => {
      const k = DH_LVK[a.level] || "info";
      return '<div class="dh-al-item ' + k + '" data-dhalarm="' + esc(a.pointId) + '">' +
        '<span class="al-bar"></span>' +
        '<div class="dh-al-top"><b>' + esc(a.devName || a.devId) + '</b><i class="tag ' + k + '">' + (DH_LEVEL[a.level] || a.level) + "</i></div>" +
        '<div class="dh-al-txt">' + esc(a.text || a.pointName || a.pointId) + "</div>" +
        '<div class="dh-al-bot"><span class="al-time">' + dhTime(a.ts) + "</span>" +
        '<span class="dh-al-state">' + (a.state === "acked" ? "已确认" : "未确认") + "</span>" +
        '<span class="dh-al-acts">' +
        '<button class="link" data-dhack="' + esc(a.pointId) + '">确认</button>' +
        '<button class="link" data-dhclear="' + esc(a.pointId) + '">清除</button></span></div></div>';
    }).join("");
  }

  /* ---------------- 动环：点表速览 ---------------- */
  function renderDhPoints() {
    const dh = IDC.dh, box = $("#dhPointList");
    if (!box || !dhOK()) return;
    let rows = [];
    try { rows = (dh.pointTable ? dh.pointTable() : []).slice(0, 10); } catch (e) {}
    box.innerHTML = rows.map((r) => {
      const addr = r.addr !== "" && r.addr != null ? String(r.addr) : (r.oid ? String(r.oid).slice(-8) : "--");
      const th = [];
      if (r.hiHi !== "") th.push("≤" + r.hiHi);
      if (r.hi !== "") th.push("<" + r.hi);
      if (r.lo !== "") th.push(">" + r.lo);
      if (r.loLo !== "") th.push("≥" + r.loLo);
      return '<div class="dh-pt">' +
        '<div class="dh-pt-h"><b>' + esc(r.pointId) + "</b><span>" + esc(r.name) + "</span></div>" +
        '<div class="dh-pt-b"><i class="tag info">' + esc(r.protocol) + "</i><span>" + esc(addr) + "</span>" +
        (th.length ? '<em>' + th.join(" / ") + " " + esc(r.unit || "") + "</em>" : '<em class="muted">DI</em>') + "</div></div>";
    }).join("") || '<div class="dh-empty">点表不可用</div>';
  }
  /* ---------------- 动环：卡片构造助手 ---------------- */
  const dhCard = (title, en, body, cls) => panel({ title: title, en: en, cls: "dh-card " + (cls || ""), body: body });
  const dhKv = (l, v, c) => '<div class="dh-kv"><span>' + l + '</span><b class="' + (c || "") + '">' + v + "</b></div>";
  function dhBit(devId, key) {
    const dh = IDC.dh;
    const p = dh && dh.getPoint ? dh.getPoint(devId + "." + key) : null;
    const v = dhV(devId + "." + key);
    if (!p || v == null) return { t: "--", bad: "" };
    const bits = p.bits || {};
    const t = bits[String(v)] != null ? bits[String(v)] : String(v);
    const bad = (p.invert ? v === p.normal : v !== p.normal) ? "crit" : "ok";
    return { t: t, bad: bad };
  }
  const dhTri = (devId, a, b, c, unit, d) =>
    dhNum(dhV(devId + "." + a), d) + " / " + dhNum(dhV(devId + "." + b), d) + " / " + dhNum(dhV(devId + "." + c), d) + (unit ? " " + unit : "");
  function dhDevHead(d) {
    return '<div class="dh-devh"><i class="dot ' + (d.online === false ? "off" : "ok") + '"></i><b>' + esc(d.id) + "</b><span>" + esc(d.name) + "</span>" +
      (d.online === false ? '<i class="tag off">离线</i>' : "") + "</div>";
  }

  /* ---------------- 动环：UPS 分区 ---------------- */
  function dhUpsCards() {
    const dh = IDC.dh;
    const ups = dh.byType("ups");
    const inBody = ups.map((d) => {
      const o = dhSev(d.id + ".UAA") || dhSev(d.id + ".IAA");
      return '<div class="dh-devblk">' + dhDevHead(d) +
        dhKv("输入电压 UA/UB/UC", dhTri(d.id, "UAA", "UAB", "UAC", "V", 1), o) +
        dhKv("输入电流 IA/IB/IC", dhTri(d.id, "IAA", "IAB", "IAC", "A", 1)) +
        dhKv("输入频率", dhNum(dhV(d.id + ".fIn"), 2) + " Hz") +
        dhKv("线电压 UAB", dhNum(dhV(d.id + ".UAB_L"), 1) + " V") + "</div>";
    }).join("");
    const outBody = ups.map((d) => {
      const o = dhSev(d.id + ".load") || dhSev(d.id + ".UOA");
      return '<div class="dh-devblk">' + dhDevHead(d) +
        dhKv("输出电压 UOA/UOB/UOC", dhTri(d.id, "UOA", "UOB", "UOC", "V", 1)) +
        dhKv("输出电流 IOA/IOB/IOC", dhTri(d.id, "IOA", "IOB", "IOC", "A", 1)) +
        dhKv("输出有功功率", dhNum(dhV(d.id + ".pOut"), 2) + " kW") +
        dhKv("负载率", dhNum(dhV(d.id + ".load"), 1) + " %", o) +
        dhKv("机内温度", dhNum(dhV(d.id + ".temp"), 1) + " ℃") + "</div>";
    }).join("");
    const gaugeBody = '<div class="dh-rings">' + ups.map((d, i) =>
      '<div class="dh-ring"><canvas class="cv" data-c="dhUpsLoad' + i + '"></canvas>' +
      '<span class="dh-ring-lb">' + esc(d.id) + "</span></div>").join("") + "</div>" +
      '<div class="dh-ring-foot">' + ups.map((d) => dhKv(esc(d.id) + " 载率", dhNum(dhV(d.id + ".load"), 1) + " %", dhSev(d.id + ".load"))).join("") + "</div>";
    const batBody = ups.map((d) => '<div class="dh-devblk">' + dhDevHead(d) +
      dhKv("电池组电压", dhNum(dhV(d.id + ".batV"), 1) + " V", dhSev(d.id + ".batV")) +
      dhKv("充放电电流", dhNum(dhV(d.id + ".batI"), 1) + " A", dhSev(d.id + ".batI")) +
      dhKv("后备时间", dhNum(dhV(d.id + ".batMin"), 1) + " min", dhSev(d.id + ".batMin")) + "</div>").join("");
    const bat01 = dh.getDevice("BAT-01") ? ('<div class="dh-devblk">' + dhDevHead(dh.getDevice("BAT-01")) +
      dhKv("组电压 / 电流", dhNum(dhV("BAT-01.U"), 1) + " V / " + dhNum(dhV("BAT-01.I"), 1) + " A") +
      dhKv("SOC / SOH", dhNum(dhV("BAT-01.soc"), 1) + " % / " + dhNum(dhV("BAT-01.soh"), 1) + " %", dhSev("BAT-01.soh")) +
      dhKv("单体温差 / 内阻", dhNum(dhV("BAT-01.dT"), 2) + " ℃ / " + dhNum(dhV("BAT-01.rInt"), 3) + " mΩ") + "</div>") : "";
    const bitKeys = [["stIn", "输入开关"], ["stOut", "输出开关"], ["bypass", "旁路"], ["fault", "整流"], ["faultInv", "逆变"], ["faultBat", "电池"], ["onBatt", "放电中"]];
    const badgeBody = ups.map((d) => '<div class="dh-devblk">' + dhDevHead(d) +
      '<div class="dh-badges">' + bitKeys.map((k) => {
        const b = dhBit(d.id, k[0]);
        const isBad = b.bad === "crit";
        const invertGood = (k[0] === "stIn" || k[0] === "stOut" || k[0] === "onBatt");
        return '<i class="dh-badge2 ' + (invertGood ? (b.bad === "ok" ? "ok" : "") : (isBad ? "crit" : "ok")) + '" title="' + k[1] + '">' + k[1] + " · " + b.t + "</i>";
      }).join("") + "</div></div>").join("");
    return dhCard("三相输入 / 输出", "THREE-PHASE I/O", inBody + outBody) +
      dhCard("负载率 / 电池组", "LOAD & BATTERY", gaugeBody + batBody) +
      dhCard("开关状态量 / 电池组", "STATUS POINTS", badgeBody + bat01);
  }

  /* ---------------- 动环：温湿度分区 ---------------- */
  function dhThCards() {
    const dh = IDC.dh;
    const devs = dh.byType("th");
    const outs = [];
    devs.forEach((d) => {
      const s = dhSev(d.id + ".temp") || dhSev(d.id + ".hum");
      if (s) outs.push('<div class="dh-out ' + s + '"><b>' + esc(d.name) + '</b><span>' + dhNum(dhV(d.id + ".temp"), 1) + " ℃ / " + dhNum(dhV(d.id + ".hum"), 1) + " %RH</span></div>");
    });
    const trend = dhCard("24 小时温湿度趋势", "24H TREND",
      '<div class="dh-legend2"><span><i style="background:#f5a524"></i>温度 ℃</span><span><i style="background:#35e0ff"></i>湿度 %RH</span></div>' +
      '<div class="dh-chartwrap"><canvas class="cv fill" data-c="dhThTrend"></canvas></div>');
    const bars = dhCard("温湿度测点 / 越限", "ZONE SENSORS",
      '<div class="dh-chartwrap sm"><canvas class="cv" data-c="dhThBars" style="height:132px"></canvas></div>' +
      '<div class="dh-outs">' + (outs.length ? outs.join("") : '<div class="dh-empty">全部温湿度测点在上/下限内</div>') + "</div>");
    return trend + bars;
  }

  /* ---------------- 动环：浸水分区 ---------------- */
  function dhWaterCards() {
    const dh = IDC.dh;
    const devs = dh.byType("water");
    let bad = 0, ropeBad = 0;
    const rows = devs.map((d) => {
      const n = d.rope ? 6 : 1;
      let cells = "";
      for (let i = 1; i <= 6; i++) {
        if (i > n) { cells += '<i class="mx-cell na">--</i>'; continue; }
        const p = dh.getPoint(d.id + ".ch" + i);
        const v = dhV(d.id + ".ch" + i);
        const b = v != null && p && (p.invert ? v === p.normal : v !== p.normal);
        if (b) bad++;
        cells += '<i class="mx-cell ' + (b ? "crit" : "ok") + '" title="' + esc(d.name) + " CH" + i + (b ? " 浸水报警" : " 正常") + '">' + (b ? "浸水" : "正常") + "</i>";
      }
      const rb = d.rope ? dhBit(d.id, "ropeBreak") : null;
      if (rb && rb.bad === "crit") ropeBad++;
      return '<div class="mx-row"><span class="mx-name"><i class="dot ' + (d.online === false ? "off" : "ok") + '"></i>' + esc(d.name) + "</span>" + cells +
        '<span class="mx-rope">' + (rb ? '<i class="tag ' + (rb.bad === "crit" ? "crit" : "ok") + '">' + rb.t + "</i>" : '<i class="tag off">点式</i>') + "</span></div>";
    }).join("");
    const matrix = dhCard("浸水点位矩阵（12 台 / 绳式 + 点式）", "WATER LEAK MATRIX",
      '<div class="dh-mx"><div class="mx-row head"><span class="mx-name">设备</span><i class="mx-cell">CH1</i><i class="mx-cell">CH2</i><i class="mx-cell">CH3</i><i class="mx-cell">CH4</i><i class="mx-cell">CH5</i><i class="mx-cell">CH6</i><span class="mx-rope">感应绳</span></div>' +
      rows + "</div>");
    const list = devs.filter((d) => {
      for (let i = 1; i <= (d.rope ? 6 : 1); i++) { if (dhSev(d.id + ".ch" + i) === "crit") return true; }
      return false;
    });
    const side = dhCard("汇总 / 报警点", "SUMMARY",
      '<div class="dh-bignum"><b class="' + (bad ? "crit" : "ok") + '">' + bad + '</b><span>浸水报警点</span></div>' +
      '<div class="dh-bignum"><b class="' + (ropeBad ? "crit" : "ok") + '">' + ropeBad + '</b><span>感应绳断线</span></div>' +
      '<div class="dh-outs">' + (list.length ? list.map((d) => {
        let s = "warn";
        for (let i = 1; i <= (d.rope ? 6 : 1); i++) { if (dhSev(d.id + ".ch" + i) === "crit") s = "crit"; }
        return '<div class="dh-out ' + s + '"><b>' + esc(d.name) + "</b><span>浸水报警</span></div>";
      }).join("") : '<div class="dh-empty">全部浸水点位正常</div>') + "</div>");
    return matrix + side;
  }

  /* ---------------- 动环：烟感分区 ---------------- */
  function dhSmokeCards() {
    const dh = IDC.dh;
    const devs = dh.byType("smoke");
    let bad = 0;
    const cells = devs.map((d) => {
      const b = dhSev(d.id + ".state") === "crit";
      const fault = dhSev(d.id + ".fault") === "crit" || dhSev(d.id + ".fault") === "warn";
      if (b) bad++;
      return '<div class="sm-cell ' + (b ? "crit" : fault ? "warn" : "ok") + '"><b>' + esc(d.id) + "</b><span>" + (b ? "烟雾报警" : fault ? "探头故障" : "正常") + "</span>" +
        '<i>' + dhNum(dhV(d.id + ".pollution"), 2) + " %</i></div>";
    }).join("");
    const matrix = dhCard("烟感点位矩阵（12 点）", "SMOKE DETECTORS", '<div class="sm-grid">' + cells + "</div>");
    const rows = devs.map((d) => '<div class="dh-kv"><span>' + esc(d.id) + ' · ' + esc(d.zone) + '</span><b>' +
      dhNum(dhV(d.id + ".pollution"), 2) + " % / " + dhNum(dhV(d.id + ".voltage"), 1) + " V</b></div>").join("");
    const side = dhCard("污染度 / 供电电压", "POLLUTION & SUPPLY",
      '<div class="dh-bignum"><b class="' + (bad ? "crit" : "ok") + '">' + bad + '</b><span>烟雾报警点数</span></div>' +
      '<div class="dh-scroll">' + rows + "</div>");
    return matrix + side;
  }

  /* ---------------- 动环：供配电分区 ---------------- */
  function dhMdbCards() {
    const dh = IDC.dh;
    const mdbs = dh.byType("mdb");
    const tbl = mdbs.map((d) => '<div class="dh-devblk">' + dhDevHead(d) +
      dhKv("三相相电压 UPA/UPB/UPC", dhTri(d.id, "UPA", "UPB", "UPC", "V", 1), dhSev(d.id + ".UPA")) +
      dhKv("三相电流 IA/IB/IC", dhTri(d.id, "IA", "IB", "IC", "A", 1), dhSev(d.id + ".IA")) +
      dhKv("有功功率", dhNum(dhV(d.id + ".P"), 2) + " kW", dhSev(d.id + ".P")) +
      dhKv("功率因数", dhNum(dhV(d.id + ".PF"), 3), dhSev(d.id + ".PF")) +
      dhKv("有功电能", dhNum(dhV(d.id + ".E"), 1) + " kWh") +
      dhKv("频率", dhNum(dhV(d.id + ".f"), 2) + " Hz", dhSev(d.id + ".f")) +
      dhKv("断路器位置", "<i class=\"tag " + (dhBit(d.id, "brk").bad === "crit" ? "crit" : "ok") + "\">" + dhBit(d.id, "brk").t + "</i>") + "</div>").join("");
    const ats = dh.getDevice("ATS-01");
    const atsBody = ats ? ('<div class="dh-devblk">' + dhDevHead(ats) +
      dhKv("主电源电压", dhNum(dhV("ATS-01.Umain"), 1) + " V", dhSev("ATS-01.Umain")) +
      dhKv("备用电源电压", dhNum(dhV("ATS-01.Ubak"), 1) + " V", dhSev("ATS-01.Ubak")) +
      dhKv("输出电压", dhNum(dhV("ATS-01.Uout"), 1) + " V") +
      dhKv("当前工位", "<i class=\"tag " + (dhBit("ATS-01", "pos").bad === "crit" ? "crit" : "ok") + "\">" + dhBit("ATS-01", "pos").t + "</i>") +
      dhKv("主电源可用", dhBit("ATS-01", "stMain").t) +
      dhKv("备用电源可用", dhBit("ATS-01", "stBak").t) +
      dhKv("切换次数", dhNum(dhV("ATS-01.cnt"), 0) + " 次") + "</div>") : '<div class="dh-empty">未接入 ATS</div>';
    return dhCard("低压配电 / 列头柜", "MDB CIRCUITS", '<div class="dh-2col">' + tbl + "</div>") +
      dhCard("ATS 双电源", "ATS", atsBody +
        '<div class="dh-outs">' + mdbs.map((d) => {
          const s = dhSev(d.id + ".P");
          return '<div class="dh-out ' + (s || "ok") + '"><b>' + esc(d.id) + '</b><span>' + dhNum(dhV(d.id + ".P"), 2) + " kW · " + dhNum(dhV(d.id + ".PF"), 3) + "</span></div>";
        }).join("") + "</div>");
  }

  function dhTabHtml(tab) {
    if (tab === "ups") return dhUpsCards();
    if (tab === "th") return dhThCards();
    if (tab === "water") return dhWaterCards();
    if (tab === "smoke") return dhSmokeCards();
    if (tab === "mdb") return dhMdbCards();
    return "";
  }

  /* ---------------- 动环：主渲染 ---------------- */
  function dhHistPush() {
    const dh = IDC.dh;
    if (!dhOK()) return;
    const t = dhPMap("th", "temp"), h = dhPMap("th", "hum");
    let ts = 0, tn = 0, hs = 0, hn = 0;
    Object.keys(t).forEach((k) => { const v = Number(t[k].value); if (isFinite(v)) { ts += v; tn++; } });
    Object.keys(h).forEach((k) => { const v = Number(h[k].value); if (isFinite(v)) { hs += v; hn++; } });
    const z = { "A 区": [], "B 区": [], "C 区": [], "电力间": [] };
    dh.byType("th").forEach((d) => { const v = Number(dhV(d.id + ".temp")); if (isFinite(v) && z[d.zone]) z[d.zone].push(v); });
    const za = (k) => (z[k].length ? z[k].reduce((a, b) => a + b, 0) / z[k].length : null);
    state.dhHist.push({ t: (D().clockShort ? D().clockShort() : "--:--:--"), temp: tn ? ts / tn : null, hum: hn ? hs / hn : null, A: za("A 区"), B: za("B 区"), C: za("C 区"), P: za("电力间") });
    while (state.dhHist.length > 90) state.dhHist.shift();
  }
  function renderDhKpi() {
    const dh = IDC.dh;
    if (!dhOK()) return;
    const on = dh.devices.filter((d) => d.online !== false).length;
    setTxt("#dhOnlineRate", dhNum((on / dh.devices.length) * 100, 1));
    const ups = dhPMap("ups", "load"), bat = dhPMap("ups", "batMin");
    const avg = (m) => {
      let s = 0, n = 0;
      Object.keys(m).forEach((k) => { const v = Number(m[k].value); if (isFinite(v)) { s += v; n++; } });
      return n ? s / n : null;
    };
    setTxt("#dhUpsLoad", dhNum(avg(ups), 1));
    setTxt("#dhBatMin", dhNum(avg(bat), 1));
  }
  function renderDonghuan() {
    if (state.dhHist.length < 2) dhHistPush();
    if (!dhOK()) {
      const c = $("#dhCards");
      if (c) c.innerHTML = '<div class="dh-empty">动环模块 IDC.dh 未就绪<br><small>src/donghuan.js 加载失败或未 init</small></div>';
      return;
    }
    renderDhStatus();
    renderDhKpi();
    renderDhTree();
    $$("[data-dhtab]").forEach((b) => b.classList.toggle("on", b.getAttribute("data-dhtab") === state.dhTab));
    const c = $("#dhCards");
    if (c) {
      c.className = "dh-cards dh-tab-" + state.dhTab;
      c.innerHTML = dhTabHtml(state.dhTab);
    }
    renderDhAlarms();
    renderDhPoints();
    paint("donghuan");
  }
  /* ---------------- 动环：Canvas 图表 ---------------- */
  function dhRingPaint(cv, i) {
    if (!dhOK()) return;
    const ups = IDC.dh.byType("ups"), d = ups[i];
    if (!d) return;
    const v = Number(dhV(d.id + ".load"));
    const sev = dhSev(d.id + ".load");
    drawGauge(cv, (isFinite(v) ? v : 0) / 100, {
      value: (isFinite(v) ? dhNum(v, 1) : "--") + "%", size: 15, lw: 6, pad: 4,
      c1: sev === "crit" ? "#ff8b8c" : "#35e0ff", c2: sev === "crit" ? "#ff4d4f" : "#2f7fe8",
      glow: sev === "crit" ? "rgba(255,77,79,.8)" : "rgba(34,211,238,.8)",
    });
  }
  function dhThTrendPaint(cv) {
    const g = ctxOf(cv); if (!g) return;
    const ctx = g.ctx, w = g.w, h = g.h;
    const hist = state.dhHist || [];
    const padL = 30, padR = 34, padT = 10, padB = 16;
    const iw = w - padL - padR, ih = h - padT - padB;
    if (iw <= 6 || ih <= 6) return;
    ctx.strokeStyle = "rgba(64,180,255,.10)"; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + ih * (i / 4);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    }
    let lo = 1e9, hi = -1e9;
    hist.forEach((s) => { ["A", "B", "C", "P"].forEach((k) => { const v = s[k]; if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } }); });
    if (!isFinite(lo) || !isFinite(hi)) { lo = 22; hi = 27; }
    const span = Math.max(0.8, hi - lo);
    let tmin = lo - span * 0.55, tmax = hi + span * 0.55;
    if (tmax - tmin < 2.4) { const mid = (tmax + tmin) / 2; tmin = mid - 1.2; tmax = mid + 1.2; }
    ctx.font = "9px " + FONT; ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const y = padT + ih * (i / 4);
      ctx.fillStyle = "#5f7791"; ctx.textAlign = "right";
      ctx.fillText((tmax - (tmax - tmin) * (i / 4)).toFixed((tmax - tmin) < 8 ? 1 : 0), padL - 4, y);
      ctx.textAlign = "left";
      ctx.fillStyle = "#4d80a8";
      ctx.fillText((100 - 100 * (i / 4)).toFixed(0), w - padR + 4, y);
    }
    if (hist.length < 2) {
      ctx.fillStyle = "#5f7791"; ctx.font = "11px " + FONT; ctx.textAlign = "center";
      ctx.fillText("正在累积趋势样本（每 2s 一点）…", padL + iw / 2, padT + ih / 2);
      return;
    }
    const n = hist.length;
    const X = (i) => padL + iw * (i / (n - 1));
    const YT = (v) => padT + ih * (1 - clamp((v - tmin) / (tmax - tmin), 0, 1));
    const YH = (v) => padT + ih * (1 - clamp(v / 100, 0, 1));
    // 湿度（右轴）面积
    ctx.beginPath();
    hist.forEach((s, i) => { const y = YH(s.hum == null ? 45 : s.hum); if (i) ctx.lineTo(X(i), y); else ctx.moveTo(X(i), y); });
    ctx.lineTo(X(n - 1), padT + ih); ctx.lineTo(X(0), padT + ih); ctx.closePath();
    const ag = ctx.createLinearGradient(0, padT, 0, padT + ih);
    ag.addColorStop(0, hexA("#35e0ff", .20)); ag.addColorStop(1, hexA("#35e0ff", 0));
    ctx.fillStyle = ag; ctx.fill();
    ctx.beginPath();
    hist.forEach((s, i) => { const y = YH(s.hum == null ? 45 : s.hum); if (i) ctx.lineTo(X(i), y); else ctx.moveTo(X(i), y); });
    ctx.strokeStyle = hexA("#35e0ff", .75); ctx.lineWidth = 1; ctx.stroke();
    // 温度曲线
    const series = [["A", "#f5a524"], ["B", "#7c6cf0"], ["C", "#22c55e"], ["P", "#ff8b8c"]];
    series.forEach((sd) => {
      ctx.beginPath();
      let started = false;
      hist.forEach((s, i) => {
        const v = s[sd[0]];
        if (v == null) return;
        if (!started) { ctx.moveTo(X(i), YT(v)); started = true; } else ctx.lineTo(X(i), YT(v));
      });
      if (!started) return;
      ctx.strokeStyle = sd[1]; ctx.lineWidth = 1.5; ctx.lineJoin = "round";
      ctx.save(); ctx.shadowColor = hexA(sd[1], .7); ctx.shadowBlur = 5; ctx.stroke(); ctx.restore();
    });
    // X 轴时间
    ctx.fillStyle = "#5f7791"; ctx.font = "9px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "top";
    [0, n >> 1, n - 1].forEach((i) => { ctx.fillText(String(hist[i].t || ""), X(i), padT + ih + 3); });
  }
  function dhThBarsPaint(cv) {
    const g = ctxOf(cv); if (!g) return;
    const ctx = g.ctx, w = g.w, h = g.h;
    if (!dhOK()) return;
    const devs = IDC.dh.byType("th");
    if (!devs.length) return;
    const padL = 28, padR = 8, padT = 8, padB = 16;
    const iw = w - padL - padR, ih = h - padT - padB;
    if (iw <= 6 || ih <= 6) return;
    const tmin = 14, tmax = 32;
    const Y = (v) => padT + ih * (1 - clamp((v - tmin) / (tmax - tmin), 0, 1));
    // 正常区间带
    ctx.fillStyle = "rgba(34,197,94,.10)";
    ctx.fillRect(padL, Y(27), iw, Math.max(1, Y(18) - Y(27)));
    ctx.strokeStyle = "rgba(64,180,255,.10)"; ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = padT + ih * (i / 3);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = "#5f7791"; ctx.font = "9px " + FONT; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText((tmax - (tmax - tmin) * (i / 3)).toFixed(0), padL - 4, y);
    }
    const n = devs.length;
    const gap = clamp(iw / n * 0.34, 2, 8);
    const bw = Math.min(34, (iw - gap * (n - 1)) / n);
    const off = padL + Math.max(0, (iw - (n * bw + (n - 1) * gap)) / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    devs.forEach((d, i) => {
      const v = Number(dhV(d.id + ".temp"));
      const sev = dhSev(d.id + ".temp");
      const y = isFinite(v) ? Y(v) : padT + ih;
      const x = off + i * (bw + gap);
      const bh = Math.max(2, padT + ih - y);
      const c1 = sev === "crit" ? "#ff8b8c" : sev === "warn" ? "#ffd166" : "#35e0ff";
      const c2 = sev === "crit" ? "rgba(255,77,79,.25)" : sev === "warn" ? "rgba(245,165,36,.25)" : "rgba(53,224,255,.18)";
      const gr = ctx.createLinearGradient(0, y, 0, padT + ih);
      gr.addColorStop(0, c1); gr.addColorStop(1, c2);
      ctx.fillStyle = gr;
      rr(ctx, x, y, bw, bh, Math.min(3, bw / 2)); ctx.fill();
      if (isFinite(v)) {
        ctx.fillStyle = sev ? c1 : "#9fd8f5"; ctx.font = "9px " + FONT;
        ctx.fillText(dhNum(v, 1), x + bw / 2, Math.max(padT, y - 11));
      }
      ctx.fillStyle = "#5f7791"; ctx.font = "9px " + FONT;
      ctx.fillText(d.id.replace("TH-", ""), x + bw / 2, padT + ih + 3);
    });
  }

  function dhExportCsv() {
    const dh = IDC.dh;
    if (!dh || !dh.exportPointTableCsv) { api.toast("点表接口不可用", "warning"); return; }
    let csv = "";
    try { csv = dh.exportPointTableCsv(); } catch (e) { api.toast("导出失败：" + e.message, "critical"); return; }
    if (!csv) { api.toast("点表为空", "warning"); return; }
    try {
      const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "动环点表.csv"; a.style.display = "none";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 3000);
      api.toast("已导出动环点表 CSV（" + (csv.split("\n").length - 1) + " 行）", "ok");
    } catch (e) { api.toast("导出失败：" + e.message, "critical"); }
  }

  IDC.hud = api;
})(window);
