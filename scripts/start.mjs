/* scripts/start.mjs — 起本地静态服务，监听成功后再打开浏览器（避免"先开浏览器→连不上"）
 * 用法: node scripts/start.mjs [port]
 * 环境变量: IDC_NO_BROWSER=1 只起服务不开浏览器（自测用）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".map": "application/json",
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(root, path.normalize(p).replace(/^([/\\])+/, ""));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("404 Not Found: " + p);
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
});

function openBrowser(url) {
  if (process.env.IDC_NO_BROWSER === "1") { console.log("[start] 已跳过打开浏览器 (IDC_NO_BROWSER=1)"); return; }
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    console.log("[start] 已调用系统浏览器打开: " + url);
  } catch (e) { console.log("[start] 自动打开浏览器失败，请手动访问: " + url); }
}

function listen(port, triesLeft) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && triesLeft > 0) {
      console.log(`[start] 端口 ${port} 被占用，改用 ${port + 1}`);
      listen(port + 1, triesLeft - 1);
    } else {
      console.error("[start] 启动失败: " + err.message);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${server.address().port}/`;
    console.log("============================================================");
    console.log("  IDC 智能运维管理平台 · 3D 机房可视化运维（语音巡检 Demo）");
    console.log("  服务已启动: " + url);
    console.log("  语音识别需要 localhost 环境；按 Ctrl+C 结束服务");
    console.log("============================================================");
    openBrowser(url);
  });
}

fs.mkdirSync(path.join(root, "shots"), { recursive: true });
listen(+(process.argv[2] || 8123), 12);