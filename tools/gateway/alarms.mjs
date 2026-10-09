/* =========================================================================
 * tools/gateway/alarms.mjs — 动环报警规则引擎（规范 §1.3）
 *  - AI 越限：hiHi/hi/lo/loLo -> critical/warning，deadband 回差 + delay 持续确认
 *  - DI 变位：v !== normal（invert 时相反）；smoke/water=critical，bypass/ats=warning
 *  - 通信中断：设备 online=false 持续 > offlineAfter(默认 30s) -> info「通信中断」
 *  - 报警对象：{ id, pointId, devId, level, rule, text, value, unit, state, ts, ackTs, clearTs }
 * ========================================================================= */

export const LEVEL_RANK = { critical: 3, warning: 2, info: 1, normal: 0 };
export const LEVEL_TEXT = { critical: "严重", warning: "一般", info: "提示" };
export const RULE_TEXT = {
  hiHi: "严重超上限", hi: "超上限", loLo: "严重超下限", lo: "超下限",
  di: "状态异常", offline: "通信中断",
};

/** 纯运行状态指示类 DI（0=停止 / 1=运行），属状态量而非告警量，不参与 DI 变位判定 */
const STATUS_ONLY_DI = new Set(["ac:stComp", "ac:stFan", "ac:stHeat", "ac:stHum"]);
const isStatusOnlyDI = (dev, pt) => STATUS_ONLY_DI.has((dev ? dev.type : "") + ":" + pt.key);

const N = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** 稳定报警 id（同一测点同一规则复用） */
export function alarmId(pointId, rule) { return "AL:" + pointId + ":" + rule; }

export class AlarmEngine {
  constructor({ devices = [], points = [], offlineAfter = 30000, onAlarm = null, now = () => Date.now() } = {}) {
    this.devices = devices;
    this.points = points;
    this.deviceById = Object.fromEntries(devices.map((d) => [d.id, d]));
    this.offlineAfter = offlineAfter;
    this.onAlarm = onAlarm;
    this.now = now;
    this.activeAlarms = new Map();
    this.aiState = new Map();
    this.diState = new Map();
    this.offlineSince = new Map();
    this.counters = { raised: 0, cleared: 0, updates: 0 };
    this._aiPoints = points.filter((x) => x.kind === "ai");
    this._diPoints = points.filter((x) => x.kind === "di");
  }
  /* ---------------- AI：越限 + 回差 + 延时 ---------------- */
  _evalAI(p, v, cur) {
    const db = N(p.deadband) ?? 0;
    const hi = N(p.hi), hiHi = N(p.hiHi), lo = N(p.lo), loLo = N(p.loLo);
    let level = "normal", rule = null, thr = null;
    if (hiHi != null && v > hiHi) { level = "critical"; rule = "hiHi"; thr = hiHi; }
    else if (hi != null && v > hi) { level = "warning"; rule = "hi"; thr = hi; }
    else if (loLo != null && v < loLo) { level = "critical"; rule = "loLo"; thr = loLo; }
    else if (lo != null && v < lo) { level = "warning"; rule = "lo"; thr = lo; }
    // 回差：只在降级/恢复时需要越过当前锚点阈值加减 deadband，防止临界抖动
    if (cur && cur.level !== "normal" && LEVEL_RANK[cur.level] > LEVEL_RANK[level]) {
      const highSide = cur.anchor === "hi" || cur.anchor === "hiHi";
      const Ta = N(highSide ? (cur.anchor === "hiHi" ? hiHi : hi) : (cur.anchor === "loLo" ? loLo : lo));
      if (Ta != null) {
        const beyond = highSide ? v <= Ta - db : v >= Ta + db;
        if (!beyond) return { level: cur.level, rule: cur.rule, thr: Ta, hold: true };
      }
    }
    return { level, rule, thr };
  }

  _touchAI(p, v, ts, out) {
    const st = this.aiState.get(p.id) || { level: "normal", rule: null, anchor: null, pending: null };
    const target = this._evalAI(p, v, st);
    if (target.level === st.level) { st.pending = null; this.aiState.set(p.id, st); return; }
    if (!st.pending || st.pending.level !== target.level) st.pending = { level: target.level, since: ts };
    const delayMs = (N(p.delay) ?? 3) * 1000;
    if (ts - st.pending.since < delayMs) { this.aiState.set(p.id, st); return; }
    const prevRule = st.rule;
    st.level = target.level; st.rule = target.rule; st.anchor = target.rule; st.pending = null;
    this.aiState.set(p.id, st);
    if (target.level === "normal") {
      if (prevRule) this._clear(alarmId(p.id, prevRule), ts, out);
    } else {
      if (prevRule && prevRule !== target.rule) this._clear(alarmId(p.id, prevRule), ts, out);
      this._raise(p, target.level, target.rule, v, ts, out);
    }
  }

  /* ---------------- DI：变位立即报警 ---------------- */
  _diLevel(dev, p) {
    const t = dev ? dev.type : "";
    if (t === "smoke" || t === "water") return "critical";
    if (p.key === "bypass" || t === "ats") return "warning";
    return "warning";
  }

