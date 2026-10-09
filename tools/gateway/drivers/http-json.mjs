/* =========================================================================
 * tools/gateway/drivers/http-json.mjs — 厂家 HTTP-JSON 南向驱动（零依赖）
 *  - 定时 GET 厂家 JSON 接口（可带 token / 自定义请求头 / URL 模板）
 *  - 按点表映射取值：point.addr(字符串路径) / point.key / point.id / point.mqtt
 *    支持 data / result 包裹层与 points 数组
 *  - 连接状态如实上报（connecting/connected/error），失败指数退避
 * ========================================================================= */
import http from "node:http";
import https from "node:https";

/** 极简 HTTP(S) 请求 */
export function httpRequest(url, { method = "GET", headers = {}, body = null, timeout = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(new Error("非法 URL: " + url)); }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method, headers, timeout }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; if (data.length > 4e6) { req.destroy(new Error("响应过大")); } });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("timeout", () => req.destroy(new Error("请求超时 " + url)));
    req.on("error", (e) => reject(e));
    if (body) req.write(body);
    req.end();
  });
}

/** 按点路径取值（先整体 key，再逐级下钻） */
export function jsonPath(obj, path) {
  if (obj == null || path == null) return undefined;
  if (typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  let cur = obj;
  for (const seg of String(path).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

function isPresent(v) {
  return v !== undefined && v !== null && (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.trim() !== ""));
}

/** 从一台设备的 JSON 响应中取某测点的值 */
export function pickValue(json, pt) {
  const layers = [json];
  if (json && typeof json === "object") {
    if (json.data && typeof json.data === "object") layers.push(json.data);
    if (json.result && typeof json.result === "object") layers.push(json.result);
    if (Array.isArray(json.points)) layers.push(json.points);
  }
  const cands = [];
  if (typeof pt.addr === "string" && pt.addr && !/^\d+$/.test(pt.addr)) cands.push(pt.addr);
  cands.push(pt.key, pt.id);
  if (pt.mqtt) { cands.push(pt.mqtt); cands.push(String(pt.mqtt).split("/").pop()); }
  for (const layer of layers) {
    if (layer == null || typeof layer !== "object") continue;
    for (const c of cands) {
      if (c == null) continue;
      const v = jsonPath(layer, c);
      if (isPresent(v)) return v;
      // 数组元素：按 id / pointId / key 匹配
      if (Array.isArray(layer)) {
        for (const item of layer) {
          if (item && typeof item === "object" && (item.id === c || item.pointId === c || item.key === c)) {
            const iv = item.value !== undefined ? item.value : item.v;
            if (isPresent(iv)) return iv;
          }
        }
      }
    }
  }
  return undefined;
}
/* ------------------------------ 驱动工厂 ------------------------------ */
const isHttpHost = (h) => typeof h === "string" && h.length > 0 && !/^(com\d+|tty|\/dev\/)/i.test(h);

export function createHttpJsonDriver({ devices = [], points = [], options = {}, log = () => {}, emit = () => {} } = {}) {
  const timeout = options.timeout ?? 2000;
  const path = options.path || "/api/points";
  const headers = Object.assign({ accept: "application/json" }, options.headers || {});
  if (options.token) headers.authorization = "Bearer " + options.token;

  function resolveUrl(dev) {
    if (typeof options.url === "function") return options.url(dev);
    const port = options.port || dev.port || 80;
    const tpl = options.url || options.baseUrl;
    if (typeof tpl === "string") {
      return tpl.replace(/\{ip\}/g, dev.ip).replace(/\{port\}/g, port).replace(/\{id\}/g, dev.id).replace(/\{path\}/g, path);
    }
    return "http://" + dev.ip + ":" + port + path;
  }

  const targets = devices.map((dev) => ({
    dev, pts: points.filter((x) => x.devId === dev.id),
    url: resolveUrl(dev),
    supported: isHttpHost(dev.ip),
    online: false, failCount: 0, nextRetryAt: 0, lastErr: null,
  }));

  let state = "idle";
  let running = false;

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
    await Promise.all(targets.map(async (t) => {
      if (!t.supported) { ds[t.dev.id] = { online: false, rt: 0, reason: "无 HTTP 地址（串口设备需网关转 HTTP）" }; return; }
      if (now < t.nextRetryAt) { ds[t.dev.id] = { online: false, rt: 0, reason: "退避重试中：" + (t.lastErr || "") }; return; }
      const t0 = Date.now();
      try {
        const res = await httpRequest(t.url, { method: "GET", headers, timeout });
        if (res.status < 200 || res.status >= 300) throw new Error("HTTP " + res.status);
        let json;
        try { json = JSON.parse(res.body); } catch (e) { throw new Error("响应不是合法 JSON"); }
        let got = 0;
        for (const pt of t.pts) {
          const raw = pickValue(json, pt);
          if (raw === undefined) { quality[pt.id] = "bad"; continue; }
          let v = typeof raw === "boolean" ? (raw ? 1 : 0) : Number(raw);
          if (!Number.isFinite(v)) { quality[pt.id] = "bad"; continue; }
          v = pt.kind === "di" ? (v ? 1 : 0) : Math.round(v * (typeof pt.scale === "number" ? pt.scale : 1) * 1000) / 1000;
          values[pt.id] = v;
          quality[pt.id] = "good";
          got++;
        }
        if (got === 0) throw new Error("响应中未匹配到任何测点（检查 path/addr 映射）");
        t.online = true; t.failCount = 0; t.lastErr = null;
        ds[t.dev.id] = { online: true, rt: Date.now() - t0 };
      } catch (e) {
        t.online = false; t.failCount++; t.lastErr = e.message;
        t.nextRetryAt = now + Math.min(30000, 1000 * Math.pow(2, Math.min(t.failCount, 5)));
        ds[t.dev.id] = { online: false, rt: 0, reason: e.message };
        setState("error", "HTTP-JSON 采集失败：" + t.dev.name + " -> " + e.message);
      }
    }));
    const ok = targets.filter((t) => t.online).length;
    if (ok > 0) setState("connected", "HTTP-JSON 已连接 " + ok + " / " + targets.length + " 台设备");
    else if (state !== "connecting") setState("error", "HTTP-JSON 暂无可用设备（" + targets.length + " 台全部失败）");
    return { values, quality, devices: ds };
  }

  return {
    name: "http-json",
    protocols: ["http-json"],
    get state() { return state; },
    async start() {
      running = true; state = "connecting";
      emit({ kind: "connecting", text: "HTTP-JSON 驱动启动，共 " + targets.length + " 台设备，path=" + path });
      return true;
    },
    async stop() { running = false; state = "idle"; },
    async poll() { return poll(); },
    status() {
      return {
        state, path,
        devices: targets.map((t) => ({ id: t.dev.id, url: t.url, supported: t.supported, online: t.online, error: t.lastErr || undefined })),
      };
    },
  };
}

export default createHttpJsonDriver;