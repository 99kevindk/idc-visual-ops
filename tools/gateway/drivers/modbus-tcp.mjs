/* SPDX-License-Identifier: AGPL-3.0-or-later
 * IDC 可视化运维项目（IDC Visual Ops）· Copyright (c) 2026 99kevindk
 * 本文件以 AGPL-3.0-or-later 开源；闭源商业集成 / SaaS 托管需另行取得商业授权（见 COMMERCIAL-LICENSE.md）。
 *//* =========================================================================
 * tools/gateway/drivers/modbus-tcp.mjs — Modbus TCP 南向驱动（零依赖）
 *  - MBAP 头（事务号/协议号/长度/单元号）+ 功能码 03/04 批量读
 *  - 按点表 addr(4xxxx 保持 / 3xxxx 输入) + dtype(uint16/int16/uint32/int32/float32/bit)
 *    + scale 解码为工程值；支持 bits.bit 位提取
 *  - 连续寄存器自动合并成批量请求（最多 100 寄存器/次）；超时 / 异常码(0x83 等)解析
 *  - 断线自动重连 + 指数退避；连接状态如实上报（connecting/connected/error）
 * ========================================================================= */
import net from "node:net";

export const MODBUS_EXCEPTIONS = {
  1: "非法功能码", 2: "非法数据地址", 3: "非法数据值", 4: "从站设备故障",
  5: "确认", 6: "从站设备忙", 8: "存储奇偶校验错", 10: "网关路径不可用", 11: "网关目标无响应",
};

export class ModbusError extends Error {
  constructor(code) { super("Modbus 异常码 " + code + " (" + (MODBUS_EXCEPTIONS[code] || "未知") + ")"); this.code = code; }
}

/* ------------------------------ 点表解码 ------------------------------ */
export function toOffset(addr) {
  const n = typeof addr === "string" ? parseInt(addr, 10) : addr;
  if (!Number.isFinite(n)) return null;
  if (n >= 40000) return n - 40001;
  if (n >= 30000) return n - 30001;
  return n;
}

export function fcFor(pt) {
  const n = typeof pt.addr === "string" ? parseInt(pt.addr, 10) : pt.addr;
  if (pt.reg === "input") return 4;
  if (pt.reg === "holding") return 3;
  return n >= 30000 && n < 40000 ? 4 : 3;
}

export function wordsFor(pt) {
  const t = pt.dtype || "uint16";
  return t === "uint32" || t === "int32" || t === "float32" ? 2 : 1;
}

export function decodeValue(pt, buf) {
  let raw;
  if (pt.bits && pt.bits.bit != null) raw = (buf.readUInt16BE(0) >> pt.bits.bit) & 1;
  else {
    const t = pt.dtype || "uint16";
    if (t === "int16") raw = buf.readInt16BE(0);
    else if (t === "uint32") raw = buf.readUInt32BE(0);
    else if (t === "int32") raw = buf.readInt32BE(0);
    else if (t === "float32") raw = buf.readFloatBE(0);
    else if (t === "bit") raw = buf.readUInt16BE(0) & 1;
    else raw = buf.readUInt16BE(0);
  }
  if (pt.kind === "di") return raw ? 1 : 0;
  const scale = typeof pt.scale === "number" ? pt.scale : 1;
  return Math.round(raw * scale * 1000) / 1000;
}

/** 把一台设备的测点规划为若干批量读请求 */
export function planReads(pts, { maxRegs = 100, maxGap = 8 } = {}) {
  const byFc = { 3: [], 4: [] };
  for (const pt of pts) {
    const off = toOffset(pt.addr);
    if (off == null || off < 0) continue;
    byFc[fcFor(pt)].push({ pt, off });
  }
  const plans = [];
  for (const fc of [3, 4]) {
    const list = byFc[fc].sort((a, b) => a.off - b.off);
    let cur = null;
    for (const it of list) {
      const w = wordsFor(it.pt);
      if (cur && it.off - (cur.start + cur.count) <= maxGap && it.off + w - cur.start <= maxRegs) {
        cur.count = it.off + w - cur.start;
        cur.items.push(it);
      } else {
        cur = { fc, start: it.off, count: w, items: [it] };
        plans.push(cur);
      }
    }
  }
  return plans;
}

