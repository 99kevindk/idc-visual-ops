/* SPDX-License-Identifier: AGPL-3.0-or-later
 * IDC 可视化运维项目（IDC Visual Ops）· Copyright (c) 2026 99kevindk
 * 本文件以 AGPL-3.0-or-later 开源；闭源商业集成 / SaaS 托管需另行取得商业授权（见 COMMERCIAL-LICENSE.md）。
 */
/* tools/gateway/pointtable.mjs
 * 点表加载器：src/pointtable.js 是「浏览器 ES 模块 + Node 共用」的唯一数据源，
 * 但本仓库不含 package.json（无 "type":"module"），低版本 Node 会把 .js 当 CommonJS。
 * 这里以 data: URL 形式导入（data: URL 恒为 ESM），从而不依赖任何配置文件与 Node 版本特性。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/pointtable.js");
const src = fs.readFileSync(FILE, "utf8");
const mod = await import("data:text/javascript;charset=utf-8;base64," + Buffer.from(src, "utf8").toString("base64"));
export const SITE = mod.SITE;
export const DEVICES = mod.DEVICES;
export const POINTS = mod.POINTS;
export const DEVICE_BY_ID = mod.DEVICE_BY_ID;
export const POINT_BY_ID = mod.POINT_BY_ID;
export const pointsOf = mod.pointsOf;
export const devicesByType = mod.devicesByType;
export const pointTable = mod.pointTable;
export const pointTableCsv = mod.pointTableCsv;
export default mod;