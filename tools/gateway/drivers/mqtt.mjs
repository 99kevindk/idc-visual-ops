/* SPDX-License-Identifier: AGPL-3.0-or-later
 * IDC 可视化运维项目（IDC Visual Ops）· Copyright (c) 2026 99kevindk
 * 本文件以 AGPL-3.0-or-later 开源；闭源商业集成 / SaaS 托管需另行取得商业授权（见 COMMERCIAL-LICENSE.md）。
 *//* =========================================================================
 * tools/gateway/drivers/mqtt.mjs — MQTT 3.1.1 南向驱动（零依赖）
 *  - 帧编解码：CONNECT / CONNACK / SUBSCRIBE / SUBACK / PUBLISH / PUBACK / PINGREQ / PINGRESP
 *  - 按点表 point.mqtt topic 映射（idc/<type>/<devId>/<key>），订阅前缀通配
 *  - 连接状态如实上报（connecting/connected/error），断线指数退避重连
 * ========================================================================= */
import net from "node:net";
import { EventEmitter } from "node:events";

export const CONNACK_TEXT = { 0: "连接已接受", 1: "协议版本不支持", 2: "clientId 被拒绝", 3: "服务不可用", 4: "用户名或密码错误", 5: "未授权" };

export function encRemainingLength(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return Buffer.from(out);
}

export function mqttPacket(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | (flags & 0x0f)]), encRemainingLength(body.length), body]);
}

export function mqttString(s) {
  const b = Buffer.from(String(s), "utf8");
  return Buffer.concat([Buffer.from([(b.length >> 8) & 0xff, b.length & 0xff]), b]);
}

/** 从缓冲区中尝试解析一个完整 MQTT 包；不完整返回 null */
export function tryParsePacket(buf) {
  if (buf.length < 2) return null;
  let multiplier = 1, value = 0, i = 1, byte;
  do {
    if (i >= buf.length) return null;
    byte = buf[i++];
    value += (byte & 0x7f) * multiplier;
    multiplier *= 128;
    if (multiplier > 128 * 128 * 128) throw new Error("MQTT 剩余长度格式非法");
  } while (byte & 0x80);
  const total = i + value;
  if (buf.length < total) return null;
  return { header: buf[0], type: buf[0] >> 4, flags: buf[0] & 0x0f, body: buf.subarray(i, total), total };
}

export function buildConnect({ clientId, username, password, keepalive = 60, cleanSession = true }) {
  let flags = 0;
  if (cleanSession) flags |= 0x02;
  if (username) flags |= 0x80;
  if (password) flags |= 0x40;
  const body = Buffer.concat([
    mqttString("MQTT"), Buffer.from([0x04, flags, (keepalive >> 8) & 0xff, keepalive & 0xff,]),
    mqttString(clientId),
    username ? mqttString(username) : Buffer.alloc(0),
    password ? mqttString(password) : Buffer.alloc(0),
  ]);
  return mqttPacket(1, 0, body);
}

export function buildSubscribe(topics, packetId = 1, qos = 0) {
  const parts = [Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff])];
  for (const t of topics) parts.push(mqttString(t), Buffer.from([qos & 0x03]));
  return mqttPacket(8, 2, Buffer.concat(parts)); // 0x82：SUBSCRIBE 固定 flags=0010
}

export function buildPublish(topic, payload, qos = 0, packetId = 1) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const parts = [mqttString(topic)];
  if (qos > 0) parts.push(Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]));
  parts.push(p);
  return mqttPacket(3, (qos & 0x03) << 1, Buffer.concat(parts));
}

export class MqttClient extends EventEmitter {
  constructor({ host, port = 1883, clientId, username, password, keepalive = 60, timeout = 2500, log = () => {} }) {
    super();
    this.host = host; this.port = port;
    this.clientId = clientId || "dh-gw-" + Math.random().toString(16).slice(2, 10);
    this.username = username; this.password = password;
    this.keepalive = keepalive; this.timeout = timeout; this.log = log;
    this.sock = null; this._buf = Buffer.alloc(0);
    this.connected = false; this._pid = 0;
    this._connack = null; this._suback = null;
    this._keepTimer = null;
  }

