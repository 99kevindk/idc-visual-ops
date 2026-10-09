/* =========================================================================
 * tools/gateway/drivers/sim.mjs — 内置设备模拟器（默认驱动，零依赖）
 *  按点表产生有真实感的动环数据：
 *   - UPS 三相电压 228~232V、电流随负载、负载率 60~72%、电池 512V / 备用 22min
 *   - 温湿度 23~25 度 / 42~48 %RH，缓慢漂移 + 日周期
 *   - 偶发真实告警（每分钟 1~2 次）：烟感动作 / 浸水 / UPS 旁路
 *   - inject 可强制置位与恢复（最高优先级覆盖）
 * ========================================================================= */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const noise = (a) => (Math.random() - 0.5) * 2 * a;
const round2 = (v) => Math.round(v * 100) / 100;
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000; return h; };
/** 日周期因子：15:00 最高、03:00 最低 */
function daily(now) {
  const d = new Date(now);
  const h = d.getHours() + d.getMinutes() / 60;
  return Math.sin(((h - 9) / 24) * TAU);
}

/* ------------------------- 各类型设备的数据生成 ------------------------- */
function genUPS(dev, now, seed) {
  const v = {};
  const load = clamp(66 + 4.5 * Math.sin(now / 90000 + seed) + noise(0.8), 60, 72);
  const rated = dev.ratedKW || 200;
  [["A", 0], ["B", 2.1], ["C", 4.2]].forEach(([ph, ph2]) => {
    v["UA" + ph] = round2(clamp(230 + 1.6 * Math.sin(now / 70000 + seed + ph2) + noise(0.5), 228, 232));
    v["IA" + ph] = round2(clamp(150 + (load - 60) * (80 / 12) + noise(3), 120, 250));
    v["UO" + ph] = round2(clamp(230 + 1.6 * Math.sin(now / 70000 + seed + ph2 + 0.6) + noise(0.5), 228, 232));
    v["IO" + ph] = round2(clamp(150 + (load - 60) * (80 / 12) + noise(3), 120, 250));
  });
  v.UAB_L = round2(clamp(v.UAA * 1.732 + noise(0.8), 390, 410));
  v.fIn = round2(50 + noise(0.03));
  v.load = round2(load);
  v.pOut = round2(load / 100 * rated * 0.88 + noise(1.5));
  v.batV = round2(512 + 1.5 * Math.sin(now / 120000 + seed) + noise(0.3));
  v.batI = round2(3.5 + noise(1.0));
  v.batMin = round2(clamp(22 + 0.4 * Math.sin(now / 180000 + seed) + noise(0.15), 20.5, 23.5));
  v.temp = round2(25.0 + noise(0.4));
  Object.assign(v, { stIn: 0, stOut: 0, bypass: 0, fault: 0, faultInv: 0, faultBat: 0, faultByp: 0, onBatt: 0, gen: 0 });
  return v;
}

function genAC(dev, now, seed) {
  return {
    retT: round2(clamp(24.5 + 0.7 * Math.sin(now / 300000 + seed) + noise(0.15), 23, 26.5)),
    retH: round2(clamp(48 + 3 * Math.sin(now / 420000 + seed) + noise(0.5), 42, 55)),
    supT: round2(clamp(19 + 0.5 * Math.sin(now / 260000 + seed) + noise(0.15), 18, 20)),
    setT: 24, setH: 50,
    cool: round2(16 + 2 * Math.sin(now / 500000 + seed) + noise(0.3)),
    fan: round2(clamp(78 + 5 * Math.sin(now / 200000 + seed) + noise(1), 65, 92)),
    valve: round2(clamp(50 + 9 * Math.sin(now / 340000 + seed) + noise(2), 30, 75)),
    stComp: 1, stFan: 1, stHeat: 0, stHum: 0, almFilter: 0, almHP: 0, almLP: 0, almWater: 0,
  };
}

function genTH(dev, now, seed) {
  const off = (hash(dev.id) % 7 - 3) * 0.18;
  const d = daily(now);
  const temp = clamp(24 + d * 0.9 + off + noise(0.12), 23, 25);
  const hum = clamp(45 - d * 1.1 + off * 2 + noise(0.6), 42, 48);
  return {
    temp: round2(temp),
    hum: round2(hum),
    dew: round2(temp - (100 - hum) / 5),
    online: 0,
  };
}

function genWater(dev, now) {
  const v = { online: 0 };
  const n = dev.rope ? 6 : 1;
  for (let i = 1; i <= n; i++) v["ch" + i] = 0;
  if (dev.rope) v.ropeBreak = 0;
  return v;
}

function genSmoke(dev, now, seed) {
  return {
    state: 0, fault: 0,
    pollution: round2(clamp(0.4 + Math.abs(noise(0.25)), 0.1, 1.2)),
    voltage: round2(clamp(23.5 + noise(0.4), 21, 25)),
  };
}

