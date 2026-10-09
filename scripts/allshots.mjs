/* scripts/allshots.mjs — 批量截图 6 个页面 + 语音巡检剧情，供 QA 与交付验收 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const jobs = [
  ["overview", null, 3200, "shots/page_overview.png"],
  ["overview", null, 2200, "shots/page_intro.png", "1"],
  ["monitor", null, 3200, "shots/page_monitor.png"],
  ["assets", null, 3000, "shots/page_assets.png"],
  ["energy", null, 3000, "shots/page_energy.png"],
  ["alarms", "IDC.app.goto('alarms')", 3200, "shots/page_alarms.png"],
  ["workorder", "IDC.app.goto('workorder')", 3000, "shots/page_workorder.png"],
  ["donghuan", null, 4500, "shots/page_donghuan.png"],
  ["plan", null, 5000, "shots/page_plan.png"],
  ["monitor", "IDC.app.ask('巡检 A-02')", 5200, "shots/demo_1_inspect.png"],
  ["monitor", "IDC.app.ask('当前有哪些告警')", 7000, "shots/demo_2_alarms.png"],
  ["monitor", "IDC.app.ask('检查电力数据')", 6000, "shots/demo_3_power.png"],
  ["monitor", "IDC.app.ask('生成工单，派人处理')", 6500, "shots/demo_4_wo.png"],
  ["workorder", "IDC.app.ask('现场处理完成，复核并归档')", 7000, "shots/demo_5_close.png"],
  ["overview", "IDC.app.ask('整间机房总览')", 5200, "shots/demo_6_room.png"],
  ["donghuan", "IDC.app.ask('UPS 状态')", 6500, "shots/demo_7_ups.png"],
  ["plan", "IDC.app.ask('在图纸上定位 A-02')", 6500, "shots/demo_8_plan.png"],
];
let fail = 0;
for (const [page, ev, wait, out, intro] of jobs) {
  const args = ["scripts/shot.mjs", "--page", page, "--w", "1440", "--h", "810", "--wait", String(wait), "--out", out];
  if (ev) args.push("--eval", ev);
  if (intro) args.push("--intro", intro);
  const r = spawnSync(node, args, { cwd: root, encoding: "utf8" });
  const ok = r.status === 0;
  if (!ok) fail++;
  const last = (r.stdout || "").split("\n").filter((l) => /errors:|screenshot|webgl/.test(l)).join(" | ");
  console.log(`${ok ? "OK  " : "FAIL"} ${out.padEnd(30)} ${last}`);
}
console.log(fail ? `\n${fail} 张截图存在控制台错误` : "\n全部页面截图完成，0 错误");
process.exit(fail ? 1 : 0);