  _send(buf) { if (this.sock) { try { this.sock.write(buf); } catch (e) { this.emit("error", e); } } }

  connect() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      this.sock = sock;
      let settled = false;
      const fail = (e) => { if (settled) return; settled = true; sock.destroy(); reject(e); };
      const timer = setTimeout(() => fail(new Error("MQTT CONNECT 超时 " + this.host + ":" + this.port)), this.timeout);
      sock.once("connect", () => sock.write(buildConnect({ clientId: this.clientId, username: this.username, password: this.password, keepalive: this.keepalive })));
      sock.on("data", (d) => { try { this._onData(d); } catch (e) { fail(e); } });
      sock.on("error", (e) => { this.emit("error", e); fail(e); });
      sock.on("close", () => { this.connected = false; clearInterval(this._keepTimer); this.emit("close"); });
      this._connack = (rc) => {
        clearTimeout(timer);
        if (rc !== 0) return fail(new Error("MQTT CONNACK 拒绝：" + (CONNACK_TEXT[rc] || rc)));
        settled = true;
        this.connected = true;
        this._keepTimer = setInterval(() => this._send(mqttPacket(12, 0, Buffer.alloc(0))), Math.max(5, this.keepalive / 2) * 1000);
        this._keepTimer.unref?.();
        resolve();
      };
    });
  }

  subscribe(topics, qos = 0) {
    return new Promise((resolve, reject) => {
      const pid = (this._pid = (this._pid + 1) & 0xffff) || 1;
      const timer = setTimeout(() => reject(new Error("MQTT SUBACK 超时")), this.timeout);
      this._suback = (rpid, codes) => { if (rpid !== pid) return; clearTimeout(timer); resolve(codes); };
      this._send(buildSubscribe(topics, pid, qos));
    });
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    for (;;) {
      const p = tryParsePacket(this._buf);
      if (!p) break;
      this._buf = this._buf.subarray(p.total);
      this._handle(p);
    }
  }

  _handle(p) {
    if (p.type === 2) { const rc = p.body.length > 1 ? p.body[1] : 255; this.emit("connack", rc); if (this._connack) this._connack(rc); return; }
    if (p.type === 9) { const rpid = p.body.readUInt16BE(0); const codes = Array.from(p.body.subarray(2)); this.emit("suback", rpid, codes); if (this._suback) this._suback(rpid, codes); return; }
    if (p.type === 13) { this.emit("pong"); return; }
    if (p.type === 3) {
      const qos = (p.header >> 1) & 0x03;
      let off = 0;
      const tlen = p.body.readUInt16BE(0); off = 2;
      const topic = p.body.subarray(off, off + tlen).toString("utf8"); off += tlen;
      let pid = null;
      if (qos > 0) { pid = p.body.readUInt16BE(off); off += 2; this._send(mqttPacket(4, 0, Buffer.from([(pid >> 8) & 0xff, pid & 0xff]))); }
      this.emit("message", topic, p.body.subarray(off), { qos, retain: p.header & 1 });
      return;
    }
  }

  publish(topic, payload, qos = 0) { this._send(buildPublish(topic, payload, qos, ++this._pid)); }

  end() {
    clearInterval(this._keepTimer);
    if (this.sock) { try { this.sock.end(); } catch (e) {} this.sock = null; }
    this.connected = false;
  }
}
/* ------------------------------ 载荷解析 ------------------------------ */
export function parsePayload(buf) {
  const s = (Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf)).trim();
  if (s === "") return null;
  if (s === "true") return 1;
  if (s === "false") return 0;
  try {
    const j = JSON.parse(s);
    if (typeof j === "number") return j;
    if (typeof j === "boolean") return j ? 1 : 0;
    if (j && typeof j === "object") {
      if (typeof j.value === "number") return j.value;
      if (typeof j.v === "number") return j.v;
      return j;
    }
    return j;
  } catch (e) { /* 非 JSON，按数字处理 */ }
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

