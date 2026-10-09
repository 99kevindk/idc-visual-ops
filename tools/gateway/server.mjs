/* =========================================================================
 * tools/gateway/server.mjs — 动环南向采集网关入口（纯 Node 标准库，零依赖）
 *
 *   启动：node tools/gateway/server.mjs --port 8124 --driver sim [--poll 2000]
 *
 *   - 南向：sim / modbus-tcp / modbus-rtu / snmp / mqtt / http-json 驱动
 *   - 北向：WebSocket ws://<host>:<port>/dh（hello/data/status/alarm/event）
 *           HTTP     /dh/{health,points,points.csv,snapshot,alarms,inject,driver}
 *   - 采集主循环 + 报警引擎（规范 §1.3），点表唯一数据源 src/pointtable.js
 * ========================================================================= */
import http from "node:http";
import * as PT from "../../src/pointtable.js";
import { WebSocketServer } from "./ws.mjs";
import { AlarmEngine, LEVEL_RANK } from "./alarms.mjs";
import { createSimDriver } from "./drivers/sim.mjs";
import { createModbusDriver } from "./drivers/modbus-tcp.mjs";
import { createSnmpDriver } from "./drivers/snmp.mjs";
import { createMqttDriver } from "./drivers/mqtt.mjs";
import { createHttpJsonDriver } from "./drivers/http-json.mjs";

export const GW_VERSION = "dh-gw/1.0";
export const DRIVER_NAMES = ["sim", "modbus-tcp", "modbus-rtu", "snmp", "mqtt", "http-json"];