  _touchDI(dev, p, v, ts, out) {
    const normal = N(p.normal) ?? 0;
    const invert = !!p.invert;
    const active = invert ? v === normal : v !== normal;
    const st = this.diState.get(p.id) || { active: false };
    if (active === st.active) return;
    st.active = active;
    this.diState.set(p.id, st);
    if (active) this._raise(p, this._diLevel(dev, p), "di", v, ts, out);
    else this._clear(alarmId(p.id, "di"), ts, out);
  }
  /* ---------------- 通信中断 ---------------- */
  _touchDevice(dev, online, ts, out) {
    const id = "AL:" + dev.id + ":offline";
    if (online === false) {
      if (!this.offlineSince.has(dev.id)) this.offlineSince.set(dev.id, ts);
      const since = this.offlineSince.get(dev.id);
      if (ts - since >= this.offlineAfter && !this.activeAlarms.has(id)) {
        this._raiseRaw({
          id, pointId: null, devId: dev.id, level: "info", rule: "offline",
          text: (dev.name || dev.id) + " 通信中断", value: null, unit: "",
        }, ts, out);
      }
    } else {
      this.offlineSince.delete(dev.id);
      if (this.activeAlarms.has(id)) this._clear(id, ts, out);
    }
  }

  /* ---------------- 报警对象生成 ---------------- */
  _raise(p, level, rule, value, ts, out) {
    const dev = this.deviceById[p.devId];
    const suffix = RULE_TEXT[rule] || "报警";
    this._raiseRaw({
      id: alarmId(p.id, rule),
      pointId: p.id, devId: p.devId, level, rule,
      text: (dev ? dev.name + " " : "") + p.name + suffix,
      value, unit: p.unit || "",
    }, ts, out);
  }

  _raiseRaw(alarm, ts, out) {
    const prev = this.activeAlarms.get(alarm.id);
    const obj = {
      id: alarm.id, pointId: alarm.pointId, devId: alarm.devId,
      level: alarm.level, rule: alarm.rule, text: alarm.text,
      value: alarm.value == null ? null : alarm.value, unit: alarm.unit || "",
      state: "active",
      ts: prev && prev.state !== "cleared" ? prev.ts : ts,
      ackTs: null, clearTs: null,
    };
    this.activeAlarms.set(obj.id, obj);
    this.counters.raised++;
    out.push(obj);
    this._emit(obj);
  }

  _clear(id, ts, out) {
    const prev = this.activeAlarms.get(id);
    if (!prev) return;
    prev.state = "cleared";
    prev.clearTs = ts;
    prev.durationMs = Math.max(0, ts - prev.ts);
    this.activeAlarms.delete(id);
    this.counters.cleared++;
    out.push(prev);
    this._emit(prev);
  }

  _emit(alarm) { if (this.onAlarm) { try { this.onAlarm(alarm); } catch (e) {} } }

  /* ---------------- 对外主入口 ---------------- */
  update(values = {}, quality = {}, deviceStatus = {}, ts = this.now()) {
    const out = [];
    this.counters.updates++;
    for (const dev of this.devices) {
      const st = deviceStatus[dev.id];
      const online = st && typeof st.online === "boolean" ? st.online : true;
      this._touchDevice(dev, online, ts, out);
    }
    for (const pt of this._aiPoints) {
      const v = N(values[pt.id]);
      if (v == null) continue;
      if (quality[pt.id] && quality[pt.id] !== "good") continue;
      this._touchAI(pt, v, ts, out);
    }
    for (const pt of this._diPoints) {
      const dev = this.deviceById[pt.devId];
      if (isStatusOnlyDI(dev, pt)) continue;
      const v = N(values[pt.id]);
      if (v == null) continue;
      this._touchDI(dev, pt, v, ts, out);
    }
    return out;
  }

  /** 当前活动（未恢复）报警，按级别 + 时间排序 */
  active() {
    return [...this.activeAlarms.values()].sort((a, b) =>
      (LEVEL_RANK[b.level] - LEVEL_RANK[a.level]) || (b.ts - a.ts));
  }

  get(id) { return this.activeAlarms.get(id) || null; }

  /** 确认报警 */
  ack(id, ts = this.now()) {
    const a = this.activeAlarms.get(id);
    if (!a) return null;
    a.state = "acked";
    a.ackTs = ts;
    this._emit(a);
    return a;
  }

  /** 手动清除：立即恢复并复位规则状态，允许再次触发 */
  forceClear(id, ts = this.now()) {
    const a = this.activeAlarms.get(id);
    if (!a) return null;
    const out = [];
    this._clear(id, ts, out);
    if (a.pointId) {
      if (a.rule === "di") this.diState.delete(a.pointId);
      else this.aiState.delete(a.pointId);
    }
    this.offlineSince.delete(a.devId);
    return a;
  }

  stats() { return { ...this.counters, active: this.activeAlarms.size }; }
}

export default AlarmEngine;