/* SPDX-License-Identifier: AGPL-3.0-or-later
 * IDC 可视化运维项目（IDC Visual Ops）· Copyright (c) 2026 99kevindk
 * 本文件以 AGPL-3.0-or-later 开源；闭源商业集成 / SaaS 托管需另行取得商业授权（见 COMMERCIAL-LICENSE.md）。
 */
/* =========================================================================
 *  src/props.js — 机房拟真组件库（精密空调 / UPS / 配电柜 / 电池柜 / 门禁 /
 *                 摄像头 / 灭火器 / 吊顶灯盘 / 监控大屏 / KVM 控制台 / 温湿度传感器）
 *  依赖：textures.js（程序化 PBR 贴图与材质）
 *  约定：每个 builder 返回 THREE.Group；原点在**底面中心**，正面朝 **+Z**，单位为米。
 * ========================================================================= */
import * as THREE from "../vendor/three.module.js";
import { TEX, MAT, pbr } from "./textures.js";

const BOX = new THREE.BoxGeometry(1, 1, 1);
function box(mat, w, h, d, x, y, z, parent) {
  const m = new THREE.Mesh(BOX, mat);
  m.scale.set(w, h, d); m.position.set(x || 0, y == null ? h / 2 : y, z || 0);
  m.castShadow = true; m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}
function panel(mat, w, h, x, y, z, ry, parent, rx) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.position.set(x, y, z); if (ry) m.rotation.y = ry; if (rx) m.rotation.x = rx;
  if (parent) parent.add(m);
  return m;
}
function rep(mat, rx, ry) {
  ["map", "normalMap", "roughnessMap", "alphaMap", "emissiveMap"].forEach((k) => {
    const t = mat[k]; if (t && t.repeat) { t.repeat.set(rx, ry); t.needsUpdate = true; }
  });
  return mat;
}
const dark = () => MAT.solid(0x1c2128, 0.6, 0.42);
const shell = () => MAT.solid(0x39414b, 0.55, 0.42);