/* ------------------------------ Modbus 客户端 ------------------------------ */
export class ModbusClient {
  constructor({ host, port = 502, unitId = 1, timeout = 1500, log = () => {} }) {
    this.host = host; this.port = port; this.unitId = unitId & 0xff;
    this.timeout = timeout; this.log = log;
    this.sock = null; this.tid = 0; this._tail = Promise.resolve();
  }
  get connected() { return !!this.sock && !this.sock.destroyed; }

  connect() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      let settled = false;
      const fail = (e) => { if (settled) return; settled = true; sock.destroy(); reject(e); };
      sock.setTimeout(this.timeout, () => fail(new Error("连接超时 " + this.host + ":" + this.port)));
      sock.once("error", fail);
      sock.once("connect", () => {
        if (settled) return;
        settled = true;
        sock.setTimeout(0);
        sock.removeListener("error", fail);
        this.sock = sock;
        resolve();
      });
    });
  }

  _enqueue(fn) {
    const run = this._tail.then(fn, fn);
    this._tail = run.then(() => {}, () => {});
    return run;
  }

  request(pdu) {
    return this._enqueue(() => new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error("未连接"));
      const sock = this.sock;
      const tid = (this.tid = (this.tid + 1) & 0xffff);
      const mbap = Buffer.alloc(7);
      mbap.writeUInt16BE(tid, 0);
      mbap.writeUInt16BE(0, 2);
      mbap.writeUInt16BE(pdu.length + 1, 4);
      mbap[6] = this.unitId;
      let acc = Buffer.alloc(0);
      let done = false;
      const cleanup = () => { sock.off("data", onData); sock.off("error", onErr); sock.off("close", onClose); clearTimeout(timer); };
      const finish = (e, r) => { if (done) return; done = true; cleanup(); e ? reject(e) : resolve(r); };
      const timer = setTimeout(() => finish(new Error("请求超时 " + this.host + ":" + this.port)), this.timeout);
      const onClose = () => finish(new Error("连接被关闭"));
      const onErr = (e) => finish(e);
      const onData = (d) => {
        acc = Buffer.concat([acc, d]);
        while (acc.length >= 6) {
          const len = acc.readUInt16BE(4);
          if (acc.length < 6 + len) break;
          const msg = acc.subarray(0, 6 + len);
          acc = acc.subarray(6 + len);
          if (msg.readUInt16BE(2) !== 0) continue;
          if (msg.readUInt16BE(0) !== tid) continue;
          finish(null, msg.subarray(7));
          return;
        }
      };
      sock.on("data", onData);
      sock.on("error", onErr);
      sock.on("close", onClose);
      sock.write(Buffer.concat([mbap, pdu]));
    }));
  }

  readRegisters(fc, start, count) {
    const pdu = Buffer.alloc(5);
    pdu[0] = fc;
    pdu.writeUInt16BE(start & 0xffff, 1);
    pdu.writeUInt16BE(count & 0xffff, 3);
    return this.request(pdu).then((resp) => {
      const fn = resp[0];
      if (fn === (fc | 0x80)) throw new ModbusError(resp[1]);
      if (fn !== fc) throw new Error("功能码不匹配：期望 " + fc + " 收到 " + fn);
      const byteCount = resp[1];
      return resp.subarray(2, 2 + byteCount);
    });
  }

  destroy() {
    if (this.sock) { try { this.sock.destroy(); } catch (e) {} }
    this.sock = null;
  }
}

/* ------------------------------ 驱动工厂 ------------------------------ */
const isIp = (h) => typeof h === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

