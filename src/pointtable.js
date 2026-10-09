/* SPDX-License-Identifier: AGPL-3.0-or-later
 * IDC 可视化运维项目（IDC Visual Ops）· Copyright (c) 2026 99kevindk
 * 本文件以 AGPL-3.0-or-later 开源；闭源商业集成 / SaaS 托管需另行取得商业授权（见 COMMERCIAL-LICENSE.md）。
 */
/* =========================================================================
 *  src/pointtable.js — 动环（动力环境）设备点表：网关(Node) 与前端(浏览器) 共用同一份定义
 *  - 纯数据 + 纯函数，无任何依赖（Node 可直接 import）
 *  - 设备 16 台 / 测点约 240 个：UPS、精密空调、温湿度、浸水、烟感、低压配电、
 *    电池组、ATS 双电源
 *  - 真实项目换厂家只改本文件（addr/oid/mqtt/scale/bits），上层代码不用动
 * ========================================================================= */

export const SITE = {
  id: "sh-dc-01",
  name: "上海一号数据中心",
  zones: ["A 区", "B 区", "C 区", "电力间"],
  pollInterval: 2000,          // 采集周期 ms
  offlineAfter: 30000,         // 通信中断判定 ms
};

/* ---------------- 阈值模板（AI 点） ---------------- */
const T = {
  volt380: { hi: 418, hiHi: 437, lo: 342, loLo: 323, unit: "V", deadband: 3, delay: 3 },
  voltPhase: { hi: 245, hiHi: 253, lo: 198, loLo: 187, unit: "V", deadband: 2, delay: 3 },
  current: { hi: 260, hiHi: 300, unit: "A", deadband: 4, delay: 5 },
  temp: { hi: 27, hiHi: 30, lo: 18, loLo: 15, unit: "℃", deadband: 0.4, delay: 5 },
  tempRack: { hi: 28, hiHi: 32, lo: 15, loLo: 10, unit: "℃", deadband: 0.4, delay: 5 },
  humidity: { hi: 65, hiHi: 75, lo: 30, loLo: 20, unit: "%RH", deadband: 3, delay: 10 },
  pue: { hi: 1.5, hiHi: 1.7, unit: "", deadband: 0.02, delay: 60 },
  power: { hi: 0.9, hiHi: 1.0, unit: "kW", deadband: 0.02, delay: 5 },
  batVolt: { hi: 560, hiHi: 580, lo: 480, loLo: 460, unit: "V", deadband: 2, delay: 5 },
  freq: { hi: 51, hiHi: 52, lo: 49, loLo: 48, unit: "Hz", deadband: 0.1, delay: 5 },
  pf: { lo: 0.85, loLo: 0.8, unit: "", deadband: 0.02, delay: 10 },
  pollution: { hi: 3, hiHi: 4, unit: "%", deadband: 0.3, delay: 60 },
  batteryMin: { lo: 10, loLo: 5, unit: "min", deadband: 1, delay: 5 },
};

/* ---------------- 测点工厂 ---------------- */
let seq = 0;
const mk = (devId, key, name, o) => Object.assign({
  id: devId + "." + key, devId, key, name,
  kind: "ai", scale: 1, addr: null, oid: null, mqtt: null,
  reg: "holding", dtype: "uint16",
}, o);
const bit = (devId, key, name, o) => mk(devId, key, name, Object.assign({ kind: "di", normal: 0, bits: { 0: "正常", 1: "报警" } }, o));

