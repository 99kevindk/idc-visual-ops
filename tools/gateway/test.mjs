/* SPDX-License-Identifier: AGPL-3.0-or-later
 * IDC 可视化运维项目（IDC Visual Ops）· Copyright (c) 2026 99kevindk
 * 本文件以 AGPL-3.0-or-later 开源；闭源商业集成 / SaaS 托管需另行取得商业授权（见 COMMERCIAL-LICENSE.md）。
 *//* =========================================================================
 * tools/gateway/test.mjs — 动环网关自测（零依赖）
 *   覆盖：① WS 握手 + hello   ② >=3 轮 data   ③ inject 烟感后收到 alarm
 *         ④ /dh/health、/dh/points.csv 正常   ⑤ driver 切换报错处理
 *   全部通过后打印 ALL PASS
 *
 *   运行：node tools/gateway/test.mjs
 * ========================================================================= */
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push("  [PASS] " + name); console.log("  [PASS] " + name); }
  else { fail++; const line = "  [FAIL] " + name + (extra ? "  -> " + extra : ""); results.push(line); console.log(line); }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

async function waitFor(fn, { timeout = 10000, interval = 120, label = "条件" } = {}) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { /* 继续重试 */ }
    if (Date.now() - t0 > timeout) throw new Error("等待超时：" + label);
    await sleep(interval);
  }
}

/* ------------------------------ WebSocket 客户端（RFC6455，自实现） ------------------------------ */
function encodeMaskedFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

async function wsConnect(wsUrl, { timeout = 6000 } = {}) {
  const u = new URL(wsUrl);
  const key = crypto.randomBytes(16).toString("base64");
  const expect = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  const sock = net.connect(Number(u.port), u.hostname);
  const client = {
    sock, messages: [], listeners: [], handshake: "", closed: false, _buf: Buffer.alloc(0),
    send(obj) { sock.write(encodeMaskedFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8"))); },
    close() { try { sock.write(encodeMaskedFrame(0x8, Buffer.from([0x03, 0xe8]))); } catch (e) {} try { sock.destroy(); } catch (e) {} },
    _feed(d) {
      this._buf = Buffer.concat([this._buf, d]);
      for (;;) {
        const b = this._buf;
        if (b.length < 2) return;
        const op = b[0] & 0x0f;
        let len = b[1] & 0x7f, off = 2;
        if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
        if (b.length < off + len) return;
        const payload = b.subarray(off, off + len);
        this._buf = b.subarray(off + len);
        if (op === 0x1) {
          let msg = null; try { msg = JSON.parse(payload.toString("utf8")); } catch (e) {}
          if (msg) { this.messages.push(msg); for (const fn of [...this.listeners]) fn(msg); }
        } else if (op === 0x9) { sock.write(encodeMaskedFrame(0xa, payload)); }   // ping -> pong
        else if (op === 0x8) { this.closed = true; }
      }
    },
  };
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (settled) return; settled = true; client.close(); reject(e); };
    const timer = setTimeout(() => fail(new Error("WS 握手超时")), timeout);
    sock.on("error", fail);
    sock.on("connect", () => {
      sock.write([
        "GET " + u.pathname + " HTTP/1.1",
        "Host: " + u.host,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: " + key,
        "Sec-WebSocket-Version: 13",
        "Origin: http://localhost",
        "", "",
      ].join("\r\n"));
    });
    let hs = Buffer.alloc(0);
    const onData = (d) => {
      hs = Buffer.concat([hs, d]);
      const idx = hs.indexOf("\r\n\r\n");
      if (idx < 0) return;
      const head = hs.subarray(0, idx).toString("utf8");
      const rest = hs.subarray(idx + 4);
      if (!/^HTTP\/1\.1 101/.test(head)) return fail(new Error("握手未返回 101：" + head.split("\r\n")[0]));
      const m = /sec-websocket-accept:\s*(\S+)/i.exec(head);
      if (!m || m[1].trim() !== expect) return fail(new Error("Sec-WebSocket-Accept 校验失败"));
      settled = true;
      clearTimeout(timer);
      sock.off("data", onData);
      client.handshake = head;
      sock.on("data", (x) => { try { client._feed(x); } catch (e) { fail(e); } });
      resolve(client);
      if (rest.length) client._feed(rest);
    };
    sock.on("data", onData);
  });
  return client;
}

