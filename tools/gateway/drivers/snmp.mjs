/* =========================================================================
 * tools/gateway/drivers/snmp.mjs — SNMP v2c GET 南向驱动（零依赖）
 *  - BER/DER 编解码：SEQUENCE / INTEGER / OCTET STRING / NULL / OID / Counter32
 *    / Gauge32 / TimeTicks / Counter64 / IpAddress
 *  - 一台设备一次 GET 多个 OID（varbind list），按点表 oid 映射工程值
 *  - UDP 无连接：按 request-id 匹配响应，超时重试 + 指数退避，状态如实上报
 * ========================================================================= */
import dgram from "node:dgram";

/* ------------------------------ BER 编解码 ------------------------------ */
export function encLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), encLen(content.length), content]);
}

export function encInt(n) {
  if (n === 0) return Buffer.from([0x02, 0x01, 0x00]);
  const bytes = [];
  let v = Math.trunc(n);
  const neg = v < 0;
  while (v !== 0 && v !== -1) { bytes.unshift(v & 0xff); v = v >> 8; }
  if (bytes.length === 0) bytes.push(0);
  if (!neg && (bytes[0] & 0x80)) bytes.unshift(0x00);
  if (neg && !(bytes[0] & 0x80)) bytes.unshift(0xff);
  return tlv(0x02, Buffer.from(bytes));
}

export function decInt(buf) {
  if (!buf.length) return 0;
  let v = 0n;
  for (const b of buf) v = (v << 8n) | BigInt(b);
  if (buf[0] & 0x80) v -= (1n << BigInt(buf.length * 8));
  return Number(v);
}

export function decUint(buf) {
  let v = 0n;
  for (const b of buf) v = (v << 8n) | BigInt(b);
  return Number(v);
}

export function encOid(oid) {
  const parts = String(oid).split(".").map((x) => parseInt(x, 10));
  if (parts.length < 2 || parts.some((x) => !Number.isFinite(x))) throw new Error("非法 OID: " + oid);
  const bytes = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const stack = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
}

export function decOid(buf) {
  const out = [Math.floor(buf[0] / 40), buf[0] % 40];
  let v = 0;
  for (let i = 1; i < buf.length; i++) {
    v = v * 128 + (buf[i] & 0x7f);
    if (!(buf[i] & 0x80)) { out.push(v); v = 0; }
  }
  return out.join(".");
}

export function parseTLV(buf, off = 0) {
  if (off + 2 > buf.length) throw new Error("TLV 越界");
  const tag = buf[off];
  let len = buf[off + 1];
  let p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
  }
  if (p + len > buf.length) throw new Error("TLV 内容越界");
  return { tag, len, content: buf.subarray(p, p + len), end: p + len };
}

function decodeAsn1Value(node) {
  switch (node.tag) {
    case 0x02: return decInt(node.content);
    case 0x41: case 0x42: case 0x43: case 0x46: return decUint(node.content);
    case 0x40: return Array.from(node.content).join(".");
    case 0x04: {
      const s = node.content.toString("utf8");
      const n = Number(s);
      return s.trim() !== "" && Number.isFinite(n) ? n : s;
    }
    case 0x05: return null;
    case 0x06: return decOid(node.content);
    default: return node.content.toString("hex");
  }
}

/** 构造 SNMP v2c GET 请求报文 */
export function buildGetRequest(oids, community = "public", requestId = 1) {
  const varbinds = oids.map((o) => tlv(0x30, Buffer.concat([encOid(o), tlv(0x05, Buffer.alloc(0))])));
  const vbList = tlv(0x30, Buffer.concat(varbinds));
  const pdu = tlv(0xa0, Buffer.concat([encInt(requestId), encInt(0), encInt(0), vbList]));
  return tlv(0x30, Buffer.concat([encInt(1), tlv(0x04, Buffer.from(community, "utf8")), pdu]));
}