function upsPoints(id, prefix) {
  const p = [];
  ["A", "B", "C"].forEach((ph, i) => {
    p.push(mk(id, "UA" + ph, ph + " 相输入电压", Object.assign({}, T.voltPhase, { scale: 0.1, addr: 40001 + i * 2, oid: "1.3.6.1.4.1.10001.1.1." + i })));
    p.push(mk(id, "IA" + ph, ph + " 相输入电流", Object.assign({}, T.current, { scale: 0.1, addr: 40007 + i * 2, oid: "1.3.6.1.4.1.10001.1.2." + i })));
    p.push(mk(id, "UO" + ph, ph + " 相输出电压", Object.assign({}, T.voltPhase, { scale: 0.1, addr: 40013 + i * 2, oid: "1.3.6.1.4.1.10001.1.3." + i })));
    p.push(mk(id, "IO" + ph, ph + " 相输出电流", Object.assign({}, T.current, { scale: 0.1, addr: 40019 + i * 2, oid: "1.3.6.1.4.1.10001.1.4." + i })));
  });
  p.push(mk(id, "UAB_L", "线电压 UAB", Object.assign({}, T.volt380, { scale: 0.1, addr: 40025, oid: "1.3.6.1.4.1.10001.1.5.0" })));
  p.push(mk(id, "fIn", "输入频率", Object.assign({}, T.freq, { scale: 0.01, addr: 40026, oid: "1.3.6.1.4.1.10001.1.6.0" })));
  p.push(mk(id, "load", "负载率", { unit: "%", scale: 0.1, addr: 40027, oid: "1.3.6.1.4.1.10001.1.7.0", hi: 85, hiHi: 95, lo: 5, deadband: 1, delay: 10 }));
  p.push(mk(id, "pOut", "输出有功功率", { unit: "kW", scale: 0.01, addr: 40028, oid: "1.3.6.1.4.1.10001.1.8.0", hi: 170, hiHi: 190, deadband: 2, delay: 10 }));
  p.push(mk(id, "batV", "电池组电压", Object.assign({}, T.batVolt, { scale: 0.1, addr: 40029, oid: "1.3.6.1.4.1.10001.1.9.0" })));
  p.push(mk(id, "batI", "电池充放电电流", { unit: "A", scale: 0.1, addr: 40030, oid: "1.3.6.1.4.1.10001.1.10.0", hi: 60, hiHi: 80, lo: -60, loLo: -80, deadband: 2, delay: 5 }));
  p.push(mk(id, "batMin", "后备时间", Object.assign({}, T.batteryMin, { scale: 0.1, addr: 40031, oid: "1.3.6.1.4.1.10001.1.11.0" })));
  p.push(mk(id, "temp", "机内温度", Object.assign({}, T.temp, { addr: 40032, oid: "1.3.6.1.4.1.10001.1.12.0" })));
  p.push(bit(id, "stIn", "输入开关", { addr: 40101, oid: "1.3.6.1.4.1.10001.2.1.0", bits: { 0: "闭合", 1: "断开" } }));
  p.push(bit(id, "stOut", "输出开关", { addr: 40102, oid: "1.3.6.1.4.1.10001.2.2.0", bits: { 0: "闭合", 1: "断开" } }));
  p.push(bit(id, "bypass", "旁路供电", { addr: 40103, oid: "1.3.6.1.4.1.10001.2.3.0", bits: { 0: "逆变供电", 1: "旁路供电" } }));
  p.push(bit(id, "fault", "整流器故障", { addr: 40104, oid: "1.3.6.1.4.1.10001.2.4.0" }));
  p.push(bit(id, "faultInv", "逆变器故障", { addr: 40105, oid: "1.3.6.1.4.1.10001.2.5.0" }));
  p.push(bit(id, "faultBat", "电池故障", { addr: 40106, oid: "1.3.6.1.4.1.10001.2.6.0" }));
  p.push(bit(id, "faultByp", "旁路故障", { addr: 40107, oid: "1.3.6.1.4.1.10001.2.7.0" }));
  p.push(bit(id, "onBatt", "电池放电中", { addr: 40108, oid: "1.3.6.1.4.1.10001.2.8.0" }));
  p.push(bit(id, "gen", "油机联动信号", { addr: 40109, oid: "1.3.6.1.4.1.10001.2.9.0" }));
  return p;
}

