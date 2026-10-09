// headless Chrome 截图 + 控制台错误收集（QA / 自检用）
// 用法: node scripts/shot.mjs --page overview --w 1440 --h 810 --wait 2500 --out shots/overview.png
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];

const W = +(args.w || 1440), H = +(args.h || 810);
const wait = +(args.wait || 2500);
const outPath = path.resolve(root, args.out || "shots/shot.png");
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    "--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars",
    "--allow-file-access-from-files", "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader", `--window-size=${W},${H}`,
  ],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [], logs = [];
page.on("console", (m) => { logs.push(`[${m.type()}] ${m.text()}`); if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + (e && e.message)));

let url = args.url || pathToFileURL(path.join(root, "index.html")).href;
if (args.page) url += (url.includes("?") ? "&" : "?") + "page=" + args.page;
if (args.intro !== "1") url += (url.includes("?") ? "&" : "?") + "intro=0";
await page.goto(url, { waitUntil: "load", timeout: 60000 });
const evalCode = args.eval || (args.evalfile ? fs.readFileSync(path.resolve(root, args.evalfile), "utf8") : null);
if (evalCode) { try { await page.evaluate(evalCode); } catch (e) { errors.push("EVAL: " + e.message); } }
await new Promise((r) => setTimeout(r, wait));
await page.screenshot({ path: outPath });

const info = await page.evaluate(() => {
  const gl = document.querySelector("canvas#gl");
  let webgl = "none";
  try { webgl = gl && gl.getContext("webgl2") ? "webgl2" : (gl && gl.getContext("webgl") ? "webgl" : "none"); } catch (e) { webgl = "err"; }
  return {
    title: document.title,
    page: document.getElementById("stage") && document.getElementById("stage").dataset.page,
    canvas: gl ? `${gl.width}x${gl.height}` : "missing",
    webgl,
    hudRoot: !!document.getElementById("hud-root"),
    panels: document.querySelectorAll("[data-panel]").length,
    bodyText: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 400),
  };
});
console.log(JSON.stringify(info, null, 1));
if (logs.length) console.log("--- console (last 12) ---\n" + logs.slice(-12).join("\n"));
console.log("--- errors: " + errors.length + " ---");
errors.slice(0, 12).forEach((e) => console.log("  " + e));
console.log("screenshot -> " + outPath);
await browser.close();
process.exit(errors.length ? 2 : 0);