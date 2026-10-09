import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const minify = process.argv.includes("--minify");

const result = await build({
  entryPoints: [path.join(root, "src/app.js")],
  bundle: true,
  outfile: path.join(root, "dist/app.js"),
  format: "iife",
  target: ["chrome100"],
  sourcemap: false,
  minify,
  legalComments: "none",
  logLevel: "info",
});

// 顺便报告体积，方便 QA 检查
const size = fs.statSync(path.join(root, "dist/app.js")).size;
console.log(`dist/app.js = ${(size / 1024).toFixed(1)} KB  (minify=${minify})`);