function acPoints(id) {
  const p = [];
  p.push(mk(id, "retT", "回风温度", Object.assign({}, T.temp, { scale: 0.1, addr: 41001 })));
  p.push(mk(id, "retH", "回风湿度", Object.assign({}, T.humidity, { scale: 0.1, addr: 41002 })));
  p.push(mk(id, "supT", "送风温度", Object.assign({}, T.temp, { scale: 0.1, addr: 41003 })));
  p.push(mk(id, "setT", "设定温度", { unit: "℃", scale: 0.1, addr: 41004 }));
  p.push(mk(id, "setH", "设定湿度", { unit: "%RH", scale: 0.1, addr: 41005 }));
  p.push(mk(id, "cool", "制冷量", { unit: "kW", scale: 0.1, addr: 41006 }));
  p.push(mk(id, "fan", "风机转速", { unit: "%", scale: 1, addr: 41007, hi: 95, deadband: 2, delay: 10 }));
  p.push(mk(id, "valve", "冷冻水阀开度", { unit: "%", scale: 1, addr: 41008 }));
  p.push(bit(id, "stComp", "压缩机运行", { addr: 41101, bits: { 0: "停止", 1: "运行" }, statusOnly: true }));
  p.push(bit(id, "stFan", "风机运行", { addr: 41102, bits: { 0: "停止", 1: "运行" }, statusOnly: true }));
  p.push(bit(id, "stHeat", "加热器", { addr: 41103, bits: { 0: "停止", 1: "运行" }, statusOnly: true }));
  p.push(bit(id, "stHum", "加湿器", { addr: 41104, bits: { 0: "停止", 1: "运行" }, statusOnly: true }));
  p.push(bit(id, "almFilter", "滤网堵塞", { addr: 41105 }));
  p.push(bit(id, "almHP", "高压报警", { addr: 41106 }));
  p.push(bit(id, "almLP", "低压报警", { addr: 41107 }));
  p.push(bit(id, "almWater", "漏水报警", { addr: 41108 }));
  return p;
}

function thPoints(id, where) {
  const p = [];
  p.push(mk(id, "temp", (where || "") + "温度", Object.assign({}, T.tempRack, { scale: 0.1, addr: 42001 })));
  p.push(mk(id, "hum", (where || "") + "湿度", Object.assign({}, T.humidity, { scale: 0.1, addr: 42002 })));
  p.push(mk(id, "dew", (where || "") + "露点", { unit: "℃", scale: 0.1, addr: 42003, hi: 20, hiHi: 23, deadband: 0.5, delay: 30 }));
  p.push(bit(id, "online", "通信状态", { addr: 42101, bits: { 0: "在线", 1: "离线" } }));
  return p;
}

function waterPoints(id, chans, rope) {
  const p = [];
  for (let i = 1; i <= chans; i++) {
    p.push(bit(id, "ch" + i, (rope ? "绳式" : "点式") + i + " 路浸水", { addr: 43000 + i, bits: { 0: "正常", 1: "浸水报警" } }));
  }
  if (rope) p.push(bit(id, "ropeBreak", "感应绳断线", { addr: 43090, bits: { 0: "正常", 1: "断线" } }));
  p.push(bit(id, "online", "通信状态", { addr: 43101, bits: { 0: "在线", 1: "离线" } }));
  return p;
}

function smokePoints(id) {
  const p = [];
  p.push(bit(id, "state", "烟雾报警", { addr: 44001, bits: { 0: "正常", 1: "报警" } }));
  p.push(bit(id, "fault", "探头故障", { addr: 44002 }));
  p.push(mk(id, "pollution", "污染度", Object.assign({}, T.pollution, { addr: 44003 })));
  p.push(mk(id, "voltage", "供电电压", { unit: "V", scale: 0.1, addr: 44004, lo: 18, loLo: 15, deadband: 0.5, delay: 60 }));
  return p;
}