export function createModbusDriver({ devices = [], points = [], options = {}, log = () => {}, emit = () => {} } = {}) {
  const timeout = options.timeout ?? 1500;
  const byDev = {};
  for (const d of devices) byDev[d.id] = points.filter((x) => x.devId === d.id);

  const runtimes = new Map();
  for (const d of devices) {
    if (d.protocol !== "modbus-tcp" && d.protocol !== "modbus-rtu") continue;
    const pts = byDev[d.id] || [];
    const plans = isIp(d.ip) ? planReads(pts) : [];
    runtimes.set(d.id, {
      dev: d, pts, plans,
      client: new ModbusClient({ host: d.ip, port: d.port || 502, unitId: d.slaveId || 1, timeout, log }),
      failCount: 0, nextRetryAt: 0, online: false, lastErr: null, lastRt: 0,
      reachable: isIp(d.ip) && plans.length > 0,
      reason: !isIp(d.ip) ? "串口/非 IP 设备需 RTU 转 TCP 网关" : (plans.length ? "" : "点表无有效寄存器地址"),
    });
  }

  let running = false;
  let state = "idle";
  const connectedIds = () => [...runtimes.values()].filter((r) => r.online).length;

  function setState(next, text) {
    if (state === next) return;
    state = next;
    emit({ kind: next === "error" ? "error" : next === "connected" ? "connect" : "info", text });
  }

  async function poll() {
    const now = Date.now();
    const values = {};
    const quality = {};
    const ds = {};
    await Promise.all(devices.map(async (d) => {
      const r = runtimes.get(d.id);
      if (!r || !r.reachable) {
        ds[d.id] = { online: false, rt: 0, reason: (r && r.reason) || "该驱动不处理此设备" };
        if (r) r.online = false;
        return;
      }
      if (now < r.nextRetryAt) { ds[d.id] = { online: false, rt: 0, reason: "退避重试中：" + (r.lastErr || "") }; return; }
      const t0 = Date.now();
      try {
        if (!r.client.connected) { setState("connecting", "正在连接 " + d.name + " (" + d.ip + ":" + (d.port || 502) + ")"); await r.client.connect(); }
        for (const plan of r.plans) {
          const buf = await r.client.readRegisters(plan.fc, plan.start, plan.count);
          for (const it of plan.items) {
            const off = (it.off - plan.start) * 2;
            const need = wordsFor(it.pt) * 2;
            values[it.pt.id] = decodeValue(it.pt, buf.subarray(off, off + need));
            quality[it.pt.id] = "good";
          }
        }
        r.online = true; r.failCount = 0; r.lastErr = null; r.lastRt = Date.now() - t0;
        ds[d.id] = { online: true, rt: r.lastRt };
      } catch (e) {
        r.client.destroy();
        r.online = false; r.failCount++; r.lastErr = e.message;
        r.nextRetryAt = now + Math.min(30000, 1000 * Math.pow(2, Math.min(r.failCount, 5)));
        ds[d.id] = { online: false, rt: 0, reason: e.message };
        setState("error", "Modbus 采集失败：" + d.name + " -> " + e.message);
      }
    }));
    const ok = connectedIds();
    if (ok > 0) setState("connected", "Modbus 已连接 " + ok + " / " + runtimes.size + " 台设备");
    else if (state !== "connecting") setState("error", "Modbus 暂无可用设备（" + runtimes.size + " 台全部失败或不可达）");
    return { values, quality, devices: ds };
  }

  return {
    name: "modbus-tcp",
    protocols: ["modbus-tcp", "modbus-rtu"],
    get state() { return state; },
    async start() {
      running = true;
      state = "connecting";
      emit({ kind: "connecting", text: "Modbus TCP 驱动启动，共 " + runtimes.size + " 台设备待采集" });
      return true;
    },
    async stop() { running = false; for (const r of runtimes.values()) r.client.destroy(); state = "idle"; },
    async poll() { return poll(); },
    status() {
      const list = [...runtimes.values()].map((r) => ({ id: r.dev.id, ip: r.dev.ip, port: r.dev.port, online: r.online, fail: r.failCount, error: r.lastErr, reason: r.lastErr || r.reason || undefined }));
      return { state, online: connectedIds(), total: runtimes.size, devices: list };
    },
  };
}

export default createModbusDriver;