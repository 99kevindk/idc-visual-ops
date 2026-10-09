/* SPDX-License-Identifier: AGPL-3.0-or-later
 * IDC 可视化运维项目（IDC Visual Ops）· Copyright (c) 2026 99kevindk
 * 本文件以 AGPL-3.0-or-later 开源；闭源商业集成 / SaaS 托管需另行取得商业授权（见 COMMERCIAL-LICENSE.md）。
 *//* =========================================================================
 * tools/gateway/ws.mjs — 极简 WebSocket 服务端（RFC6455，纯 Node 标准库）
 *  - 握手：Sec-WebSocket-Accept = base64(sha1(clientKey + GUID))
 *  - 帧解析：7/16/64 位长度、掩码解掩、TEXT/BIN/CONT/PING/PONG/CLOSE、分片重组
 *  - 服务端 -> 客户端 的帧不掩码（协议规定）；客户端 -> 服务端 必须掩码
 *  - 不校验 Origin（规范要求前端可直连）
 * ========================================================================= */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MAX_PAYLOAD = 4 * 1024 * 1024; // 单条消息 4MB 上限，防滥用

export const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** 计算握手应答 key */
export function acceptKey(clientKey) {
  return createHash("sha1").update(String(clientKey).trim() + WS_GUID).digest("base64");
}

/** RFC6455 帧头长度编码（service -> client，不掩码） */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
  return Buffer.concat([header, payload]);
}

/** 解掩码（原地） */
function unmask(buf, key) {
  for (let i = 0; i < buf.length; i++) buf[i] ^= key[i & 3];
  return buf;
}

export class WSConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.remote = `${(socket.remoteAddress || "?").replace(/^::ffff:/, "")}:${socket.remotePort || "?"}`;
    this.path = req && req.url ? req.url : "/dh";
    this.readyState = "open"; // open | closing | closed
    this.binaryType = "string";
    this._buf = Buffer.alloc(0);
    this._frag = null; // { opcode, chunks: [] }
    this._closedEmitted = false;
    socket.setNoDelay(true);
    socket.on("data", (d) => {
      try { this._feed(d); } catch (e) { this.emit("error", e); this.destroy(); }
    });
    socket.on("close", () => this._finishClose());
    socket.on("end", () => this._finishClose());
    socket.on("error", (e) => { this.emit("error", e); this._finishClose(); });
  }

  /** 接入来自客户端的原始字节（HTTP upgrade 的 head 也走这里） */
  feed(chunk) { this._feed(chunk); }

  _feed(chunk) {
    if (this.readyState === "closed") return;
    this._buf = Buffer.concat([this._buf, chunk]);
    this._parse();
  }

  _parse() {
    for (;;) {
      const b = this._buf;
      if (b.length < 2) return;
      const b0 = b[0], b1 = b[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (rsv !== 0) { this.close(1002, "RSV must be 0"); return; }
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) { this.close(1009, "message too big"); return; }
        len = Number(big); off = 10;
      }
      if (len > MAX_PAYLOAD) { this.close(1009, "message too big"); return; }
      // 协议规定：客户端 -> 服务端 必须掩码
      if (!masked) { this.close(1002, "client frame must be masked"); return; }
      if (b.length < off + 4) return;
      const maskKey = b.subarray(off, off + 4); off += 4;
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      unmask(payload, maskKey);
      this._buf = b.subarray(off + len);
      this._handleFrame(fin, opcode, payload);
      if (this.readyState === "closed") return;
    }
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP.CONT: {
        if (!this._frag) { this.close(1002, "unexpected continuation"); return; }
        this._frag.chunks.push(payload);
        if (fin) {
          const op = this._frag.opcode;
          const data = Buffer.concat(this._frag.chunks);
          this._frag = null;
          this._deliver(op, data);
        }
        break;
      }
      case OP.TEXT:
      case OP.BIN: {
        if (this._frag) { this.close(1002, "fragment in progress"); return; }
        if (fin) this._deliver(opcode, payload);
        else this._frag = { opcode, chunks: [payload] };
        break;
      }
      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (this.readyState === "open") {
          this.readyState = "closing";
          try { this.socket.write(encodeFrame(OP.CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0))); } catch {}
        }
        this.readyState = "closed";
        try { this.socket.end(); } catch {}
        this.emit("close", code, payload.subarray(2).toString("utf8"));
        this._finishClose();
        break;
      }
      case OP.PING: {
        try { this.socket.write(encodeFrame(OP.PONG, payload)); } catch {}
        this.emit("ping", payload);
        break;
      }
      case OP.PONG:
        this.emit("pong", payload);
        break;
      default:
        this.close(1002, "bad opcode " + opcode);
    }
  }

  _deliver(opcode, data) {
    if (opcode === OP.TEXT) this.emit("message", data.toString("utf8"), false);
    else this.emit("message", data, true);
  }

  /** 发送文本（对象自动 JSON 序列化）或二进制 */
  send(data) {
    if (this.readyState !== "open" || !this.socket.writable) return false;
    let buf, op = OP.TEXT;
    if (Buffer.isBuffer(data)) { buf = data; op = OP.BIN; }
    else if (typeof data === "string") buf = Buffer.from(data, "utf8");
    else buf = Buffer.from(JSON.stringify(data), "utf8");
    try { this.socket.write(encodeFrame(op, buf)); return true; } catch (e) { this.emit("error", e); return false; }
  }

  sendJson(obj) { return this.send(JSON.stringify(obj)); }

  ping(payload = Buffer.alloc(0)) {
    if (this.readyState !== "open") return false;
    try { this.socket.write(encodeFrame(OP.PING, payload)); return true; } catch { return false; }
  }

  close(code = 1000, reason = "") {
    if (this.readyState === "closed") return;
    const reasonBuf = Buffer.from(String(reason), "utf8").subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    if (this.readyState === "open") {
      this.readyState = "closing";
      try { this.socket.write(encodeFrame(OP.CLOSE, payload)); } catch {}
    }
    this.readyState = "closed";
    setTimeout(() => { try { this.socket.end(); } catch {} }, 20).unref?.();
  }

  destroy() {
    this.readyState = "closed";
    try { this.socket.destroy(); } catch {}
    this._finishClose();
  }

  _finishClose() {
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this.readyState = "closed";
    this.emit("close", 1006, "");
  }
}