function mdbPoints(id) {
  const p = [];
  ["A", "B", "C"].forEach((ph, i) => {
    p.push(mk(id, "UP" + ph, ph + " 相电压", Object.assign({}, T.voltPhase, { scale: 0.1, addr: 45001 + i })));
    p.push(mk(id, "I" + ph, ph + " 相电流", Object.assign({}, T.current, { scale: 0.1, addr: 45005 + i })));
  });
  p.push(mk(id, "P", "有功功率", { unit: "kW", scale: 0.01, addr: 45010, hi: 90, hiHi: 110, deadband: 1, delay: 10 }));
  p.push(mk(id, "PF", "功率因数", Object.assign({}, T.pf, { scale: 0.01, addr: 45011 })));
  p.push(mk(id, "E", "有功电能", { unit: "kWh", scale: 0.1, addr: 45012 }));
  p.push(mk(id, "f", "频率", Object.assign({}, T.freq, { scale: 0.01, addr: 45013 })));
  p.push(bit(id, "brk", "断路器位置", { addr: 45101, bits: { 0: "合闸", 1: "分闸" } }));
  p.push(bit(id, "almOver", "过流报警", { addr: 45102 }));
  p.push(bit(id, "almUnder", "欠压报警", { addr: 45103 }));
  p.push(bit(id, "almOverV", "过压报警", { addr: 45104 }));
  p.push(bit(id, "almPhase", "缺相报警", { addr: 45105 }));
  return p;
}

function batPoints(id) {
  const p = [];
  p.push(mk(id, "U", "组电压", Object.assign({}, T.batVolt, { scale: 0.1, addr: 46001 })));
  p.push(mk(id, "I", "充放电电流", { unit: "A", scale: 0.1, addr: 46002, hi: 60, hiHi: 80, lo: -60, loLo: -80, deadband: 2, delay: 5 }));
  p.push(mk(id, "dT", "单体温差", { unit: "℃", scale: 0.1, addr: 46003, hi: 3, hiHi: 5, deadband: 0.2, delay: 60 }));
  p.push(mk(id, "rInt", "内阻均值", { unit: "mΩ", scale: 0.01, addr: 46004, hi: 2.5, hiHi: 3.2, deadband: 0.05, delay: 300 }));
  p.push(mk(id, "soh", "健康度 SOH", { unit: "%", scale: 0.1, addr: 46005, lo: 80, loLo: 70, deadband: 1, delay: 300 }));
  p.push(mk(id, "soc", "剩余电量 SOC", { unit: "%", scale: 0.1, addr: 46006, lo: 30, loLo: 20, deadband: 1, delay: 60 }));
  p.push(mk(id, "temp", "环境温度", Object.assign({}, T.temp, { addr: 46007 })));
  p.push(bit(id, "almCell", "单体过压/欠压", { addr: 46101 }));
  return p;
}

function atsPoints(id) {
  const p = [];
  p.push(mk(id, "Umain", "主电源电压", Object.assign({}, T.volt380, { scale: 0.1, addr: 47001 })));
  p.push(mk(id, "Ubak", "备用电源电压", Object.assign({}, T.volt380, { scale: 0.1, addr: 47002 })));
  p.push(mk(id, "cnt", "切换次数", { unit: "次", scale: 1, addr: 47003 }));
  p.push(mk(id, "Uout", "输出电压", Object.assign({}, T.volt380, { scale: 0.1, addr: 47004 })));
  p.push(bit(id, "pos", "当前工位", { addr: 47101, bits: { 0: "主电源", 1: "备用电源" } }));
  p.push(bit(id, "stMain", "主电源可用", { addr: 47102, bits: { 0: "可用", 1: "失电" } }));
  p.push(bit(id, "stBak", "备用电源可用", { addr: 47103, bits: { 0: "可用", 1: "失电" } }));
  p.push(bit(id, "alm", "切换故障", { addr: 47104 }));
  return p;
}

