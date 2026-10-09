/* SPDX-License-Identifier: AGPL-3.0-or-later
 * IDC 可视化运维项目（IDC Visual Ops）· Copyright (c) 2026 99kevindk
 * 本文件以 AGPL-3.0-or-later 开源；闭源商业集成 / SaaS 托管需另行取得商业授权（见 COMMERCIAL-LICENSE.md）。
 */
/* =========================================================================
 *  src/floorplan.js — 机房二维图纸（平面图）：图元绘制、编辑、导出、与 3D 联动
 *  · 数据源：IDC.data.racks（42 台机柜真实坐标）/ src/pointtable.js（39 台动环设备 place）
 *  · 图元库：window.IDC.symbols（src/symbols.js；缺失时用内置兜底图元）
 *  · 对外：window.IDC.plan（见 docs/机房图纸与图元规范.md §3）
 * ========================================================================= */
(function (global) {
  "use strict";
  const IDC = global.IDC = global.IDC || {};
  const bus = IDC.bus;
  const emit = (e, p) => { try { bus && bus.emit && bus.emit(e, p); } catch (err) { console.error("[plan]" + e, err); } };
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (tag, cls, html) => { const d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round = (v, n) => { const k = Math.pow(10, n || 0); return Math.round(v * k) / k; };
  const uid = (p) => (p || "it") + "-" + Math.random().toString(36).slice(2, 7);

  const LAYERS = [
    { id: "arch", name: "建筑", color: "#7f9ab8", visible: true, locked: false },
    { id: "rack", name: "机柜", color: "#22d3ee", visible: true, locked: false },
    { id: "power", name: "电力", color: "#f5a524", visible: true, locked: false },
    { id: "cool", name: "制冷", color: "#2f7fe8", visible: true, locked: false },
    { id: "safety", name: "消防安防", color: "#ff4d4f", visible: true, locked: false },
    { id: "env", name: "环境监测", color: "#22c55e", visible: true, locked: false },
    { id: "cable", name: "综合布线", color: "#7c6cf0", visible: true, locked: false },
    { id: "annot", name: "标注", color: "#dce9ff", visible: true, locked: false },
  ];
  const SYM2KIND = {};
  (function () {
    const M = {
      rack: "rack", lvdp: "pdu", battery: "battery", ats: "pdu", pdu: "pdu", busway: "pdu", trench: "pdu", ups: "ups",
      crac: "ac", rowac: "ac", fcu: "ac", ahu: "ac", humid: "ac", pipe: "custom",
      smoke: "smoke", heat: "smoke", sprinkler: "custom", gas: "custom", emergency: "custom", exit: "custom",
      extinguisher: "ext", cctv: "cctv", access: "door", intrusion: "custom",
      th: "th", water: "water", leak: "water", diff: "th", air: "th",
      "tray": "tray", ladder: "tray", racktop: "tray", odf: "custom", patch: "custom",
      wall: "wall", glass: "wall", column: "column", door: "door", stair: "custom", ceiling: "custom", grid: "custom",
      text: "sign", dim: "sign", north: "sign", scale: "sign", legend: "sign", title: "sign", zone: "custom",
    };
    Object.keys(M).forEach((suffix) => { SYM2KIND[suffix] = M[suffix]; });
  })();
  function kindOf(sym) { const parts = String(sym || "").split("."); for (let i = parts.length - 1; i >= 0; i--) { if (SYM2KIND[parts[i]]) return SYM2KIND[parts[i]]; } return "custom"; }
  const MM = 1000;                                  // 1 m = 1000 mm（图纸单位 mm）

  /* ---------------- 模型 ---------------- */
  function emptyModel() {
    return {
      meta: { site: "上海一号数据中心", floor: "1F", name: "机房平面图", unit: "mm",
              grid: 100, snap: 100, scale: 50, rev: 1, updated: 0, title: "IDC 机房平面图" },
      layers: LAYERS.map((l) => Object.assign({}, l)),
      items: [], dims: [], texts: [], view: { zoom: 0.045, panX: 0, panY: 0 },
    };
  }
  const A = {                                          // 内部状态
    root: null, canvas: null, ctx: null, model: emptyModel(),
    sel: new Set(), clipboard: [], mode: "select", hover: null,
    drag: null, band: null, space: false, dirty: true, raf: 0, time: 0,
    undo: [], redo: [], saveTimer: 0, lastMouse: { x: 0, y: 0 }, visible: false, ep: null,
  };
  const layerOf = (id) => A.model.layers.find((l) => l.id === id) || A.model.layers[0];
  const itemById = (id) => A.model.items.find((i) => i.id === id);
  const itemsOf = (fn) => A.model.items.filter(fn);
  A.selectionSize = function () { return A.sel.size; };
  function snapshot() { return JSON.stringify({ items: A.model.items, dims: A.model.dims, texts: A.model.texts, meta: A.model.meta }); }
  function pushUndo() {
    A.undo.push(snapshot());
    if (A.undo.length > 60) A.undo.shift();
    A.redo.length = 0;
  }
  function applySnap(json) {
    const s = JSON.parse(json);
    A.model.items = s.items; A.model.dims = s.dims; A.model.texts = s.texts; A.model.meta = s.meta;
    A.sel.clear(); A.dirty = true; scheduleSave(); refreshProps(); refreshTree();
  }
  const undo = () => { if (!A.undo.length) return; A.redo.push(snapshot()); applySnap(A.undo.pop()); };
  const redo = () => { if (!A.redo.length) return; A.undo.push(snapshot()); applySnap(A.redo.pop()); };
  function scheduleSave() {
    A.model.meta.updated = Date.now(); A.model.meta.rev++;
    clearTimeout(A.saveTimer);
    A.saveTimer = setTimeout(() => { try { localStorage.setItem("idc.plan.v1", JSON.stringify(A.model)); } catch (e) {} }, 900);
  }
  function restore() {
    try {
      const raw = localStorage.getItem("idc.plan.v1");
      if (raw) { const m = JSON.parse(raw); if (m && m.items && m.items.length) { A.model = m; if (!A.model.view) A.model.view = { zoom: .045, panX: 0, panY: 0 }; return true; } }
    } catch (e) {}
    return false;
  }

  /* ---------------- 图元访问（含兜底） ---------------- */
  function S() { return (IDC.symbols && IDC.symbols.SYMBOLS) ? IDC.symbols : null; }
  /* ---------------- 图纸底层图元（图元库缺失时的兜底；同名时以图元库为准） ---------------- */
  const L = (o) => Object.assign({ cat: "annot", fill: "#1b2530", stroke: "#5f7791", bind: null, params: [], label: true }, o);
  const LOCAL = {
    "arch.zone": L({ name: "机房范围", cat: "arch", w: 16000, h: 24000, draw(ctx, it) {
      ctx.fillStyle = "rgba(20,34,52,.55)"; ctx.strokeStyle = "#4f7fa8"; ctx.lineWidth = 60; ctx.setLineDash([400, 300]);
      ctx.fillRect(-it.w / 2, -it.h / 2, it.w, it.h); ctx.strokeRect(-it.w / 2, -it.h / 2, it.w, it.h); ctx.setLineDash([]);
    } }),
    "env.coldaisle": L({ name: "冷通道", cat: "env", w: 12000, h: 1800, draw(ctx, it) {
      ctx.fillStyle = "rgba(34,211,238,.12)"; ctx.strokeStyle = "rgba(34,211,238,.5)"; ctx.lineWidth = 40;
      ctx.fillRect(-it.w / 2, -it.h / 2, it.w, it.h);
      ctx.save(); ctx.beginPath(); ctx.rect(-it.w / 2, -it.h / 2, it.w, it.h); ctx.clip();
      ctx.strokeStyle = "rgba(34,211,238,.18)"; ctx.lineWidth = 30;
      for (let x = -it.w / 2; x < it.w / 2; x += 400) { ctx.beginPath(); ctx.moveTo(x, -it.h / 2); ctx.lineTo(x + it.h, it.h / 2); ctx.stroke(); }
      ctx.restore();
      if (it.label) { ctx.fillStyle = "#7fe3ff"; ctx.font = "600 260px Microsoft YaHei,sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(it.name || "冷通道", 0, 0); }
    } }),
    "cable.tray": L({ name: "桥架", cat: "cable", w: 12000, h: 300, draw(ctx, it) {
      ctx.strokeStyle = "#8f7be8"; ctx.lineWidth = 40; ctx.fillStyle = "rgba(124,108,240,.18)";
      ctx.fillRect(-it.w / 2, -it.h / 2, it.w, it.h); ctx.strokeRect(-it.w / 2, -it.h / 2, it.w, it.h);
      ctx.lineWidth = 20; ctx.beginPath();
      for (let x = -it.w / 2 + 200; x < it.w / 2; x += 400) { ctx.moveTo(x, -it.h / 2); ctx.lineTo(x, it.h / 2); }
      ctx.stroke();
    } }),
    "arch.wall": L({ name: "墙体/隔断", cat: "arch", w: 200, h: 8000, draw(ctx, it) {
      ctx.fillStyle = "#3a4a5c"; ctx.strokeStyle = "#7f9ab8"; ctx.lineWidth = 20;
      ctx.fillRect(-it.w / 2, -it.h / 2, it.w, it.h); ctx.strokeRect(-it.w / 2, -it.h / 2, it.w, it.h);
      ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.lineWidth = 12;
      for (let y = -it.h / 2; y < it.h / 2; y += 300) { ctx.beginPath(); ctx.moveTo(-it.w / 2, y); ctx.lineTo(it.w / 2, y + 300); ctx.stroke(); }
    } }),
    "annot.titleblock": L({ name: "标题栏", w: 6800, h: 3200, draw(ctx, it, env) {
      const rows = [["工程名称", "上海一号数据中心"], ["图名", "机房平面图（1F）"], ["比例", "1:50"], ["图号", "IDC-PLAN-001"], ["日期", new Date().toLocaleDateString("zh-CN")], ["设计/审核", "运维部 / 张工"]];
      ctx.fillStyle = "#0d1a29"; ctx.strokeStyle = "#8fd8f5"; ctx.lineWidth = 30;
      ctx.fillRect(-it.w / 2, -it.h / 2, it.w, it.h); ctx.strokeRect(-it.w / 2, -it.h / 2, it.w, it.h);
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      rows.forEach((r, i) => {
        const y = -it.h / 2 + it.h / rows.length * (i + .5);
        ctx.strokeStyle = "rgba(143,216,245,.25)"; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(-it.w / 2, y + it.h / rows.length / 2); ctx.lineTo(it.w / 2, y + it.h / rows.length / 2); ctx.stroke();
        ctx.fillStyle = "#7f9ab8"; ctx.font = "300 'Microsoft YaHei',sans-serif"; ctx.fillText(r[0] + "：", -it.w / 2 + 200, y);
        ctx.fillStyle = "#dce9ff"; ctx.fillText(r[1], -it.w / 2 + 1600, y);
      });
    } }),
    "annot.north": L({ name: "指北针", w: 1200, h: 1200, draw(ctx, it) {
      ctx.fillStyle = "#dce9ff"; ctx.beginPath(); ctx.moveTo(0, -it.h / 2); ctx.lineTo(it.w / 4, it.h / 2); ctx.lineTo(0, it.h / 3); ctx.lineTo(-it.w / 4, it.h / 2); ctx.closePath(); ctx.fill();
      ctx.font = "600 400px Microsoft YaHei,sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("N", 0, -it.h / 3);
    } }),
    "annot.scalebar": L({ name: "比例尺", w: 4000, h: 700, draw(ctx, it) {
      const n = 4, seg = it.w / n;
      ctx.textAlign = "center"; ctx.textBaseline = "bottom"; ctx.font = "600 300px Consolas,monospace";
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = i % 2 ? "#dce9ff" : "#0d1a29"; ctx.strokeStyle = "#dce9ff"; ctx.lineWidth = 20;
        ctx.fillRect(-it.w / 2 + i * seg, -it.h / 2, seg, it.h / 2); ctx.strokeRect(-it.w / 2 + i * seg, -it.h / 2, seg, it.h / 2);
        ctx.fillStyle = "#dce9ff"; ctx.fillText(String(i), -it.w / 2 + i * seg, -it.h / 2 - 60);
      }
      ctx.fillStyle = "#dce9ff"; ctx.fillText(String(n) + " m", it.w / 2, -it.h / 2 - 60);
    } }),
    "annot.legend": L({ name: "图例", w: 2600, h: 5000, draw(ctx, it) {
      const items = [["正常机柜", "#22c55e"], ["告警机柜", "#ff4d4f"], ["离线机柜", "#5b6b80"], ["UPS/配电", "#f5a524"], ["精密空调", "#2f7fe8"], ["烟感/浸水", "#ff4d4f"], ["温湿度", "#22c55e"], ["桥架", "#7c6cf0"]];
      ctx.fillStyle = "#0d1a29"; ctx.strokeStyle = "#8fd8f5"; ctx.lineWidth = 20;
      ctx.fillRect(-it.w / 2, -it.h / 2, it.w, it.h); ctx.strokeRect(-it.w / 2, -it.h / 2, it.w, it.h);
      ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.font = "600 220px Microsoft YaHei,sans-serif";
      ctx.fillStyle = "#8fd8f5"; ctx.fillText("图 例", -it.w / 2 + 160, -it.h / 2 + 220);
      items.forEach(([name, color], i) => {
        const y = -it.h / 2 + 560 + i * (it.h - 700) / items.length;
        ctx.fillStyle = color; ctx.fillRect(-it.w / 2 + 160, y - 70, 180, 140);
        ctx.fillStyle = "#dce9ff"; ctx.fillText(name, -it.w / 2 + 460, y);
      });
    } }),
  };
  const ALIAS = {
    "arch.zone": [],                                   // 机房范围：用内置图元（库里没有等价物）
    "env.coldaisle": ["annot.zone", "env.cold", "env.aisle"],     // 冷通道 → 区域填充
    "cable.tray": ["cable.tray.v", "cable.ladder", "cable.tray.h"],
    "arch.wall": ["arch.partition", "arch.wall.line"],
    "annot.titleblock": ["annot.title", "annot.frame"],
    "annot.scalebar": ["annot.scale"],
    "annot.legend": ["annot.legendbox", "annot.legend"],
    "annot.north": ["annot.north"],
  };
  function lookup(id) {
    const s = S();
    if (s && s.SYMBOLS && s.SYMBOLS[id]) return s.SYMBOLS[id];
    const al = ALIAS[id] || [];
    for (let i = 0; i < al.length; i++) { if (s && s.SYMBOLS && s.SYMBOLS[al[i]]) return s.SYMBOLS[al[i]]; }
    if (s && s.SYMBOLS) {
      const cat = id.split(".")[0], key = id.split(".")[1] || "";
      const hit = Object.keys(s.SYMBOLS).find((k) => k.indexOf(cat + ".") === 0 && (key && k.toLowerCase().indexOf(key.slice(0, 4).toLowerCase()) >= 0));
      if (hit) return s.SYMBOLS[hit];
    }
    return LOCAL[id] || null;
  }
  function symDef(id) {
    const hit = lookup(id);
    if (hit) return Object.assign({ w: 600, h: 600, fill: "#2b3138", stroke: "#7fd8ff", params: [] }, hit, { id });
    return { id, name: id, cat: "ext", w: 600, h: 600, fill: "#2b3138", stroke: "#7fd8ff", bind: null, params: [], draw: fallbackDraw };
  }
  function fallbackDraw(ctx, it, env) {
    const w = (it && it.w) || 600, h = (it && it.h) || 600;
    ctx.fillStyle = "#232a33"; ctx.strokeStyle = (env && env.status && env.status.state === "alarm") ? "#ff4d4f" : "#7fd8ff";
    ctx.lineWidth = 20; ctx.fillRect(-w / 2, -h / 2, w, h); ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.beginPath(); ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(w / 2, h / 2); ctx.moveTo(w / 2, -h / 2); ctx.lineTo(-w / 2, h / 2); ctx.stroke();
  }
  function drawOne(ctx, it, env) {
    const def = lookup(it.sym);                       // 先查图元库（含别名/模糊）→ 再查内置底图图元
    if (def && def.draw) { try { def.draw(ctx, it, env); return; } catch (e) { console.warn("[plan] draw " + it.sym, e); } }
    const s = S();
    if (s && s.drawSymbol) { try { s.drawSymbol(ctx, it.sym, it, env); return; } catch (e) { } }
    fallbackDraw(ctx, it, env);
  }
  function iconFor(id, px) {
    const s = S();
    if (s && s.iconCanvas) { try { const c = s.iconCanvas(id, px || 34); if (c) return c.toDataURL(); } catch (e) {} }
    const c = document.createElement("canvas"); c.width = c.height = px || 34;
    const x = c.getContext("2d");
    x.translate(c.width / 2, c.height / 2);
    const d = symDef(id); const k = Math.min(c.width / (d.w * 1.25), c.height / (d.h * 1.25));
    x.scale(k, k);
    (d.draw || fallbackDraw)(x, { sym: id, w: d.w, h: d.h, params: {} }, { scale: k, label: false, selected: false, hover: false, time: 0 });
    return c.toDataURL();
  }

  /* ======================================================================
   *  视口 / 渲染
   * ==================================================================== */
  function resize() {
    const c = A.canvas; if (!c) return;
    const r = c.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    c.width = Math.max(320, Math.floor(r.width * dpr)); c.height = Math.max(240, Math.floor(r.height * dpr));
    c.style.width = r.width + "px"; c.style.height = r.height + "px";
    A.ctx = c.getContext("2d"); A.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    A.dirty = true;
  }
  const V = () => A.model.view;
  const w2s = (x, y) => [x * V().zoom + V().panX, y * V().zoom + V().panY];
  const s2w = (sx, sy) => [(sx - V().panX) / V().zoom, (sy - V().panY) / V().zoom];
  function fitToScreen(pad) {
    const c = A.canvas; if (!c) return;
    const box = contentBox(false); if (!box) return;
    const W = c.clientWidth, H = c.clientHeight, p = pad == null ? 60 : pad;
    const z = Math.min((W - p * 2) / Math.max(1, box.w), (H - p * 2) / Math.max(1, box.h));
    V().zoom = clamp(z, .002, 2); V().panX = (W - box.w * V().zoom) / 2 - box.x * V().zoom; V().panY = (H - box.h * V().zoom) / 2 - box.y * V().zoom;
    A.dirty = true; refreshStatus();
  }
  function contentBox(includeAnnot) {
    let it = A.model.items; if (!it.length) return null;
    if (!includeAnnot) {
      const core = it.filter((i) => (i.layer || "") !== "annot" && !i._noBox);
      if (core.length > 6) it = core;
    }
    let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    it.forEach((i) => { const h = Math.max(i.w, i.h) / 2 + 200; x1 = Math.min(x1, i.x - h); y1 = Math.min(y1, i.y - h); x2 = Math.max(x2, i.x + h); y2 = Math.max(y2, i.y + h); });
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  function zoomAt(sx, sy, f) {
    const [wx, wy] = s2w(sx, sy);
    V().zoom = clamp(V().zoom * f, .004, 2);
    V().panX = sx - wx * V().zoom; V().panY = sy - wy * V().zoom;
    A.dirty = true; refreshStatus();
  }
  function itemStatus(it) {
    const b = it.bind; if (!b) return null;
    if (b.type === "rack") {
      const r = IDC.data && IDC.data.getRack && IDC.data.getRack(b.ref); if (!r) return null;
      const alarm = IDC.data.alarmOfRack ? IDC.data.alarmOfRack(b.ref) : null;
      return { state: r.status === "alarm" ? "alarm" : r.status === "offline" ? "offline" : "normal",
               level: alarm ? (alarm.level === "critical" ? "critical" : "warning") : null,
               value: r.tempIn + "℃", rack: r };
    }
    const dh = IDC.dh; if (!dh || !dh.getDevice) return null;
    const d = dh.getDevice(b.ref); if (!d) return null;
    const al = (dh.alarmsOf ? dh.alarmsOf(b.ref) : []).filter((a) => a.state !== "cleared");
    const p0 = (dh.pointsOf ? dh.pointsOf(b.ref) : []).find((p) => p.kind === "ai");
    const lv = al.length ? (al.some((a) => a.level === "critical") ? "critical" : al[0].level) : null;
    return { state: al.length ? "alarm" : (d.online === false ? "offline" : "normal"), level: lv,
             value: p0 ? round(dh.value(p0.id), 1) + (p0.unit || "") : null, dev: d };
  }
  function render() {
    const ctx = A.ctx, c = A.canvas; if (!ctx || !c) return;
    const W = c.clientWidth, H = c.clientHeight;
    ctx.save();
    ctx.fillStyle = "#04070d"; ctx.fillRect(0, 0, W, H);
    drawGrid(ctx, W, H);
    const layers = A.model.layers;
    const pulse = 0.5 + 0.5 * Math.sin(A.time / 320);
    let anyAlarm = false;
    layers.forEach((L) => {
      if (!L.visible) return;
      A.model.items.forEach((it) => {
        if ((it.layer || "ext") !== L.id) return;
        const env = { scale: V().zoom, label: it.label !== false, selected: A.sel.has(it.id), hover: A.hover === it.id,
                      locked: it.locked, time: A.time, status: null, value: null };
        const st = itemStatus(it);
        if (st) { env.status = { state: st.state, level: st.level, pulse }; env.value = st.value; if (st.level) anyAlarm = true; }
        ctx.save();
        const [sx, sy] = w2s(it.x, it.y);
        ctx.translate(sx, sy);
        if (it.rot) ctx.rotate(it.rot * Math.PI / 180);
        ctx.scale(V().zoom, V().zoom);
        drawOne(ctx, it, env);
        ctx.restore();
        if (A.sel.has(it.id) && !it._noBox) drawSelect(ctx, it);
        if (it.locked && (A.sel.has(it.id) || A.hover === it.id)) { ctx.strokeStyle = "rgba(245,165,36,.8)"; ctx.lineWidth = 1; const [x1, y1, x2, y2] = bbox(it); const p1 = w2s(x1, y1), p2 = w2s(x2, y2); ctx.strokeRect(p1[0], p1[1], p2[0] - p1[0], p2[1] - p1[1]); }
      });
    });
    // 文字与标注
    ctx.save();
    ctx.font = "600 11px 'Microsoft YaHei',sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    A.model.texts.forEach((t) => { const [sx, sy] = w2s(t.x, t.y); ctx.save(); ctx.translate(sx, sy); if (t.rot) ctx.rotate(t.rot * Math.PI / 180); ctx.fillStyle = t.color || "#dce9ff"; ctx.font = "600 " + Math.max(9, (t.size || 300) * V().zoom / 3) + "px 'Microsoft YaHei',sans-serif"; ctx.fillText(t.text, 0, 0); ctx.restore(); });
    A.model.dims.forEach((d) => {
      const p1 = w2s(d.x1, d.y1), p2 = w2s(d.x2, d.y2);
      ctx.strokeStyle = "#8fd8f5"; ctx.fillStyle = "#8fd8f5"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
      arrow(ctx, p1, p2); arrow(ctx, p2, p1);
      const L = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
      ctx.font = "600 10px Consolas,monospace"; ctx.textAlign = "center"; ctx.fillText(d.text || (round(L, 0) + " mm"), (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2 - 5);
    });
    ctx.restore();
    if (A.band) {
      const [x1, y1] = w2s(A.band.x0, A.band.y0), [x2, y2] = w2s(A.band.x1, A.band.y1);
      ctx.fillStyle = "rgba(34,211,238,.12)"; ctx.strokeStyle = "rgba(34,211,238,.7)"; ctx.lineWidth = 1;
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1); ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }
    ctx.restore();
    A.anyAlarm = anyAlarm;
  }
  function arrow(ctx, p, to) {
    const a = Math.atan2(to[1] - p[1], to[0] - p[0]), L = 7;
    ctx.beginPath(); ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[0] + Math.cos(a - .4) * L, p[1] + Math.sin(a - .4) * L);
    ctx.lineTo(p[0] + Math.cos(a + .4) * L, p[1] + Math.sin(a + .4) * L);
    ctx.closePath(); ctx.fill();
  }
  function bbox(it) {
    const w = it.w, h = it.h;
    if (!it.rot) return [it.x - w / 2, it.y - h / 2, it.x + w / 2, it.y + h / 2];
    const r = it.rot * Math.PI / 180, cx = Math.cos(r), sn = Math.sin(r);
    const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [it.x + x * cx - y * sn, it.y + x * sn + y * cx]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)];
  }
  function drawSelect(ctx, it) {
    const [x1, y1, x2, y2] = bbox(it), p1 = w2s(x1, y1), p2 = w2s(x2, y2);
    ctx.save();
    ctx.strokeStyle = "#22d3ee"; ctx.lineWidth = 1.4; ctx.setLineDash([5, 3]);
    ctx.strokeRect(p1[0] - 3, p1[1] - 3, p2[0] - p1[0] + 6, p2[1] - p1[1] + 6);
    ctx.setLineDash([]);
    ctx.fillStyle = "#22d3ee";
    [[p1[0] - 3, p1[1] - 3], [p2[0] + 3, p1[1] - 3], [p2[0] + 3, p2[1] + 3], [p1[0] - 3, p2[1] + 3]].forEach(([x, y]) => ctx.fillRect(x - 2.5, y - 2.5, 5, 5));
    ctx.restore();
  }
  function drawGrid(ctx, W, H) {
    const g = A.model.meta.grid || 100;
    let step = g * V().zoom;
    let mult = 1;
    while (step < 8) { step *= 5; mult *= 5; }
    const [wx0, wy0] = s2w(0, 0), [wx1, wy1] = s2w(W, H);
    ctx.save(); ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(64,180,255,.07)";
    ctx.beginPath();
    for (let x = Math.floor(wx0 / (g * mult)) * g * mult; x < wx1; x += g * mult) { const p = w2s(x, 0)[0]; ctx.moveTo(p, 0); ctx.lineTo(p, H); }
    for (let y = Math.floor(wy0 / (g * mult)) * g * mult; y < wy1; y += g * mult) { const p = w2s(0, y)[1]; ctx.moveTo(0, p); ctx.lineTo(W, p); }
    ctx.stroke();
    // 5m 主网格 + 原点
    ctx.strokeStyle = "rgba(64,180,255,.14)"; ctx.beginPath();
    for (let x = Math.floor(wx0 / 5000) * 5000; x < wx1; x += 5000) { const p = w2s(x, 0)[0]; ctx.moveTo(p, 0); ctx.lineTo(p, H); }
    for (let y = Math.floor(wy0 / 5000) * 5000; y < wy1; y += 5000) { const p = w2s(0, y)[1]; ctx.moveTo(0, p); ctx.lineTo(W, p); }
    ctx.stroke();
    const o = w2s(0, 0);
    ctx.strokeStyle = "rgba(255,120,120,.5)"; ctx.beginPath(); ctx.moveTo(o[0] - 8, o[1]); ctx.lineTo(o[0] + 8, o[1]); ctx.moveTo(o[0], o[1] - 8); ctx.lineTo(o[0], o[1] + 8); ctx.stroke();
    ctx.restore();
  }
  function loop(ts) {
    A.time = ts || 0;
    if (A.visible) {
      if (A.dirty || A.anyAlarm) { A.dirty = false; render(); }
      A.raf = requestAnimationFrame(loop);
    } else A.raf = 0;
  }
  const invalidate = () => { A.dirty = true; };

  /* ======================================================================
   *  自动出图（按 3D 机房真实坐标 + 动环 place）
   * ==================================================================== */
  function rackRowExtent(row) {
    const rs = (IDC.data && IDC.data.racksOfRow) ? IDC.data.racksOfRow(row) : [];
    if (!rs.length) return null;
    const xs = rs.map((r) => r.x * MM);
    return { min: Math.min.apply(null, xs), max: Math.max.apply(null, xs), n: rs.length };
  }
  function placeOf(dev) {
    const p = dev.place || {};
    const rowZ = { A: -13500, B: -10500, C: -4500, D: -1500, E: 4500, F: 7500 };
    if (p.kind === "power-room") return { x: 9500 + (p.idx % 2) * 1500, y: -12000 + Math.floor(p.idx / 2) * 3200 };
    if (p.kind === "wall-side") return { x: p.idx ? 8200 : -8200, y: -6000 };
    if (p.kind === "ceiling") { const g = p.grid % 12; return { x: [-6000, -2000, 2000, 6000][g % 4], y: [-12000, -6000, 0][Math.floor(g / 4)] }; }
    if (p.kind === "aisle-end") { const z = (p.row === "A" || p.row === "B") ? -12000 : -3000; return { x: p.idx ? 6700 : -6700, y: z }; }
    if (p.kind === "floor") { const i = p.idx; if (i <= 4) return { x: -4500 + (i - 1) * 3000, y: 9200 }; if (i <= 6) return { x: -8200, y: -4000 + (i - 5) * 3000 }; return { x: 8200, y: -4000 + (i - 7) * 3000 }; }
    if (p.kind === "rack-front") { const ex = rackRowExtent(p.row); const x = ex ? (p.idx === 0 ? ex.min : ex.max) : -6000; return { x: x + (p.idx === 0 ? 900 : -900), y: (rowZ[p.row] || 0) + (p.row === "B" || p.row === "D" || p.row === "F" ? 950 : -950) }; }
    return { x: 0, y: 0 };
  }
  const DH_SYM = { ups: "power.ups", mdb: "power.lvdp", battery: "power.battery", ats: "power.ats",
    ac: "cool.crac.down", th: "env.th", water: "env.water.rope", smoke: "safety.smoke" };
  const dhSym = (d) => (d.type === "water" ? (d.rope === false ? "env.water.point" : "env.water.rope") : (DH_SYM[d.type] || "env.th"));
  const DH_LAYER = { ups: "power", mdb: "power", battery: "power", ats: "power", ac: "cool", th: "env", water: "env", smoke: "safety" };
  function buildFromScene(opts) {
    opts = opts || {};
    const keep = opts.keepUser === false ? [] : A.model.items.filter((i) => i.user && i.user.added);
    const m = emptyModel(); m.view = A.model.view || m.view;
    const push = (it) => { it.id = it.id || uid("it"); m.items.push(Object.assign({ rot: 0, label: true, locked: false, params: {}, user: {} }, it)); };
    const racks = (IDC.data && IDC.data.racks) || [];
    if (racks.length) {
      let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
      racks.forEach((r) => { const X = r.x * MM, Y = r.z * MM; x1 = Math.min(x1, X); x2 = Math.max(x2, X); y1 = Math.min(y1, Y); y2 = Math.max(y2, Y); });
      const pad = 2400;
      const rw = x2 - x1 + 600 + pad * 2, rh = y2 - y1 + 1200 + pad * 2;
      push({ sym: "arch.zone", layer: "arch", x: (x1 + x2) / 2, y: (y1 + y2) / 2, w: rw, h: rh, name: "主机房", label: false, locked: true, _noBox: true, params: {} });
      // 机柜
      racks.forEach((r) => push({ sym: "rack.42u", layer: "rack", x: r.x * MM, y: r.z * MM, w: 600, h: 1100,
        rot: (r.row === "B" || r.row === "D" || r.row === "F") ? 180 : 0, name: r.id, bind: { type: "rack", ref: r.id },
        user: { auto: true }, params: { row: r.row } }));
      // 冷通道
      [["A", "B"], ["C", "D"], ["E", "F"]].forEach(([ra, rb]) => {
        const za = (racks.find((r) => r.row === ra) || {}).z, zb = (racks.find((r) => r.row === rb) || {}).z;
        if (za == null || zb == null) return;
        const ex = rackRowExtent(ra) || rackRowExtent(rb);
        push({ sym: "env.coldaisle", layer: "env", x: (ex.min + ex.max) / 2, y: (za + zb) / 2 * MM, w: ex.max - ex.min + 900, h: Math.abs(za - zb) * MM - 1200, name: ra + "/" + rb + " 冷通道", label: true, locked: true, _noBox: true });
      });
      // 桥架（沿排）
      ["A", "C", "E"].forEach((row) => { const r = racks.find((x) => x.row === row); const ex = rackRowExtent(row); if (r && ex) push({ sym: "cable.tray", layer: "cable", x: (ex.min + ex.max) / 2, y: r.z * MM, w: ex.max - ex.min + 1200, h: 300, locked: true, _noBox: true, name: row + " 排桥架" }); });
    }
    // 动环设备
    const dhDevs = (IDC.dh && IDC.dh.devices) ? IDC.dh.devices : (IDC.pointtableDevices || []);
    dhDevs.forEach((d) => {
      const pos = placeOf(d); const sym = dhSym(d);
      push({ sym, layer: DH_LAYER[d.type] || "env", x: pos.x, y: pos.y, name: d.name || d.id, bind: { type: "dh", ref: d.id },
             w: (symDef(sym).w), h: (symDef(sym).h), user: { auto: true }, params: {} });
    });
    // 建筑：外墙（沿主机房范围）+ 电力间隔断
    push({ sym: "arch.wall", layer: "arch", x: 11200, y: -3000, w: 180, h: 22000, rot: 0, name: "电力间隔墙", locked: true, _noBox: true });
    // 图框 + 标题栏 + 指北针 + 比例尺 + 图例
    push({ sym: "annot.titleblock", layer: "annot", x: 16500, y: 11500, w: 6800, h: 3200, name: "标题栏", locked: true, _noBox: true });
    push({ sym: "annot.north", layer: "annot", x: -9500, y: -14000, w: 1200, h: 1200, locked: true, _noBox: true });
    push({ sym: "annot.scalebar", layer: "annot", x: -9500, y: 11000, w: 4000, h: 600, locked: true, _noBox: true });
    push({ sym: "annot.legend", layer: "annot", x: -9500, y: 3000, w: 2600, h: 5000, name: "图例", locked: true, _noBox: true });
    m.texts.push({ id: uid("t"), x: 0, y: -16500, text: "上海一号数据中心 · 机房平面图（1F）", size: 420, layer: "annot" });
    keep.forEach((u) => m.items.push(u));
    A.model = m; A.sel.clear(); A.undo.length = 0; A.redo.length = 0;
    A.dirty = true; scheduleSave(); fitToScreen(50); refreshAll();
    // 动环模块可能比图纸晚就绪（异步连网关）：补一次带设备的出图
    if (!dhDevs.length && !A._rebuildTimer) {
      A._rebuildTimer = setTimeout(() => {
        A._rebuildTimer = 0;
        if (IDC.dh && IDC.dh.devices && IDC.dh.devices.length) {
          const userItems = A.model.items.filter((i) => i.user && i.user.added);
          buildFromScene({ keepUser: true });
        }
      }, 2000);
    }
    return m;
  }

  /* ======================================================================
   *  命中测试 / 交互
   * ==================================================================== */
  function hitTest(wx, wy) {
    for (let i = A.model.items.length - 1; i >= 0; i--) {
      const it = A.model.items[i]; if (it._noBox) continue;
      const L = layerOf(it.layer); if (!L.visible || L.locked) continue;
      const r = -(it.rot || 0) * Math.PI / 180, dx = wx - it.x, dy = wy - it.y;
      const lx = dx * Math.cos(r) - dy * Math.sin(r), ly = dx * Math.sin(r) + dy * Math.cos(r);
      if (Math.abs(lx) <= it.w / 2 && Math.abs(ly) <= it.h / 2) return it;
    }
    return null;
  }
  const snapV = (v) => { const s = A.model.meta.snap || 0; return s ? Math.round(v / s) * s : v; };
  function bindCanvas() {
    const c = A.canvas;
    c.addEventListener("mousedown", (e) => {
      const r = c.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      const [wx, wy] = s2w(sx, sy);
      if (e.button === 1 || A.space || A.mode === "pan") { A.drag = { type: "pan", sx, sy, px: V().panX, py: V().panY }; return; }
      if (A.mode === "dim") { A.ep = A.ep || []; A.ep.push([wx, wy]); if (A.ep.length === 2) { pushUndo(); A.model.dims.push({ id: uid("d"), x1: A.ep[0][0], y1: A.ep[0][1], x2: A.ep[1][0], y2: A.ep[1][1], layer: "annot" }); A.ep = null; setMode("select"); scheduleSave(); } invalidate(); return; }
      if (A.mode === "text") { const t = prompt("输入文字标注：", "机房 A 区"); if (t) { pushUndo(); A.model.texts.push({ id: uid("t"), x: wx, y: wy, text: t, size: 320, layer: "annot" }); scheduleSave(); } setMode("select"); invalidate(); return; }
      if (A.mode === "place" && A.pendingSym) { placeAt(A.pendingSym, wx, wy); setMode("select"); return; }
      const hit = hitTest(wx, wy);
      if (e.shiftKey) { if (hit) { A.sel.has(hit.id) ? A.sel.delete(hit.id) : A.sel.add(hit.id); } }
      else if (hit) { if (!A.sel.has(hit.id)) { A.sel.clear(); A.sel.add(hit.id); } }
      else { A.sel.clear(); A.band = { x0: wx, y0: wy, x1: wx, y1: wy }; }
      if (hit && !hit.locked && !e.shiftKey) {
        pushUndo();
        A.drag = { type: "move", start: [wx, wy], base: Array.from(A.sel).map((id) => { const it = itemById(id); return { id, x: it.x, y: it.y }; }) };
      }
      invalidate(); refreshProps(); refreshStatus(); refreshTree();
    });
    c.addEventListener("mousemove", (e) => {
      const r = c.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, [wx, wy] = s2w(sx, sy);
      A.lastMouse = { x: wx, y: wy };
      if (A.drag && A.drag.type === "pan") { V().panX = A.drag.px + (sx - A.drag.sx); V().panY = A.drag.py + (sy - A.drag.sy); invalidate(); return; }
      if (A.drag && A.drag.type === "move") {
        let dx = wx - A.drag.start[0], dy = wy - A.drag.start[1];
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        A.drag.base.forEach((b) => { const it = itemById(b.id); if (it && !it.locked) { it.x = snapV(b.x + dx); it.y = snapV(b.y + dy); } });
        invalidate(); refreshProps(); return;
      }
      if (A.band) { A.band.x1 = wx; A.band.y1 = wy; invalidate(); return; }
      const hit = hitTest(wx, wy);
      const id = hit ? hit.id : null;
      if (id !== A.hover) { A.hover = id; c.style.cursor = hit ? "move" : (A.mode === "select" ? "default" : "crosshair"); invalidate(); }
      refreshStatus();
    });
    c.addEventListener("mouseup", () => {
      if (A.band) {
        const x1 = Math.min(A.band.x0, A.band.x1), x2 = Math.max(A.band.x0, A.band.x1), y1 = Math.min(A.band.y0, A.band.y1), y2 = Math.max(A.band.y0, A.band.y1);
        if (Math.abs(x2 - x1) > 30 * (1 / V().zoom) / 30 && (x2 - x1) * V().zoom > 4) {
          A.model.items.forEach((it) => { if (it._noBox) return; const L = layerOf(it.layer); if (!L.visible || L.locked) return; const b = bbox(it); if (b[0] >= x1 && b[2] <= x2 && b[1] >= y1 && b[3] <= y2) A.sel.add(it.id); });
        }
        A.band = null; refreshProps(); refreshStatus();
      }
      if (A.drag && A.drag.type === "move") scheduleSave();
      A.drag = null; invalidate();
    });
    c.addEventListener("wheel", (e) => { e.preventDefault(); const r = c.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    c.addEventListener("dblclick", () => {
      const it = A.model.items.find((i) => A.sel.has(i.id));
      if (it && it.bind) { emit("plan:select", { type: it.bind.type, ref: it.bind.ref }); focusBound(it); }
    });
    c.addEventListener("dragover", (e) => e.preventDefault());
    c.addEventListener("drop", (e) => { e.preventDefault(); const sym = e.dataTransfer.getData("text/plan-sym"); if (!sym) return; const r = c.getBoundingClientRect(); const [wx, wy] = s2w(e.clientX - r.left, e.clientY - r.top); placeAt(sym, wx, wy); });
    addEventListener("keydown", onKey);
    addEventListener("keyup", (e) => { if (e.code === "Space") A.space = false; });
  }
  function focusBound(it) {
    if (!it || !it.bind) return;
    if (it.bind.type === "rack") { IDC.scene && IDC.scene.focusRack && IDC.scene.focusRack(it.bind.ref, { open: false, duration: .8 }); }
    else { IDC.scene && IDC.scene.focusDevice && IDC.scene.focusDevice(it.bind.ref, { duration: .8 }); }
  }
  function onKey(e) {
    if (!A.visible) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === "z") { e.preventDefault(); return undo(); }
    if (e.ctrlKey && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); return redo(); }
    if (e.ctrlKey && k === "a") { e.preventDefault(); A.model.items.forEach((i) => { const L = layerOf(i.layer); if (L.visible && !L.locked && !i._noBox) A.sel.add(i.id); }); invalidate(); refreshProps(); return; }
    if (e.ctrlKey && k === "c") { A.clipboard = Array.from(A.sel).map((id) => JSON.parse(JSON.stringify(itemById(id)))).filter(Boolean); return toast("已复制 " + A.clipboard.length + " 个图元"); }
    if (e.ctrlKey && k === "v") { if (!A.clipboard.length) return; pushUndo(); A.clipboard.forEach((c) => { const n = JSON.parse(JSON.stringify(c)); n.id = uid("it"); n.x += 600; n.y += 600; n.user = Object.assign({}, n.user, { added: !n.bind }); A.model.items.push(n); A.sel.add(n.id); }); invalidate(); scheduleSave(); refreshTree(); return; }
    if (k === "delete" || k === "backspace") { e.preventDefault(); delSel(); return; }
    if (k === "escape") { A.sel.clear(); setMode("select"); invalidate(); refreshProps(); return; }
    if (k === "r") { rotSel(90); return; }
    if (k === "f") { fitToScreen(); return; }
    if (k === " ") { A.space = true; return; }
    if (k.indexOf("arrow") === 0) {
      e.preventDefault(); const step = e.shiftKey ? 1000 : (A.model.meta.snap || 100);
      const dx = k === "arrowleft" ? -step : k === "arrowright" ? step : 0, dy = k === "arrowup" ? -step : k === "arrowdown" ? step : 0;
      pushUndo(); Array.from(A.sel).forEach((id) => { const it = itemById(id); if (it && !it.locked) { it.x += dx; it.y += dy; } });
      invalidate(); refreshProps(); scheduleSave();
    }
  }
  function delSel() {
    if (!A.sel.size) return;
    pushUndo();
    A.model.items = A.model.items.filter((i) => !A.sel.has(i.id));
    A.sel.clear(); invalidate(); refreshProps(); refreshTree(); refreshStatus(); scheduleSave();
  }
  function rotSel(deg) {
    if (!A.sel.size) return;
    pushUndo();
    Array.from(A.sel).forEach((id) => { const it = itemById(id); if (it && !it.locked) it.rot = ((it.rot || 0) + deg + 360) % 360; });
    invalidate(); refreshProps(); scheduleSave();
  }
  function alignSel(kind) {
    const ids = Array.from(A.sel).filter((id) => { const it = itemById(id); return it && !it.locked; });
    if (ids.length < 2) return toast("请先选中 2 个以上图元");
    pushUndo();
    const its = ids.map((id) => itemById(id));
    const x1 = Math.min.apply(null, its.map((i) => bbox(i)[0])), x2 = Math.max.apply(null, its.map((i) => bbox(i)[2]));
    const y1 = Math.min.apply(null, its.map((i) => bbox(i)[1])), y2 = Math.max.apply(null, its.map((i) => bbox(i)[3]));
    its.forEach((i) => {
      const b = bbox(i), w = b[2] - b[0], h = b[3] - b[1];
      if (kind === "left") i.x = x1 + w / 2;
      if (kind === "right") i.x = x2 - w / 2;
      if (kind === "top") i.y = y1 + h / 2;
      if (kind === "bottom") i.y = y2 - h / 2;
      if (kind === "cx") i.x = (x1 + x2) / 2;
      if (kind === "cy") i.y = (y1 + y2) / 2;
      i.x = snapV(i.x); i.y = snapV(i.y);
    });
    invalidate(); refreshProps(); scheduleSave();
  }
  function zorder(kind) {
    if (!A.sel.size) return;
    pushUndo();
    const sel = A.model.items.filter((i) => A.sel.has(i.id)), rest = A.model.items.filter((i) => !A.sel.has(i.id));
    A.model.items = kind === "front" ? rest.concat(sel) : sel.concat(rest);
    A.model.items.forEach((i, n) => { if (i.id) i.z = n; });
    invalidate(); scheduleSave();
  }
  function placeAt(sym, x, y, opts) {
    const d = symDef(sym); pushUndo();
    const it = { id: uid("it"), sym, x: snapV(x), y: snapV(y), w: d.w, h: d.h, rot: 0, name: (d.name || sym) + " " + (A.model.items.filter((i) => i.sym === sym).length + 1),
      label: true, locked: false, layer: d.cat === "ext" ? "annot" : (d.cat || "annot"), params: {}, bind: null, user: { added: true } };
    A.model.items.push(it); A.sel.clear(); A.sel.add(it.id);
    invalidate(); refreshProps(); refreshTree(); refreshStatus(); scheduleSave();
    return it;
  }

  /* ======================================================================
   *  3D 联动 / 导出
   * ==================================================================== */
  function extended() {
    return A.model.items.filter((i) => i.user && i.user.added).map((i) => ({
      id: i.id, kind: kindOf(i.sym), x: i.x / MM, z: i.y / MM, w: i.w / MM, d: i.h / MM,
      rot: i.rot || 0, name: i.name, level: (kindOf(i.sym) === "smoke") ? "ceiling" : ((i.sym || "").indexOf("arch.") === 0 ? "wall" : "floor"), status: null,
    }));
  }
  function applyExtras() {
    const list = extended();
    if (IDC.scene && IDC.scene.setExtras) { IDC.scene.setExtras(list); toast("已同步 " + list.length + " 个新增图元到三维机房"); }
    else toast("三维场景未就绪", "warning");
    return list.length;
  }
  function exportCanvas(scale) {
    scale = scale || 2;
    const box = contentBox(true); if (!box) return null;
    const pad = 700;
    const W = Math.ceil((box.w + pad * 2) * 0.05 * scale), H = Math.ceil((box.h + pad * 2) * 0.05 * scale);
    const off = document.createElement("canvas"); off.width = W; off.height = H;
    const x = off.getContext("2d");
    x.fillStyle = "#0a1524"; x.fillRect(0, 0, W, H);
    const k = 0.05 * scale, ox = -(box.x - pad) * k, oy = -(box.y - pad) * k;
    x.save(); x.translate(ox, oy); x.scale(k, k);
    const save = { zoom: V().zoom, panX: V().panX, panY: V().panY };
    V().zoom = 1; V().panX = 0; V().panY = 0;
    const ctxSave = A.ctx, canvasSave = A.canvas;
    A.ctx = x;
    // 直接以 mm 为单位绘制（无屏幕变换）
    x.save();
    A.model.layers.forEach((L) => { if (!L.visible) return; A.model.items.forEach((it) => { if ((it.layer || "ext") !== L.id) return; const env = { scale: k, label: it.label !== false, time: A.time, status: itemStatus(it) ? { state: itemStatus(it).state, level: itemStatus(it).level, pulse: 1 } : null, value: itemStatus(it) ? itemStatus(it).value : null }; x.save(); x.translate(it.x, it.y); if (it.rot) x.rotate(it.rot * Math.PI / 180); drawOne(x, it, env); x.restore(); }); });
    x.font = "600 320px 'Microsoft YaHei',sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
    A.model.texts.forEach((t) => { x.save(); x.translate(t.x, t.y); x.fillStyle = t.color || "#dce9ff"; x.fillText(t.text, 0, 0); x.restore(); });
    A.model.dims.forEach((d) => { x.strokeStyle = "#8fd8f5"; x.lineWidth = 30; x.beginPath(); x.moveTo(d.x1, d.y1); x.lineTo(d.x2, d.y2); x.stroke(); });
    x.restore();
    A.ctx = ctxSave; A.canvas = canvasSave;
    V().zoom = save.zoom; V().panX = save.panX; V().panY = save.panY;
    x.restore();
    // 右下标题栏信息
    x.fillStyle = "rgba(220,233,255,.9)"; x.font = "600 13px 'Microsoft YaHei',sans-serif"; x.textAlign = "right";
    x.fillText("上海一号数据中心 · 机房平面图 · 图元 " + A.model.items.length + " 个 · 导出 " + new Date().toLocaleString("zh-CN"), W - 16, H - 12);
    return off;
  }
  function dl(name, dataUrl) { const a = document.createElement("a"); a.href = dataUrl; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function exportPNG() { const c = exportCanvas(2); if (!c) return toast("图纸为空"); dl("机房平面图_" + Date.now() + ".png", c.toDataURL("image/png")); toast("已导出 PNG"); }
  function exportSVG() {
    const c = exportCanvas(2); if (!c) return;
    const svg = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + c.width + '" height="' + c.height + '" viewBox="0 0 ' + c.width + ' ' + c.height + '">\n<title>' + esc(A.model.meta.title || "机房平面图") + '</title>\n<!-- 由 IDC 机房图纸工具导出：位图嵌入（保证与屏幕一致），缩放清晰度为 2x -->\n<image x="0" y="0" width="' + c.width + '" height="' + c.height + '" xlink:href="' + c.toDataURL("image/png") + '"/>\n</svg>';
    dl("机房平面图_" + Date.now() + ".svg", "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg)); toast("已导出 SVG（位图嵌入）");
  }
  function esc(s) { return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }
  function exportJSON() { dl("机房图纸_" + Date.now() + ".json", "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(A.model, null, 2))); toast("已导出 JSON（可再导入）"); }
  function printPlan() {
    const c = exportCanvas(3); if (!c) return;
    const w = global.open("", "_blank");
    if (!w) return toast("浏览器拦截了打印窗口", "warning");
    w.document.write('<html><head><title>' + esc(A.model.meta.title || "机房平面图") + '</title><style>body{margin:0;background:#fff}img{width:100%}</style></head><body><img src="' + c.toDataURL("image/png") + '"></body></html>');
    w.document.close(); setTimeout(() => { try { w.print(); } catch (e) {} }, 400);
  }

  /* ======================================================================
   *  左侧图元面板 / 右侧属性栏 / 工具栏
   * ==================================================================== */
  function toast(t, lv) { if (IDC.hud && IDC.hud.toast) IDC.hud.toast(t, lv); }
  function palette(clientWidth) {
    const box = el("div", "plan-palette");
    box.appendChild(el("div", "plan-sec", '<span>图元库 <b>' + ((S() && Object.keys(S().SYMBOLS).length) || 0) + '</b></span><span>点击后落图</span>'));
    const s = S();
    const cats = (s && s.CATEGORIES) || [{ id: "annot", name: "底图与标注" }];
    cats.forEach((cat) => {
      let list = (s && s.listSymbols) ? s.listSymbols(cat.id) : [];
      if (!list.length) list = Object.keys(LOCAL).filter((k) => (LOCAL[k].cat || "annot") === cat.id).map((k) => Object.assign({ id: k }, LOCAL[k]));
      if (!list.length) return;
      const h = el("div", "plan-sec", "<span>" + esc(cat.name) + " <b>" + list.length + "</b></span>");
      box.appendChild(h);
      const grid = el("div", "plan-sym");
      list.forEach((d) => {
        const b = el("button"); b.title = d.name + "（" + d.w + "×" + d.h + " mm）";
        const img = el("img"); img.src = iconFor(d.id, 34); img.alt = d.name;
        b.appendChild(img); b.appendChild(el("span", null, esc(d.name.length > 6 ? d.name.slice(0, 6) : d.name)));
        b.draggable = true;
        b.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plan-sym", d.id));
        b.addEventListener("click", () => { A.pendingSym = d.id; setMode("place"); toast("请在图纸上点一下放置「" + d.name + "」（Esc 取消）"); });
        grid.appendChild(b);
      });
      box.appendChild(grid);
    });
    const sec = el("div", "plan-sec", "<span>扩展 <b>API</b></span>");
    box.appendChild(sec);
    const tip = el("div", null, '<div style="font-size:10.5px;color:#6f88a4;line-height:1.7">自定义图元：<br><code style="color:#9fd8f5">IDC.symbols.register(def)</code><br><code style="color:#9fd8f5">IDC.symbols.registerFromSvg(id, meta, path)</code></div>');
    box.appendChild(tip);
    return box;
  }
  function setMode(m) {
    A.mode = m; if (m !== "place") A.pendingSym = null; if (m !== "dim") A.ep = null;
    refreshToolbar(); if (A.canvas) A.canvas.style.cursor = m === "select" ? "default" : "crosshair";
  }
  function propsPanel() {
    const box = el("div", "plan-props");
    box.id = "plan-props";
    box.appendChild(el("div", "plan-sec", "<span>属性</span><span id='plan-selinfo'>未选中</span>"));
    box.appendChild(el("div", null, '<div id="plan-props-body"></div>'));
    const lh = el("div", "plan-sec", "<span>图层</span><span>可见 / 锁定</span>");
    box.appendChild(lh);
    const list = el("div", "plan-list"); list.id = "plan-layer-list"; box.appendChild(list);
    const sh = el("div", "plan-sec", "<span>图元清单</span><span id='plan-count'></span>");
    box.appendChild(sh);
    const tree = el("div", "plan-list"); tree.id = "plan-tree"; tree.style.maxHeight = "260px"; tree.style.overflow = "auto";
    box.appendChild(tree);
    const st = el("div", "plan-sec", "<span>统计 / 联动</span>");
    box.appendChild(st);
    const info = el("div", null, '<div id="plan-stats" style="font-size:11px;color:#8aa0bd;line-height:1.8"></div>');
    box.appendChild(info);
    const btnRow = el("div", "plan-row");
    const bApply = el("button", "plan-btn", "同步到三维"); bApply.addEventListener("click", applyExtras);
    const b3d = el("button", "plan-btn", "定位到 3D"); b3d.addEventListener("click", () => { const it = itemById(Array.from(A.sel)[0]); if (it) focusBound(it); });
    btnRow.appendChild(bApply); btnRow.appendChild(b3d);
    box.appendChild(btnRow);
    return box;
  }
  function refreshProps() {
    const body = $("#plan-props-body"); if (!body) return;
    const ids = Array.from(A.sel); const it = ids.length === 1 ? itemById(ids[0]) : null;
    $("#plan-selinfo").textContent = ids.length ? (ids.length + " 个选中") : "未选中";
    if (ids.length > 1) {
      body.innerHTML = '<div style="font-size:11px;color:#8aa0bd;margin:4px 0 8px">多选：可用工具栏对齐/旋转/复制/删除</div>';
      return;
    }
    if (!it) { body.innerHTML = '<div style="font-size:11px;color:#6f88a4">选中图纸上的图元可编辑属性；双击绑定的图元可在三维中定位。</div>'; return; }
    const d = symDef(it.sym);
    const row = (label, node) => { const r = el("div", "plan-row"); r.appendChild(el("label", null, label)); r.appendChild(node); return r; };
    const inp = (v, k, type) => { const i = el("input"); i.type = type || "text"; i.value = v; i.addEventListener("input", () => { pushUndo(); const n = type === "number" ? Number(i.value) : i.value; it[k] = n; invalidate(); scheduleSave(); }); return i; };
    body.innerHTML = "";
    body.appendChild(row("图元", (() => { const s = el("span", null, esc(d.name)); s.style.cssText = "flex:1;color:#cfe4ff"; return s; })()));
    body.appendChild(row("名称", inp(it.name || "", "name")));
    const g1 = el("div", "plan-row");
    g1.appendChild(el("label", null, "坐标 mm")); g1.appendChild(inp(round(it.x, 0), "x", "number")); g1.appendChild(inp(round(it.y, 0), "y", "number"));
    body.appendChild(g1);
    const g2 = el("div", "plan-row");
    g2.appendChild(el("label", null, "尺寸 mm")); g2.appendChild(inp(round(it.w, 0), "w", "number")); g2.appendChild(inp(round(it.h, 0), "h", "number"));
    body.appendChild(g2);
    const g3 = el("div", "plan-row");
    g3.appendChild(el("label", null, "旋转°")); g3.appendChild(inp(it.rot || 0, "rot", "number"));
    const sel = el("select"); ["0", "90", "180", "270"].forEach((r) => { const o = el("option", null, r); o.value = r; sel.appendChild(o); }); sel.value = String(it.rot || 0);
    sel.addEventListener("change", () => { pushUndo(); it.rot = Number(sel.value); invalidate(); scheduleSave(); refreshProps(); });
    g3.appendChild(sel);
    body.appendChild(g3);
    const g4 = el("div", "plan-row");
    g4.appendChild(el("label", null, "图层"));
    const ls = el("select"); A.model.layers.forEach((L) => { const o = el("option", null, L.name); o.value = L.id; ls.appendChild(o); }); ls.value = it.layer;
    ls.addEventListener("change", () => { pushUndo(); it.layer = ls.value; invalidate(); scheduleSave(); refreshTree(); });
    g4.appendChild(ls);
    body.appendChild(g4);
    const g5 = el("div", "plan-row");
    g5.appendChild(el("label", null, "颜色"));
    const ci = el("input"); ci.type = "color"; ci.value = it.color || d.fill || "#2b3138";
    ci.addEventListener("input", () => { pushUndo(); it.color = ci.value; invalidate(); scheduleSave(); });
    g5.appendChild(ci);
    const lbl = el("input"); lbl.type = "checkbox"; lbl.checked = it.label !== false;
    lbl.addEventListener("change", () => { it.label = lbl.checked; invalidate(); });
    g5.appendChild(lbl); g5.appendChild(el("span", null, "显示名称"));
    body.appendChild(g5);
    // 绑定
    const g6 = el("div", "plan-row");
    g6.appendChild(el("label", null, "绑定"));
    const bs = el("select");
    [["", "不绑定"], ["rack", "机柜（racks）"], ["dh", "动环设备（IDC.dh）"]].forEach(([v, t]) => { const o = el("option", null, t); o.value = v; bs.appendChild(o); });
    bs.value = it.bind ? it.bind.type : "";
    const refs = el("select");
    const fillRefs = () => {
      refs.innerHTML = "";
      const list = bs.value === "rack" ? ((IDC.data && IDC.data.racks) || []).map((r) => r.id)
        : bs.value === "dh" ? ((IDC.dh && IDC.dh.devices) || []).map((x) => x.id) : [];
      list.forEach((id) => { const o = el("option", null, id); o.value = id; refs.appendChild(o); });
      refs.style.display = bs.value ? "" : "none";
      if (it.bind) refs.value = it.bind.ref;
    };
    bs.addEventListener("change", () => { pushUndo(); it.bind = bs.value ? { type: bs.value, ref: (refs.value || "") } : null; fillRefs(); invalidate(); scheduleSave(); });
    refs.addEventListener("change", () => { if (it.bind) { it.bind.ref = refs.value; invalidate(); scheduleSave(); } });
    fillRefs();
    g6.appendChild(bs); g6.appendChild(refs);
    body.appendChild(g6);
    // 参数
    (d.params || []).forEach((prm) => {
      const r = el("div", "plan-row"); r.appendChild(el("label", null, prm.name || prm.key));
      let node;
      if (prm.type === "enum") { node = el("select"); (prm.options || []).forEach((v) => { const o = el("option", null, v); o.value = v; node.appendChild(o); }); node.value = (it.params && it.params[prm.key]) || prm.def; node.addEventListener("change", () => { it.params[prm.key] = node.value; invalidate(); scheduleSave(); }); }
      else { node = el("input"); node.type = prm.type === "number" ? "number" : "text"; node.value = (it.params && it.params[prm.key]) || prm.def || ""; node.addEventListener("input", () => { it.params[prm.key] = prm.type === "number" ? Number(node.value) : node.value; invalidate(); scheduleSave(); }); }
      r.appendChild(node); body.appendChild(r);
    });
    const act = el("div", "plan-row");
    const bRot = el("button", "plan-btn", "旋转90°"); bRot.addEventListener("click", () => rotSel(90));
    const bDup = el("button", "plan-btn", "复制"); bDup.addEventListener("click", () => { A.clipboard = [JSON.parse(JSON.stringify(it))]; onKey({ key: "v", ctrlKey: true, target: {} }); });
    const bDel = el("button", "plan-btn danger", "删除"); bDel.addEventListener("click", delSel);
    act.appendChild(bRot); act.appendChild(bDup); act.appendChild(bDel);
    body.appendChild(act);
    const lk = el("div", "plan-row");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = !!it.locked;
    cb.addEventListener("change", () => { it.locked = cb.checked; invalidate(); });
    lk.appendChild(el("label", null, "锁定")); lk.appendChild(cb);
    body.appendChild(lk);
  }
  function refreshTree() {
    const box = $("#plan-tree"); if (!box) return;
    const counts = {};
    A.model.items.forEach((i) => { counts[i.sym] = (counts[i.sym] || 0) + 1; });
    const dhAlarms = {};
    if (IDC.dh && IDC.dh.activeAlarms) IDC.dh.activeAlarms().forEach((a) => { dhAlarms[a.devId] = true; });
    const bound = A.model.items.filter((i) => i.bind);
    const alarms = bound.filter((i) => (i.bind.type === "dh" && dhAlarms[i.bind.ref]) || (i.bind.type === "rack" && IDC.data && IDC.data.alarmOfRack && IDC.data.alarmOfRack(i.bind.ref)));
    box.innerHTML = "";
    if (alarms.length) {
      box.appendChild(el("div", "plan-sec", '<span style="color:#ff8b8c">告警图元 <b>' + alarms.length + '</b></span><span>点击定位</span>'));
      alarms.forEach((i) => { const d = el("div", "pl-item alarm", '<span class="dot"></span><span style="flex:1">' + esc((i.bind.ref || "") + " " + i.sym) + '</span>'); d.addEventListener("click", () => { zoomToRef(i.bind.type, i.bind.ref); }); box.appendChild(d); });
    }
    const byLayer = {};
    A.model.items.forEach((i) => { (byLayer[i.layer] = byLayer[i.layer] || []).push(i); });
    A.model.layers.forEach((L) => {
      const arr = byLayer[L.id] || []; if (!arr.length) return;
      box.appendChild(el("div", "plan-sec", "<span>" + esc(L.name) + " <b>" + arr.length + "</b></span>"));
      arr.slice(0, 60).forEach((i) => {
        const d = el("div", "pl-item", '<span class="dot" style="background:' + (L.color || "#22c55e") + '"></span><span style="flex:1">' + esc(i.name || i.sym) + '</span>');
        d.addEventListener("click", () => { A.sel.clear(); A.sel.add(i.id); zoomTo(i); refreshProps(); });
        box.appendChild(d);
      });
    });
    const cnt = $("#plan-count"); if (cnt) cnt.textContent = A.model.items.length + " 个";
    const st = $("#plan-stats");
    if (st) st.innerHTML = "绑定机柜 " + A.model.items.filter((i) => i.bind && i.bind.type === "rack").length +
      " · 绑定动环 " + A.model.items.filter((i) => i.bind && i.bind.type === "dh").length +
      "<br>新增图元（待同步 3D）" + A.model.items.filter((i) => i.user && i.user.added).length +
      "<br>告警图元 " + alarms.length + " · 图层 " + A.model.layers.length;
  }
  function refreshLayerList() {
    const box = $("#plan-layer-list"); if (!box) return;
    box.innerHTML = "";
    A.model.layers.forEach((L) => {
      const row = el("div", "pl-item");
      row.appendChild(el("span", null, '<span class="dot" style="background:' + L.color + '"></span>'));
      row.appendChild(el("span", null, esc(L.name)));
      const v = el("input"); v.type = "checkbox"; v.checked = L.visible; v.title = "显示/隐藏";
      v.addEventListener("change", () => { L.visible = v.checked; invalidate(); });
      const lk = el("input"); lk.type = "checkbox"; lk.checked = L.locked; lk.title = "锁定";
      lk.addEventListener("change", () => { L.locked = lk.checked; });
      row.appendChild(v); row.appendChild(lk);
      box.appendChild(row);
    });
  }
  function refreshStatus() {
    const s = $("#plan-status"); if (!s) return;
    s.innerHTML = '缩放 <b>' + Math.round(V().zoom * 1000) / 10 + '%</b> · 光标 <b>' + Math.round(A.lastMouse.x) + ',' + Math.round(A.lastMouse.y) + '</b> mm' +
      ' · 选中 <b>' + A.selectionSize() + '</b> · 图元 <b>' + A.model.items.length + '</b> · 吸附 <b>' + (A.model.meta.snap || 0) + '</b> mm · 模式 <b>' + A.mode + '</b>';
  }
  function refreshAll() { refreshLayerList(); refreshTree(); refreshProps(); refreshStatus(); refreshToolbar(); }

  /* ---------------- 工具栏 ---------------- */
  const TOOLS = [
    ["选择", "select", () => setMode("select")],
    ["平移", "pan", () => setMode("pan")],
    ["尺寸", "dim", () => setMode("dim"), "点击两点标注距离"],
    ["文字", "text", () => setMode("text"), "点击位置添加文字"],
  ];
  function refreshToolbar() { document.querySelectorAll("#plan-toolbar [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === A.mode)); }
  function toolbar() {
    const bar = el("div", "plan-toolbar"); bar.id = "plan-toolbar";
    TOOLS.forEach(([name, mode, fn, tip]) => { const b = el("button", "plan-btn", name); b.dataset.mode = mode; if (tip) b.title = tip; b.addEventListener("click", fn); bar.appendChild(b); });
    bar.appendChild(el("span", "pt-sep"));
    const zoom = (f, label) => { const b = el("button", "plan-btn", label); b.addEventListener("click", () => { const c = A.canvas; zoomAt(c.clientWidth / 2, c.clientHeight / 2, f); }); return b; };
    bar.appendChild(zoom(1.25, "放大")); bar.appendChild(zoom(0.8, "缩小"));
    const bFit = el("button", "plan-btn", "适应窗口"); bFit.addEventListener("click", () => fitToScreen()); bar.appendChild(bFit);
    bar.appendChild(el("span", "pt-sep"));
    const bU = el("button", "plan-btn", "撤销"); bU.addEventListener("click", undo); bar.appendChild(bU);
    const bR = el("button", "plan-btn", "重做"); bR.addEventListener("click", redo); bar.appendChild(bR);
    const bRot = el("button", "plan-btn", "旋转90°"); bRot.addEventListener("click", () => rotSel(90)); bar.appendChild(bRot);
    const bDel = el("button", "plan-btn danger", "删除"); bDel.addEventListener("click", delSel); bar.appendChild(bDel);
    bar.appendChild(el("span", "pt-sep"));
    // 对齐下拉
    const al = el("select"); al.className = "plan-btn"; al.style.cssText = "background:rgba(34,211,238,.07);color:#a9d8ef";
    [["", "对齐方式"], ["left", "左对齐"], ["cx", "水平居中"], ["right", "右对齐"], ["top", "上对齐"], ["cy", "垂直居中"], ["bottom", "下对齐"]].forEach(([v, t]) => { const o = el("option", null, t); o.value = v; al.appendChild(o); });
    al.addEventListener("change", () => { if (al.value) { alignSel(al.value); al.value = ""; } });
    bar.appendChild(al);
    const zo = el("select"); zo.className = "plan-btn"; zo.style.cssText = "background:rgba(34,211,238,.07);color:#a9d8ef";
    [["", "层级"], ["front", "置顶"], ["back", "置底"]].forEach(([v, t]) => { const o = el("option", null, t); o.value = v; zo.appendChild(o); });
    zo.addEventListener("change", () => { if (zo.value) { zorder(zo.value); zo.value = ""; } });
    bar.appendChild(zo);
    const sn = el("select"); sn.className = "plan-btn"; sn.style.cssText = "background:rgba(34,211,238,.07);color:#a9d8ef";
    [10, 50, 100, 500, 1000, 0].forEach((v) => { const o = el("option", null, v ? "吸附 " + v + "mm" : "不吸附"); o.value = String(v); sn.appendChild(o); });
    sn.value = String(A.model.meta.snap || 100);
    sn.addEventListener("change", () => { A.model.meta.snap = Number(sn.value); A.model.meta.grid = Number(sn.value) || 100; invalidate(); refreshStatus(); scheduleSave(); });
    bar.appendChild(sn);
    bar.appendChild(el("span", "pt-sep"));
    const bAuto = el("button", "plan-btn", "自动出图"); bAuto.title = "按 3D 机房与动环设备重新生成底图（保留手动新增的图元）"; bAuto.addEventListener("click", () => { if (confirm("按现有 3D 机房 + 动环设备重新出图？手动新增的图元会保留。")) buildFromScene(); }); bar.appendChild(bAuto);
    const bClear = el("button", "plan-btn danger", "清空"); bClear.addEventListener("click", () => { if (confirm("清空图纸（含新增图元）？")) { pushUndo(); A.model = emptyModel(); invalidate(); refreshAll(); scheduleSave(); } }); bar.appendChild(bClear);
    const bApply = el("button", "plan-btn", "同步三维"); bApply.addEventListener("click", applyExtras); bar.appendChild(bApply);
    bar.appendChild(el("span", "pt-sep"));
    const bPng = el("button", "plan-btn", "导出PNG"); bPng.addEventListener("click", exportPNG); bar.appendChild(bPng);
    const bSvg = el("button", "plan-btn", "导出SVG"); bSvg.addEventListener("click", exportSVG); bar.appendChild(bSvg);
    const bJson = el("button", "plan-btn", "导出JSON"); bJson.addEventListener("click", exportJSON); bar.appendChild(bJson);
    const bImp = el("button", "plan-btn", "导入JSON");
    const fi = el("input"); fi.type = "file"; fi.accept = ".json"; fi.style.display = "none";
    fi.addEventListener("change", () => { const f = fi.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { pushUndo(); load(JSON.parse(r.result)); toast("已导入图纸"); } catch (e) { toast("JSON 解析失败", "warning"); } }; r.readAsText(f); });
    bImp.addEventListener("click", () => fi.click()); bar.appendChild(bImp); bar.appendChild(fi);
    const bPrint = el("button", "plan-btn", "打印"); bPrint.addEventListener("click", printPlan); bar.appendChild(bPrint);
    const bHelp = el("button", "plan-btn", "快捷键"); bHelp.addEventListener("click", showHelp); bar.appendChild(bHelp);
    return bar;
  }
  function showHelp() {
    const m = el("div", "plan-modal"); m.id = "plan-help";
    m.innerHTML = '<div class="pm-box"><h3>机房图纸 · 操作说明</h3>' +
      '<div>· <span class="plan-kbd">左键</span> 选择 / 拖动图元 · <span class="plan-kbd">Shift+左键</span> 加选 · <span class="plan-kbd">空白拖动</span> 框选</div>' +
      '<div>· <span class="plan-kbd">中键</span> 或 <span class="plan-kbd">空格+拖动</span> 平移 · <span class="plan-kbd">滚轮</span> 缩放 · <span class="plan-kbd">F</span> 适应窗口</div>' +
      '<div>· <span class="plan-kbd">双击</span> 绑定图元 → 三维定位 · <span class="plan-kbd">R</span> 旋转 90° · <span class="plan-kbd">方向键</span> 微移（Shift 加速）</div>' +
      '<div>· <span class="plan-kbd">Ctrl+C/V</span> 复制粘贴 · <span class="plan-kbd">Del</span> 删除 · <span class="plan-kbd">Ctrl+Z/Y</span> 撤销重做 · <span class="plan-kbd">Ctrl+A</span> 全选 · <span class="plan-kbd">Esc</span> 取消</div>' +
      '<div>· 左侧点图元后在图上点一下即可放置；也可直接把图元拖到图纸上</div>' +
      '<div>· 右侧「同步到三维」把<b>手动新增</b>的图元扩展到 3D 机房（<code>IDC.scene.setExtras</code>）</div>' +
      '<div style="margin-top:8px;color:#7f9ab8">图元扩展：<code>IDC.symbols.register(def)</code> / <code>IDC.symbols.registerFromSvg(id, meta, pathD)</code></div>' +
      '<div style="margin-top:10px"><button class="plan-btn" id="plan-help-close">关闭</button></div></div>';
    A.root.appendChild(m);
    const close = () => m.remove();
    $("#plan-help-close", m).addEventListener("click", close);
    m.addEventListener("click", (e) => { if (e.target === m) close(); });
  }

  /* ======================================================================
   *  对外 API
   * ==================================================================== */
  const api = {
    get model() { return A.model; },
    get selection() { return Array.from(A.sel); },
    get visible() { return A.visible; },
    mount(root) {
      A.root = root; root.innerHTML = "";
      root.appendChild(toolbar());
      const body = el("div", "plan-body");
      body.appendChild(palette());
      const wrap = el("div", "plan-canvas-wrap");
      const c = el("canvas"); c.id = "plan-canvas"; wrap.appendChild(c);
      const tip = el("div", "plan-tip", '<b style="color:#cfe4ff">图纸提示</b><br>左侧选图元→在图上点一下放置；拖动可移动；双击绑定图元可在三维定位。<br>「自动出图」按现有 3D 机房 + 动环设备重绘底图。');
      wrap.appendChild(tip);
      wrap.appendChild(el("div", "plan-status")); $(".plan-status", wrap).id = "plan-status";
      body.appendChild(wrap);
      body.appendChild(propsPanel());
      root.appendChild(body);
      A.canvas = c; resize(); bindCanvas();
      if (!restore()) buildFromScene();
      else { fitToScreen(50); refreshAll(); }
      try { new ResizeObserver(() => { resize(); }).observe(wrap); } catch (e) { addEventListener("resize", resize); }
      A.visible = false;                       // 由 show() 激活
      return api;
    },
    show() { A.visible = true; resize(); fitToScreen(60); if (!A.raf) A.raf = requestAnimationFrame(loop); refreshAll(); return api; },
    hide() { A.visible = false; if (A.raf) { cancelAnimationFrame(A.raf); A.raf = 0; } return api; },
    load(json) { const m = typeof json === "string" ? JSON.parse(json) : json; if (!m || !m.items) return; A.model = m; if (!A.model.view) A.model.view = { zoom: .045, panX: 0, panY: 0 }; invalidate(); fitToScreen(60); refreshAll(); scheduleSave(); return A.model; },
    toJSON() { return JSON.parse(JSON.stringify(A.model)); },
    save() { try { localStorage.setItem("idc.plan.v1", JSON.stringify(A.model)); toast("图纸已保存到本机"); } catch (e) {} },
    restore() { const ok = restore(); if (ok) { fitToScreen(60); refreshAll(); } return ok; },
    buildFromScene,
    addSymbol(symId, x, y) {
      if (x == null || y == null) { const box = contentBox(false) || { x: 0, y: 0, w: 20000, h: 20000 }; x = box.x + box.w + 1200; y = box.y + box.h / 2; }
      return placeAt(symId || "rack.42u", x, y);
    },
    addText(text, x, y) { pushUndo(); const t = { id: uid("t"), x: x || 0, y: y || 0, text: text || "标注", size: 320, layer: "annot" }; A.model.texts.push(t); invalidate(); scheduleSave(); return t; },
    remove(id) { const it = itemById(id); if (!it) return false; pushUndo(); A.model.items = A.model.items.filter((i) => i.id !== id); A.sel.delete(id); invalidate(); refreshTree(); scheduleSave(); return true; },
    select(id) { const it = itemById(id) || A.model.items.find((i) => i.bind && i.bind.ref === id); if (!it) return null; A.sel.clear(); A.sel.add(it.id); zoomTo(it, .3); refreshProps(); return it.id; },
    selectByRef(type, ref) { const it = A.model.items.find((i) => i.bind && i.bind.type === type && i.bind.ref === ref); return it ? api.select(it.id) : null; },
    clearSelection() { A.sel.clear(); invalidate(); refreshProps(); },
    setZoom(z) { V().zoom = clamp(z, .004, 2); invalidate(); refreshStatus(); },
    fitToScreen,
    zoomToRef(type, ref) {
      const it = A.model.items.find((i) => i.bind && i.bind.type === type && i.bind.ref === ref);
      if (!it) { toast("图纸上未找到 " + ref, "warning"); return null; }
      A.sel.clear(); A.sel.add(it.id); zoomTo(it, .22); refreshProps(); return it.id;
    },
    items(filter) { return filter ? A.model.items.filter(filter) : A.model.items; },
    extended, applyExtras,
    undo, redo,
    exportPNG, exportSVG, exportJSON, print: printPlan,
    /** 由 3D 侧点击扩展物件时调用 */
    on3dSelect(p) { if (p && p.myId) api.select(p.myId); else if (p && p.ref) { const it = itemById(p.ref); if (it) api.select(it.id); } },
    stats() {
      const bound = A.model.items.filter((i) => i.bind).length;
      return { items: A.model.items.length, bound, added: A.model.items.filter((i) => i.user && i.user.added).length, layers: A.model.layers.length, texts: A.model.texts.length, dims: A.model.dims.length, zoom: V().zoom };
    },
  };
  function zoomTo(it, padFactor) {
    const c = A.canvas; if (!c || !it) return;
    const box = bbox(it);
    const z = clamp(Math.min(c.clientWidth, c.clientHeight) * (padFactor || .25) / Math.max(1, box[2] - box[0], box[3] - box[1]), .01, 1.2);
    V().zoom = z;
    V().panX = c.clientWidth / 2 - it.x * z; V().panY = c.clientHeight / 2 - it.y * z;
    invalidate();
  }

  /* ---------------- 事件订阅 ---------------- */
  try {
    bus && bus.on && bus.on("dh:data", () => { invalidate(); if (A.visible) refreshTree(); });
    bus && bus.on && bus.on("dh:alarm", () => { invalidate(); if (A.visible) { refreshTree(); toast("图纸：动环报警已高亮"); } });
    bus && bus.on && bus.on("dh:alarm:clear", () => { invalidate(); if (A.visible) refreshTree(); });
    bus && bus.on && bus.on("data:tick", () => invalidate());
    bus && bus.on && bus.on("plan:select", (p) => {
      if (!p) return;
      if (p.type === "extra" && p.ref) { const it = itemById(p.ref); if (it) { A.sel.clear(); A.sel.add(it.id); zoomTo(it, .3); refreshProps(); } }
      else if (p.ref) api.selectByRef(p.type, p.ref);
    });
  } catch (e) {}

  global.IDC.plan = api;
})(window);