/* ------------------------------ 命令行参数 ------------------------------ */
export function parseArgs(argv = process.argv.slice(2)) {
  const o = { port: 8124, driver: "sim", poll: PT.SITE.pollInterval || 2000, host: "0.0.0.0" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--port" || a === "-p") o.port = Number(next());
    else if (a === "--driver" || a === "-d") o.driver = String(next());
    else if (a === "--poll") o.poll = Number(next());
    else if (a === "--host") o.host = String(next());
    else if (a === "--mqtt") o.mqtt = String(next());
    else if (a === "--snmp-community") o.snmpCommunity = String(next());
    else if (a === "--http-token") o.httpToken = String(next());
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

export function usage() {
  return [
    "用法: node tools/gateway/server.mjs [选项]",
    "  --port <n>               HTTP/WS 监听端口（默认 8124）",
    "  --driver <name>          采集驱动（默认 sim）",
    "  --poll <ms>              采集周期毫秒（默认 2000）",
    "  --host <ip>              监听地址（默认 0.0.0.0）",
    "  --mqtt <host:port>       MQTT Broker（默认 127.0.0.1:1883）",
    "  --snmp-community <s>     SNMP community（默认 public）",
    "  --http-token <token>     厂家 HTTP-JSON 接口 Bearer Token",
    "  --help                   显示帮助",
    "  可用驱动: " + DRIVER_NAMES.join(", "),
  ].join("\n");
}

/* ------------------------------ 网关运行状态 ------------------------------ */
export function createGateway(args) {
  const state = {
    args,
    startTs: Date.now(),
    driverName: args.driver,
    driver: null,
    seq: 0,
    polling: false,
    values: {},
    quality: {},
    deviceStatus: {},
    lastSent: {},
    lastStatus: {},
    lastPollTs: 0,
    lastPollMs: 0,
    errors: 0,
    events: [],
  };

  const log = (...a) => console.log("[" + new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "]", ...a);

  /* ---------------- 报警引擎 ---------------- */
  const engine = new AlarmEngine({
    devices: PT.DEVICES,
    points: PT.POINTS,
    offlineAfter: PT.SITE.offlineAfter || 30000,
  });

  /* ---------------- WebSocket 服务 ---------------- */
  const wss = new WebSocketServer({ paths: ["/dh", "/"], heartbeatMs: 30000 });

  const broadcast = (obj) => wss.broadcast(typeof obj === "string" ? obj : JSON.stringify(obj));

  function pushEvent(kind, text) {
    const frame = { type: "event", t: Date.now(), event: { kind, text } };
    state.events.push(frame.event);
    if (state.events.length > 100) state.events.shift();
    broadcast(frame);
    return frame;
  }

  /* ---------------- 驱动装配 ---------------- */
  function buildDriverOptions() {
    const opts = {};
    if (args.mqtt) {
      const [h, p] = String(args.mqtt).split(":");
      opts.mqttHost = h; opts.mqttPort = Number(p) || 1883;
    }
    if (args.snmpCommunity) opts.snmpCommunity = args.snmpCommunity;
    if (args.httpToken) opts.httpToken = args.httpToken;
    return opts;
  }

  function createDriver(name) {
    const ctx = {
      devices: PT.DEVICES, points: PT.POINTS, site: PT.SITE,
      log, emit: (e) => pushEvent(e.kind || "info", e.text || ""),
      options: buildDriverOptions(),
    };
    switch (name) {
      case "sim": return createSimDriver(ctx);
      case "modbus-tcp":
      case "modbus-rtu": return createModbusDriver(Object.assign({}, ctx, { options: { timeout: 1500 } }));
      case "snmp": return createSnmpDriver(Object.assign({}, ctx, { options: { community: args.snmpCommunity || "public", timeout: 1500 } }));
      case "mqtt": return createMqttDriver(Object.assign({}, ctx, { options: { host: buildDriverOptions().mqttHost, port: buildDriverOptions().mqttPort, timeout: 2000 } }));
      case "http-json": return createHttpJsonDriver(Object.assign({}, ctx, { options: { timeout: 2000, token: args.httpToken } }));
      default: return null;
    }
  }

  async function switchDriver(name, { quiet = false } = {}) {
    if (!DRIVER_NAMES.includes(name)) throw new Error("未知驱动 " + name + "（可用：" + DRIVER_NAMES.join(", ") + "）");
    const prev = state.driverName;
    if (state.driver) { try { await state.driver.stop(); } catch (e) { log("旧驱动停止异常:", e.message); } }
    state.driverName = name;
    state.driver = createDriver(name);
    state.values = {}; state.quality = {}; state.lastSent = {}; state.lastStatus = {};
    if (!quiet && prev !== name) pushEvent("info", "驱动切换：" + prev + " -> " + name);
    if (!state.driver) throw new Error("驱动 " + name + " 创建失败");
    try {
      await state.driver.start();
    } catch (e) {
      state.errors++;
      pushEvent("error", "驱动启动失败：" + name + " -> " + e.message);
    }
    return state.driver;
  }
  /* ---------------- 报文构造 ---------------- */
  function deviceList() {
    return PT.DEVICES.map((d) => {
      const st = state.deviceStatus[d.id];
      return {
        id: d.id, name: d.name, type: d.type, zone: d.zone, vendor: d.vendor, model: d.model,
        protocol: d.protocol, ip: d.ip, port: d.port, slaveId: d.slaveId, ratedKW: d.ratedKW,
        online: st ? !!st.online : !!d.online,
        lastRt: st ? (st.rt || 0) : (d.lastRt || 0),
        reason: st && st.reason ? st.reason : undefined,
        loc: d.place || null,
        points: d.points,
      };
    });
  }

  function helloFrame() {
    return {
      type: "hello", gw: GW_VERSION, site: PT.SITE.name, t: Date.now(),
      devices: deviceList(), points: PT.POINTS, driver: state.driverName,
      poll: { interval: args.poll }, protocols: DRIVER_NAMES,
      pointCount: PT.POINTS.length, deviceCount: PT.DEVICES.length,
    };
  }

  function buildDataFrame({ full = false } = {}) {
    const values = {};
    const quality = {};
    for (const [id, v] of Object.entries(state.values)) {
      if (full || state.lastSent[id] !== v) {
        values[id] = v;
        quality[id] = state.quality[id] || "good";
      }
    }
    state.lastSent = Object.assign({}, state.values);
    return { type: "data", t: Date.now(), seq: state.seq, values, quality, full };
  }

  function buildStatusFrame() {
    const devices = {};
    const changed = {};
    for (const d of PT.DEVICES) {
      const st = state.deviceStatus[d.id] || { online: true, rt: 0 };
      devices[d.id] = { online: !!st.online, rt: st.rt || 0 };
      const prev = state.lastStatus[d.id];
      if (!prev || prev.online !== devices[d.id].online) changed[d.id] = devices[d.id];
    }
    state.lastStatus = devices;
    return Object.keys(changed).length ? { type: "status", t: Date.now(), devices: changed } : null;
  }

  /* ---------------- 采集主循环 ---------------- */
  function markOfflinePoints() {
    for (const [devId, st] of Object.entries(state.deviceStatus)) {
      if (st.online) continue;
      const dev = PT.DEVICE_BY_ID[devId];
      if (!dev) continue;
      for (const pid of dev.points) { delete state.values[pid]; delete state.quality[pid]; }
    }
  }

  async function runPoll() {
    if (state.polling) return null;
    state.polling = true;
    const t0 = Date.now();
    try {
      const res = (await state.driver.poll()) || {};
      state.lastPollMs = Date.now() - t0;
      state.lastPollTs = Date.now();
      Object.assign(state.values, res.values || {});
      Object.assign(state.quality, res.quality || {});
      const ds = res.devices || {};
      for (const d of PT.DEVICES) {
        const st = ds[d.id];
        if (st) state.deviceStatus[d.id] = { online: !!st.online, rt: st.rt || 0, reason: st.reason };
        else if (!state.deviceStatus[d.id]) state.deviceStatus[d.id] = { online: true, rt: 0 };
      }
      markOfflinePoints();
      const changes = engine.update(state.values, state.quality, state.deviceStatus, state.lastPollTs);
      state.seq++;
      const data = buildDataFrame({ full: state.seq % 10 === 0 });
      broadcast(data);
      const stf = buildStatusFrame();
      if (stf) broadcast(stf);
      return { changes, data };
    } catch (e) {
      state.errors++;
      log("采集异常:", e.message);
      pushEvent("error", "采集异常：" + e.message);
      return null;
    } finally {
      state.polling = false;
    }
  }

  /* ---------------- 报警回调 ---------------- */
  engine.onAlarm = (alarm) => {
    broadcast({ type: "alarm", t: Date.now(), alarm });
    log("报警", alarm.state === "cleared" ? "恢复" : "产生", "[" + alarm.level + "]", alarm.text, "=", alarm.value == null ? "-" : alarm.value);
  };

  /* ---------------- HTTP 工具 ---------------- */
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
  };

  function sendJson(res, obj, status = 200) {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length }, CORS));
    res.end(body);
  }

  function sendText(res, text, contentType = "text/plain; charset=utf-8", status = 200) {
    const body = Buffer.from(text, "utf8");
    res.writeHead(status, Object.assign({ "Content-Type": contentType, "Content-Length": body.length }, CORS));
    res.end(body);
  }

  function readBody(req, limit = 1e6) {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c) => { data += c; if (data.length > limit) { reject(new Error("请求体过大")); req.destroy(); } });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  async function readJson(req) {
    const raw = await readBody(req);
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (e) { throw new Error("请求体不是合法 JSON"); }
  }

  function health() {
    const online = PT.DEVICES.filter((d) => (state.deviceStatus[d.id] ? state.deviceStatus[d.id].online : true)).length;
    const drvStatus = state.driver && state.driver.status ? safe(() => state.driver.status()) : null;
    return {
      ok: true, gw: GW_VERSION, site: PT.SITE.name,
      driver: state.driverName, driverState: state.driver ? state.driver.state : "idle",
      uptime: Math.round((Date.now() - state.startTs) / 1000),
      poll: args.poll, interval: args.poll,
      devices: PT.DEVICES.length, points: PT.POINTS.length,
      online, offline: PT.DEVICES.length - online,
      clients: wss.size, errors: state.errors,
      seq: state.seq, lastPoll: state.lastPollTs, lastPollMs: state.lastPollMs,
      activeAlarms: engine.active().length, alarmStats: engine.stats(),
      protocols: DRIVER_NAMES, driverStatus: drvStatus,
      startedAt: new Date(state.startTs).toISOString(),
      t: Date.now(),
    };
  }

  function safe(fn) { try { return fn(); } catch (e) { return { error: e.message }; } }

  function snapshot() {
    const online = {};
    for (const d of PT.DEVICES) online[d.id] = state.deviceStatus[d.id] ? !!state.deviceStatus[d.id].online : true;
    return { t: Date.now(), values: state.values, quality: state.quality, online, count: Object.keys(state.values).length };
  }

  function pointsJson() {
    return {
      ok: true, t: Date.now(), site: PT.SITE.name,
      deviceCount: PT.DEVICES.length, pointCount: PT.POINTS.length,
      devices: PT.DEVICES.map((d) => ({ id: d.id, name: d.name, type: d.type, zone: d.zone, protocol: d.protocol, ip: d.ip, port: d.port, slaveId: d.slaveId })),
      points: PT.POINTS,
    };
  }
  /* ---------------- HTTP 路由 ---------------- */
  const API_LIST = ["GET /dh/health", "GET /dh/points", "GET /dh/points.csv", "GET /dh/snapshot", "GET /dh/alarms", "POST /dh/inject", "POST /dh/driver", "POST /dh/alarm"];

  async function handleRequest(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = (req.method || "GET").toUpperCase();
    if (method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    try {
      if (method === "GET" && (path === "/" || path === "/dh")) {
        return sendJson(res, { ok: true, gw: GW_VERSION, site: PT.SITE.name, driver: state.driverName, ws: "/dh", endpoints: API_LIST, protocols: DRIVER_NAMES });
      }
      if (method === "GET" && path === "/dh/health") return sendJson(res, health());
      if (method === "GET" && path === "/dh/points") {
        if ((url.searchParams.get("format") || "") === "csv") return sendText(res, "\ufeff" + PT.pointTableCsv(), "text/csv; charset=utf-8");
        return sendJson(res, pointsJson());
      }
      if (method === "GET" && (path === "/dh/points.csv" || path === "/dh/points/csv")) {
        return sendText(res, "\ufeff" + PT.pointTableCsv(), "text/csv; charset=utf-8");
      }
      if (method === "GET" && path === "/dh/snapshot") return sendJson(res, snapshot());
      if (method === "GET" && path === "/dh/alarms") {
        const alarms = engine.active();
        return sendJson(res, { ok: true, t: Date.now(), count: alarms.length, alarms });
      }
      if (method === "POST" && path === "/dh/inject") {
        if (!state.driver || typeof state.driver.inject !== "function") {
          return sendJson(res, { ok: false, error: "当前驱动 " + state.driverName + " 不支持注入（请切换到 sim）", driver: state.driverName }, 400);
        }
        const body = await readJson(req);
        const r = state.driver.inject(body);
        if (!r || !r.ok) return sendJson(res, { ok: false, error: (r && r.error) || "注入失败" }, 400);
        pushEvent("inject", r.text || "演示注入成功");
        await runPoll();
        return sendJson(res, Object.assign({ ok: true, t: Date.now(), driver: state.driverName }, r));
      }
      if (method === "POST" && path === "/dh/driver") {
        const body = await readJson(req);
        const name = String(body.driver || "").trim();
        if (!name) return sendJson(res, { ok: false, error: "缺少 driver 字段", available: DRIVER_NAMES }, 400);
        if (!DRIVER_NAMES.includes(name)) return sendJson(res, { ok: false, error: "未知驱动 " + name, available: DRIVER_NAMES }, 400);
        if (name === state.driverName && state.driver) return sendJson(res, { ok: true, t: Date.now(), driver: name, note: "驱动未变化", state: state.driver.state });
        await switchDriver(name);
        await runPoll();
        return sendJson(res, { ok: true, t: Date.now(), driver: name, state: state.driver ? state.driver.state : "idle", available: DRIVER_NAMES });
      }
      if (method === "POST" && path === "/dh/alarm") {
        const body = await readJson(req);
        const action = String(body.action || "ack");
        const a = action === "clear" ? engine.forceClear(body.id) : engine.ack(body.id);
        if (!a) return sendJson(res, { ok: false, error: "未找到活动报警 " + body.id }, 404);
        return sendJson(res, { ok: true, t: Date.now(), action, alarm: a });
      }
      return sendJson(res, { ok: false, error: "未找到接口 " + method + " " + path, endpoints: API_LIST }, 404);
    } catch (e) {
      state.errors++;
      return sendJson(res, { ok: false, error: e.message }, 400);
    }
  }

  /* ---------------- HTTP / WebSocket 服务 ---------------- */
  const server = http.createServer((req, res) => { handleRequest(req, res); });
  wss.attach(server);

  wss.on("connection", (conn, req) => {
    try {
      conn.sendJson(helloFrame());
      if (Object.keys(state.values).length) conn.sendJson(buildDataFrame({ full: true }));
      for (const a of engine.active()) conn.sendJson({ type: "alarm", t: Date.now(), alarm: a });
      pushEvent("connect", "客户端接入 " + conn.remote + (conn.path ? " (" + conn.path + ")" : ""));
    } catch (e) { log("WS 建链下发失败:", e.message); }
    conn.on("message", async (raw, isBinary) => {
      if (isBinary) return;
      let msg; try { msg = JSON.parse(raw.toString("utf8")); } catch (e) { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ping") return conn.sendJson({ type: "pong", t: Date.now() });
      if (msg.type === "inject") {
        if (!state.driver || typeof state.driver.inject !== "function") return conn.sendJson({ type: "inject:result", ok: false, error: "当前驱动不支持注入" });
        const r = state.driver.inject(msg.payload || msg);
        if (r && r.ok) { pushEvent("inject", r.text || "演示注入成功"); runPoll(); }
        return conn.sendJson({ type: "inject:result", t: Date.now(), ok: !!(r && r.ok), result: r });
      }
      if (msg.type === "ack" && msg.id) return conn.sendJson({ type: "alarm:ack", alarm: engine.ack(msg.id) });
      if (msg.type === "clear" && msg.id) return conn.sendJson({ type: "alarm:clear", alarm: engine.forceClear(msg.id) });
    });
    conn.on("error", () => {});
  });

  /* ---------------- 启停 ---------------- */
  let timer = null;

  function banner() {
    const host = args.host === "0.0.0.0" ? "localhost" : args.host;
    const lines = [
      "============================================================",
      "  动环南向采集网关  " + GW_VERSION + "  (纯 Node 标准库，零依赖)",
      "------------------------------------------------------------",
      "  站点      : " + PT.SITE.name,
      "  HTTP      : http://" + host + ":" + args.port + "/dh/health",
      "  WebSocket : ws://" + host + ":" + args.port + "/dh",
      "  驱动      : " + state.driverName + "      采集周期: " + args.poll + " ms",
      "  设备/测点 : " + PT.DEVICES.length + " 台 / " + PT.POINTS.length + " 个",
      "  可用驱动  : " + DRIVER_NAMES.join(", "),
      "  启动时间  : " + new Date().toLocaleString("zh-CN", { hour12: false }),
      "============================================================",
    ];
    console.log("\n" + lines.join("\n") + "\n");
  }

  async function start({ silent = false } = {}) {
    await switchDriver(args.driver, { quiet: true });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(args.port, args.host, () => { server.removeListener("error", reject); resolve(); });
    });
    if (!silent) banner();
    await runPoll();
    timer = setInterval(() => runPoll(), Math.max(200, Number(args.poll) || 2000));
    return state;
  }

  async function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    try { wss.close(); } catch (e) {}
    if (state.driver && state.driver.stop) { try { await state.driver.stop(); } catch (e) {} }
    await new Promise((resolve) => {
      try { server.close(() => resolve()); } catch (e) { resolve(); }
      const t = setTimeout(resolve, 400); t.unref?.();
    });
  }

  return {
    state, server, wss, engine, args,
    start, stop, runPoll, switchDriver, pushEvent, broadcast,
    helloFrame, deviceList, snapshot, health, pointsJson, handleRequest,
  };
}
/* ------------------------------ 进程入口 ------------------------------ */
import { fileURLToPath } from "node:url";

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usage()); return null; }
  if (!DRIVER_NAMES.includes(args.driver)) {
    console.error("错误：未知驱动 " + args.driver + "（可用：" + DRIVER_NAMES.join(", ") + "）");
    console.log(usage());
    process.exitCode = 1;
    return null;
  }
  if (!Number.isFinite(args.port) || args.port <= 0 || args.port > 65535) {
    console.error("错误：端口非法 " + args.port);
    process.exitCode = 1;
    return null;
  }
  const gw = createGateway(args);
  await gw.start();
  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    console.log("\n收到 " + sig + "，正在关闭网关 ...");
    await gw.stop();
    console.log("网关已关闭。");
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => { gw.state.errors++; console.error("[未捕获异常]", (e && e.stack) || e); });
  process.on("unhandledRejection", (e) => { gw.state.errors++; console.error("[未处理的 Promise 拒绝]", (e && e.stack) || e); });
  return gw;
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();

export default { createGateway, parseArgs, main, GW_VERSION, DRIVER_NAMES };