/* ---------------- 设备清单（loc.place 交给 3D 层映射成坐标） ---------------- */
const D = (o) => Object.assign({ online: true, lastRt: 8, protocol: "modbus-tcp", slaveId: 1 }, o);
export const DEVICES = [
  D({ id: "UPS-01", name: "A 区 UPS-01", type: "ups", zone: "电力间", vendor: "华为", model: "UPS5000-E 200kVA",
      ip: "10.20.1.11", port: 502, slaveId: 1, place: { kind: "power-room", idx: 0 }, ratedKW: 200 }),
  D({ id: "UPS-02", name: "B 区 UPS-02", type: "ups", zone: "电力间", vendor: "华为", model: "UPS5000-E 200kVA",
      ip: "10.20.1.12", port: 502, slaveId: 2, place: { kind: "power-room", idx: 1 }, ratedKW: 200 }),
  D({ id: "AC-01", name: "A 区精密空调 01", type: "ac", zone: "A 区", vendor: "维谛", model: "PEX4 25kW",
      ip: "10.20.2.21", port: 502, slaveId: 1, place: { kind: "wall-side", idx: 0 }, ratedKW: 25 }),
  D({ id: "AC-02", name: "B 区精密空调 02", type: "ac", zone: "B 区", vendor: "维谛", model: "PEX4 25kW",
      ip: "10.20.2.22", port: 502, slaveId: 1, place: { kind: "wall-side", idx: 1 }, ratedKW: 25 }),
  D({ id: "MDB-1", name: "1# 低压配电柜", type: "mdb", zone: "电力间", vendor: "施耐德", model: "B柜 400A",
      ip: "10.20.3.11", port: 502, slaveId: 1, place: { kind: "power-room", idx: 2 } }),
  D({ id: "MDB-2", name: "2# 列头柜", type: "mdb", zone: "电力间", vendor: "施耐德", model: "列头柜 250A",
      ip: "10.20.3.12", port: 502, slaveId: 1, place: { kind: "power-room", idx: 3 } }),
  D({ id: "BAT-01", name: "UPS 电池组 01", type: "battery", zone: "电力间", vendor: "双登", model: "12V100Ah×40",
      ip: "10.20.3.31", port: 502, slaveId: 1, place: { kind: "power-room", idx: 4 } }),
  D({ id: "ATS-01", name: "市电 ATS 双电源", type: "ats", zone: "电力间", vendor: "ABB", model: "OTM 400A",
      ip: "10.20.3.41", port: 502, slaveId: 1, place: { kind: "power-room", idx: 5 } }),
];
// 温湿度：A/B 区各排首尾 + 电力间
[["A", 1], ["A", 2], ["B", 1], ["B", 2], ["C", 1], ["C", 2]].forEach(([row, i]) => {
  DEVICES.push(D({ id: "TH-" + row + "0" + i, name: row + " 排温湿度 0" + i, type: "th", zone: row + " 区",
    vendor: "昆仑海岸", model: "JWSK-6", protocol: "modbus-rtu", ip: "COM3", port: 9600, slaveId: row.charCodeAt(0) - 60,
    place: { kind: "rack-front", row, idx: i === 1 ? 0 : 6 } }));
});
DEVICES.push(D({ id: "TH-PW1", name: "电力间温湿度", type: "th", zone: "电力间", vendor: "昆仑海岸", model: "JWSK-6",
  protocol: "modbus-rtu", ip: "COM3", port: 9600, slaveId: 9, place: { kind: "power-room", idx: 6 } }));
// 浸水：4 条绳式（冷通道两端）+ 8 个点式
[["A", 1], ["A", 2], ["B", 1], ["B", 2]].forEach(([row, i]) => {
  DEVICES.push(D({ id: "WD-" + row + i, name: row + " 区冷通道浸水" + (i === 1 ? "东" : "西"), type: "water", zone: row + " 区",
    vendor: "科星", model: "KX-RS 绳式 6 路", ip: "10.20.4." + (10 + i), port: 502, slaveId: 1, rope: true,
    place: { kind: "aisle-end", row, idx: i === 1 ? 1 : 0 } }));
});
for (let i = 1; i <= 8; i++) {
  DEVICES.push(D({ id: "WD-P" + i, name: "电力间/墙脚浸水点 " + i, type: "water", zone: "电力间",
    vendor: "科星", model: "KX-PS 点式", ip: "10.20.4." + (20 + i), port: 502, slaveId: 1, rope: false,
    place: { kind: "floor", idx: i } }));
}
// 烟感：吊顶 12 点
for (let i = 1; i <= 12; i++) {
  DEVICES.push(D({ id: "SM-" + String(i).padStart(2, "0"), name: "烟感探测器 " + String(i).padStart(2, "0"), type: "smoke",
    zone: i <= 4 ? "A 区" : i <= 8 ? "B 区" : "C 区", vendor: "海湾", model: "JTY-GD-G3",
    protocol: "modbus-tcp", ip: "10.20.5." + (10 + i), port: 502, slaveId: 1,
    place: { kind: "ceiling", grid: i } }));
}

