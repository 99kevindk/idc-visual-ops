/* =========================================================================
 *  src/data.js  —  IDC 智能运维管理平台 · 本地模拟数据模型 + 事件总线
 *  纯前端演示数据（非真实机房数据），所有数值由确定性伪随机数生成。
 *  对外暴露： window.IDC.bus / window.IDC.data
 * ========================================================================= */
(function (global) {
  "use strict";

  /* ---------------- 事件总线 ---------------- */
  const handlers = new Map();
  const bus = {
    on(evt, fn) {
      if (!handlers.has(evt)) handlers.set(evt, new Set());
      handlers.get(evt).add(fn);
      return () => bus.off(evt, fn);
    },
    off(evt, fn) {
      const s = handlers.get(evt);
      if (s) s.delete(fn);
    },
    emit(evt, payload) {
      const s = handlers.get(evt);
      if (s) s.forEach((fn) => { try { fn(payload); } catch (e) { console.error("[bus:" + evt + "]", e); } });
    },
  };

  /* ---------------- 确定性随机 ---------------- */
  let _seed = 20261102;
  function rnd() { _seed = (_seed * 1664525 + 1013904223) % 4294967296; return _seed / 4294967296; }
  const rr = (a, b) => a + rnd() * (b - a);
  const ri = (a, b) => Math.floor(rr(a, b + 1));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const round = (v, n = 1) => Math.round(v * Math.pow(10, n)) / Math.pow(10, n);
  const pad2 = (n) => String(n).padStart(2, "0");

  /* ---------------- 静态定义 ---------------- */
  const ROWS = ["A", "B", "C", "D", "E", "F"];
  const PER_ROW = 7;                     // 6 排 × 7 = 42 个机柜
  const ZONES = { A: "A 区", B: "A 区", C: "B 区", D: "B 区", E: "C 区", F: "C 区" };
  const VENDORS = [
    { name: "计算服务器", model: "华为 FusionServer RH2288H V5", type: "server" },
    { name: "计算服务器", model: "浪潮 NF5280M6", type: "server" },
    { name: "GPU 服务器", model: "华为 FusionServer G5500 V6", type: "server" },
    { name: "分布式存储", model: "华为 OceanStor 5310 V6", type: "storage" },
    { name: "全闪存储", model: "浪潮 AS5300G5", type: "storage" },
    { name: "核心交换机", model: "华为 CloudEngine S12700E", type: "network" },
    { name: "接入交换机", model: "H3C S6520X-30QC", type: "network" },
    { name: "下一代防火墙", model: "深信服 AF-2000-B2100", type: "security" },
    { name: "负载均衡", model: "F5 BIG-IP i4800", type: "security" },
    { name: "KVM 管理机", model: "华为 iBMC 管理模块", type: "network" },
  ];
  const OWNERS = ["张工", "李工", "王工", "刘工", "赵工", "陈工"];
  // 单柜功率（贴合参考视频：A-02 = 2.23 kW）；其余机柜总功耗按 32.6 kW 归一化
  const POWER_ALARM = { "A-02": 2.23, "C-05": 1.85, "D-07": 1.32, "E-05": 1.64 };

  /* ---------------- 机柜 ---------------- */
  // 3D 坐标：A/B 排、C/D 排、E/F 排 组成 3 组冷通道；x 为排内序号方向，z 为排方向
  const racks = [];
  const rackIndex = {};
  const ROW_Z = { A: -13.5, B: -10.5, C: -4.5, D: -1.5, E: 4.5, F: 7.5 };
  ROWS.forEach((row) => {
    for (let i = 1; i <= PER_ROW; i++) {
      const id = row + "-" + pad2(i);
      const uTotal = 42;
      let uUsed = ri(24, 40);
      const alarm0 = { "A-02": true, "C-05": true, "D-07": true, "E-05": true }[id] || false;
      const offline = id === "B-06";
      const tempIn = round(alarm0 ? 31.8 : rr(22.6, 25.4), 1);
      const devices = [];
      let u = 1;
      const n = ((racks.length % 11) === 0) ? 7 : 6;   // 42 台机柜：4 台 x 7 设备 + 38 台 x 6 设备 = 256 台设备
      for (let d = 0; d < n; d++) {
        const v = pick(VENDORS);
        const size = v.type === "server" ? ri(1, 2) : 2;
        devices.push({
          id: id + "-U" + pad2(u),
          name: v.name,
          model: v.model,
          type: v.type,
          uStart: u,
          uSize: size,
          status: (alarm0 && d === 0) ? "alarm" : ((offline && d < 4) ? "offline" : (rnd() < 0.04 ? "warn" : "normal")),
          temp: round(alarm0 && d === 0 ? 36.5 : rr(24, 33), 1),
          capacityPct: ri(18, 92),
        });
        u += size + ri(2, 5);                          // 留空位：设备均匀分布在 1~42U
      }
      uUsed = Math.min(uTotal, Math.max(u, 36));        // 视觉上接近满柜
      const devTypes = { server: 0, storage: 0, network: 0, security: 0 };
      devices.forEach((d) => { devTypes[d.type]++; });
      const rack = {
        id, row, rowIndex: i, zoneLabel: ZONES[row],
        x: round((i - (PER_ROW + 1) / 2) * 1.9, 2),
        z: ROW_Z[row],
        rot: (row === "A" || row === "C" || row === "E") ? 0 : Math.PI,
        status: offline ? "offline" : (alarm0 ? "alarm" : "normal"),
        tempIn, tempOut: round(rr(21, 24), 1), humidity: round(rr(40, 56), 1),
        powerKW: round(POWER_ALARM[id] != null ? POWER_ALARM[id] : rr(0.40, 0.94), 2),
        powerRatedKW: 3.68,
        loadPct: 61,
        uUsed, uTotal,
        devices,
        devMix: devTypes,
        maintain: { last: "2024-10-28", next: "2024-11-28", team: "IDC 维保一组" },
      };
      rack.powerRatedKW = id === "A-02" ? 3.68 : round(rack.powerKW / rr(0.46, 0.82), 2);
      rack.loadPct = Math.round((rack.powerKW / rack.powerRatedKW) * 100);
      racks.push(rack);
      rackIndex[id] = rack;
    }
  });

  /* ---------------- 归一化：总功耗 32.6kW / 平均温度 24.3℃ / 平均湿度 45.2% ---------------- */
  (function normalize() {
    const alarmSum = racks.reduce((s, r) => s + (POWER_ALARM[r.id] || 0), 0);
    const otherSum = racks.reduce((s, r) => s + r.powerKW, 0) - alarmSum;
    const k = (32.6 - alarmSum) / otherSum;                 // 其余机柜等比缩放
    racks.forEach((r) => {
      if (POWER_ALARM[r.id]) return;
      r.powerKW = round(Math.max(0.18, r.powerKW * k), 2);
      r.powerRatedKW = round(r.powerKW / rr(0.46, 0.82), 2);
      r.loadPct = Math.round((r.powerKW / r.powerRatedKW) * 100);
    });
    const adjust = (key, target) => {
      const adj = racks.filter((r) => r.status !== "alarm");
      for (let pass = 0; pass < 4; pass++) {
        const all = racks.reduce((s, r) => s + r[key], 0);
        const delta = target * racks.length - all;
        if (Math.abs(delta) < 0.02) break;
        const per = delta / adj.length;
        adj.forEach((r) => { r[key] = round(r[key] + per, 1); });
      }
    };
    adjust("tempIn", 24.3);
    adjust("humidity", 45.2);
    racks.forEach((r) => { r.power0 = r.powerKW; r.temp0 = r.tempIn; r.hum0 = r.humidity; });
  })();

  /* ---------------- 告警 ---------------- */
  const ALARM_DEFS = [
    { id: "AL-20261102-001", rackId: "A-02", level: "critical", title: "进风温度过高",
      detail: "进风温度 31.8°C，超过阈值 28°C 已持续 6 分钟。", time: "14:21:08",
      suggest: "检查进风通道与冷通道送风，确认温度传感器读数。" },
    { id: "AL-20261102-002", rackId: "C-05", level: "critical", title: "散热风扇故障",
      detail: "第 3 组风扇模组转速为 0，冗余风扇仍在运行。", time: "14:18:32",
      suggest: "更换故障风扇模组，并复查同批次模组健康度。" },
    { id: "AL-20261102-003", rackId: "D-07", level: "warning", title: "网络丢包偏高",
      detail: "上联端口 15 分钟丢包率 1.8%，高于基线 0.2%。", time: "14:12:45",
      suggest: "检查交换机上联丢包，核对光模块与链路。 " },
    { id: "AL-20261102-004", rackId: "E-05", level: "warning", title: "PDU 负载偏高",
      detail: "A 路 PDU 负载 82%，B 路 38%，建议均衡负载。", time: "14:09:16",
      suggest: "核对 PDU 实际用电量，均衡双路负载。" },
  ];
  const alarms = ALARM_DEFS.map((a, i) => Object.assign({}, a, {
    ts: Date.now() - (i + 1) * 6 * 60 * 1000,
    acked: false, woId: a.rackId === "A-02" ? "WO-1102-001" : (a.rackId === "C-05" ? "WO-1102-002" : (a.rackId === "D-07" ? "WO-1102-003" : null)),
    minute: 0, status: i === 0 ? "处置中" : "待确认",
  }));

  /* ---------------- 工单 ---------------- */
  const workOrders = [
    {
      id: "WO-1102-001", level: "critical", title: "检查 A 区送风与温度传感器", rackId: "A-02",
      owner: "张工", status: "pending", created: "2026-11-02 14:23",
      note: "核对温度传感器读数，检查进风通道。",
      timeline: [
        { time: "14:23", text: "告警生成工单" },
        { time: "14:23", text: "维保人员接单（演示）" },
        { time: "14:24", text: "用户确认处置方案后，助手关联工单并安排处理（演示）" },
        { time: "14:26", text: "现场处理记录待回填（演示）" },
      ],
      footer: "需要现场人员实际检查：助手不会把派单当作维修完成。",
    },
    {
      id: "WO-1102-002", level: "critical", title: "更换故障风扇模组", rackId: "C-05",
      owner: "李工", status: "doing", created: "2026-11-02 14:20",
      note: "携带 C 区备件柜同型号风扇模组，更换后复查转速。",
      timeline: [{ time: "14:20", text: "告警生成工单" }, { time: "14:22", text: "维保人员接单（演示）" }, { time: "14:25", text: "现场处理中（演示）" }],
      footer: "更换完成后需回填风扇转速实测值。",
    },
    {
      id: "WO-1102-003", level: "warning", title: "检查交换机上联丢包", rackId: "D-07",
      owner: "王工", status: "pending", created: "2026-11-02 14:15",
      note: "核对光模块收发光功率，检查上联链路。",
      timeline: [{ time: "14:15", text: "告警生成工单" }, { time: "14:16", text: "维保人员接单（演示）" }],
      footer: "如丢包恢复，需连续观察 30 分钟再关闭。",
    },
    {
      id: "WO-1101-004", level: "plan", title: "机柜周巡检与清洁", rackId: "B-04",
      owner: "刘工", status: "done", created: "2026-11-01 10:00",
      note: "按周计划完成机柜内外除尘与线缆整理。",
      timeline: [{ time: "11-01 10:00", text: "计划任务下发" }, { time: "11-01 16:20", text: "现场完成并回填" }, { time: "11-01 16:40", text: "核验通过" }],
      footer: "本周计划任务已完成。",
    },
  ];

  /* ---------------- 能耗 / 图表 ---------------- */
  const energy = {
    monthKWh: 210785, pueTarget: 1.40, savingPct: -6.8,
    hourly: Array.from({ length: 24 }, (_, h) => ({
      label: pad2(h) + ":00",
      kwh: Math.round((h < 6 ? 6800 : h < 9 ? 9200 : h < 12 ? 12400 : h < 14 ? 11600 : h < 18 ? 13600 : h < 21 ? 14850 : 10200) * rr(0.94, 1.06)),
    })),
    week: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((label) => ({ label, kwh: Math.round(rr(210000, 268000)) })),
    pueSeries: Array.from({ length: 24 }, (_, h) => ({ label: pad2(h) + ":00", v: round(1.30 + Math.sin(h / 3.4) * 0.09 + rr(-0.03, 0.03), 2) })),
    mix: [
      { name: "IT 设备", pct: 52, color: "#22d3ee" },
      { name: "制冷系统", pct: 30, color: "#2f7fe8" },
      { name: "供配电", pct: 12, color: "#7c6cf0" },
      { name: "照明与其它", pct: 6, color: "#f5a524" },
    ],
  };
  const kpi = {
    rackTotal: racks.length, deviceTotal: 0, deviceOnline: 0, deviceAlarm: 4, deviceMaintain: 0,
    tempAvg: 24.3, humAvg: 45.2, pue: 1.36, itLoadPct: 68, itLoadKW: 12.6, itLoadCapKW: 18.5,
    energyTodayKWh: 28430, energyDeltaPct: -6.8, available: 99.99, totalPowerKW: 32.6,
    energyMonthKWh: energy.monthKWh, pueTarget: energy.pueTarget, savingPct: energy.savingPct,
    runScore: 98, runState: "运行良好",
  };
  const deviceMix = [
    { name: "服务器", pct: 58, color: "#22d3ee" },
    { name: "存储设备", pct: 18, color: "#2f7fe8" },
    { name: "网络设备", pct: 12, color: "#7c6cf0" },
    { name: "安全设备", pct: 7, color: "#22c55e" },
    { name: "其它设备", pct: 5, color: "#f5a524" },
  ];
  const alarmStats = { total: 12, critical: 2, warning: 4, info: 6, hourly: Array.from({ length: 24 }, (_, h) => ({ label: pad2(h), v: h % 5 === 0 ? ri(1, 3) : (rnd() < 0.3 ? 1 : 0) })) };
  const events = [
    { time: "14:28:34", text: "A-02 进风温度过高（31.8°C）", level: "critical" },
    { time: "14:26:10", text: "C-05 散热风扇模组告警", level: "critical" },
    { time: "14:21:08", text: "D-07 网络丢包偏高", level: "warning" },
    { time: "14:09:16", text: "E-05 PDU 负载偏高", level: "warning" },
    { time: "13:58:45", text: "B-04 周巡检任务完成", level: "info" },
  ];

  /* ---------------- 统计 ---------------- */
  function recount() {
    let total = 0, online = 0, alarm = 0, maintain = 0, power = 0, tSum = 0, hSum = 0;
    racks.forEach((r) => {
      total += r.devices.length;
      online += r.devices.filter((d) => d.status !== "offline").length;
      alarm += r.devices.filter((d) => d.status === "alarm").length;
      maintain += r.status === "offline" ? 1 : 0;
      power += r.powerKW;
      tSum += r.tempIn; hSum += r.humidity;
    });
    kpi.deviceTotal = total;
    kpi.deviceOnline = online;
    kpi.racksNormal = racks.filter((r) => r.status === "normal").length;
    kpi.racksAlarm = racks.filter((r) => r.status === "alarm").length;
    kpi.racksOffline = racks.filter((r) => r.status === "offline").length;
    kpi.uUsedTotal = racks.reduce((s, r) => s + r.uUsed, 0);
    kpi.uTotal = racks.reduce((s, r) => s + r.uTotal, 0);
    kpi.deviceAlarm = 4;
    kpi.deviceMaintain = 0;
    kpi.totalPowerKW = round(power, 1);
    kpi.tempAvg = round(tSum / racks.length, 1);
    kpi.humAvg = round(hSum / racks.length, 1);
    kpi.itLoadKW = round(power * 0.386, 1);
    kpi.itLoadCapKW = 18.5;
    kpi.itLoadPct = Math.round((kpi.itLoadKW / kpi.itLoadCapKW) * 100);
  }
  recount();

  /* ---------------- 仿真时间 ---------------- */
  const SIM_START = new Date(2026, 10, 2, 14, 28, 36);
  const realStart = Date.now();
  const simNow = () => new Date(SIM_START.getTime() + (Date.now() - realStart) * 6); // 时间加速 6×
  function clock() {
    const d = simNow();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  function clockShort() { const d = simNow(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }

  /* ---------------- 数据访问 API ---------------- */
  const api = {
    bus, kpi, racks, alarms, workOrders, energy, deviceMix, alarmStats, events,
    rows: ROWS, zoneLabel: ZONES, owners: OWNERS,
    clock, clockShort, simNow, recount,
    getRack: (id) => rackIndex[id] || null,
    racksOfRow(row) { return racks.filter((r) => r.row === row); },
    getAlarm: (id) => alarms.find((a) => a.id === id) || null,
    alarmOfRack(rackId) { return alarms.find((a) => a.rackId === rackId) || null; },
    getWorkOrder: (id) => workOrders.find((w) => w.id === id) || null,
    woOfRack(rackId) { return workOrders.find((w) => w.rackId === rackId) || null; },
    devicesOfRack(rackId) { const r = rackIndex[rackId]; return r ? r.devices : []; },
    allDevices() { const out = []; racks.forEach((r) => r.devices.forEach((d) => out.push(Object.assign({ rackId: r.id, zone: r.zoneLabel }, d)))); return out; },
    addEvent(text, level) {
      events.unshift({ time: clockShort(), text, level: level || "info" });
      if (events.length > 40) events.pop();
      bus.emit("event:add", events[0]);
    },
    addAlarm(a) {
      const id = a.id || "AL-20261102-" + String(alarms.length + 1).padStart(3, "0");
      const item = Object.assign({ id, ts: Date.now(), time: clockShort(), acked: false, woId: null, status: "待确认", level: "critical", minute: 0 }, a);
      alarms.unshift(item);
      const r = rackIndex[item.rackId];
      if (r) r.status = "alarm";
      kpi.deviceAlarm = alarms.filter((x) => !x.acked).length;
      bus.emit("alarm:add", item);
      return item;
    },
    ackAlarm(id) {
      const a = api.getAlarm(id);
      if (a) { a.acked = true; a.status = "已确认"; bus.emit("alarm:ack", a); }
      return a;
    },
    addWorkOrder(wo) {
      const item = Object.assign({
        id: "WO-1102-" + String(workOrders.length + 1).padStart(3, "0"),
        level: "warning", status: "pending", owner: pick(OWNERS), created: clock().slice(0, 16).replace("T", " "),
        note: "", timeline: [], footer: "",
      }, wo);
      workOrders.unshift(item);
      bus.emit("wo:update", item);
      api.addEvent("生成工单 " + item.id + " · " + item.title, "info");
      return item;
    },
    updateWorkOrder(id, patch) {
      const w = api.getWorkOrder(id);
      if (!w) return null;
      Object.assign(w, patch);
      bus.emit("wo:update", w);
      return w;
    },
    pushTimeline(id, text) {
      const w = api.getWorkOrder(id);
      if (!w) return null;
      w.timeline.push({ time: clock().slice(11, 16), text });
      bus.emit("wo:update", w);
      return w;
    },
    /* 让某机柜温度回落（巡检/处置闭环用） */
    coolRack(rackId, temp) {
      const r = rackIndex[rackId];
      if (!r) return;
      r.tempIn = round(temp != null ? temp : 24.2, 1);
      r.status = "normal";
      if (r.devices[0]) { r.devices[0].status = "normal"; r.devices[0].temp = round(rr(26, 30), 1); }
      api.addEvent(rackId + " 温度恢复至 " + r.tempIn + "°C", "info");
      bus.emit("data:tick");
    },
    tick() {
      racks.forEach((r) => {
        const drift = (r.status === "alarm" ? 0 : rr(-0.08, 0.08));
        r.tempIn = round(Math.min(33, Math.max(21.5, r.tempIn + drift + (r.temp0 - r.tempIn) * 0.2)), 1);
        r.humidity = round(Math.min(60, Math.max(38, r.humidity + rr(-0.25, 0.25) + (r.hum0 - r.humidity) * 0.2)), 1);
        r.powerKW = round(Math.max(0.18, Math.min(2.6, r.powerKW + rr(-0.015, 0.015) + (r.power0 - r.powerKW) * 0.2)), 2);
        r.loadPct = Math.round((r.powerKW / r.powerRatedKW) * 100);
      });
      kpi.pue = round(1.358 + Math.sin(Date.now() / 120000) * 0.004, 2);
      kpi.energyTodayKWh += Math.round(rr(20, 60));
      kpi.available = Math.min(99.99, round(99.992 + Math.sin(Date.now() / 150000) * 0.004, 2));
      kpi.runScore = Math.min(99, Math.round(96 + (kpi.deviceAlarm === 4 ? 2 : 3)));
      recount();
      alarmStats.hourly[0].v = Math.min(6, alarmStats.hourly[0].v + (rnd() < 0.2 ? 1 : 0));
      bus.emit("data:tick", kpi);
    },
    _rnd: rnd,
  };

  global.IDC = global.IDC || {};
  global.IDC.bus = bus;
  global.IDC.data = api;
})(window);