/** 解析 SNMP v2c 响应 */
export function parseResponse(buf) {
  const top = parseTLV(buf, 0);
  if (top.tag !== 0x30) throw new Error("SNMP 响应不是 SEQUENCE");
  const body = top.content;
  const ver = parseTLV(body, 0);
  const comm = parseTLV(body, ver.end);
  const pdu = parseTLV(body, comm.end);
  if (pdu.tag !== 0xa2) throw new Error("SNMP PDU tag 非 GetResponse(0xA2): 0x" + pdu.tag.toString(16));
  const pb = pdu.content;
  const rid = parseTLV(pb, 0);
  const errStatus = parseTLV(pb, rid.end);
  const errIndex = parseTLV(pb, errStatus.end);
  const vbList = parseTLV(pb, errIndex.end);
  const varbinds = [];
  let q = 0;
  while (q < vbList.content.length) {
    const vb = parseTLV(vbList.content, q);
    q = vb.end;
    const oidNode = parseTLV(vb.content, 0);
    const valNode = parseTLV(vb.content, oidNode.end);
    varbinds.push({ oid: decOid(oidNode.content), value: decodeAsn1Value(valNode), type: valNode.tag });
  }
  return {
    version: decInt(ver.content), community: comm.content.toString("utf8"),
    requestId: decInt(rid.content), errorStatus: decInt(errStatus.content), errorIndex: decInt(errIndex.content),
    varbinds,
  };
}
/* ------------------------------ 驱动工厂 ------------------------------ */
export function createSnmpDriver({ devices = [], points = [], options = {}, log = () => {}, emit = () => {} } = {}) {
  const community = options.community || "public";
  const port = options.port || 161;
  const timeout = options.timeout ?? 1500;

  const targets = [];
  for (const d of devices) {
    const pts = (points || []).filter((x) => x.devId === d.id && x.oid);
    targets.push({ dev: d, pts, failCount: 0, nextRetryAt: 0, online: false, lastErr: null, supported: pts.length > 0 });
  }

  let sock = null;
  let rid = 0;
  const pending = new Map();
  let state = "idle";
  let running = false;

  function openSock() {
    if (sock) return;
    sock = dgram.createSocket("udp4");
    sock.on("message", (msg) => {
      let res; try { res = parseResponse(msg); } catch (e) { return; }
      const p = pending.get(res.requestId);
      if (!p) return;
      pending.delete(res.requestId);
      clearTimeout(p.timer);
      p.resolve(res);
    });
    sock.on("error", (e) => { emit({ kind: "error", text: "SNMP UDP 错误：" + e.message }); });
  }

  function get(host, oids) {
    return new Promise((resolve, reject) => {
      const id = (rid = (rid + 1) & 0x7fffffff);
      const buf = buildGetRequest(oids, community, id);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("SNMP 超时 " + host)); }, timeout);
      pending.set(id, { resolve, timer });
      sock.send(buf, port, host, (err) => {
        if (err) { clearTimeout(timer); pending.delete(id); reject(err); }
      });
    });
  }

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
    openSock();
    for (const t of targets) {
      if (!t.supported) { ds[t.dev.id] = { online: false, rt: 0, reason: "点表无 SNMP OID" }; continue; }
      if (now < t.nextRetryAt) { ds[t.dev.id] = { online: false, rt: 0, reason: "退避重试中：" + (t.lastErr || "") }; continue; }
      const t0 = Date.now();
      try {
        const res = await get(t.dev.ip, t.pts.map((x) => x.oid));
        if (res.errorStatus !== 0) throw new Error("SNMP errorStatus=" + res.errorStatus + " errorIndex=" + res.errorIndex);
        const map = new Map(res.varbinds.map((v) => [v.oid, v.value]));
        let got = 0;
        for (const pt of t.pts) {
          const raw = map.get(pt.oid);
          let v = typeof raw === "string" ? Number(raw) : raw;
          if (!Number.isFinite(v)) { quality[pt.id] = "bad"; continue; }
          if (pt.kind === "di") v = v ? 1 : 0;
          else v = Math.round(v * (typeof pt.scale === "number" ? pt.scale : 1) * 1000) / 1000;
          values[pt.id] = v;
          quality[pt.id] = "good";
          got++;
        }
        t.online = got > 0; t.failCount = 0; t.lastErr = null;
        if (!t.online) throw new Error("响应中无可映射 OID");
        ds[t.dev.id] = { online: true, rt: Date.now() - t0 };
      } catch (e) {
        t.online = false; t.failCount++; t.lastErr = e.message;
        t.nextRetryAt = now + Math.min(30000, 1000 * Math.pow(2, Math.min(t.failCount, 5)));
        ds[t.dev.id] = { online: false, rt: 0, reason: e.message };
        setState("error", "SNMP 采集失败：" + t.dev.name + " -> " + e.message);
      }
    }
    const ok = targets.filter((t) => t.online).length;
    const usable = targets.filter((t) => t.supported).length;
    if (ok > 0) setState("connected", "SNMP 已连接 " + ok + " / " + usable + " 台设备 (community=" + community + ")");
    else if (state !== "connecting") setState("error", "SNMP 暂无可用设备（" + usable + " 台支持 OID，全部超时或不可达）");
    return { values, quality, devices: ds };
  }

  return {
    name: "snmp",
    protocols: ["snmp"],
    get state() { return state; },
    async start() {
      running = true; state = "connecting"; openSock();
      const usable = targets.filter((t) => t.supported).length;
      emit({ kind: "connecting", text: "SNMP v2c 驱动启动：community=" + community + "，端口 " + port + "，" + usable + " 台设备含 OID" });
      return true;
    },
    async stop() {
      running = false;
      for (const [, p] of pending) clearTimeout(p.timer);
      pending.clear();
      if (sock) { try { sock.close(); } catch (e) {} sock = null; }
      state = "idle";
    },
    async poll() { return poll(); },
    status() {
      return {
        state, community, port,
        devices: targets.map((t) => ({ id: t.dev.id, ip: t.dev.ip, oids: t.pts.length, online: t.online, error: t.lastErr || undefined })),
      };
    },
  };
}

export default createSnmpDriver;