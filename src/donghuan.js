/* =========================================================================
 *  src/donghuan.js — 动环（动力环境）前端接入模块
 *  职责：①连动环网关(WebSocket/HTTP)取实时数据 ②网关不在时用内置模拟器等价跑通
 *        ③点表/实时值/质量码管理 ④报警规则引擎（与网关同规则）⑤北向报文
 *  对外：window.IDC.dh  （详见 docs/动环接口规范.md §5）
 * ========================================================================= */
import * as PT from "./pointtable.js";

(function (global) {
  "use strict";
  const IDC = global.IDC = global.IDC || {};
  const bus = IDC.bus;
  const emit = (e, p) => { try { bus && bus.emit && bus.emit(e, p); } catch (err) { console.error("[dh]" + e, err); } };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const round = (v, n) => { const k = Math.pow(10, n == null ? 2 : n); return Math.round(v * k) / k; };
  const now = () => Date.now();                                  // 内部计时（延时/抑制/抖动）用真实时钟
  const tsNow = () => (IDC.data && IDC.data.simNow ? IDC.data.simNow().getTime() : Date.now());  // 展示时间戳用仿真时钟
  const pad2 = (n) => String(n).padStart(2, "0");

  /* ---------------- 状态 ---------------- */
  const S = {
    ready: false, mode: "init",                 // 'ws' | 'sim'
    url: "", ws: null, retry: 0, reconnectTimer: 0,
    devices: new Map(), points: new Map(),
    values: new Map(), quality: new Map(), ts: 0, seq: 0,
    alarms: new Map(), alarmSeq: 0,             // 活动+历史报警
    engine: new Map(),                          // pointId -> {phase,since,level,rule}
    frozen: new Map(),                          // inject 后临时冻结的点
    suppress: new Map(),                        // pointId -> 抑制到的时间戳（人工清除后短暂不再重复报警）
    poll: PT.SITE.pollInterval, timer: 0, lastTick: 0, frames: 0, errors: 0,
    gw: { connected: false, driver: "sim", lastPoll: 0, latency: 0, interval: PT.SITE.pollInterval, frames: 0, errors: 0, url: "", mode: "sim" },
  };
  PT.DEVICES.forEach((d) => S.devices.set(d.id, d));
  PT.POINTS.forEach((p) => { S.points.set(p.id, p); S.quality.set(p.id, "good"); });

  /* ---------------- 取值工具 ---------------- */
  const dev = (id) => S.devices.get(id) || null;
  const point = (id) => S.points.get(id) || null;
  const val = (id) => (S.values.has(id) ? S.values.get(id) : null);
  const pointsOfDev = (devId) => PT.POINTS.filter((p) => p.devId === devId);
  const devicesOfType = (t) => PT.DEVICES.filter((d) => d.type === t);
  /** 按「设备类型 + 点名后缀」快速取值，如 pick('ups','load') 返回 [{dev, value}] */
  function pick(type, key, opts) {
    const out = [];
    devicesOfType(type).forEach((d) => {
      const p = pointsOfDev(d.id).find((x) => x.key === key);
      if (p) out.push({ devId: d.id, dev: d, point: p, value: val(p.id), unit: p.unit });
    });
    if (opts && opts.avg) out.avg = out.length ? round(out.reduce((s, x) => s + (Number(x.value) || 0), 0) / out.length, opts.digits == null ? 1 : opts.digits) : null;
    return out;
  }

  /* ======================================================================
   *  内置模拟器（网关不可用时的等价数据源，与 tools/gateway/drivers/sim.mjs 同规则）
   * ==================================================================== */
  let simT = 0;
  function base(devId, key, i) {                 // 确定性基准值，避免每次刷新乱跳
    let h = 2166136261 >>> 0;
    const s = devId + "|" + key + "|" + i;
    for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619) >>> 0; }
    return (h % 1000) / 1000;
  }
  function simValue(p) {
    const d = S.devices.get(p.devId), b = base(p.devId, p.key, 1);
    const t = simT / 1000;
    const wave = Math.sin(t / 26 + b * 6.28) * 0.5 + Math.sin(t / 7.3 + b * 3.1) * 0.2;
    const noise = (a) => (Math.random() - 0.5) * a;
    const fz = S.frozen.get(p.id);
    if (fz && fz.until > now()) return fz.value;
    if (p.kind === "di") {
      if (d && d.online === false) return p.normal;
      if (p.statusOnly) return (p.key === "stComp" || p.key === "stFan") ? 1 : 0;  // 运行状态类：压缩机/风机运行中，加热/加湿停用
      return p.normal;                            // 其余状态量默认正常；异常由 inject / 随机事件制造
    }
    switch (d.type) {
      case "ups": {
        const load = 68 + wave * 4 + noise(0.6);
        switch (p.key) {
          case "UAA": case "UAB": case "UAC": return round(229.5 + wave * 1.6 + noise(0.8), 1);
          case "IAA": case "IAB": case "IAC": return round((load / 100) * 118 + noise(2), 1);
          case "UOA": case "UOB": case "UOC": return round(230.2 + wave * 1.2 + noise(0.7), 1);
          case "IOA": case "IOB": case "IOC": return round((load / 100) * 121 + noise(2), 1);
          case "UAB_L": return round(398.5 + wave * 2.6 + noise(1.2), 1);
          case "fIn": return round(50 + noise(0.04), 2);
          case "load": return round(load, 1);
          case "pOut": return round((load / 100) * (d.ratedKW || 200) * 0.86, 2);
          case "batV": return round(512 + wave * 1.5 + noise(0.4), 1);
          case "batI": return round(wave * 6 + noise(1.2), 1);
          case "batMin": return round(22 + wave * 2 + noise(0.4), 1);
          case "temp": return round(24 + wave * 1.2 + noise(0.3), 1);
          default: return p.kind === "di" ? p.normal : 0;
        }
      }
      case "ac":
        switch (p.key) {
          case "retT": return round(24.3 + wave * 1.1 + noise(0.3), 1);
          case "retH": return round(45.2 + wave * 2.2 + noise(0.6), 1);
          case "supT": return round(19.6 + wave * 0.8 + noise(0.3), 1);
          case "setT": return 22;
          case "setH": return 45;
          case "cool": return round(11.8 + wave * 2.4 + noise(0.5), 1);
          case "fan": return round(78 + wave * 6 + noise(1.5), 1);
          case "valve": return round(46 + wave * 8 + noise(2), 1);
          case "stComp": case "stFan": case "stHeat": case "stHum": return 1;   // 运行中
          case "almFilter": case "almHP": case "almLP": case "almWater": return 0; // 正常
          default: return p.kind === "di" ? 0 : 0;
        }
      case "th":
        switch (p.key) {
          case "temp": return round(24.3 + wave * 1.4 + noise(0.25), 1);
          case "hum": return round(45.2 + wave * 3.2 + noise(0.7), 1);
          case "dew": return round(12.4 + wave * 1.6 + noise(0.4), 1);
          default: return p.normal;
        }
      case "smoke":
        switch (p.key) {
          case "pollution": return round(1.3 + Math.abs(wave) * 0.8 + noise(0.15), 2);
          case "voltage": return round(24.1 + noise(0.3), 1);
          default: return p.normal;
        }
      case "mdb":
        switch (p.key) {
          case "UPA": case "UPB": case "UPC": return round(230.4 + wave * 1.8 + noise(0.9), 1);
          case "IA": case "IB": case "IC": return round(108 + wave * 14 + noise(3), 1);
          case "P": return round(66 + wave * 5 + noise(1.2), 2);
          case "PF": return round(0.985 + wave * 0.01, 3);
          case "E": return round(28430 + t * 0.02, 1);
          case "f": return round(50 + noise(0.03), 2);
          default: return p.normal;
        }
      case "battery":
        switch (p.key) {
          case "U": return round(512.6 + wave * 1.4 + noise(0.5), 1);
          case "I": return round(2.4 + wave * 3.6 + noise(0.6), 1);
          case "dT": return round(1.1 + Math.abs(wave) * 0.7 + noise(0.1), 2);
          case "rInt": return round(1.86 + Math.abs(wave) * 0.18, 3);
          case "soh": return round(96.4 + wave * 0.6, 1);
          case "soc": return round(98.2 + wave * 0.5, 1);
          case "temp": return round(23.2 + wave * 0.8 + noise(0.2), 1);
          default: return p.normal;
        }
      case "ats":
        switch (p.key) {
          case "Umain": return round(398.2 + wave * 2.2 + noise(1), 1);
          case "Ubak": return round(397.4 + wave * 2.4 + noise(1), 1);
          case "Uout": return round(398.0 + wave * 2.2 + noise(1), 1);
          case "cnt": return 3;
          default: return p.normal;
        }
      default: return 0;
    }
  }

  /* ======================================================================
   *  报警引擎（与 docs/动环接口规范.md §1.3 完全一致）
   * ==================================================================== */
  function alarmLevelOf(p, v) {
    if (p.kind === "di") {
      if (p.statusOnly) return null;                    // 运行状态类（如空调压缩机/风机）不参与变位报警
      const isBad = p.invert ? v === p.normal : v !== p.normal;
      if (!isBad) return null;
      const d = S.devices.get(p.devId);
      const critical = d && (d.type === "smoke" || d.type === "water");
      return { level: critical ? "critical" : "warning", rule: "di" };
    }
    if (p.hiHi != null && v > p.hiHi) return { level: "critical", rule: "hiHi" };
    if (p.hi != null && v > p.hi) return { level: "warning", rule: "hi" };
    if (p.loLo != null && v < p.loLo) return { level: "critical", rule: "loLo" };
    if (p.lo != null && v < p.lo) return { level: "warning", rule: "lo" };
    return null;
  }
  function raise(p, v, info) {
    const key = p.id;
    const until = S.suppress.get(key) || 0;
    if (until > now()) return null;               // 人工清除后的抑制期
    let a = S.alarms.get(key);
    if (a && (a.state === "active" || a.state === "acked")) {
      if (a.level !== info.level || a.value !== v) { a.value = round(v, 2); a.level = info.level; a.ts = now(); emit("dh:data", { changed: true }); }
      return a;
    }
    S.alarmSeq++;
    a = {
      id: "DHA-" + now().toString(36).toUpperCase() + "-" + pad2(S.alarmSeq % 100),
      pointId: p.id, devId: p.devId, pointName: p.name, devName: (S.devices.get(p.devId) || {}).name || p.devId,
      level: info.level, rule: info.rule, value: round(v, 2), unit: p.unit || "",
      text: textOf(p, info, v), state: "active", ts: tsNow(), ackTs: 0, clearTs: 0,
    };
    S.alarms.set(key, a);
    S.errors = S.errors;
    emit("dh:alarm", a);
    IDC.data && IDC.data.addEvent && IDC.data.addEvent("动环报警：" + a.devName + " " + a.text, a.level === "critical" ? "critical" : a.level === "warning" ? "warning" : "info");
    return a;
  }
  function textOf(p, info, v) {
    const d = S.devices.get(p.devId);
    if (info.rule === "di") {
      const bits = p.bits && p.bits[String(v)];
      return p.name + (bits ? "：" + bits : " 变位");
    }
    if (info.rule === "offline") return "通信中断（超过 30 秒无响应）";
    const map = { hiHi: "超高限", hi: "超上限", loLo: "超低限", lo: "低于下限" };
    return p.name + map[info.rule] + "（" + round(v, 1) + (p.unit || "") + "）";
  }
  function clearAlarm(p, why) {
    const a = S.alarms.get(p.id);
    if (!a || a.state === "cleared") return null;
    a.state = "cleared"; a.clearTs = tsNow();
    emit("dh:alarm:clear", a);
    return a;
  }
  function evaluate(p, v) {
    const st = S.engine.get(p.id) || { phase: "idle", since: 0 };
    const info = alarmLevelOf(p, v);
    const delayMs = (p.delay == null ? (p.kind === "di" ? 0 : 3) : p.delay) * 1000;
    if (info) {
      if (st.phase === "idle") { st.phase = "pending"; st.since = now(); st.level = info.level; st.rule = info.rule; }
      else if (st.phase === "pending") {
        st.level = info.level; st.rule = info.rule;
        if (now() - st.since >= delayMs) { st.phase = "active"; raise(p, v, info); }
      } else { raise(p, v, info); }
    } else {
      if (st.phase === "active") {
        // 回差判断：必须回到阈值内 deadband 才算恢复
        const db = p.deadband == null ? 0 : p.deadband;
        const prev = S.alarms.get(p.id);
        let stillBad = false;
        if (prev) {
          if (prev.rule === "hiHi" || prev.rule === "hi") stillBad = p.hiHi != null && v > (p.hi != null ? p.hi : p.hiHi) - db && (p.hiHi != null && v > p.hiHi - db);
          if (prev.rule === "loLo" || prev.rule === "lo") stillBad = stillBad || (p.lo != null && v < p.lo + db);
          if (prev.rule === "di") stillBad = p.invert ? v === p.normal : v !== p.normal;
        }
        if (!stillBad) { st.phase = "idle"; clearAlarm(p, "recover"); }
      } else { st.phase = "idle"; }
    }
    S.engine.set(p.id, st);
  }

  /* ---------------- 一轮采集与广播 ---------------- */
  function tick() {
    const t0 = now();
    const values = {};
    const changed = [];
    S.points.forEach((p) => {
      const before = S.values.get(p.id);
      const v = simValue(p);
      S.values.set(p.id, v);
      values[p.id] = v;
      if (before === undefined || Math.abs((Number(before) || 0) - v) > 1e-6) changed.push(p.id);
      evaluate(p, v);
    });
    // 通信中断判定
    S.devices.forEach((d) => {
      if (d.online === false && !d._offAlarm) {
        d._offAlarm = true;
        const p = pointsOfDev(d.id)[0];
        if (p) raise(p, S.values.get(p.id) || 0, { level: "info", rule: "offline" });
        emit("dh:device", { devId: d.id, online: false });
      } else if (d.online !== false && d._offAlarm) { d._offAlarm = false; emit("dh:device", { devId: d.id, online: true }); }
    });
    S.seq++; S.frames++; S.ts = now();
    S.gw.lastPoll = S.ts; S.gw.frames = S.frames;
    S.gw.interval = S.poll;
    S.gw.latency = now() - t0;
    simT += S.poll;
    emit("dh:data", { ts: S.ts, seq: S.seq, changed: changed.length, full: S.seq % 10 === 1, values });
  }

  /* ---------------- 随机真实感事件（模拟现场偶发报警） ---------------- */
  let eventTimer = 0;
  function startEvents() {
    clearInterval(eventTimer);
    eventTimer = setInterval(() => {
      if (S.mode !== "sim") return;
      const r = Math.random();
      if (r < 0.02) { const list = devicesOfType("smoke"); const d = list[Math.floor(Math.random() * list.length)]; trigger(d.id, "smoke"); }
      else if (r < 0.03) { const list = devicesOfType("water"); const d = list[Math.floor(Math.random() * list.length)]; trigger(d.id, "water"); }
    }, 30000);
  }

  /* ======================================================================
   *  网关接入（WebSocket）——连不上自动降级本地模拟
   * ==================================================================== */
  function gwUrl() {
    const q = new URLSearchParams(location.search);
    const g = q.get("gw");
    if (g && /^wss?:\/\//i.test(g)) return g;          // ?gw=ws://host:8124/dh 形式
    const port = q.get("gwport") || 8124;               // ?gw=1 / ?gw=on 走默认端口
    const host = (location.hostname && location.protocol !== "file:") ? location.hostname : "localhost";
    return "ws://" + host + ":" + port + "/dh";
  }
  function startSim(reason) {
    if (S.mode === "sim" && S.timer) return;
    S.mode = "sim"; S.gw.mode = "sim"; S.gw.connected = false; S.gw.driver = "sim";
    S.gw.url = S.url || gwUrl();
    S.ready = true;
    clearInterval(S.timer);
    S.timer = setInterval(tick, S.poll);
    tick();
    startEvents();
    emit("dh:ready", { mode: "sim", reason: reason || "", driver: "sim", points: S.points.size, devices: S.devices.size });
    console.log("[dh] 本地模拟模式已启动（" + (reason || "gateway unavailable") + "）· 设备 " + S.devices.size + " · 测点 " + S.points.size);
  }
  function connectGateway() {
    S.url = gwUrl(); S.gw.url = S.url;
    if (typeof WebSocket === "undefined") return startSim("no WebSocket");
    let ws;
    try { ws = new WebSocket(S.url); } catch (e) { return startSim("ws error"); }
    S.ws = ws;
    const fail = (why) => {
      S.errors++; S.gw.errors = S.errors;
      try { ws.close(); } catch (e) {}
      if (S.mode !== "ws") startSim(why);
      scheduleReconnect();
    };
    const to = setTimeout(() => { if (ws.readyState !== 1) fail("timeout"); }, 3000);
    ws.onopen = () => {
      clearTimeout(to);
      S.mode = "ws"; S.gw.connected = true; S.gw.mode = "ws"; S.retry = 0;
      clearInterval(S.timer); S.timer = 0;
      emit("dh:ready", { mode: "ws", url: S.url });
      console.log("[dh] 已接入动环网关 " + S.url);
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleGw(m);
    };
    ws.onerror = () => { clearTimeout(to); if (S.mode !== "ws") fail("error"); };
    ws.onclose = () => {
      S.gw.connected = false;
      if (S.mode === "ws") { S.mode = "sim"; startSim("gateway closed"); }
      scheduleReconnect();
    };
  }
  function scheduleReconnect() {
    if (S.reconnectTimer) return;
    S.reconnectTimer = setTimeout(() => { S.reconnectTimer = 0; if (S.mode !== "ws") connectGateway(); }, 12000);
  }
  /** 连接网关后补拉一次全量快照与活动报警（WS 只推变化量/当场产生的报警） */
  function seedFromGateway() {
    const base = api.httpBase();
    fetch(base + "/dh/snapshot", { cache: "no-store" }).then((r) => r.json()).then((s) => {
      const v = (s && s.values) || {};
      Object.keys(v).forEach((id) => {
        S.values.set(id, v[id]);
        const p = S.points.get(id);
        if (p) { const e = S.engine.get(p.id); if (!e || e.phase === "idle") S.engine.set(p.id, { phase: "idle", since: 0 }); }
      });
      emit("dh:data", { ts: s.t || now(), seq: S.seq, full: true, values: v, seed: true });
    }).catch(() => {});
    fetch(base + "/dh/alarms", { cache: "no-store" }).then((r) => r.json()).then((a) => {
      const list = (a && a.alarms) || [];
      list.forEach((al) => { S.alarms.set(al.pointId, al); });
      if (list.length) { emit("dh:alarm", list[0]); emit("dh:alarms", list); }
    }).catch(() => {});
  }

  function handleGw(m) {
    if (m.type === "hello") {
      if (Array.isArray(m.devices)) m.devices.forEach((d) => S.devices.set(d.id, d));
      if (Array.isArray(m.points)) m.points.forEach((p) => { if (!S.points.has(p.id)) S.points.set(p.id, p); });
      S.gw.driver = m.driver || "unknown";
      const iv = (m.poll && typeof m.poll === "object") ? Number(m.poll.interval) : Number(m.poll);
      if (iv > 0) { S.poll = iv; S.gw.interval = iv; }
      clearInterval(S.timer); S.timer = 0;          // WS 模式由网关推送，不再本地采集
      seedFromGateway();                            // 补拉快照值 + 当前活动报警
      S.ready = true;
      emit("dh:ready", { mode: "ws", driver: S.gw.driver, devices: S.devices.size, points: S.points.size, site: m.site });
      return;
    }
    if (m.type === "data") {
      S.seq = m.seq || S.seq + 1; S.ts = m.t || now();
      const values = m.values || {};
      Object.keys(values).forEach((id) => {
        S.values.set(id, values[id]);
        const p = S.points.get(id); if (p) evaluate(p, values[id]);
      });
      S.frames++; S.gw.lastPoll = S.ts; S.gw.frames = S.frames;
      emit("dh:data", { ts: S.ts, seq: S.seq, full: !!m.full, values });
      return;
    }
    if (m.type === "status") {
      Object.keys(m.devices || {}).forEach((id) => {
        const d = S.devices.get(id); if (d) { const was = d.online; d.online = m.devices[id].online; d.lastRt = m.devices[id].rt; if (was !== d.online) emit("dh:device", { devId: id, online: d.online }); }
      });
      return;
    }
    if (m.type === "alarm") {
      const a = m.alarm; if (!a) return;
      if (a.state === "cleared") { const cur = S.alarms.get(a.pointId); if (cur) { cur.state = "cleared"; cur.clearTs = a.clearTs || now(); emit("dh:alarm:clear", cur); } }
      else { S.alarms.set(a.pointId, a); emit("dh:alarm", a); }
      return;
    }
    if (m.type === "event") { emit("dh:event", m.event); }
  }

  /* ======================================================================
   *  对外 API
   * ==================================================================== */
  const api = {
    S, SITE: PT.SITE,
    get devices() { return Array.from(S.devices.values()); },
    get points() { return Array.from(S.points.values()); },
    get alarms() { return Array.from(S.alarms.values()); },
    get gw() { return S.gw; },
    get mode() { return S.mode; },
    get connected() { return S.gw.connected; },
    get poll() { return S.poll; },
    get frames() { return S.frames; },
    get latency() { return S.gw.latency; },

    init(opts) {
      api._opts = opts || {};
      const q = new URLSearchParams(location.search);
      const g = q.get("gw");
      if (g && g !== "off") connectGateway();          // ?gw=1 / ?gw=ws://host:8124/dh 才主动接入
      else startSim("local simulator (use ?gw=1 to connect gateway)");
      return api;
    },
    /** 手动接入网关（HUD 上的「接入网关」按钮用） */
    connect() { connectGateway(); return api; },
    /** 断开网关，回到本地模拟 */
    disconnect() {
      try { S.ws && S.ws.close(); } catch (e) {}
      S.ws = null; clearInterval(S.timer); S.timer = 0; S.mode = "sim";
      startSim("manual disconnect");
      return api;
    },
    tick,
    getDevice: dev,
    getPoint: point,
    value: val,
    pointsOf: pointsOfDev,
    byType: devicesOfType,
    pick,
    refresh() { if (S.mode === "sim") tick(); else emit("dh:redraw", { ts: S.ts, seq: S.seq }); },

    activeAlarms() { return api.alarms.filter((a) => a.state === "active" || a.state === "acked"); },
    alarmsOf(devId) { return api.alarms.filter((a) => a.devId === devId); },
    alarmOf(pointId) { return S.alarms.get(pointId) || null; },
    ack(id) {
      const a = typeof id === "string" ? S.alarms.get(id) || api.alarms.find((x) => x.id === id) : null;
      if (!a) return null;
      a.state = "acked"; a.ackTs = tsNow();
      emit("dh:alarm:ack", a);
      return a;
    },
    clear(id) {
      const a = typeof id === "string" ? S.alarms.get(id) || api.alarms.find((x) => x.id === id) : null;
      if (!a) return null;
      a.state = "cleared"; a.clearTs = tsNow();
      S.suppress.set(a.pointId, now() + 30000);   // 30s 抑制：故障值仍在时不再立刻重复报警
      S.frozen.delete(a.pointId);
      emit("dh:alarm:clear", a);
      return a;
    },
    /** 注入（演示/联调）：inject({pointId, value, holdMs}) */
    inject(o) {
      if (!o || !o.pointId) return null;
      const p = S.points.get(o.pointId);
      if (!p) return null;
      const hold = o.holdMs == null ? 30000 : o.holdMs;
      S.frozen.set(o.pointId, { value: o.value, until: now() + hold });
      S.values.set(o.pointId, o.value);
      evaluate(p, o.value);
      emit("dh:inject", o);
      if (S.ws && S.gw.connected) { try { fetch(api.httpBase() + "/dh/inject", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) }); } catch (e) {} }
      return p;
    },
    /** 场景化演示：trigger('SM-03','smoke'|'water'|'offline'|'overvoltage'|'recover') */
    trigger(devId, action) {
      const d = S.devices.get(devId); if (!d) return null;
      const ps = pointsOfDev(devId);
      const first = (key) => ps.find((p) => p.key === key);
      if (action === "smoke") { const p = first("state"); return p ? api.inject({ pointId: p.id, value: 1, holdMs: 60000 }) : null; }
      if (action === "water") { const p = first("ch1"); return p ? api.inject({ pointId: p.id, value: 1, holdMs: 60000 }) : null; }
      if (action === "overvoltage") { const p = first("UAA"); return p ? api.inject({ pointId: p.id, value: 258.6, holdMs: 30000 }) : null; }
      if (action === "offline") { d.online = false; d._offAlarm = false; tick(); return d; }
      if (action === "recover") {
        ps.forEach((p) => { S.frozen.delete(p.id); if (p.kind === "di") S.values.set(p.id, p.normal); });
        d.online = true; d._offAlarm = false; tick(); return d;
      }
      return null;
    },
    driver() { return S.gw.driver; },
    setDriver(name) {
      if (S.ws && S.gw.connected) {
        try { fetch(api.httpBase() + "/dh/driver", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ driver: name }) }); } catch (e) {}
      }
      S.gw.driver = name;
      emit("dh:driver", { driver: name });
      return name;
    },
    drivers() {
      return [
        { name: "sim", label: "内置模拟器", status: S.mode === "sim" ? "connected" : "standby", desc: "无真实设备时的等价数据源" },
        { name: "modbus-tcp", label: "Modbus TCP", status: S.gw.driver === "modbus-tcp" ? "connected" : "standby", desc: "UPS/空调/配电/电池/烟感集中器（功能码 03/04）" },
        { name: "modbus-rtu", label: "Modbus RTU", status: "standby", desc: "温湿度串口网关" },
        { name: "snmp", label: "SNMP v2c", status: S.gw.driver === "snmp" ? "connected" : "standby", desc: "厂家 SNMP 卡（按 OID 取值）" },
        { name: "mqtt", label: "MQTT", status: S.gw.driver === "mqtt" ? "connected" : "standby", desc: "IoT 平台订阅（按 topic 映射）" },
        { name: "http-json", label: "HTTP-JSON", status: S.gw.driver === "http-json" ? "connected" : "standby", desc: "厂家 REST 接口轮询" },
      ];
    },
    httpBase() {
      const u = S.url || gwUrl();
      return u.replace(/^ws/, "http").replace(/\/dh$/, "");
    },
    pointTable(o) { return (o && o.format === "csv") ? PT.pointTableCsv() : PT.pointTable(); },
    exportPointTableCsv() { return PT.pointTableCsv(); },
    /** 北向报文（上报上级平台，见规范 §4） */
    northbound() {
      const act = api.activeAlarms();
      const ups = pick("ups", "load", { avg: true });
      const bat = pick("ups", "batMin", { avg: true });
      const th = pick("th", "temp", { avg: true });
      const online = api.devices.filter((d) => d.online !== false).length;
      return {
        site: PT.SITE.name, ts: S.ts || tsNow(), mode: S.mode, driver: S.gw.driver,
        devices: api.devices.map((d) => ({ id: d.id, type: d.type, name: d.name, zone: d.zone, online: d.online !== false, rt: d.lastRt || 0 })),
        alarms: act.map((a) => ({ id: a.id, level: a.level, point: a.pointId, device: a.devId, text: a.text, value: a.value, unit: a.unit, state: a.state, ts: a.ts })),
        metrics: {
          deviceTotal: api.devices.length, onlineRate: round(online / api.devices.length, 4),
          activeAlarms: act.length, critical: act.filter((a) => a.level === "critical").length,
          warning: act.filter((a) => a.level === "warning").length, info: act.filter((a) => a.level === "info").length,
          upsLoad: ups.avg, batteryMin: bat.avg, tempAvg: th.avg, points: S.points.size,
        },
      };
    },
    metrics() {
      const nb = api.northbound();
      return Object.assign({ frames: S.frames, latency: S.gw.latency, interval: S.poll, mode: S.mode, driver: S.gw.driver, connected: S.gw.connected }, nb.metrics);
    },
    stop() { clearInterval(S.timer); S.timer = 0; clearInterval(eventTimer); if (S.ws) try { S.ws.close(); } catch (e) {} },
  };

  IDC.dh = api;
})(window);