export const PROPS = {
  /** 精密空调（下送风，正面进风网孔 + 顶部出风 + 触摸屏） */
  ac(o) {
    o = o || {};
    const g = new THREE.Group();
    const W = o.w || 0.85, H = o.h || 2.05, D = o.d || 0.72;
    box(shell(), W, H, D, 0, H / 2, 0, g);
    // 正面网孔门 + 边框
    const doorMat = MAT.rackDoor();
    panel(doorMat, W - 0.1, H - 0.62, 0, H / 2 - 0.2, D / 2 + 0.002, 0, g);
    box(MAT.rackFrame(), W - 0.06, H - 0.58, 0.03, 0, H / 2 - 0.2, D / 2 - 0.015, g);
    panel(doorMat, W - 0.1, H - 0.62, 0, H / 2 - 0.2, D / 2 + 0.012, 0, g);
    // 面板显示屏
    const scr = MAT.screen("PRECISION AC", ["MODE   COOL", "SET    22.0C", "RET    24.3C", "HUM    45.2%"], "#5fe6ff");
    panel(scr, W * 0.62, W * 0.34, 0, H - 0.34, D / 2 + 0.014, 0, g);
    // 顶部出风格栅
    const gm = pbr(TEX.floorGrille(), { metalness: 0.5, roughness: 0.55, color: 0x9fb0c0 });
    panel(gm, W - 0.14, D - 0.14, 0, H + 0.005, 0, 0, g, -Math.PI / 2);
    // 品牌条 + 底部踢脚
    box(MAT.label(o.brand || "精密空调", { sub: "PRECISION AC", w: 512, h: 96, size: 54 }), W * 0.72, 0.085, 0.012, 0, H - 0.075, D / 2 + 0.014, g);
    box(dark(), W + 0.04, 0.06, D + 0.04, 0, 0.03, 0, g);
    return g;
  },

  /** UPS 机柜（双屏 + 断路器排 + 状态灯） */
  ups(o) {
    o = o || {};
    const g = new THREE.Group();
    const W = o.w || 0.8, H = o.h || 2.0, D = o.d || 0.85;
    box(shell(), W, H, D, 0, H / 2, 0, g);
    const m = MAT.rackSide(); rep(m, 1, 1);
    panel(m, W - 0.06, H - 0.06, 0, H / 2, D / 2 + 0.004, 0, g);
    const scr = MAT.screen(o.title || "UPS 200kVA", ["INPUT   380V", "OUTPUT  380V", "LOAD     68%", "BATT     96%"], "#7effa8");
    panel(scr, W * 0.66, W * 0.4, 0, H - 0.36, D / 2 + 0.016, 0, g);
    box(MAT.label(o.title || "UPS", { sub: "不间断电源", w: 512, h: 110, size: 62 }), W * 0.7, 0.1, 0.012, 0, H - 0.075, D / 2 + 0.016, g);
    // 断路器排
    for (let i = 0; i < 6; i++) {
      box(dark(), W * 0.11, 0.13, 0.05, -W * 0.3 + i * W * 0.12, H * 0.42, D / 2 + 0.02, g);
    }
    // 状态灯
    [["#4cff8a", 1], ["#ffb648", 1], ["#ff4d4f", 0.3]].forEach(([c, on], i) => {
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8),
        MAT.ledStrip(c, on ? 2.6 : 0.4));
      led.position.set(W * 0.3 + i * 0.05, H * 0.3, D / 2 + 0.02); g.add(led);
    });
    box(dark(), W + 0.05, 0.07, D + 0.05, 0, 0.035, 0, g);
    return g;
  },

  /** 低压配电柜（多排断路器 + 仪表 + 母排） */
  pduCabinet(o) {
    o = o || {};
    const g = new THREE.Group();
    const W = o.w || 0.9, H = o.h || 2.1, D = o.d || 0.65;
    box(shell(), W, H, D, 0, H / 2, 0, g);
    panel(rep(MAT.rackSide(), 1, 1), W - 0.06, H - 0.06, 0, H / 2, D / 2 + 0.004, 0, g);
    // 三排断路器
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 9; i++) {
        box(dark(), W * 0.075, 0.11, 0.045, -W * 0.36 + i * W * 0.09, H * 0.34 + r * 0.3, D / 2 + 0.02, g);
      }
      box(MAT.rackFrame(), W - 0.12, 0.03, 0.02, 0, H * 0.34 + r * 0.3 + 0.09, D / 2 + 0.02, g);
    }
    const scr = MAT.screen(o.title || "配电柜 PDU", ["A 相  128A", "B 相  132A", "C 相  126A", "PF     0.98"], "#ffd166");
    panel(scr, W * 0.7, W * 0.36, 0, H - 0.3, D / 2 + 0.016, 0, g);
    return g;
  },

  /** 电池柜 / 电池架 */
  battery(o) {
    o = o || {};
    const g = new THREE.Group();
    const W = o.w || 0.8, H = o.h || 1.9, D = o.d || 0.8;
    box(shell(), W, H, D, 0, H / 2, 0, g);
    panel(rep(MAT.rackSide(), 1, 1), W - 0.06, H - 0.06, 0, H / 2, D / 2 + 0.004, 0, g);
    for (let r = 0; r < 5; r++) {
      const y = H * 0.13 + r * (H / 5.3);
      box(MAT.solid(0x39424d, 0.5, 0.5), W - 0.1, H / 7.2, D - 0.12, 0, y, 0, g);          // 电池模块
      box(MAT.solid(0x8a939e, 0.85, 0.32), W - 0.14, 0.02, 0.02, 0, y + H / 14.4, D / 2 - 0.035, g); // 端子排
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.01, 8, 6), MAT.ledStrip("#4cff8a", 2.0));
      led.position.set(W * 0.32, y, D / 2 + 0.02); g.add(led);
    }
    box(MAT.label("电池柜", { sub: "BATTERY  ·  480V", w: 512, h: 110, size: 60 }), W * 0.72, 0.09, 0.012, 0, H - 0.075, D / 2 + 0.014, g);
    return g;
  },

  /** 半球摄像头（吸顶） */
  cctv(o) {
    o = o || {};
    const g = new THREE.Group();
    box(dark(), 0.13, 0.05, 0.13, 0, 0.025, 0, g);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.075, 18, 12, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5),
      new THREE.MeshPhysicalMaterial({ color: 0x0b0f14, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.85 }));
    dome.position.y = 0.02; g.add(dome);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.03, 0.03, 16), MAT.solid(0x0a0d11, 0.6, 0.2));
    lens.position.y = -0.005; g.add(lens);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), MAT.ledStrip("#ff4d4f", 3));
    led.position.set(0.045, 0.02, 0.045); g.add(led);
    return g;
  },

  /** 门禁读卡器 + 出门按钮 */
  badge(o) {
    o = o || {};
    const g = new THREE.Group();
    box(dark(), 0.09, 0.14, 0.028, 0, 0.07, 0, g);
    const scr = MAT.screen("门禁", ["READY", "ID: 8F2A"], "#7effa8");
    panel(scr, 0.07, 0.05, 0, 0.11, 0.016, 0, g);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), MAT.ledStrip("#4cff8a", 2.4));
    led.position.set(0, 0.04, 0.016); g.add(led);
    return g;
  },

  /** 手提式灭火器（含支架） */
  extinguisher(o) {
    o = o || {};
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.42, 18), MAT.solid(0xc02b2b, 0.35, 0.4));
    body.position.y = 0.28; body.castShadow = true; g.add(body);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.06, 12), MAT.solid(0x2b2f35, 0.7, 0.35));
    top.position.y = 0.52; g.add(top);
    box(dark(), 0.2, 0.04, 0.06, 0, 0.1, 0, g);
    return g;
  },

  /** 吊顶 LED 灯盘（自发光 + 光晕精灵） */
  ceilingLight(o) {
    o = o || {};
    const g = new THREE.Group();
    const W = o.w || 1.2, D = o.d || 0.3;
    box(MAT.solid(0x2a3038, 0.6, 0.4), W + 0.06, 0.05, D + 0.05, 0, 0.025, 0, g);
    const panelMat = new THREE.MeshStandardMaterial({ color: 0xf2fbff, emissive: new THREE.Color(0xdfefff), emissiveIntensity: o.intensity || 2.4, roughness: 0.4 });
    panel(panelMat, W, D, 0, -0.004, 0, 0, g, Math.PI / 2);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX.glow({ color: "#cfe8ff", soft: true }).map, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, opacity: 0.55,
    }));
    spr.scale.set(W * 2.4, D * 5.5, 1); spr.position.y = -0.1; g.add(spr);
    return g;
  },

  /** 墙上监控大屏（多画面） */
  monitorWall(o) {
    o = o || {};
    const g = new THREE.Group();
    const cols = o.cols || 3, rows = o.rows || 2, cw = o.cw || 0.9, ch = o.ch || 0.55, gap = 0.02;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c + 1;
        const mat = MAT.screen("CAM-0" + idx, ["LIVE  " + (idx < 10 ? "0" + idx : idx), "1080P  25FPS"], "#5fe6ff");
        panel(mat, cw, ch, (c - (cols - 1) / 2) * (cw + gap), (rows - 1 - r) * (ch + gap) + ch / 2 + 0.06, 0.03, 0, g);
        box(MAT.solid(0x14181d, 0.5, 0.5), cw + 0.03, ch + 0.03, 0.03, (c - (cols - 1) / 2) * (cw + gap), (rows - 1 - r) * (ch + gap) + ch / 2 + 0.06, 0.012, g);
      }
    }
    return g;
  },

  /** KVM 控制台（折叠屏 + 键盘抽屉） */
  kvm(o) {
    o = o || {};
    const g = new THREE.Group();
    box(shell(), 0.09, 1.0, 0.75, -0.28, 0.5, 0, g);
    const scr = MAT.screen("KVM 控制台", ["HOST  A-02-U21", "iBMC  192.168.10.21", "POWER ON"], "#5fe6ff");
    panel(scr, 0.4, 0.26, 0, 0.98, 0.02, 0, g, -0.35);
    box(dark(), 0.42, 0.03, 0.16, 0, 0.82, 0.2, g);
    box(MAT.solid(0x22262c, 0.4, 0.5), 0.44, 0.02, 0.2, 0, 0.78, 0.22, g);
    return g;
  },

  /** 温湿度传感器（墙装小盒 + LED） */
  sensor(o) {
    o = o || {};
    const g = new THREE.Group();
    box(MAT.solid(0xe8eef4, 0.25, 0.45), 0.12, 0.15, 0.032, 0, 0.075, 0, g);
    const scr = MAT.screen("24.3C 45.2%", ["TEMP 24.3C", "HUM  45.2%"], "#7effa8");
    panel(scr, 0.062, 0.036, 0, 0.09, 0.018, 0, g);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.007, 8, 6), MAT.ledStrip("#4cff8a", 2.2));
    led.position.set(0, 0.036, 0.018); g.add(led);
    return g;
  },

  /** 区域门牌 / 分区标识（发光） */
  sign(o) {
    o = o || {};
    const g = new THREE.Group();
    const m = MAT.label(o.text || "A 区", { sub: o.sub || "ZONE A", w: 512, h: 200, size: 96, border: "#22d3ee" });
    box(m, o.w || 0.7, o.h || 0.27, 0.02, 0, 0, 0, g);
    return g;
  },
};

export default PROPS;