function genMDB(dev, now, seed, t0) {
  const v = {};
  [["A", 0], ["B", 2.1], ["C", 4.2]].forEach(([ph, ph2]) => {
    v["UP" + ph] = round2(clamp(230 + 1.4 * Math.sin(now / 80000 + seed + ph2) + noise(0.5), 228, 232));
    v["I" + ph] = round2(clamp(120 + 25 * Math.sin(now / 200000 + seed + ph2) + noise(4), 90, 170));
  });
  v.P = round2(clamp(62 + 12 * Math.sin(now / 260000 + seed) + noise(2), 50, 80));
  v.PF = round2(clamp(0.95 + noise(0.012), 0.9, 0.99));
  v.E = round2(12000 + ((now - t0) / 1000) * 1.35);
  v.f = round2(50 + noise(0.03));
  Object.assign(v, { brk: 0, almOver: 0, almUnder: 0, almOverV: 0, almPhase: 0 });
  return v;
}

function genBAT(dev, now, seed) {
  return {
    U: round2(512 + 1.6 * Math.sin(now / 130000 + seed) + noise(0.4)),
    I: round2(4 + noise(1.2)),
    dT: round2(clamp(1.4 + Math.abs(noise(0.5)), 0.5, 2.6)),
    rInt: round2(clamp(2.05 + noise(0.12), 1.8, 2.4)),
    soh: round2(clamp(94 + noise(0.8), 90, 97)),
    soc: round2(clamp(88 + noise(1.5), 82, 96)),
    temp: round2(25 + noise(0.4)),
    almCell: 0,
  };
}