/* ---------------- 点表 ---------------- */
export const POINTS = [];
DEVICES.forEach((d) => {
  let ps = [];
  if (d.type === "ups") ps = upsPoints(d.id, d.id);
  else if (d.type === "ac") ps = acPoints(d.id);
  else if (d.type === "th") ps = thPoints(d.id, d.name);
  else if (d.type === "water") ps = waterPoints(d.id, d.rope ? 6 : 1, d.rope);
  else if (d.type === "smoke") ps = smokePoints(d.id);
  else if (d.type === "mdb") ps = mdbPoints(d.id);
  else if (d.type === "battery") ps = batPoints(d.id);
  else if (d.type === "ats") ps = atsPoints(d.id);
  d.points = ps.map((p) => p.id);
  ps.forEach((p) => { if (!p.mqtt) p.mqtt = "idc/" + d.type + "/" + d.id + "/" + p.key; POINTS.push(p); });
});

/* ---------------- 便捷索引 ---------------- */
// 自检：点号必须唯一（撞号会让 Map 丢点、对点表出错）
(() => {
  const seen = new Set(), dup = [];
  POINTS.forEach((p) => { if (seen.has(p.id)) dup.push(p.id); else seen.add(p.id); });
  if (dup.length) console.error("[pointtable] 重复点号:", dup.join(", "));
  const dSeen = new Set(), dDup = [];
  DEVICES.forEach((d) => { if (dSeen.has(d.id)) dDup.push(d.id); else dSeen.add(d.id); });
  if (dDup.length) console.error("[pointtable] 重复设备号:", dDup.join(", "));
})();

export const DEVICE_BY_ID = Object.fromEntries(DEVICES.map((d) => [d.id, d]));
export const POINT_BY_ID = Object.fromEntries(POINTS.map((p) => [p.id, p]));
export const pointsOf = (devId) => POINTS.filter((p) => p.devId === devId);
export const devicesByType = (type) => DEVICES.filter((d) => d.type === type);
export function pointTable() {
  return POINTS.map((p) => ({
    devId: p.devId, devName: DEVICE_BY_ID[p.devId].name, devType: DEVICE_BY_ID[p.devId].type,
    protocol: DEVICE_BY_ID[p.devId].protocol, pointId: p.id, name: p.name, kind: p.kind,
    addr: p.addr == null ? "" : p.addr, dtype: p.dtype, scale: p.scale, unit: p.unit,
    oid: p.oid || "", mqtt: p.mqtt || "", hi: p.hi != null ? p.hi : "", hiHi: p.hiHi != null ? p.hiHi : "",
    lo: p.lo != null ? p.lo : "", loLo: p.loLo != null ? p.loLo : "", deadband: p.deadband != null ? p.deadband : "",
    delay: p.delay != null ? p.delay : "", normal: p.kind === "di" ? p.normal : "",
  }));
}
export function pointTableCsv() {
  const rows = pointTable();
  const head = ["设备编号", "设备名称", "设备类型", "协议", "测点编号", "测点名称", "类型", "寄存器", "数据类型", "缩放", "单位", "SNMP OID", "MQTT Topic", "高限", "高高限", "低限", "低低限", "回差", "延时(s)", "正常值"];
  const lines = [head.join(",")];
  rows.forEach((r) => lines.push([r.devId, r.devName, r.devType, r.protocol, r.pointId, r.name,
    r.kind === "ai" ? "模拟量" : r.kind === "di" ? "状态量" : "控制量", r.addr, r.dtype, r.scale, r.unit,
    r.oid, r.mqtt, r.hi, r.hiHi, r.lo, r.loLo, r.deadband, r.delay, r.normal]
    .map((v) => (typeof v === "string" && v.indexOf(",") >= 0 ? '"' + v + '"' : v)).join(",")));
  return lines.join("\n");
}
export default { SITE, DEVICES, POINTS, DEVICE_BY_ID, POINT_BY_ID, pointsOf, devicesByType, pointTable, pointTableCsv };