function waitForMessage(client, pred, { timeout = 8000, from = 0 } = {}) {
  return new Promise((resolve, reject) => {
    for (let i = from; i < client.messages.length; i++) if (pred(client.messages[i])) return resolve(client.messages[i]);
    const timer = setTimeout(() => { off(); reject(new Error("等待 WS 消息超时")); }, timeout);
    const fn = (m) => { if (pred(m)) { clearTimeout(timer); off(); resolve(m); } };
    const off = () => { const i = client.listeners.indexOf(fn); if (i >= 0) client.listeners.splice(i, 1); };
    client.listeners.push(fn);
  });
}

async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}
/* ------------------------------ 主流程 ------------------------------ */
console.log("动环南向网关自测 test.mjs");
console.log("------------------------------------------------------------");

const port = await freePort();
const base = "http://127.0.0.1:" + port;
let child = null, ws = null, gwErr = "";

try {
  console.log("启动网关：node tools/gateway/server.mjs --port " + port + " --driver sim --poll 300");
  child = spawn(process.execPath, [SERVER, "--port", String(port), "--driver", "sim", "--poll", "300"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { gwErr += d.toString(); });

  await waitFor(async () => (await fetch(base + "/dh/health")).ok, { label: "网关 HTTP 就绪" });
  check("网关 HTTP 服务就绪", true);

  /* ① WS 握手 + hello */
  ws = await wsConnect("ws://127.0.0.1:" + port + "/dh");
  check("WS 握手成功（101 + Sec-WebSocket-Accept 校验）", ws.handshake.includes("101"), ws.handshake.split("\r\n")[0]);
  const hello = await waitForMessage(ws, (m) => m.type === "hello");
  check("收到 hello（39 设备 / 260 测点 / driver=sim）",
    hello.devices.length === 39 && hello.points.length === 260 && hello.driver === "sim",
    "devices=" + hello.devices.length + " points=" + hello.points.length + " driver=" + hello.driver);
  check("hello 含 protocols 与 poll.interval",
    Array.isArray(hello.protocols) && hello.protocols.includes("sim") && hello.protocols.includes("modbus-tcp") && hello.points[0].id,
    JSON.stringify({ protocols: hello.protocols, poll: hello.poll }));
  check("hello.devices 含 3D 定位 loc 与 online",
    hello.devices.every((d) => d.id && d.type) && hello.devices.some((d) => d.loc && d.loc.kind === "ceiling"),
    "示例=" + hello.devices[0].id + "/" + hello.devices[0].type);

  /* WS 客户端掩码帧 -> 服务端解析（ping/pong） */
  ws.send({ type: "ping" });
  await waitForMessage(ws, (m) => m.type === "pong");
  check("WS ping -> pong（客户端掩码帧解析）", true);

  /* ② >= 3 轮 data */
  const data0 = ws.messages.filter((m) => m.type === "data").length;
  await waitFor(() => ws.messages.filter((m) => m.type === "data").length >= data0 + 3, { timeout: 10000, label: "3 轮 data" });
  const datas = ws.messages.filter((m) => m.type === "data");
  const lastData = datas[datas.length - 1];
  check("收到 >= 3 轮 data（seq 递增）", datas.length >= data0 + 3 && lastData.seq > datas[0].seq,
    "data 帧=" + datas.length + " 首 seq=" + datas[0].seq + " 末 seq=" + lastData.seq);
  check("data 含 values（非空）且带 quality/full 字段",
    Object.keys(lastData.values).length > 0 && typeof lastData.quality === "object" && typeof lastData.full === "boolean",
    "values=" + Object.keys(lastData.values).length + " full=" + lastData.full);

  /* ④ /dh/health 与 /dh/points.csv */
  const health = await (await fetch(base + "/dh/health")).json();
  check("GET /dh/health 正常（ok/driver/devices/points）",
    health.ok === true && health.driver === "sim" && health.devices === 39 && health.points === 260,
    JSON.stringify({ ok: health.ok, driver: health.driver, devices: health.devices, points: health.points }));
  check("/dh/health 统计到 WS 客户端", health.clients >= 1, "clients=" + health.clients);

  const csvRes = await fetch(base + "/dh/points.csv");
  const csv = await csvRes.text();
  const csvLines = csv.replace(/^\ufeff/, "").trim().split(/\r?\n/);
  check("GET /dh/points.csv 正常（表头 + 260 行）",
    csvRes.status === 200 && csvLines.length === 261 && csvLines[0].includes("设备编号"), "lines=" + csvLines.length);
  check("points.csv 含厂家对点字段（SNMP OID / 高高限 / MQTT Topic）",
    csvLines[0].includes("SNMP OID") && csvLines[0].includes("高高限") && csvLines[0].includes("MQTT Topic"));

  const snap = await (await fetch(base + "/dh/snapshot")).json();
  check("GET /dh/snapshot 实时快照非空", Object.keys(snap.values || {}).length >= 200, "values=" + Object.keys(snap.values || {}).length);

  /* ③ inject 烟感 -> alarm */
  const from = ws.messages.length;
  const inj = await postJson(base + "/dh/inject", { deviceId: "SM-03", action: "smoke" });
  check("POST /dh/inject 烟感注入成功", inj.status === 200 && inj.json && inj.json.ok === true, JSON.stringify(inj.json));
  const alarmMsg = await waitForMessage(ws, (m) => m.type === "alarm" && m.alarm && m.alarm.pointId === "SM-03.state" && m.alarm.state === "active", { timeout: 8000, from });
  check("注入烟感后收到 alarm（critical / rule=di）",
    alarmMsg.alarm.level === "critical" && alarmMsg.alarm.rule === "di",
    JSON.stringify({ level: alarmMsg.alarm.level, rule: alarmMsg.alarm.rule, text: alarmMsg.alarm.text }));

  const alarms = await (await fetch(base + "/dh/alarms")).json();
  check("GET /dh/alarms 含 SM-03 critical 报警",
    alarms.count >= 1 && alarms.alarms.some((a) => a.pointId === "SM-03.state" && a.level === "critical"), "count=" + alarms.count);

  const inj2 = await postJson(base + "/dh/inject", { pointId: "SM-03.state", value: 0 });
  check("POST /dh/inject 点级恢复（value=0）", inj2.status === 200 && inj2.json.ok === true);
  await sleep(900);
  const alarms2 = await (await fetch(base + "/dh/alarms")).json();
  check("恢复后 SM-03 报警自动清除",
    !alarms2.alarms.some((a) => a.pointId === "SM-03.state"), "活动报警=" + alarms2.count);

  /* 附加：AI 越限 hiHi + delay 持续确认 + deadband 回差（注入 UPS-01 过压 258V） */
  const from2 = ws.messages.length;
  await postJson(base + "/dh/inject", { deviceId: "UPS-01", action: "overvoltage" });
  const aiAlarm = await waitForMessage(ws, (m) => m.type === "alarm" && m.alarm && m.alarm.pointId === "UPS-01.UAA" && m.alarm.state === "active", { timeout: 10000, from: from2 });
  check("AI 越限 delay 确认后产生 critical（rule=hiHi）",
    aiAlarm.alarm.level === "critical" && aiAlarm.alarm.rule === "hiHi",
    JSON.stringify({ level: aiAlarm.alarm.level, rule: aiAlarm.alarm.rule, value: aiAlarm.alarm.value }));
  const from3 = ws.messages.length;
  await postJson(base + "/dh/inject", { deviceId: "UPS-01", action: "clear" });
  const aiCleared = await waitForMessage(ws, (m) => m.type === "alarm" && m.alarm && m.alarm.id === aiAlarm.alarm.id && m.alarm.state === "cleared", { timeout: 10000, from: from3 });
  check("AI 越限恢复（deadband + delay）后自动清除", aiCleared.alarm.state === "cleared", "durationMs=" + aiCleared.alarm.durationMs);
  /* ⑤ driver 切换报错处理 */
  const bad = await postJson(base + "/dh/driver", { driver: "nope" });
  check("POST /dh/driver 未知驱动 -> 400 + available",
    bad.status === 400 && bad.json && bad.json.ok === false && Array.isArray(bad.json.available), JSON.stringify(bad.json));
  const bad2 = await postJson(base + "/dh/driver", {});
  check("POST /dh/driver 缺字段 -> 400", bad2.status === 400 && bad2.json && bad2.json.ok === false && /缺少/.test(bad2.json.error));
  const okSwitch = await postJson(base + "/dh/driver", { driver: "sim" });
  check("POST /dh/driver 切换回 sim 成功",
    okSwitch.status === 200 && okSwitch.json && okSwitch.json.ok === true && okSwitch.json.driver === "sim", JSON.stringify(okSwitch.json));

  check("网关进程 stderr 无未捕获异常", !/Unhandled|Uncaught|throw new/i.test(gwErr), gwErr.slice(0, 160) || "(stderr 为空)");
} catch (e) {
  fail++;
  const line = "  [FAIL] 自测流程异常: " + (e && e.message ? e.message : e);
  results.push(line);
  console.log(line);
} finally {
  try { if (ws) ws.close(); } catch (e) {}
  await sleep(150);
  try { if (child && !child.killed) child.kill(); } catch (e) {}
  await sleep(250);
}

console.log("------------------------------------------------------------");
/* ------------------------------ 真实驱动编解码自测（离线，无网络） ------------------------------ */
console.log("");
console.log("协议编解码自测（Modbus-TCP / SNMP / MQTT / HTTP-JSON）");
console.log("------------------------------------------------------------");
try {
  const PT = await import("./pointtable.mjs");
  const MB = await import("./drivers/modbus-tcp.mjs");
  check("Modbus 地址解析（40001/30001 -> offset 0，FC03/FC04）",
    MB.toOffset(40001) === 0 && MB.toOffset(30001) === 0 && MB.fcFor({ addr: 30001 }) === 4 && MB.fcFor({ addr: 40001 }) === 3,
    "toOffset(40001)=" + MB.toOffset(40001) + " fcFor(30001)=" + MB.fcFor({ addr: 30001 }));
  const fbuf = Buffer.alloc(4); fbuf.writeFloatBE(230.5);
  check("Modbus 解码 uint16*scale / int16 负值 / float32 / bit 位提取",
    MB.decodeValue({ kind: "ai", dtype: "uint16", scale: 0.1 }, Buffer.from([0x00, 0x64])) === 10 &&
    MB.decodeValue({ kind: "ai", dtype: "int16", scale: 1 }, Buffer.from([0xff, 0x9c])) === -100 &&
    MB.decodeValue({ kind: "ai", dtype: "float32", scale: 1 }, fbuf) === 230.5 &&
    MB.decodeValue({ kind: "di", dtype: "uint16", bits: { bit: 3 } }, Buffer.from([0x00, 0x08])) === 1);
  const plans = MB.planReads([
    { id: "a", addr: 40001, reg: "holding", dtype: "uint16", kind: "ai" },
    { id: "b", addr: 40002, reg: "holding", dtype: "uint16", kind: "ai" },
    { id: "c", addr: 40050, reg: "holding", dtype: "uint16", kind: "ai" }]);
  check("Modbus 连续寄存器合并为批量请求（2 个请求，首个 count=2）", plans.length === 2 && plans[0].count === 2, "plans=" + plans.length);
  check("Modbus MBAP 请求帧构造（事务号/协议号/长度/单元号）", (() => {
    const b = Buffer.alloc(7); b.writeUInt16BE(1, 0); b.writeUInt16BE(0, 2); b.writeUInt16BE(6, 4); b[6] = 1;
    return b.readUInt16BE(2) === 0 && b[6] === 1;
  })());

  const SN = await import("./drivers/snmp.mjs");
  const oid = "1.3.6.1.4.1.10001.1.1.0";
  const upsOids = PT.POINTS.filter((x) => x.oid).map((x) => x.oid);
  check("SNMP OID BER 编解码往返（含点表全部 " + upsOids.length + " 个 OID）",
    SN.decOid(SN.encOid(oid).subarray(2)) === oid && upsOids.every((o) => SN.decOid(SN.encOid(o).subarray(2)) === o));
  const getReq = SN.buildGetRequest([oid, "1.3.6.1.2.1.1.3.0"], "public", 7);
  check("SNMP v2c GET 请求报文（SEQUENCE + version + community + PDU 0xA0）",
    SN.parseTLV(getReq, 0).tag === 0x30 && getReq.includes(Buffer.from("public")) && getReq.includes(Buffer.from([0xa0])), getReq.length + " bytes");
  check("SNMP INTEGER 编解码（含负数与 0）",
    SN.decInt(SN.encInt(0).subarray(2)) === 0 && SN.decInt(SN.encInt(-100).subarray(2)) === -100 && SN.decInt(SN.encInt(123456).subarray(2)) === 123456);

  const MQ = await import("./drivers/mqtt.mjs");
  const conn = MQ.tryParsePacket(MQ.buildConnect({ clientId: "gw-test" }));
  check("MQTT 3.1.1 CONNECT 帧（协议名 MQTT + level 0x04）",
    conn && conn.type === 1 && conn.body.subarray(0, 7).toString("hex") === "00044d51545404");
  const pub = MQ.tryParsePacket(MQ.buildPublish("idc/ups/UPS-01/UAA", "231.4", 0));
  check("MQTT PUBLISH 帧编解码 + 载荷解析（数字 / JSON value / 布尔）",
    pub && pub.type === 3 && MQ.parsePayload(Buffer.from("231.4")) === 231.4 &&
    MQ.parsePayload(Buffer.from('{"value":12.5}')) === 12.5 && MQ.parsePayload(Buffer.from("true")) === 1);
  const sub = MQ.tryParsePacket(MQ.buildSubscribe(["idc/ups/#", "idc/th/#"], 5, 0));
  check("MQTT SUBSCRIBE 帧（flags=0x2 / 多 topic）", sub && sub.type === 8 && sub.flags === 2, "body=" + sub.body.length + "B");

  const HJ = await import("./drivers/http-json.mjs");
  check("HTTP-JSON 取值（点路径 / key / data 包裹 / points 数组 / pointId+v）",
    HJ.jsonPath({ a: { b: { c: 7 } } }, "a.b.c") === 7 &&
    HJ.pickValue({ ua: 2314 }, { key: "ua", id: "D.ua" }) === 2314 &&
    HJ.pickValue({ data: { temp: 245 } }, { addr: "temp", key: "temp" }) === 245 &&
    HJ.pickValue({ points: [{ id: "D.x", value: 12 }] }, { key: "x", id: "D.x" }) === 12 &&
    HJ.pickValue({ points: [{ pointId: "D.y", v: 13 }] }, { key: "y", id: "D.y" }) === 13);
  check("点表协议分布（modbus-tcp 32 / modbus-rtu 7，共 39 台）",
    PT.DEVICES.length === 39 && PT.devicesByType("smoke").length === 12 && PT.devicesByType("water").length === 12 && PT.pointsOf("UPS-01").length === 29);
} catch (e) {
  fail++;
  const line = "  [FAIL] 编解码自测异常: " + (e && e.message ? e.message : e);
  results.push(line); console.log(line);
}
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
if (fail === 0) { console.log("ALL PASS"); process.exit(0); }
console.log("SOME TESTS FAILED");
process.exit(1);