export class WebSocketServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string[]} [opts.paths] 允许升级的路径，默认 ["/dh", "/"]
   * @param {number} [opts.heartbeatMs] 心跳间隔（0 关闭）
   */
  constructor(opts = {}) {
    super();
    this.paths = opts.paths || ["/dh", "/"];
    this.clients = new Set();
    this.heartbeatMs = opts.heartbeatMs ?? 30000;
    this._hb = null;
  }

  /** 挂到原生 http.Server 上 */
  attach(httpServer) {
    httpServer.on("upgrade", (req, socket, head) => {
      let pathname = "/";
      try { pathname = new URL(req.url, "http://localhost").pathname; } catch { pathname = "/"; }
      if (!this.paths.includes(pathname)) {
        try { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); } catch {}
        socket.destroy();
        return;
      }
      this.handleUpgrade(req, socket, head);
    });
    if (this.heartbeatMs > 0) {
      this._hb = setInterval(() => {
        for (const c of this.clients) {
          if (c.readyState === "open") { c.isAlive = false; c.ping(); }
        }
      }, this.heartbeatMs);
      this._hb.unref?.();
    }
    return this;
  }

  handleUpgrade(req, socket, head) {
    const key = req.headers["sec-websocket-key"];
    const upgrade = String(req.headers["upgrade"] || "").toLowerCase();
    const version = String(req.headers["sec-websocket-version"] || "13");
    if (!key || upgrade !== "websocket" || version !== "13") {
      try { socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch {}
      socket.destroy();
      return;
    }
    const res = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Accept: " + acceptKey(key),
      "", "",
    ].join("\r\n");
    try { socket.write(res); } catch { socket.destroy(); return; }
    socket.setTimeout(0);
    const conn = new WSConnection(socket, req);
    conn.isAlive = true;
    conn.on("pong", () => { conn.isAlive = true; });
    conn.on("close", () => this.clients.delete(conn));
    this.clients.add(conn);
    if (head && head.length) conn.feed(head);
    this.emit("connection", conn, req);
  }

  broadcast(data) {
    let n = 0;
    for (const c of this.clients) if (c.send(data)) n++;
    return n;
  }

  get size() { return this.clients.size; }

  close() {
    if (this._hb) clearInterval(this._hb);
    for (const c of [...this.clients]) c.close(1001, "server shutdown");
    this.clients.clear();
  }
}

export default WebSocketServer;