/* ------------------------------ 驱动工厂 ------------------------------ */
export function createMqttDriver({ devices = [], points = [], options = {}, log = () => {}, emit = () => {} } = {}) {
  const broker = options.broker || {};
  const host = broker.host || options.host || "127.0.0.1";
  const port = broker.port || options.port || 1883;
  const staleMs = options.staleMs ?? 60000;
  const withTopic = points.filter((p) => p.mqtt);

  const topicToPoint = new Map(withTopic.map((p) => [p.mqtt, p]));
  const topics = options.topics || [...new Set(withTopic.map((p) => p.mqtt.split("/").slice(0, 2).join("/") + "/#"))];
  const latest = new Map(); // pointId -> { value, ts }

  let state = "idle";
  let running = false;
  let failCount = 0;
  let nextRetryAt = 0;
  let lastErr = null;
  let msgCount = 0;
  let lastMsgAt = 0;

  const client = new MqttClient({
    host, port, clientId: options.clientId || "dh-gw-" + Math.random().toString(16).slice(2, 10),
    username: options.username, password: options.password,
    keepalive: options.keepalive || 60, timeout: options.timeout ?? 2000, log,
  });

  client.on("message", (topic, payload) => {
    msgCount++; lastMsgAt = Date.now();
    const pt = topicToPoint.get(topic);
    if (!pt) return;
    const raw = parsePayload(payload);
    if (raw == null) return;
    let v = typeof raw === "string" ? Number(raw) : raw;
    if (!Number.isFinite(v)) return;
    v = pt.kind === "di" ? (v ? 1 : 0) : Math.round(v * (typeof pt.scale === "number" ? pt.scale : 1) * 1000) / 1000;
    latest.set(pt.id, { value: v, ts: Date.now() });
  });
  client.on("error", (e) => { lastErr = e.message; });

  function setState(next, text) {
    if (state === next) return;
    state = next;
    emit({ kind: next === "error" ? "error" : next === "connected" ? "connect" : "info", text });
  }

  async function ensureConnected(now) {
    if (client.connected) return;
    if (now < nextRetryAt) throw new Error(lastErr ? "退避重试中：" + lastErr : "退避重试中");
    setState("connecting", "正在连接 MQTT Broker " + host + ":" + port);
    try {
      await client.connect();
      await client.subscribe(topics, 0);
      failCount = 0; lastErr = null;
      setState("connected", "MQTT 已连接 " + host + ":" + port + "，订阅 " + topics.length + " 个前缀：" + topics.join(", "));
    } catch (e) {
      failCount++; lastErr = e.message;
      nextRetryAt = Date.now() + Math.min(30000, 1000 * Math.pow(2, Math.min(failCount, 5)));
      setState("error", "MQTT 连接失败：" + e.message);
      throw e;
    }
  }

  async function poll() {
    const now = Date.now();
    const values = {};
    const quality = {};
    const ds = {};
    let brokered = false;
    if (running) { try { await ensureConnected(now); brokered = true; } catch (e) { brokered = false; } }
    for (const d of devices) {
      const pts = withTopic.filter((p) => p.devId === d.id);
      let fresh = 0, newest = 0;
      for (const pt of pts) {
        const it = latest.get(pt.id);
        if (it && now - it.ts <= staleMs) { values[pt.id] = it.value; quality[pt.id] = "good"; fresh++; if (it.ts > newest) newest = it.ts; }
      }
      if (!brokered) ds[d.id] = { online: false, rt: 0, reason: lastErr || "MQTT 未连接" };
      else if (fresh > 0) ds[d.id] = { online: true, rt: Math.max(0, now - newest) };
      else ds[d.id] = { online: false, rt: 0, reason: "已订阅，尚未收到该设备数据" };
    }
    return { values, quality, devices: ds };
  }

  return {
    name: "mqtt",
    protocols: ["mqtt"],
    get state() { return state; },
    async start() {
      running = true; state = "connecting";
      emit({ kind: "connecting", text: "MQTT 3.1.1 驱动启动，Broker " + host + ":" + port + "，订阅 " + topics.join(", ") });
      return true;
    },
    async stop() { running = false; client.end(); state = "idle"; },
    async poll() { return poll(); },
    status() {
      return {
        state, broker: host + ":" + port, topics, messages: msgCount,
        lastMessageAt: lastMsgAt || null, error: lastErr || undefined,
        points: latest.size, mapped: topicToPoint.size,
      };
    },
  };
}

export default createMqttDriver;