function genATS(dev, now) {
  const um = round2(clamp(399 + noise(0.7), 396, 402));
  return {
    Umain: um,
    Ubak: round2(clamp(399 + noise(0.7), 396, 402)),
    cnt: 12, Uout: um,
    pos: 0, stMain: 0, stBak: 0, alm: 0,
  };
}
/* ------------------------------ 驱动工厂 ------------------------------ */
export function createSimDriver({ devices = [], points = [], site = {}, log = () => {}, emit = () => {} } = {}) {
  const devById = {};
  const devPoints = {};
  const pointById = {};
  for (const d of devices) { devById[d.id] = d; devPoints[d.id] = []; }
  for (const pt of points) { pointById[pt.id] = pt; (devPoints[pt.devId] || (devPoints[pt.devId] = [])).push(pt); }

  const t0 = Date.now();
  const forced = new Map();   // pointId -> value（inject 持久置位）
  const timed = new Map();    // pointId -> { value, until }（随机告警临时置位）
  const offlined = new Set(); // devId（inject offline）
  let nextRandomAt = Date.now() + 20000 + Math.random() * 25000;
  let running = false;
  const stats = { polls: 0, scenarios: 0, injected: 0 };

  function genDevice(dev, now) {
    const seed = (hash(dev.id) % 1000) / 1000 * TAU;
    switch (dev.type) {
      case "ups": return genUPS(dev, now, seed);
      case "ac": return genAC(dev, now, seed);
      case "th": return genTH(dev, now, seed);
      case "water": return genWater(dev, now);
      case "smoke": return genSmoke(dev, now, seed);
      case "mdb": return genMDB(dev, now, seed, t0);
      case "battery": return genBAT(dev, now, seed);
      case "ats": return genATS(dev, now);
      default: return {};
    }
  }

  function setTimed(pointId, value, ms) { timed.set(pointId, { value, until: Date.now() + ms }); }

  function spawnRandomScenario() {
    const roll = Math.random();
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const upsList = devices.filter((d) => d.type === "ups");
    const smList = devices.filter((d) => d.type === "smoke");
    const wdList = devices.filter((d) => d.type === "water");
    if (roll < 0.4 && smList.length) {                       // 烟感动作 -> critical
      const d = pick(smList);
      setTimed(d.id + ".state", 1, 15000 + Math.random() * 12000);
      stats.scenarios++;
      emit({ kind: "info", text: "模拟随机告警：" + d.name + " 烟雾报警动作" });
    } else if (roll < 0.75 && wdList.length) {               // 浸水 -> critical
      const d = pick(wdList);
      const ch = d.rope ? 1 + Math.floor(Math.random() * 6) : 1;
      setTimed(d.id + ".ch" + ch, 1, 15000 + Math.random() * 12000);
      stats.scenarios++;
      emit({ kind: "info", text: "模拟随机告警：" + d.name + " 第 " + ch + " 路浸水" });
    } else if (upsList.length) {                             // UPS 旁路 -> warning
      const d = pick(upsList);
      setTimed(d.id + ".bypass", 1, 12000 + Math.random() * 10000);
      stats.scenarios++;
      emit({ kind: "info", text: "模拟随机告警：" + d.name + " 转旁路供电" });
    }
  }

  function tickScenarios(now) {
    for (const [pid, it] of timed) if (now >= it.until) timed.delete(pid);
    if (now >= nextRandomAt) {
      nextRandomAt = now + 25000 + Math.random() * 30000; // 平均约 40s 一次（每分钟 1~2 次）
      spawnRandomScenario();
    }
  }

  function applyOverrides(values) {
    for (const [pid, it] of timed) if (pid in values) values[pid] = it.value;
    for (const [pid, v] of forced) if (pid in values) values[pid] = v;
  }

  /* ------------------------------ inject ------------------------------ */
  function resolveChannel(dev, channel) {
    if (dev.rope) return "ch" + clamp(Number(channel) || 1, 1, 6);
    return "ch1";
  }

  function inject(req = {}) {
    const applied = [];
    // 方式一：直接按测点置位 { pointId, value }（value=null 表示清除）
    if (req.pointId) {
      const pt = pointById[req.pointId];
      if (!pt) return { ok: false, error: "未知测点 " + req.pointId };
      if (req.value === null || req.value === undefined) {
        forced.delete(req.pointId);
        return { ok: true, applied: [{ pointId: req.pointId, value: null }], text: "已清除 " + req.pointId + " 的强制值" };
      }
      const v = typeof req.value === "boolean" ? (req.value ? 1 : 0) : Number(req.value);
      if (!Number.isFinite(v)) return { ok: false, error: "value 必须是数字或布尔值" };
      forced.set(req.pointId, v);
      stats.injected++;
      applied.push({ pointId: req.pointId, value: v });
      return { ok: true, applied, text: "已注入 " + req.pointId + " = " + v };
    }
    // 方式二：按设备 + 动作 { deviceId, action }
    const dev = req.deviceId ? devById[req.deviceId] : null;
    if (!dev) return { ok: false, error: "需要 pointId，或 deviceId + action（可用驱动 sim）" };
    const action = String(req.action || "").toLowerCase();
    const put = (pid, v) => { forced.set(pid, v); applied.push({ pointId: pid, value: v }); };
    switch (action) {
      case "smoke":
        if (dev.type !== "smoke") return { ok: false, error: dev.id + " 不是烟感设备" };
        put(dev.id + ".state", 1);
        break;
      case "water": {
        if (dev.type !== "water") return { ok: false, error: dev.id + " 不是浸水设备" };
        put(dev.id + "." + resolveChannel(dev, req.channel), 1);
        break;
      }
      case "offline":
        offlined.add(dev.id);
        break;
      case "online":
        offlined.delete(dev.id);
        break;
      case "overvoltage":
        if (dev.type !== "ups") return { ok: false, error: dev.id + " 不是 UPS 设备" };
        ["A", "B", "C"].forEach((ph) => put(dev.id + ".UA" + ph, 258)); // > hiHi 253 -> critical
        break;
      case "overload":
        if (dev.type !== "ups") return { ok: false, error: dev.id + " 不是 UPS 设备" };
        put(dev.id + ".load", 96); // > hiHi 95 -> critical
        break;
      case "clear":
      case "reset": {
        for (const pid of [...forced.keys()]) if (pid.startsWith(dev.id + ".")) forced.delete(pid);
        for (const pid of [...timed.keys()]) if (pid.startsWith(dev.id + ".")) timed.delete(pid);
        offlined.delete(dev.id);
        return { ok: true, applied: [], text: "已复位 " + dev.id + " 的注入状态" };
      }
      default:
        return { ok: false, error: "未知动作 " + req.action + "（可用 smoke/water/offline/online/overvoltage/overload/clear）" };
    }
    stats.injected++;
    return { ok: true, applied, text: "已注入 " + dev.id + " 动作 " + action };
  }

  /* ------------------------------ poll ------------------------------ */
  async function poll() {
    const now = Date.now();
    tickScenarios(now);
    const values = {};
    const quality = {};
    const devStatus = {};
    for (const dev of devices) {
      if (offlined.has(dev.id)) {
        devStatus[dev.id] = { online: false, rt: 0, reason: "inject offline" };
        continue;
      }
      const vals = genDevice(dev, now);
      for (const pt of devPoints[dev.id] || []) {
        let v = vals[pt.key];
        if (v == null) v = pt.kind === "di" ? (pt.normal ?? 0) : 0;
        values[pt.id] = v;
        quality[pt.id] = "good";
      }
      devStatus[dev.id] = { online: true, rt: 1 + Math.round(Math.random() * 3) };
    }
    applyOverrides(values);
    stats.polls++;
    return { values, quality, devices: devStatus };
  }

  return {
    name: "sim",
    protocols: ["sim"],
    get state() { return running ? "connected" : "idle"; },
    stats,
    async start() {
      running = true;
      emit({ kind: "info", text: "模拟器驱动已启动：" + devices.length + " 设备 / " + points.length + " 测点" });
      return true;
    },
    async stop() { running = false; },
    async poll() { return poll(); },
    inject,
    status() { return { state: running ? "connected" : "idle", note: "内置模拟器", scenarios: stats.scenarios, injected: stats.injected }; },
    /** 供自测/调试读取当前随机/强制覆盖状态 */
    overrides() { return { forced: Object.fromEntries(forced), timed: Object.fromEntries([...timed].map(([k, v]) => [k, v.value])) }; },
  };
}

export default createSimDriver;