/* SPDX-License-Identifier: AGPL-3.0-or-later
 * IDC 可视化运维项目（IDC Visual Ops）· Copyright (c) 2026 99kevindk
 * 本文件以 AGPL-3.0-or-later 开源；闭源商业集成 / SaaS 托管需另行取得商业授权（见 COMMERCIAL-LICENSE.md）。
 */
/* =========================================================================
 *  src/scene3d.js — IDC 智能运维管理平台 · Three.js 三维机房数字孪生（拟真 PBR 版）
 *  依赖：three r169 / OrbitControls / textures.js(程序化 PBR 贴图) / props.js(机房家具)
 *  对外接口：window.IDC.scene（init/frame/resize/setView/focusRack/openRack/
 *            highlightRack/setMode/setAlarmBeacons/assistantTo/setAssistantSpeaking/
 *            resetCamera/playIntro），事件 rack:select / device:select。
 *  质量档：?quality=low 关阴影与环境贴图（headless 截图提速），默认 high。
 * ========================================================================= */
import * as THREE from "../vendor/three.module.js";
import { OrbitControls } from "../vendor/OrbitControls.js";
import { RoomEnvironment } from "../vendor/RoomEnvironment.js";
import { initTextures, TEX, MAT, pbr } from "./textures.js";
import PROPS from "./props.js";
import { DEVICES as DH_DEVICES, POINTS as DH_POINTS } from "./pointtable.js";

(function (global) {
  "use strict";
  const IDC = (global.IDC = global.IDC || {});

  /* ======================= 运行参数 ======================= */
  const QS = new URLSearchParams((global.location && global.location.search) || "");
  const LOW = (QS.get("quality") || "high") === "low";
  const SHADOWS = !LOW, ENV = !LOW;
  const LOD_NEAR = LOW ? 16 : 21;         // 机柜细节距离阈值（米）

  /* ======================= 通用工具 ======================= */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const TAU = Math.PI * 2, DEG = Math.PI / 180;
  const FONT = '"Microsoft YaHei","PingFang SC",system-ui,sans-serif';

  /* 布局常量（与 data.js 的机柜坐标体系一致） */
  const RACK_W = 1.2, RACK_H = 2.2, RACK_D = 1.1;
  const ROOM = { hw: 9.5, z0: -17, z1: 11, h: 5 };
  const AISLE_Z = [-12, -3, 6];
  const U_TOTAL = 42, U_H = 2.02 / U_TOTAL, U_BOTTOM = 0.15;
  const TILE = 0.6;                       // 600mm 架空地板砖

  /* 状态色 */
  const C_OK = 0x22c55e, C_WARN = 0xf5a524, C_CRIT = 0xff4d4f, C_OFF = 0x5b6b80;
  const C_CYAN = 0x22d3ee, C_CYAN2 = 0x35e0ff;
  const BG = 0x05080f;

  /* ======================= 运行期状态 ======================= */
  let renderer = null, scene = null, camera = null, controls = null;
  let canvasEl = null, bus = null, D = null, ready = false;
  let elapsed = 0, frames = 0, lastTs = 0, lodClock = -9;
  let mode = "status";
  let selectedId = null, selectedMode = null, selectedDevice = null, hoveredId = null;
  let intro = null, tween = null, focusHidden = null;
  let rowLight = [1, 1, 1, 1, 1, 1];
  let backdrop = null, avatar = null, selGroup = null, hoverBox = null, devHighlight = null;
  let floorTint = null;
  let zoneSprites = [];
  /* 动环（DH）点位状态 */
  const dhPoints = [];
  const dhById = Object.create(null);
  const dhBind = Object.create(null);      // devId -> { group, pos, face, name, power }
  const dhAlarmState = Object.create(null);
  let dhPickMap = [];
  let dhFocusId = null, dhFocusLabel = null, dhFocusUntil = 0;
  let dhLabelClock = -9;
  const dhAlarmLabels = [];
  const dhFirstPoint = Object.create(null);
  let dhFirstPointReady = false;

  const racks = [];
  const rackById = Object.create(null);
  const beacons = [];
  const IM = {};
  const lights = {};
  const pickDevs = [];                    // [{im, map:[{rackId,deviceId}]}]
  const tmpObj = new THREE.Object3D();
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const tmpA = new THREE.Color();
  const tmpB = new THREE.Color();
  const tmpC = new THREE.Color();
  const tmpC2 = new THREE.Color();
  const tmpT = new THREE.Color();
  const _tmpM = new THREE.Matrix4();
  const _tinyV = new THREE.Vector3(0.0001, 0.0001, 0.0001);

  /* ======================= Canvas 文字（中文浮空标签） ======================= */
  function newCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(2, w | 0); c.height = Math.max(2, h | 0);
    return c;
  }
  function cvsTexture(c) {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy() || 4) : 4;
    t.needsUpdate = true;
    return t;
  }
  function rrPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  /** 中文浮空标签贴图（自适应宽高） */
  function makeTextTexture(text, o) {
    o = o || {};
    const fs = o.fs || 40;
    const padX = o.padX != null ? o.padX : 24;
    const padY = o.padY != null ? o.padY : 12;
    const font = (o.weight || 700) + " " + fs + "px " + FONT;
    const m = newCanvas(4, 4).getContext("2d");
    m.font = font;
    let tw = m.measureText(text).width;
    const sub = o.sub || null;
    const fs2 = o.fs2 || Math.max(12, Math.round(fs * 0.6));
    if (sub) { m.font = "600 " + fs2 + "px " + FONT; tw = Math.max(tw, m.measureText(sub).width); }
    const w = Math.max(o.minW || 0, Math.ceil(tw) + padX * 2 + 8);
    const h = Math.ceil(fs * 1.28) + padY * 2 + (sub ? Math.ceil(fs2 * 1.5) + 2 : 0);
    const c = newCanvas(w, h);
    const ctx = c.getContext("2d");
    const rad = Math.min(12, h * 0.22);
    if (o.bg) { rrPath(ctx, 1, 1, w - 2, h - 2, rad); ctx.fillStyle = o.bg; ctx.fill(); }
    if (o.border) { rrPath(ctx, 1, 1, w - 2, h - 2, rad); ctx.strokeStyle = o.border; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = font;
    if (o.glow) { ctx.shadowColor = o.glow; ctx.shadowBlur = fs * 0.5; }
    ctx.fillStyle = o.color || "#dce9ff";
    const ty = sub ? padY + fs * 0.64 : h / 2 + 1;
    ctx.fillText(text, w / 2, ty);
    if (sub) {
      ctx.shadowBlur = 0;
      ctx.font = "600 " + fs2 + "px " + FONT;
      ctx.fillStyle = o.color2 || "#8aa0bd";
      ctx.fillText(sub, w / 2, ty + fs * 0.62 + fs2 * 0.62 + 4);
    }
    return { texture: cvsTexture(c), w: w, h: h };
  }
  function makeTextSprite(texObj, worldH, o) {
    o = o || {};
    const mat = new THREE.SpriteMaterial({
      map: texObj.texture, transparent: true, depthWrite: false,
      depthTest: o.depthTest !== false,
      blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      opacity: o.opacity != null ? o.opacity : 1, toneMapped: false,
    });
    const s = new THREE.Sprite(mat);
    s.scale.set((worldH * texObj.w) / texObj.h, worldH, 1);
    s.userData.baseH = worldH;
    return s;
  }

  /* ======================= 实例化工具 ======================= */
  function makeIM(geo, mat, count, castS, recvS) {
    const im = new THREE.InstancedMesh(geo, mat, Math.max(1, count | 0));
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.castShadow = !!castS;
    im.receiveShadow = !!recvS;
    im.frustumCulled = false;
    scene.add(im);
    return im;
  }
  function setInst(im, i, x, y, z, ry, sx, sy, sz) {
    tmpObj.position.set(x, y, z);
    tmpObj.rotation.set(0, ry || 0, 0);
    tmpObj.scale.set(sx == null ? 1 : sx, sy == null ? 1 : sy, sz == null ? 1 : sz);
    tmpObj.updateMatrix();
    im.setMatrixAt(i, tmpObj.matrix);
    im.instanceMatrix.needsUpdate = true;
  }
  function instColor(im, i, col) {
    if (!im.instanceColor) im.setColorAt(i, col);
    else col.toArray(im.instanceColor.array, i * 3);
  }
  function flushColors(keys) {
    for (let i = 0; i < keys.length; i++) {
      const im = IM[keys[i]];
      if (im && im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }
  /** 机柜局部坐标 -> 世界坐标（机柜仅绕 Y 旋转 0 / PI） */
  function localToWorld(r, lx, ly, lz, out) {
    const co = Math.cos(r.yaw), si = Math.sin(r.yaw);
    return out.set(r.def.x + lx * co + lz * si, ly, r.def.z - lx * si + lz * co);
  }
  function rackFrontPoint(r, dist, out) {
    const co = Math.cos(r.yaw), si = Math.sin(r.yaw);
    return out.set(r.def.x + si * dist, 0, r.def.z + co * dist);
  }
  /** 克隆材质并设置独立 repeat（共享贴图必须 clone） */
  function matRepeat(mat, rx, ry) {
    const m = mat.clone();
    ["map", "normalMap", "roughnessMap", "alphaMap", "emissiveMap"].forEach((k) => {
      if (mat[k]) { m[k] = mat[k].clone(); m[k].needsUpdate = true; if (m[k].repeat) m[k].repeat.set(rx, ry); }
    });
    return m;
  }

  /* ======================= 状态 / 温度配色 ======================= */
  const TEMP_STOPS = [[21.5, 0x1e6fa8], [24.5, 0x35e0ff], [28.0, 0x5fd7a8], [30.0, 0xf5a524], [32.0, 0xff4d4f]];
  function tempColor(t, out) {
    const st = TEMP_STOPS;
    if (t <= st[0][0]) return out.setHex(st[0][1]);
    for (let i = 1; i < st.length; i++) {
      if (t <= st[i][0]) {
        const k = (t - st[i - 1][0]) / (st[i][0] - st[i - 1][0]);
        return out.setHex(st[i - 1][1]).lerp(tmpT.setHex(st[i][1]), k);
      }
    }
    return out.setHex(st[st.length - 1][1]);
  }
  function loadColor(p, out) {
    const x = clamp(p / 100, 0, 1);
    return out.setHex(0x1e6fa8).lerp(tmpT.setHex(0xffc94d), x);
  }
  function statusColor(st, out) {
    if (st === "alarm") out.setHex(C_CRIT);
    else if (st === "offline") out.setHex(C_OFF);
    else if (st === "warn") out.setHex(C_WARN);
    else out.setHex(C_OK);
    return out;
  }
  function pulseOf(st) { return st === "alarm" ? 0.55 + 0.65 * (0.5 + 0.5 * Math.sin(elapsed * 4.2)) : 1; }
  function accentOf(r, m) {
    const d = r.def, pl = pulseOf(d.status);
    if (m === "temp") return tempColor(d.tempIn, tmpA);
    if (m === "load") return loadColor(d.loadPct, tmpA);
    if (m === "alarm") return d.status === "alarm" ? tmpA.setHex(C_CRIT).multiplyScalar(pl) : tmpA.setHex(C_OFF).multiplyScalar(0.55);
    return statusColor(d.status, tmpA).multiplyScalar(d.status === "alarm" ? pl : 1);
  }
  /** 灯带颜色：科技青为主，温度/负载/告警模式跟数据 */
  function stripColorOf(r, m) {
    const d = r.def;
    if (m === "temp") return tempColor(d.tempIn, tmpC);
    if (m === "load") return loadColor(d.loadPct, tmpC);
    if (m === "alarm") return d.status === "alarm" ? tmpC.setHex(C_CRIT).multiplyScalar(0.6 + 0.5 * pulseOf(d.status)) : tmpC.setHex(C_CYAN).multiplyScalar(0.35);
    return tmpC.setHex(C_CYAN2);
  }
  function bodyTintOf(r, m) {
    const d = r.def;
    let t = 0;
    if (m === "temp") return tmpB.setHex(0xffffff).lerp(tempColor(d.tempIn, tmpT), 0.72);
    if (m === "load") return tmpB.setHex(0xffffff).lerp(loadColor(d.loadPct, tmpT), 0.64);
    if (m === "alarm") {
      if (d.status === "alarm") return tmpB.setHex(0xffffff).lerp(tmpT.setHex(C_CRIT), 0.5);
      return tmpB.setHex(0xffffff).lerp(tmpT.setHex(C_OFF), 0.3).multiplyScalar(0.75);
    }
    tmpB.setHex(0xffffff);
    if (d.status === "alarm") tmpB.lerp(tmpT.setHex(C_CRIT), 0.3 * pulseOf(d.status));
    else if (d.status === "offline") tmpB.lerp(tmpT.setHex(C_OFF), 0.3);
    return tmpB;
  }

  /* ======================= 光照 / 环境 ======================= */
  function buildLights() {
    lights.amb = new THREE.AmbientLight(0x4a6a8c, LOW ? 0.72 : 0.42);
    scene.add(lights.amb);
    lights.hemi = new THREE.HemisphereLight(0x6ba8d8, 0x0d151d, LOW ? 0.55 : 0.38);
    scene.add(lights.hemi);
    const key = new THREE.DirectionalLight(0xe6f4ff, LOW ? 2.5 : 2.6);
    key.position.set(13, 19, 15);
    if (SHADOWS) {
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      const c = key.shadow.camera;
      c.left = -17; c.right = 17; c.top = 19; c.bottom = -19; c.near = 1; c.far = 62;
      c.updateProjectionMatrix();
      key.shadow.bias = -0.0004;
      key.shadow.normalBias = 0.024;
      key.shadow.radius = 1.6;
      key.shadow.intensity = 0.86;
    }
    scene.add(key);
    lights.key = key;
    const rim = new THREE.DirectionalLight(0x3f8ff0, LOW ? 0.5 : 0.5);
    rim.position.set(-15, 9, -13);
    scene.add(rim);
    lights.rim = rim;
    const fill = new THREE.DirectionalLight(0x9fd0f5, LOW ? 0.35 : 0.35);
    fill.position.set(-6, 14, 17);
    scene.add(fill);
    lights.fill = fill;
  }
  function buildEnv() {
    if (!ENV) return;
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = env;
      scene.environmentIntensity = 0.55;
      pmrem.dispose();
    } catch (e) { console.warn("[scene3d] env 生成失败", e); }
  }

  /* ======================= 背景穹顶 ======================= */
  function makeBackdropTexture() {
    const W = 32, H = 256, c = newCanvas(W, H), ctx = c.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#02040a"); g.addColorStop(0.45, "#050b16"); g.addColorStop(0.8, "#071527"); g.addColorStop(1, "#0a1e33");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    return cvsTexture(c);
  }

  /* ======================= 机房硬装 + 家具 ======================= */
  function buildRoom() {
    /* --- 架空地板：600mm 方砖（真实排布 + 缝隙） --- */
    const nx = Math.round((ROOM.hw * 2) / TILE);          // 32
    const nz = Math.round((ROOM.z1 - ROOM.z0) / TILE);    // 47
    const tw = (ROOM.hw * 2) / nx, td = (ROOM.z1 - ROOM.z0) / nz;
    const floorMat = MAT.floor().clone();
    floorMat.color.multiplyScalar(0.78);
    IM.tile = makeIM(new THREE.BoxGeometry(1, 1, 1), floorMat, nx * nz, false, true);
    let ti = 0;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const x = -ROOM.hw + tw * (i + 0.5);
        const z = ROOM.z0 + td * (j + 0.5);
        setInst(IM.tile, ti++, x, -0.019, z, 0, tw * 0.965, 0.038, td * 0.965);
      }
    }
    /* --- 冷通道格栅地砖 --- */
    const gx = Math.round(11.6 / TILE), gz = Math.round(2.3 / TILE);
    IM.grille = makeIM(new THREE.BoxGeometry(1, 1, 1), MAT.floorGrille(), AISLE_Z.length * gx * gz, false, true);
    let gi = 0;
    AISLE_Z.forEach((az) => {
      for (let i = 0; i < gx; i++) {
        for (let j = 0; j < gz; j++) {
          const x = -5.8 + (11.6 / gx) * (i + 0.5);
          const z = az - 1.15 + (2.3 / gz) * (j + 0.5);
          setInst(IM.grille, gi++, x, -0.010, z, 0, (11.6 / gx) * 0.95, 0.03, (2.3 / gz) * 0.95);
        }
      }
    });
    /* --- 地板模式着色层 --- */
    floorTint = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM.hw * 2 - 0.05, ROOM.z1 - ROOM.z0 - 0.05),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.0, depthWrite: false, toneMapped: false })
    );
    floorTint.rotation.x = -Math.PI / 2;
    floorTint.position.set(0, 0.012, (ROOM.z0 + ROOM.z1) / 2);
    scene.add(floorTint);

    /* --- 墙体 --- */
    const wallMat = matRepeat(MAT.wall(), 6, 1.6);
    wallMat.color.multiplyScalar(0.6);
    const wallTop = (w, h, x, y, z, ry) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
      m.position.set(x, y, z); m.rotation.y = ry; m.receiveShadow = true;
      scene.add(m);
      return m;
    };
    wallTop(ROOM.hw * 2, ROOM.h, 0, ROOM.h / 2, ROOM.z0, 0);
    wallTop(ROOM.z1 - ROOM.z0, ROOM.h, -ROOM.hw, ROOM.h / 2, (ROOM.z0 + ROOM.z1) / 2, Math.PI / 2);
    wallTop(ROOM.z1 - ROOM.z0, ROOM.h, ROOM.hw, ROOM.h / 2, (ROOM.z0 + ROOM.z1) / 2, -Math.PI / 2);
    /* 墙脚 / 地平线灯带 */
    const lineMat = MAT.ledStrip("#2f7fe8", 1.9);
    [[ROOM.hw * 2, 0, ROOM.z0 + 0.04, 0], [ROOM.z1 - ROOM.z0, -ROOM.hw + 0.04, (ROOM.z0 + ROOM.z1) / 2, Math.PI / 2], [ROOM.z1 - ROOM.z0, ROOM.hw - 0.04, (ROOM.z0 + ROOM.z1) / 2, Math.PI / 2]]
      .forEach(([len, x, z, ry]) => {
        const l = new THREE.Mesh(new THREE.BoxGeometry(len, 0.03, 0.03), lineMat);
        l.position.set(x, 1.05, z); l.rotation.y = ry;
        scene.add(l);
      });

    /* --- 前侧玻璃隔断 + 立梃 --- */
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.hw * 2, 2.35), MAT.glass());
    glass.position.set(0, 1.18, ROOM.z1);
    scene.add(glass);
    const mullMat = MAT.rackFrame();
    IM.mullion = makeIM(new THREE.BoxGeometry(0.07, 2.35, 0.1), mullMat, 9, SHADOWS, true);
    for (let i = 0; i < 9; i++) setInst(IM.mullion, i, -ROOM.hw + i * (ROOM.hw * 2 / 8), 1.18, ROOM.z1, 0, 1, 1, 1);
    const railTop = new THREE.Mesh(new THREE.BoxGeometry(ROOM.hw * 2, 0.09, 0.14), mullMat);
    railTop.position.set(0, 2.36, ROOM.z1);
    railTop.castShadow = SHADOWS; scene.add(railTop);

    /* --- 结构柱 --- */
    const colMat = matRepeat(MAT.wall(), 0.6, 3);
    colMat.color.multiplyScalar(0.55);
    IM.col = makeIM(new THREE.BoxGeometry(0.26, ROOM.h, 0.26), colMat, 6, SHADOWS, true);
    [[-ROOM.hw + 0.2, ROOM.z0 + 0.2], [ROOM.hw - 0.2, ROOM.z0 + 0.2], [-ROOM.hw + 0.2, ROOM.z1 - 0.2], [ROOM.hw - 0.2, ROOM.z1 - 0.2], [-ROOM.hw / 2, ROOM.z1 - 0.25], [ROOM.hw / 2, ROOM.z1 - 0.25]]
      .forEach((p, i) => setInst(IM.col, i, p[0], ROOM.h / 2, p[1], 0, 1, 1, 1));

    /* --- 顶部桥架 + 多色线缆 + 吊杆 --- */
    const rowZ = Array.from(new Set((D.racks || []).map((r) => r.z)));
    const trayMat = matRepeat(MAT.tray(), 9, 1);
    IM.tray = makeIM(new THREE.BoxGeometry(12.4, 0.09, 0.62), trayMat, rowZ.length, SHADOWS, true);
    rowZ.forEach((z, i) => setInst(IM.tray, i, 0, 3.62, z, 0, 1, 1, 1));
    IM.hanger = makeIM(new THREE.BoxGeometry(0.06, 1.3, 0.06), MAT.rackFrame(), rowZ.length * 2, SHADOWS, false);
    rowZ.forEach((z, i) => {
      setInst(IM.hanger, i * 2, -5.7, 4.28, z, 0, 1, 1, 1);
      setInst(IM.hanger, i * 2 + 1, 5.7, 4.28, z, 0, 1, 1, 1);
    });
    const cableMat = matRepeat(MAT.cable(), 10, 1);
    IM.trayCable = makeIM(new THREE.BoxGeometry(12.1, 0.055, 0.17), cableMat, rowZ.length * 3, SHADOWS, false);
    rowZ.forEach((z, i) => {
      for (let k = 0; k < 3; k++) setInst(IM.trayCable, i * 3 + k, 0, 3.5, z - 0.17 + k * 0.17, 0, 1, 1, 1);
    });

    /* --- 吊顶 LED 灯盘（PROPS，每 3~4m 一盏） --- */
    const lightX = [-6.2, 0, 6.2], lightZ = [-13.2, -7.6, -2.0, 3.6, 8.4];
    lightX.forEach((lx) => lightZ.forEach((lz) => {
      if (LOW && (lz === -13.2 || lz === 8.4)) return;
      const g = PROPS.ceilingLight({ w: 1.25, d: 0.32, intensity: 3.4 });
      placeProp(g, lx, 4.88, lz, 0);
    }));

    /* --- 精密空调（两侧墙，绑定 AC-01/AC-02） --- */
    const acLeft = [], acRight = [];
    [-12.6, -6.4, 0.6, 7.4].forEach((z, i) => {
      if (LOW && (i === 1 || i === 3)) return;
      acLeft.push({ g: placeProp(PROPS.ac({ w: 0.85, h: 2.05, d: 0.72, brand: "精密空调" }), -ROOM.hw + 0.52, 0, z, Math.PI / 2), z: z });
      acRight.push({ g: placeProp(PROPS.ac({ w: 0.85, h: 2.05, d: 0.72, brand: "精密空调" }), ROOM.hw - 0.52, 0, z, -Math.PI / 2), z: z });
    });
    [-6.8, 6.8].forEach((x) => placeProp(PROPS.ac({ w: 0.9, h: 2.05, d: 0.72, brand: "精密空调" }), x, 0, ROOM.z0 + 0.55, 0));
    if (acLeft[0]) dhBind["AC-01"] = { group: acLeft[0].g, pos: new THREE.Vector3(-ROOM.hw + 0.52, 1.05, acLeft[0].z), face: new THREE.Vector3(1, 0, 0), name: "A 区精密空调 01" };
    if (acRight[0]) dhBind["AC-02"] = { group: acRight[0].g, pos: new THREE.Vector3(ROOM.hw - 0.52, 1.05, acRight[0].z), face: new THREE.Vector3(-1, 0, 0), name: "B 区精密空调 02" };

    /* --- 电力间后墙：UPS×2 / MDB×2 / BAT / ATS（逐个绑定动环 devId） --- */
    const PZ = ROOM.z0 + 0.62;
    [["UPS-01", "A 区 UPS-01", -6.8, () => PROPS.ups({ title: "UPS-01 200kVA" })],
     ["UPS-02", "B 区 UPS-02", -5.8, () => PROPS.ups({ title: "UPS-02 200kVA" })],
     ["MDB-1", "1# 低压配电柜", -4.8, () => PROPS.pduCabinet({ title: "MDB-1 配电柜" })],
     ["MDB-2", "2# 列头柜", -2.6, () => PROPS.pduCabinet({ title: "MDB-2 列头柜" })],
     ["BAT-01", "UPS 电池组 01", -1.6, () => PROPS.battery({})],
     ["ATS-01", "市电 ATS 双电源", -0.6, () => PROPS.ups({ title: "ATS-01 双电源" })]
    ].forEach((d) => {
      const g = placeProp(d[3](), d[2], 0, PZ, 0);
      dhBind[d[0]] = { group: g, pos: new THREE.Vector3(d[2], 1.05, PZ), face: new THREE.Vector3(0, 0, 1), name: d[1], power: true };
    });

    /* --- 后墙监控大屏 --- */
    placeProp(PROPS.monitorWall({ cols: 3, rows: 2, cw: 0.86, ch: 0.52 }), 1.0, 2.62, ROOM.z0 + 0.16, 0);

    /* --- 门禁 / 摄像头 / 灭火器 / 温湿度传感器 / 分区牌 --- */
    if (!LOW) {
      placeProp(PROPS.badge({}), -1.6, 1.05, ROOM.z1 - 0.06, 0);
      placeProp(PROPS.badge({}), 1.6, 1.05, ROOM.z1 - 0.06, 0);
    }
    if (!LOW) {
      [[-7.6, -9.5], [7.6, -9.5], [-7.6, 8.6], [7.6, 8.6]].forEach((p) => {
        const g = PROPS.cctv({});
        g.rotation.x = Math.PI;
        placeProp(g, p[0], 4.88, p[1], 0);
      });
      placeProp(PROPS.extinguisher({}), -8.8, 0, 9.4, 0);
      placeProp(PROPS.extinguisher({}), 8.8, 0, 9.4, 0);
      placeProp(PROPS.sensor({}), -ROOM.hw + 0.09, 1.62, -5.0, Math.PI / 2);
      placeProp(PROPS.sensor({}), ROOM.hw - 0.09, 1.62, -5.0, -Math.PI / 2);
    }
    AISLE_Z.forEach((z, i) => {
      placeProp(PROPS.sign({ text: ["A 区", "B 区", "C 区"][i], sub: ["ZONE A", "ZONE B", "ZONE C"][i] }), 6.9, 2.45, z, -Math.PI / 2);
    });

    /* --- 地面排号字牌 + 分区温度浮标 --- */
    const rowLabelGeo = new THREE.PlaneGeometry(1.35, 0.45);
    rowZ.forEach((z, i) => {
      const row = "ABCDEF"[i] || String(i + 1);
      const m = new THREE.Mesh(rowLabelGeo, MAT.label(row + " 排", { sub: "ROW " + row, w: 384, h: 128, size: 62, border: "#22d3ee" }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(7.85, 0.022, z);
      scene.add(m);
    });
    zoneSprites = AISLE_Z.map((z, i) => {
      const t = makeTextTexture(["A 区", "B 区", "C 区"][i] + " · --.-℃", {
        fs: 44, color: "#eaf7ff", bg: "rgba(8,16,26,.82)", border: "rgba(53,224,255,.5)",
        radius: 14, padX: 26, padY: 14, glow: "rgba(53,224,255,.6)",
      });
      const sp = makeTextSprite(t, 0.44, {});
      sp.position.set(0, 3.15, z);
      sp.userData.zone = i;
      scene.add(sp);
      return sp;
    });
  }
  const _darkCache = new Map();
  function darkenMat(mat, factor) {
    if (!mat) return mat;
    if (_darkCache.has(mat)) return _darkCache.get(mat);
    const m = mat.clone();
    if (m.color) m.color.multiplyScalar(factor);
    if (m.envMapIntensity != null) m.envMapIntensity *= 1.15;
    _darkCache.set(mat, m);
    return m;
  }
  function placeProp(g, x, y, z, ry, parent) {
    g.position.set(x, y, z);
    if (ry) g.rotation.y = ry;
    g.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = SHADOWS; o.receiveShadow = true;
      if (o.material && !Array.isArray(o.material) && o.material.isMeshStandardMaterial) o.material = darkenMat(o.material, 0.92);
    });
    scene.add(g);
    return g;
  }

  /* ======================= 动环（DH）三维点位 ======================= */
  const DH_ROW_Z = { A: -13.5, B: -10.5, C: -4.5, D: -1.5, E: 4.5, F: 7.5 };
  let dhValueOverride = null;
  function rackXAt(idx) { return (idx - 3) * 1.9; }

  /** place（点表）→ 机房世界坐标 */
  function dhPlaceOf(dev) {
    const pl = dev.place || {};
    if (pl.kind === "ceiling") {
      const g = pl.grid || 1;
      const a = Math.min(2, Math.floor((g - 1) / 4));
      const k = (g - 1) % 4;
      return { kind: "smoke", pos: new THREE.Vector3(-6 + k * 4, 3.28, AISLE_Z[a]), face: new THREE.Vector3(0, -1, 0) };
    }
    if (pl.kind === "aisle-end") {
      const a = pl.row === "A" ? 0 : 1;
      const x = pl.idx === 1 ? 6.7 : -6.7;
      return { kind: "water-rope", pos: new THREE.Vector3(x, 0.14, AISLE_Z[a]), face: new THREE.Vector3(x > 0 ? -1 : 1, 0, 0), ropeDir: x > 0 ? -1 : 1 };
    }
    if (pl.kind === "floor") {
      const i = pl.idx || 1;
      if (i <= 4) return { kind: "water", pos: new THREE.Vector3(-6.6 + (i - 1) * 4.4, 0.14, ROOM.z0 + 0.62), face: new THREE.Vector3(0, 0, 1) };
      if (i <= 6) return { kind: "water", pos: new THREE.Vector3(-ROOM.hw + 0.17, 0.14, -8 + (i - 5) * 10), face: new THREE.Vector3(1, 0, 0) };
      return { kind: "water", pos: new THREE.Vector3(ROOM.hw - 0.17, 0.14, -8 + (i - 7) * 10), face: new THREE.Vector3(-1, 0, 0) };
    }
    if (pl.kind === "rack-front") {
      const row = pl.row || "A";
      const yaw = (row === "A" || row === "C" || row === "E") ? 0 : Math.PI;
      const zRow = DH_ROW_Z[row] != null ? DH_ROW_Z[row] : -13.5;
      return { kind: "th", pos: new THREE.Vector3(rackXAt(pl.idx || 0), 2.02, zRow + Math.cos(yaw) * (RACK_D / 2 + 0.07)),
        face: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), yaw: yaw };
    }
    if (pl.kind === "power-room") {
      if (pl.idx === 6) return { kind: "th", pos: new THREE.Vector3(1.7, 1.78, ROOM.z0 + 0.16), face: new THREE.Vector3(0, 0, 1), yaw: 0 };
      const b = dhBind[dev.id];
      if (b) return { kind: "power", pos: b.pos.clone(), face: b.face.clone() };
      return { kind: "power", pos: new THREE.Vector3(0, 1.2, ROOM.z0 + 0.8), face: new THREE.Vector3(0, 0, 1) };
    }
    if (pl.kind === "wall-side") {
      const b2 = dhBind[dev.id];
      if (b2) return { kind: "power", pos: b2.pos.clone(), face: b2.face.clone() };
    }
    return { kind: "other", pos: new THREE.Vector3(0, 1.2, 0), face: new THREE.Vector3(0, 0, 1) };
  }

  function dhMapFirstPoints() {
    if (dhFirstPointReady) return;
    dhFirstPointReady = true;
    DH_POINTS.forEach((pt) => { if (!dhFirstPoint[pt.devId]) dhFirstPoint[pt.devId] = pt.id; });
  }
  function buildDhPoints() {
    dhMapFirstPoints();
    const alertRingMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xff4d4f, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const ledMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const smoke = [], rope = [], wpoint = [], th = [], power = [];
    DH_DEVICES.forEach((d) => {
      const place = dhPlaceOf(d);
      const e = { dev: d, devId: d.id, name: d.name, type: d.type, place: place, pos: place.pos, face: place.face,
        level: null, pointId: dhFirstPoint[d.id] || d.id + ".state" };
      dhPoints.push(e);
      dhById[d.id] = e;
      if (place.kind === "smoke") smoke.push(e);
      else if (place.kind === "water-rope") rope.push(e);
      else if (place.kind === "water") wpoint.push(e);
      else if (place.kind === "th") th.push(e);
      else power.push(e);
    });
    const nLed = smoke.length + rope.length + wpoint.length;
    IM.dhDisc = makeIM(new THREE.CylinderGeometry(0.12, 0.12, 0.035, 14), new THREE.MeshBasicMaterial({ color: 0xe6f2fb }), Math.max(1, smoke.length), SHADOWS, false);
    IM.dhLed = makeIM(new THREE.SphereGeometry(0.021, 8, 6), ledMat, Math.max(1, nLed));
    IM.dhRing = makeIM(new THREE.RingGeometry(0.22, 0.86, 26).rotateX(-Math.PI / 2), alertRingMat, Math.max(1, nLed));
    IM.dhBeam = makeIM(new THREE.CylinderGeometry(0.085, 0.085, 1, 10, 1, true), beamMat, Math.max(1, smoke.length));
    IM.dhWBox = makeIM(new THREE.BoxGeometry(0.26, 0.15, 0.2), MAT.solid(0xdfe6ec, 0.3, 0.45), Math.max(1, rope.length), SHADOWS, true);
    IM.dhWPoint = makeIM(new THREE.BoxGeometry(0.2, 0.26, 0.12), MAT.solid(0xdfe6ec, 0.3, 0.45), Math.max(1, wpoint.length), SHADOWS, true);
    IM.dhRope = makeIM(new THREE.CylinderGeometry(0.019, 0.019, 6.2, 6).rotateZ(Math.PI / 2), MAT.solid(0x93a7ba, 0.35, 0.55), Math.max(1, rope.length));
    IM.dhMark = makeIM(new THREE.RingGeometry(0.14, 0.4, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }), Math.max(1, smoke.length + rope.length + wpoint.length));
    let li = 0, ri = 0, mi = 0;
    smoke.forEach((e, i) => {
      const p = e.pos;
      setInst(IM.dhDisc, i, p.x, p.y, p.z, 0, 1, 1, 1);
      setInst(IM.dhLed, li, p.x, p.y - 0.027, p.z, 0, 1, 1, 1);
      e.ledIdx = li++;
      setInst(IM.dhRing, ri, p.x, 0.035, p.z, 0, 0.0001, 0.0001, 0.0001);
      e.ringIdx = ri++;
      setInst(IM.dhBeam, i, p.x, p.y / 2, p.z, 0, 1, p.y, 1);
      e.beamIdx = i;
      setInst(IM.dhMark, mi++, p.x, p.y - 0.03, p.z, 0, 1, 1, 1);
      instColor(IM.dhLed, e.ledIdx, tmpA.setHex(0xff4d4f).multiplyScalar(0.55));
    });
    rope.forEach((e, i) => {
      const p = e.pos;
      setInst(IM.dhWBox, i, p.x, p.y + 0.075, p.z, e.face.x > 0 ? -Math.PI / 2 : Math.PI / 2, 1, 1, 1);
      setInst(IM.dhRope, i, p.x + e.place.ropeDir * 3.1, 0.055, p.z, 0, 1, 1, 1);
      setInst(IM.dhLed, li, p.x, p.y + 0.155, p.z, 0, 1, 1, 1);
      e.ledIdx = li++;
      setInst(IM.dhRing, ri, p.x, 0.035, p.z, 0, 0.0001, 0.0001, 0.0001);
      e.ringIdx = ri++;
      setInst(IM.dhMark, mi++, p.x, 0.035, p.z, 0, 1, 1, 1);
      instColor(IM.dhLed, e.ledIdx, tmpA.setHex(0x4cff8a));
    });
    wpoint.forEach((e, i) => {
      const p = e.pos;
      setInst(IM.dhWPoint, i, p.x, p.y + 0.13, p.z, e.face.x !== 0 ? Math.PI / 2 : 0, 1, 1, 1);
      setInst(IM.dhLed, li, p.x, p.y + 0.22, p.z, 0, 1, 1, 1);
      e.ledIdx = li++;
      setInst(IM.dhRing, ri, p.x, 0.035, p.z, 0, 0.0001, 0.0001, 0.0001);
      e.ringIdx = ri++;
      setInst(IM.dhMark, mi++, p.x, 0.035, p.z, 0, 1, 1, 1);
      instColor(IM.dhLed, e.ledIdx, tmpA.setHex(0x4cff8a));
    });
    th.forEach((e) => {
      const p = e.pos;
      const g = PROPS.sensor({});
      placeProp(g, p.x, p.y - 0.075, p.z, e.place.yaw || 0);
      e.group = g;
      const sp = makeTextSprite(makeTextTexture("--.-C / --%", { fs: 40, color: "#dff3ff", bg: "rgba(8,18,28,.86)", border: "rgba(53,224,255,.6)", radius: 10, padX: 14, padY: 8 }), 0.19, {});
      sp.position.set(p.x, p.y + 0.42, p.z);
      sp.visible = false;
      scene.add(sp);
      e.label = sp;
      e.labelTxt = "";
    });
    power.forEach((e) => {
      const b = dhBind[e.devId];
      if (!b || !b.group) return;
      e.group = b.group;
      const box = new THREE.Box3().setFromObject(b.group);
      const size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
      const ol = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x + 0.12, size.y + 0.12, size.z + 0.12)),
        new THREE.LineBasicMaterial({ color: 0xff4d4f, transparent: true, opacity: 0.85, toneMapped: false })
      );
      ol.position.copy(ctr);
      ol.visible = false;
      scene.add(ol);
      e.outline = ol;
    });
    IM.dhPick = makeIM(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }), Math.max(1, dhPoints.length));
    dhPoints.forEach((e, i) => {
      const p = e.pos, k = e.place.kind;
      const sx = k === "power" ? 1.05 : k === "smoke" ? 0.34 : k === "th" ? 0.3 : 0.46;
      const sy = k === "power" ? 2.15 : k === "smoke" ? 0.24 : k === "th" ? 0.34 : 0.5;
      const sz = k === "power" ? 0.95 : k === "smoke" ? 0.34 : k === "th" ? 0.24 : 0.46;
      setInst(IM.dhPick, i, p.x, p.y, p.z, 0, sx, sy, sz);
      dhPickMap[i] = e;
    });
    for (let i = 0; i < 8; i++) {
      const sp = makeTextSprite(makeTextTexture("报警", { fs: 38, color: "#ffe6e6", bg: "rgba(58,10,14,.88)", border: "rgba(255,77,79,.85)", radius: 10, padX: 16, padY: 10 }), i < 4 ? 0.3 : 0.34, {});
      sp.visible = false;
      scene.add(sp);
      dhAlarmLabels.push(sp);
    }
    dhFocusLabel = makeTextSprite(makeTextTexture("设备", { fs: 46, color: "#eaf7ff", bg: "rgba(8,16,26,.92)", border: "rgba(53,224,255,.7)", radius: 14, padX: 22, padY: 12 }), 0.34, { depthTest: false });
    dhFocusLabel.visible = false;
    scene.add(dhFocusLabel);
    flushColors(["dhLed"]);
  }

  function setDhAlarm(devId, level) {
    if (!devId) return;
    if (level) dhAlarmState[devId] = level;
    else delete dhAlarmState[devId];
    applyDhAlarms();
  }

  /** 报警态：只改实例颜色/缩放/可见性与标签，不重建对象 */
  function applyDhAlarms() {
    if (!IM.dhRing) return;
    const alarmed = [];
    for (let i = 0; i < dhPoints.length; i++) {
      const e = dhPoints[i];
      const lv = dhAlarmState[e.devId] || null;
      const on = !!lv;
      const col = lv === "warning" ? 0xf5a524 : lv === "info" ? 0x35e0ff : 0xff4d4f;
      if (on) alarmed.push(e);
      if (e.ringIdx != null) {
        setInst(IM.dhRing, e.ringIdx, e.pos.x, 0.035, e.pos.z, 0, on ? 1 : 0.0001, on ? 1 : 0.0001, on ? 1 : 0.0001);
        instColor(IM.dhRing, e.ringIdx, tmpA.setHex(col));
      }
      if (e.beamIdx != null) setInst(IM.dhBeam, e.beamIdx, e.pos.x, e.pos.y / 2, e.pos.z, 0, on ? 1 : 0.0001, e.pos.y, on ? 1 : 0.0001);
      if (e.ledIdx != null) {
        const base = e.type === "smoke" ? 0xff4d4f : 0x4cff8a;
        instColor(IM.dhLed, e.ledIdx, tmpA.setHex(on ? col : base).multiplyScalar(on ? 1 : 0.55));
      }
      if (e.outline) {
        const foc = dhFocusId === e.devId && performance.now() < dhFocusUntil;
        e.outline.visible = on || foc;
        e.outline.material.color.setHex(on ? col : 0x35e0ff);
      }
    }
    flushColors(["dhRing", "dhLed"]);
    for (let i = 0; i < dhAlarmLabels.length; i++) {
      const sp = dhAlarmLabels[i], e = alarmed[i];
      if (!e) { sp.visible = false; continue; }
      if (sp.userData.txt !== e.name) {
        sp.userData.txt = e.name;
        const tex = makeTextTexture(e.name, { fs: 38, color: "#ffe6e6", bg: "rgba(58,10,14,.88)", border: "rgba(255,77,79,.85)", radius: 10, padX: 16, padY: 10 });
        if (sp.material.map) sp.material.map.dispose();
        sp.material.map = tex.texture;
        sp.material.needsUpdate = true;
        sp.scale.set(sp.userData.baseH * tex.w / tex.h, sp.userData.baseH, 1);
      }
      sp.position.set(e.pos.x, e.pos.y + 0.78, e.pos.z);
      sp.visible = true;
    }
  }

  function updateDhAlarmFx() {
    if (!IM.dhRing) return;
    const p = 0.5 + 0.5 * Math.sin(elapsed * 3.4);
    IM.dhRing.material.opacity = 0.22 + 0.42 * p;
    IM.dhBeam.material.opacity = 0.07 + 0.15 * p;
    if (dhFocusLabel && dhFocusUntil && performance.now() > dhFocusUntil) { dhFocusLabel.visible = false; dhFocusUntil = 0; }
    for (let i = 0; i < dhPoints.length; i++) {
      const e = dhPoints[i];
      if (!e.label) continue;
      const dx = camera.position.x - e.pos.x, dy = camera.position.y - e.pos.y, dz = camera.position.z - e.pos.z;
      e.label.visible = (dx * dx + dy * dy + dz * dz) < 165 || !!dhAlarmState[e.devId];
    }
  }

  /** 温湿度标签（复用贴图对象，2s 节流刷新） */
  function updateDhLabels(force) {
    if (!IM.dhDisc) return;
    if (!force && elapsed - dhLabelClock < 2) return;
    dhLabelClock = elapsed;
    const api2 = IDC.dh || null;
    for (let i = 0; i < dhPoints.length; i++) {
      const e = dhPoints[i];
      if (!e.label) continue;
      let txt = "--.-C / --%", tv = null, hv = null;
      if (dhValueOverride && dhValueOverride[e.devId] != null) {
        txt = "T " + Number(dhValueOverride[e.devId]).toFixed(1) + "C";
      } else if (api2 && api2.pointsOf) {
        const pts = api2.pointsOf(e.devId);
        for (let k = 0; k < pts.length; k++) {
          if (pts[k].key === "temp") tv = api2.value(pts[k].id);
          else if (pts[k].key === "hum") hv = api2.value(pts[k].id);
        }
        if (tv != null) txt = Number(tv).toFixed(1) + "C" + (hv != null ? " / " + Math.round(hv) + "%" : "");
      }
      if (e.labelTxt === txt) continue;
      e.labelTxt = txt;
      const tex = makeTextTexture(txt, { fs: 40, color: "#dff3ff", bg: "rgba(8,18,28,.86)", border: "rgba(53,224,255,.6)", radius: 10, padX: 14, padY: 8 });
      if (e.label.material.map) e.label.material.map.dispose();
      e.label.material.map = tex.texture;
      e.label.material.needsUpdate = true;
      e.label.scale.set(e.label.userData.baseH * tex.w / tex.h, e.label.userData.baseH, 1);
    }
  }
  /* ======================= 图纸扩展图元（Extras → 3D） ======================= */
  const extras = new Map();                 // id -> entry
  const extraGroup = new THREE.Group();     // 单独一组：不参与 LOD / 告警着色
  const extraPickList = [];
  let extraFxClock = 0;
  let extraShared = null;
  function extraMats() {
    if (!extraShared) {
      extraShared = {
        wall: matRepeat(MAT.wall(), 4, 1),
        tray: matRepeat(MAT.tray(), 8, 1),
        dark: MAT.solid(0x1c2128, 0.6, 0.42),
        shell: MAT.solid(0x39414b, 0.55, 0.42),
        glow: new THREE.MeshBasicMaterial({ color: C_CYAN2, toneMapped: false }),
        beam: new THREE.MeshBasicMaterial({ color: C_CRIT, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
        ghost: new THREE.MeshBasicMaterial({ visible: false }),
      };
      extraShared.wall.color.multiplyScalar(0.6);
    }
    return extraShared;
  }
  function extraSign(it) {
    return [it.kind || "", it.x, it.z, it.w, it.d, it.rot || 0, it.level || "floor", it.name || "",
      it.status === true ? "alarm" : (it.status && (it.status.level || it.status)) || ""].join("|");
  }
  function makeExtraRack(w, d) {
    const g = new THREE.Group();
    const H = RACK_H, M = extraMats();
    const f = MAT.rackFrame(), sd = MAT.rackSide(), dm = matRepeat(MAT.rackDoor(), 1, 1.75);
    const postGeo = new THREE.BoxGeometry(0.06, H, 0.06);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach((c) => {
      const m = new THREE.Mesh(postGeo, f);
      m.position.set(c[0] * (w / 2 - 0.04), H / 2, c[1] * (d / 2 - 0.04));
      m.castShadow = SHADOWS; m.receiveShadow = true; g.add(m);
    });
    const sideGeo = new THREE.BoxGeometry(0.03, H - 0.16, Math.max(0.2, d - 0.06));
    [-1, 1].forEach((sx) => {
      const m = new THREE.Mesh(sideGeo, sd);
      m.position.set(sx * (w / 2 + 0.012), H / 2, 0);
      m.castShadow = SHADOWS; m.receiveShadow = true; g.add(m);
    });
    const back = new THREE.Mesh(new THREE.BoxGeometry(w - 0.1, H - 0.18, 0.03), sd);
    back.position.set(0, H / 2, -(d / 2 + 0.005));
    back.castShadow = SHADOWS; g.add(back);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.06, d + 0.04), f);
    cap.position.y = H - 0.03; cap.castShadow = SHADOWS; g.add(cap);
    const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.1, d + 0.02), f);
    base.position.y = 0.05; g.add(base);
    const door = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(0.2, w - 0.08), H - 0.2), dm);
    door.position.set(0, H / 2, d / 2 + 0.02); g.add(door);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.2, w - 0.14), 0.035, 0.03), M.glow);
    strip.position.set(0, H - 0.07, d / 2 + 0.04); g.add(strip);
    return g;
  }
  function buildExtraObject(it) {
    const kind = it.kind || "custom";
    const w = Math.max(0.25, Number(it.w) || 0.6), d = Math.max(0.25, Number(it.d) || 0.6);
    const lvl = it.level || "floor";
    const M = extraMats();
    let g = null, h = 1.0, y = 0;
    if (kind === "rack") { g = makeExtraRack(w, d); h = RACK_H; }
    else if (kind === "ups") { h = 2.0; g = PROPS.ups({ w: w, h: h, d: d, title: it.name || "UPS" }); }
    else if (kind === "pdu") { h = 2.1; g = PROPS.pduCabinet({ w: w, h: h, d: d, title: it.name || "配电柜" }); }
    else if (kind === "battery") { h = 1.9; g = PROPS.battery({ w: w, h: h, d: d }); }
    else if (kind === "ac") { h = 2.05; g = PROPS.ac({ w: w, h: h, d: d, brand: it.name || "精密空调" }); }
    else if (kind === "smoke") {
      y = lvl === "wall" ? 2.45 : 3.28; h = 0.06;
      g = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.035, 14), new THREE.MeshBasicMaterial({ color: 0xe6f2fb }));
      g.add(disc);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.021, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff4d4f, toneMapped: false }));
      led.position.y = -0.03; g.add(led);
      const mark = new THREE.Mesh(new THREE.RingGeometry(0.14, 0.4, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      mark.position.y = -0.03; g.add(mark);
    } else if (kind === "water") {
      y = 0.14; h = 0.3;
      g = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.15, 0.2), MAT.solid(0xdfe6ec, 0.3, 0.45));
      box.position.y = 0.075; box.castShadow = SHADOWS; g.add(box);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.021, 8, 6), new THREE.MeshBasicMaterial({ color: 0x4cff8a, toneMapped: false }));
      led.position.y = 0.155; g.add(led);
      const mark = new THREE.Mesh(new THREE.RingGeometry(0.14, 0.42, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      mark.position.y = 0.02; g.add(mark);
    } else if (kind === "th") {
      y = lvl === "ceiling" ? 3.1 : (Number(it.y) || 2.0); h = 0.3;
      g = PROPS.sensor({});
    } else if (kind === "cctv") {
      y = 4.88; h = 0.2;
      g = PROPS.cctv({}); g.rotation.x = Math.PI;
    } else if (kind === "ext") { h = 0.6; g = PROPS.extinguisher({}); }
    else if (kind === "sign") { y = Number(it.y) || 2.4; h = 0.3; g = PROPS.sign({ text: it.name || "标识", sub: "" }); g.scale.setScalar(Math.max(0.7, Math.min(2, w / 0.7))); }
    else if (kind === "door") {
      h = 2.15; g = new THREE.Group();
      const fr = MAT.rackFrame();
      const post = new THREE.BoxGeometry(0.08, h, 0.1);
      [-1, 1].forEach((sx) => { const m = new THREE.Mesh(post, fr); m.position.set(sx * (w / 2 - 0.04), h / 2, 0); m.castShadow = SHADOWS; g.add(m); });
      const lint = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, 0.1), fr); lint.position.y = h - 0.04; g.add(lint);
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.2, w - 0.16), h - 0.12, 0.04), MAT.glass());
      leaf.position.y = h / 2; g.add(leaf);
    } else if (kind === "wall") {
      h = 2.6; g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, Math.max(0.1, d)), M.wall);
      m.position.y = h / 2; m.castShadow = SHADOWS; m.receiveShadow = true; g.add(m);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.04, Math.max(0.1, d) + 0.02), M.glow);
      trim.position.y = h - 0.05; g.add(trim);
    } else if (kind === "column") {
      h = ROOM.h; g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.2, w), h, Math.max(0.2, d)), M.wall);
      m.position.y = h / 2; m.castShadow = SHADOWS; m.receiveShadow = true; g.add(m);
    } else if (kind === "tray") {
      y = Number(it.y) || 3.62; h = 0.1; g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.09, Math.max(0.2, d)), M.tray);
      m.castShadow = SHADOWS; g.add(m);
      [-1, 1].forEach((sx) => {
        const hg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.1, 0.05), MAT.rackFrame());
        hg.position.set(sx * (w / 2 - 0.4), 0.58, 0); g.add(hg);
      });
    } else {
      h = 2.0; g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M.shell);
      m.position.y = h / 2; m.castShadow = SHADOWS; m.receiveShadow = true; g.add(m);
    }
    return { group: g, h: h, y: y };
  }
  function createExtra(it) {
    const built = buildExtraObject(it);
    const g = built.group;
    const pos = new THREE.Vector3(Number(it.x) || 0, Number(it.y) || built.y, Number(it.z) || 0);
    const rot = ((Number(it.rot) || 0) * Math.PI) / 180;
    /* 先在原点求「局部」包围盒（setFromObject 返回世界包围盒，未摆位时即局部） */
    g.position.set(0, 0, 0); g.rotation.set(0, 0, 0); g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    const size = box.getSize(new THREE.Vector3());
    const ctr = box.getCenter(new THREE.Vector3());
    const pick = new THREE.Mesh(new THREE.BoxGeometry(size.x + 0.16, size.y + 0.16, size.z + 0.16), extraMats().ghost);
    pick.position.copy(ctr);
    pick.userData.extraId = it.id;
    g.add(pick);
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x + 0.1, size.y + 0.1, size.z + 0.1)),
      new THREE.LineBasicMaterial({ color: C_CRIT, transparent: true, opacity: 0.9, toneMapped: false })
    );
    outline.position.copy(ctr);
    outline.visible = false;
    g.add(outline);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, size.y + 2.6, 10, 1, true), extraMats().beam);
    beam.position.set(ctr.x, ctr.y + (size.y + 2.6) / 2 - 0.1, ctr.z);
    beam.visible = false;
    g.add(beam);
    /* 名称牌 */
    let label = null;
    if (it.name) {
      label = makeTextSprite(makeTextTexture(it.name, { fs: 40, color: "#eaf7ff", bg: "rgba(8,16,26,.86)", border: "rgba(53,224,255,.6)", radius: 10, padX: 16, padY: 8 }), 0.2, {});
      label.position.set(ctr.x, ctr.y + size.y / 2 + 0.3, ctr.z);
      g.add(label);
    }
    placeProp(g, pos.x, pos.y, pos.z, rot, extraGroup);
    const e = { id: it.id, it: it, group: g, pick: pick, outline: outline, beam: beam, label: label, sig: extraSign(it), pos: pos, size: size };
    extras.set(it.id, e);
    extraPickList.push(pick);
    applyExtraStatus(e);
    return e;
  }
  function removeExtra(id) {
    const e = extras.get(id);
    if (!e) return;
    const i = extraPickList.indexOf(e.pick);
    if (i >= 0) extraPickList.splice(i, 1);
    extraGroup.remove(e.group);
    e.group.traverse((o) => {
      if ((o.isMesh || o.isLine) && o.geometry) o.geometry.dispose();   // 几何均按图元新建；共享材质不释放
    });
    extras.delete(id);
  }
  function updateExtra(e, it) {
    removeExtra(e.id);
    createExtra(it);
  }
  function applyExtraStatus(e) {
    const st = e.it.status;
    const lv = st === true ? "critical" : (st && (st.level || st)) || null;
    const on = !!lv && lv !== "normal" && lv !== "offline" && lv !== false;
    const col = lv === "warning" ? 0xf5a524 : lv === "info" ? 0x35e0ff : 0xff4d4f;
    e.outline.visible = on;
    e.beam.visible = on;
    e.outline.material.color.setHex(col);
    e.beam.material.color.setHex(col);
    if (e.label) e.label.material.opacity = on ? 1 : 0.92;
  }
  function updateExtraFx() {
    if (!extras.size) return;
    const p = 0.5 + 0.5 * Math.sin(elapsed * 3.4);
    const M = extraShared;
    if (M) { M.beam.opacity = 0.07 + 0.15 * p; }
    extras.forEach((e) => {
      if (!e.outline.visible) return;
      const s = 0.99 + 0.02 * p;
      e.outline.scale.set(s, s, s);
      if (e.label) e.label.position.y = e.outline.position.y + e.size.y / 2 + 0.3 + 0.04 * p;
    });
  }
  function extraAt(id) { return extras.get(id) || null; }
  /* ======================= 机柜（高细节 + LOD） ======================= */
  function addPart(im, idx, r, x, y, z, yaw, sx, sy, sz) {
    setInst(im, idx, x, y, z, yaw, sx, sy, sz);
    const m = new THREE.Matrix4();
    im.getMatrixAt(idx, m);
    r.parts.push([im, idx, m]);
  }
  function buildRacks() {
    const list = D.racks || [];
    const N = list.length;

    /* ---- pass 1：规划（设备分组 / 空 U 位挡板） ---- */
    const devGroups = [];
    const devIndex = new Map();
    let blankCount = 0;
    list.forEach((def, ri) => {
      const r = { def: def, i: ri, yaw: def.rot || 0, doorOpen: 0, doorTarget: 0, parts: [], hidden: false, near: true, devItems: [], blanks: [] };
      racks.push(r);
      rackById[def.id] = r;
      const devices = (def.devices || []).slice().sort((a, b) => a.uStart - b.uStart);
      const used = [];
      devices.forEach((dv, k) => {
        const kind = dv.type || "server";
        const us = Math.min(2, Math.max(1, dv.uSize || 1));
        const seed = 1 + ((ri + k) % 2);
        const key = kind + "|" + us + "|" + seed;
        let g = devIndex.get(key);
        if (!g) { g = { kind: kind, uSize: us, seed: seed, items: [] }; devIndex.set(key, g); devGroups.push(g); }
        g.items.push({ r: r, dv: dv, us: us });
        r.devItems.push({ dv: dv, us: us });
        used.push([dv.uStart, dv.uStart + us - 1]);
      });
      used.sort((a, b) => a[0] - b[0]);
      const pushRange = (s, e) => { let x = s; while (x <= e) { const len = Math.min(4, e - x + 1); r.blanks.push([x, len]); x += len; } };
      let cur = 1;
      used.forEach((rg) => { if (rg[0] > cur) pushRange(cur, rg[0] - 1); cur = Math.max(cur, rg[1] + 1); });
      const uTot = def.uTotal || U_TOTAL;
      if (cur <= uTot) pushRange(cur, uTot);
      blankCount += r.blanks.length;
    });

    /* ---- pass 2：实例网格 ---- */
    const frameMat = MAT.rackFrame(), sideMat = MAT.rackSide();
    const doorMatTiled = matRepeat(MAT.rackDoor(), 1, 1.75);
    const railMat = MAT.rail(U_TOTAL / 3);
    const basicMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    IM.posts = makeIM(new THREE.BoxGeometry(0.055, RACK_H, 0.055), frameMat, N * 4, SHADOWS, true);
    IM.capTop = makeIM(new THREE.BoxGeometry(RACK_W, 0.07, RACK_D), frameMat, N, SHADOWS, true);
    IM.base = makeIM(new THREE.BoxGeometry(RACK_W, 0.12, RACK_D), frameMat, N, SHADOWS, true);
    IM.sides = makeIM(new THREE.BoxGeometry(0.03, RACK_H - 0.2, RACK_D - 0.05), sideMat, N * 2, SHADOWS, true);
    IM.back = makeIM(new THREE.BoxGeometry(RACK_W - 0.1, 1.42, 0.03), sideMat, N, SHADOWS, true);
    IM.rearDoor = makeIM(new THREE.BoxGeometry(RACK_W - 0.13, RACK_H - 0.2, 0.022), doorMatTiled, N, false, false);
    IM.rails = makeIM(new THREE.BoxGeometry(0.05, 2.02, 0.05), railMat, N * 2, false, true);
    IM.uScale = makeIM(new THREE.PlaneGeometry(0.075, 2.0), new THREE.MeshBasicMaterial({ map: TEX.uScale({ count: U_TOTAL }).map }), N * 2);
    IM.doorBar = makeIM(new THREE.BoxGeometry(RACK_W, 0.05, 0.055), frameMat, N * 2, SHADOWS, false);
    IM.strips = makeIM(new THREE.BoxGeometry(0.026, RACK_H - 0.32, 0.022), basicMat, N * 2);
    IM.leds = makeIM(new THREE.SphereGeometry(0.026, 10, 8), basicMat, N);
    IM.topbar = makeIM(new THREE.BoxGeometry(RACK_W - 0.16, 0.035, 0.03), basicMat, N);
    IM.fans = makeIM(new THREE.BoxGeometry(0.95, 0.42, 0.06), MAT.fan(), N, false, false);
    IM.pdus = makeIM(new THREE.BoxGeometry(0.055, RACK_H - 0.62, 0.06), MAT.pdu(), N * 2, false, false);
    IM.cables = makeIM(new THREE.BoxGeometry(0.028, 0.95, 0.028), MAT.cable(["#e8c33a", "#2f7fe8", "#22c55e", "#e2e8f0"]), N * 4, false, false);
    IM.blanks = makeIM(new THREE.BoxGeometry(0.9, 1, 0.03), MAT.blank(), Math.max(1, blankCount), false, false);
    devGroups.forEach((grp) => {
      grp.im = makeIM(new THREE.BoxGeometry(0.9, 1, 0.55), MAT.device(grp.kind, grp.uSize, grp.seed), grp.items.length, false, false);
      grp.n = 0; grp.map = [];
    });
    IM.farBox = makeIM(new THREE.BoxGeometry(RACK_W, RACK_H, RACK_D), sideMat, N, SHADOWS, true);
    IM.farTop = makeIM(new THREE.BoxGeometry(RACK_W, 0.07, RACK_D), frameMat, N, SHADOWS, false);
    IM.pick = makeIM(new THREE.BoxGeometry(RACK_W + 0.12, RACK_H + 0.16, RACK_D + 0.55), new THREE.MeshBasicMaterial({ visible: false }), N);
    const labelGeo = new THREE.PlaneGeometry(0.62, 0.17);

    /* ---- pass 3：摆放 ---- */
    let bi = 0;
    const used = [];
    racks.forEach((r) => {
      const yaw = r.yaw, def = r.def;
      /* 四立柱 */
      let k = r.i * 4;
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach((c) => {
        localToWorld(r, c[0] * (RACK_W / 2 - 0.028), RACK_H / 2, c[1] * (RACK_D / 2 - 0.028), tmpV);
        addPart(IM.posts, k++, r, tmpV.x, tmpV.y, tmpV.z, yaw, 1, 1, 1);
      });
      /* 顶盖 / 底座 */
      addPart(IM.capTop, r.i, r, def.x, RACK_H - 0.035, def.z, yaw, 1, 1, 1);
      addPart(IM.base, r.i, r, def.x, 0.06, def.z, yaw, 1, 1, 1);
      /* 侧板 ×2 */
      [-1, 1].forEach((s, si) => {
        localToWorld(r, s * (RACK_W / 2 + 0.012), RACK_H / 2, -0.01, tmpV);
        addPart(IM.sides, r.i * 2 + si, r, tmpV.x, tmpV.y, tmpV.z, yaw, 1, 1, 1);
      });
      /* 后板（下部实心，上部留线缆口）+ 后网孔门 */
      localToWorld(r, 0, 0.15 + 0.71, -(RACK_D / 2 + 0.005), tmpV);
      addPart(IM.back, r.i, r, tmpV.x, tmpV.y, tmpV.z, yaw, 1, 1, 1);
      localToWorld(r, 0, RACK_H / 2, -(RACK_D / 2 + 0.02), tmpV);
      addPart(IM.rearDoor, r.i, r, tmpV.x, tmpV.y, tmpV.z, yaw, 1, 1, 1);
      /* 19" 立柱 + U 位刻度 */
      [-1, 1].forEach((s, si) => {
        localToWorld(r, s * 0.42, U_BOTTOM + 1.01, 0.36, tmpV);
        addPart(IM.rails, r.i * 2 + si, r, tmpV.x, tmpV.y, tmpV.z, yaw, 1, 1, 1);
        localToWorld(r, s * 0.435, U_BOTTOM + 1.01, 0.40, tmpV);
        addPart(IM.uScale, r.i * 2 + si, r, tmpV.x, tmpV.y, tmpV.z, yaw, 1, 1, 1);
      });
      /* 门框上下横梁 + 前灯带 + 状态灯 + 顶灯条 */
      [0.145, RACK_H - 0.1].forEach((y, si) => {
        localToWorld(r, 0, y, RACK_D / 2 + 0.02, tmpV);
        addPart(IM.doorBar, r.i * 2 + si, r, tmpV.x, tmpV.y, tmpV.z, yaw, 1, 1, 1);
      });
      [-1, 1].forEach((s, si) => {
        localToWorld(r, s * (RACK_W / 2 + 0.006), RACK_H / 2 - 0.02, RACK_D / 2 + 0.028, tmpV);
        addPart(IM.strips, r.i * 2 + si, r, tmpV.x, tmpV.y, tmpV.z, yaw, 1, 1, 1);
      });
      localToWorld(r, RACK_W / 2 - 0.16, RACK_H - 0.13, RACK_D / 2 + 0.03, tmpV);
      addPart(IM.leds, r.i, r, tmpV.x, tmpV.y, tmpV.z, yaw, 1, 1, 1);
      localToWorld(r, 0, RACK_H - 0.062, RACK_D / 2 + 0.028, tmpV);
      addPart(IM.topbar, r.i, r, tmpV.x, tmpV.y, tmpV.z, yaw, 1, 1, 1);
      /* 风扇模组 / 竖装 PDU / 侧边走线 */
      localToWorld(r, 0, RACK_H - 0.42, 0.24, tmpV);
      addPart(IM.fans, r.i, r, tmpV.x, tmpV.y, tmpV.z, yaw, 1, 1, 1);
      [-1, 1].forEach((s, si) => {
        localToWorld(r, s * (RACK_W / 2 - 0.075), RACK_H / 2, 0.3, tmpV);
        addPart(IM.pdus, r.i * 2 + si, r, tmpV.x, tmpV.y, tmpV.z, yaw, 1, 1, 1);
      });
      for (let c = 0; c < 4; c++) {
        const s = c % 2 ? 1 : -1;
        localToWorld(r, s * (RACK_W / 2 - 0.135), 0.55 + Math.floor(c / 2) * 0.62 + 0.45, 0.32, tmpV);
        addPart(IM.cables, r.i * 4 + c, r, tmpV.x, tmpV.y, tmpV.z, yaw, 1, 1, 1);
      }
      /* 空 U 位盲板 */
      r.blanks.forEach(([s, len]) => {
        const y = U_BOTTOM + ((s - 1) + len * 0.5) * U_H;
        localToWorld(r, 0, y, 0.42, tmpV);
        setInst(IM.blanks, bi, tmpV.x, tmpV.y, tmpV.z, yaw, 1, len * U_H * 0.86, 1);
        const mb = new THREE.Matrix4();
        IM.blanks.getMatrixAt(bi, mb);
        r.parts.push([IM.blanks, bi, mb]);
        bi++;
      });
      /* 内部设备 */
      r.devItems.forEach((it) => {
        const kind = it.dv.type || "server";
        const seed = 1 + ((r.i + r.devItems.indexOf(it)) % 2);
        const key = kind + "|" + it.us + "|" + seed;
        const grp = devIndex.get(key);
        if (!grp) return;
        const y = U_BOTTOM + ((it.dv.uStart - 1) + it.us * 0.5) * U_H;
        localToWorld(r, 0, y, 0.12, tmpV);
        const n = grp.n++;
        setInst(grp.im, n, tmpV.x, tmpV.y, tmpV.z, yaw, 1, it.us * U_H * 0.86, 1);
        const md = new THREE.Matrix4();
        grp.im.getMatrixAt(n, md);
        r.parts.push([grp.im, n, md]);
        grp.map[n] = { rackId: def.id, deviceId: it.dv.id, x: tmpV.x, y: tmpV.y, z: tmpV.z, yaw: yaw, sy: it.us * U_H * 0.86 };
      });
      /* 铭牌（顶面前沿，微仰角便于俯视阅读） */
      const lm = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.13), MAT.label(def.id, { sub: def.zoneLabel || "", w: 384, h: 104, size: 58, border: "#35e0ff" }));
      localToWorld(r, 0, RACK_H - 0.055, RACK_D / 2 + 0.035, tmpV);
      lm.position.copy(tmpV);
      lm.rotation.set(-0.22, yaw, 0, "YXZ");
      scene.add(lm);
      r.label = lm;
      /* 前门（真实镂空，可开合） */
      const pivot = new THREE.Group();
      localToWorld(r, -RACK_W / 2 + 0.03, 0, RACK_D / 2 + 0.022, tmpV);
      pivot.position.copy(tmpV);
      pivot.rotation.y = yaw;
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(RACK_W - 0.06, RACK_H - 0.2), doorMatTiled);
      panel.position.set((RACK_W - 0.06) / 2 + 0.01, RACK_H / 2, 0);
      pivot.add(panel);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.3, 0.032), frameMat);
      handle.position.set(RACK_W - 0.16, RACK_H * 0.52, 0.04);
      pivot.add(handle);
      scene.add(pivot);
      r.doorPivot = pivot;
      /* 拾取代理（仅随 hidden 变化，不随 LOD 隐藏） */
    });
    devGroups.forEach((grp) => { pickDevs.push({ im: grp.im, map: grp.map }); });
    flushColors(["posts", "capTop", "base", "sides", "back", "farBox", "farTop", "strips", "leds", "topbar"]);
  }

  /* ======================= LOD / 聚焦显隐 ======================= */
  function applyRackState(r) {
    const dv = r.near && !r.hidden;
    const fv = !r.near && !r.hidden;
    for (let k = 0; k < r.parts.length; k++) {
      const p = r.parts[k];
      p[0].setMatrixAt(p[1], dv ? p[2] : _tmpM.copy(p[2]).scale(_tinyV));
      p[0].instanceMatrix.needsUpdate = true;
    }
    setInst(IM.pick, r.i, r.def.x, RACK_H / 2, r.def.z, r.yaw, r.hidden ? 0.0001 : 1, r.hidden ? 0.0001 : 1, r.hidden ? 0.0001 : 1);
    setInst(IM.farBox, r.i, r.def.x, RACK_H / 2, r.def.z, r.yaw, fv ? 1 : 0.0001, fv ? 1 : 0.0001, fv ? 1 : 0.0001);
    setInst(IM.farTop, r.i, r.def.x, RACK_H - 0.035, r.def.z, r.yaw, fv ? 1 : 0.0001, fv ? 1 : 0.0001, fv ? 1 : 0.0001);
    if (r.doorPivot) r.doorPivot.visible = !r.hidden;
    if (r.label) r.label.visible = !r.hidden;
  }
  function updateLOD(force) {
    if (!ready && !force) return;
    for (let i = 0; i < racks.length; i++) {
      const r = racks[i];
      const dx = camera.position.x - r.def.x, dy = camera.position.y - 1.1, dz = camera.position.z - r.def.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const near = d <= LOD_NEAR || r.def.id === selectedId;
      if (near !== r.near || force) { r.near = near; applyRackState(r); }
    }
  }
  let showcase = false;
  function setShowcase(on) {
    if (showcase === !!on) return;
    showcase = !!on;
    for (let i = 0; i < racks.length; i++) { racks[i].hidden = !!on; applyRackState(racks[i]); }
    for (let i = 0; i < zoneSprites.length; i++) zoneSprites[i].visible = !on;
  }
  function setFocusBlockers(target) {
    if (!target) {
      if (!focusHidden) return;
      focusHidden = null;
      for (let i = 0; i < racks.length; i++) if (racks[i].hidden) { racks[i].hidden = false; applyRackState(racks[i]); }
      return;
    }
    const dx = Math.sin(target.yaw), dz = Math.cos(target.yaw);
    const reach = RACK_H * 2.5 + 1.0 + 2.0;
    const hide = [];
    for (let i = 0; i < racks.length; i++) {
      const rr = racks[i];
      if (rr === target) { hide[i] = false; continue; }
      const rx = rr.def.x - target.def.x, rz = rr.def.z - target.def.z;
      const a = rx * dx + rz * dz;
      const lat = Math.sqrt(Math.max(0, rx * rx + rz * rz - a * a));
      hide[i] = a > 0.4 && a < reach && lat < 3.8;
    }
    focusHidden = hide;
    for (let i = 0; i < racks.length; i++) {
      const want = !hide[i];
      if (racks[i].hidden === !want) continue;
      racks[i].hidden = !want;
      applyRackState(racks[i]);
    }
  }

  /* ======================= 选中 / 悬停高亮 ======================= */
  function buildSelection() {
    selGroup = new THREE.Group();
    selGroup.visible = false;
    scene.add(selGroup);
    const bw = RACK_W + 0.24, bh = RACK_H + 0.22, bd = RACK_D + 0.52;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(bw, bh, bd)),
      new THREE.LineBasicMaterial({ color: C_CYAN2, transparent: true, opacity: 0.9, toneMapped: false })
    );
    edges.position.y = RACK_H / 2;
    selGroup.add(edges);
    const ringMat = new THREE.MeshBasicMaterial({ color: C_CYAN2, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.96, 0.026, 8, 64), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    selGroup.add(ring);
    const glowMat = new THREE.MeshBasicMaterial({ map: TEX.glow({ color: "#35e0ff" }).map, color: C_CYAN2, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const glow = new THREE.Mesh(new THREE.RingGeometry(0.62, 1.55, 48), glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.025;
    selGroup.add(glow);
    const barMat = new THREE.MeshBasicMaterial({ color: C_CYAN2, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach((c) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.045, RACK_H + 0.2, 0.045), barMat);
      b.position.set(c[0] * (RACK_W / 2 + 0.08), RACK_H / 2, c[1] * (RACK_D / 2 + 0.08));
      selGroup.add(b);
    });
    const sp = makeTextSprite(makeTextTexture("机柜", {
      fs: 46, color: "#eaf7ff", bg: "rgba(8,16,26,.88)", border: "rgba(53,224,255,.6)", radius: 14, padX: 24,
    }), 0.36, {});
    sp.position.y = RACK_H + 0.5;
    selGroup.add(sp);
    selGroup.userData = { edges: edges, ring: ring, glow: glow, sprite: sp, mats: [ringMat, glowMat, barMat, edges.material] };

    hoverBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(RACK_W + 0.06, RACK_H + 0.08, RACK_D + 0.44)),
      new THREE.LineBasicMaterial({ color: C_CYAN2, transparent: true, opacity: 0.4, toneMapped: false })
    );
    hoverBox.visible = false;
    hoverBox.position.y = RACK_H / 2;
    scene.add(hoverBox);

    devHighlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.95, toneMapped: false })
    );
    devHighlight.visible = false;
    scene.add(devHighlight);
  }

  /* ======================= 告警光柱池 ======================= */
  function buildBeacons() {
    const glowTex = TEX.glow({ color: "#ff5a5a" }).map;
    for (let i = 0; i < 8; i++) {
      const g = new THREE.Group();
      g.visible = false;
      scene.add(g);
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.28, 4.6, 20, 1, true),
        new THREE.MeshBasicMaterial({ color: C_CRIT, transparent: true, opacity: 0.11, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
      );
      pillar.position.y = 2.3;
      g.add(pillar);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.86, 0.045, 8, 48),
        new THREE.MeshBasicMaterial({ color: C_CRIT, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      g.add(ring);
      const glow = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 1.8, 40),
        new THREE.MeshBasicMaterial({ map: glowTex, color: C_CRIT, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
      );
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.03;
      g.add(glow);
      const sp = makeTextSprite(makeTextTexture("告警", {
        fs: 40, color: "#ffe1e1", bg: "rgba(58,10,14,.86)", border: "rgba(255,77,79,.85)", radius: 10, padX: 18, glow: "rgba(255,77,79,.9)",
      }), 0.36, {});
      sp.position.y = 3.15;
      g.add(sp);
      beacons.push({ group: g, pillar: pillar, ring: ring, glow: glow, rackId: null, phase: (i * 1.7) % TAU });
    }
  }

  /* ======================= 数字人「小维」 ======================= */
  const BUBBLE_TEX = (function () {
    const W = 256, H = 140, c = newCanvas(W, H), ctx = c.getContext("2d");
    rrPath(ctx, 8, 8, W - 16, H - 44, 22); ctx.fillStyle = "rgba(8,24,38,.92)"; ctx.fill();
    ctx.strokeStyle = "rgba(53,224,255,.8)"; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = "rgba(8,24,38,.92)";
    ctx.beginPath(); ctx.moveTo(96, H - 40); ctx.lineTo(122, H - 40); ctx.lineTo(104, H - 8); ctx.closePath(); ctx.fill();
    return cvsTexture(c);
  })();
  function buildAvatar() {
    const root = new THREE.Group();
    root.position.set(-2.4, 0, 9.4);
    root.rotation.y = Math.PI;
    scene.add(root);
    const suit = new THREE.MeshStandardMaterial({ color: 0x3f8fe0, emissive: 0x0d2a4a, metalness: 0.35, roughness: 0.4 });
    const white = new THREE.MeshStandardMaterial({ color: 0xdff2ff, emissive: 0x1a3c58, metalness: 0.15, roughness: 0.45 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x16283a, emissive: 0x08131e, metalness: 0.4, roughness: 0.5 });
    const glow = new THREE.MeshBasicMaterial({ color: C_CYAN2, toneMapped: false });
    const groundGlow = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.72, 44),
      new THREE.MeshBasicMaterial({ map: TEX.glow({ color: "#35e0ff" }).map, color: C_CYAN2, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    groundGlow.rotation.x = -Math.PI / 2;
    groundGlow.position.y = 0.02;
    root.add(groundGlow);
    const body = new THREE.Group();
    root.add(body);
    function limb(w, h, d, mat, py) {
      const p = new THREE.Group();
      p.position.y = py;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.y = -h / 2; m.castShadow = SHADOWS;
      p.add(m);
      body.add(p);
      return p;
    }
    const legL = limb(0.16, 0.7, 0.18, dark, 0.78);
    const legR = limb(0.16, 0.7, 0.18, dark, 0.78);
    [legL, legR].forEach((leg) => {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.1, 0.28), white);
      foot.position.set(0, -0.72, 0.04);
      leg.add(foot);
    });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.62, 0.3), suit);
    torso.position.y = 1.11; torso.castShadow = SHADOWS; body.add(torso);
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.02), glow);
    chest.position.set(0, 1.24, 0.155); body.add(chest);
    const belt = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.06, 0.31), white);
    belt.position.y = 0.83; body.add(belt);
    const armL = limb(0.12, 0.52, 0.14, suit, 1.36);
    const armR = limb(0.12, 0.52, 0.14, suit, 1.36);
    armL.position.x = -0.31; armR.position.x = 0.31;
    [armL, armR].forEach((a) => {
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.12, 0.15), white);
      hand.position.y = -0.58; a.add(hand);
    });
    const padL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.13, 0.22), white);
    padL.position.set(-0.31, 1.4, 0); body.add(padL);
    const padR = padL.clone(); padR.position.x = 0.31; body.add(padR);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.09, 8), dark);
    neck.position.y = 1.46; body.add(neck);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.32), white);
    head.position.y = 1.66; head.castShadow = SHADOWS; body.add(head);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, 0.02), glow);
    visor.position.set(0, 1.67, 0.165); body.add(visor);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.36, 0.12), dark);
    pack.position.set(0, 1.14, -0.2); body.add(pack);
    const cursor = new THREE.Group();
    cursor.position.y = 2.32;
    root.add(cursor);
    const curRing = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.02, 6, 24), glow);
    curRing.rotation.x = -Math.PI / 2; cursor.add(curRing);
    const curCone = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.17, 4), glow);
    curCone.rotation.x = Math.PI; curCone.position.y = -0.11; cursor.add(curCone);
    const bubble = new THREE.Group();
    bubble.position.set(0.52, 2.42, 0); bubble.visible = false; root.add(bubble);
    const bbg = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.52),
      new THREE.MeshBasicMaterial({ map: BUBBLE_TEX, transparent: true, depthWrite: false, toneMapped: false }));
    bubble.add(bbg);
    const bars = [];
    for (let i = 0; i < 5; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.12, 0.01), glow);
      b.position.set(-0.24 + i * 0.12, -0.06, 0.01);
      bubble.add(b); bars.push(b);
    }
    const lightA = new THREE.PointLight(0x35e0ff, 4, 4.5, 2);
    lightA.position.y = 1.9; root.add(lightA);
    avatar = { root: root, body: body, legL: legL, legR: legR, armL: armL, armR: armR, cursor: cursor,
      bubble: bubble, bars: bars, light: lightA, groundGlow: groundGlow,
      walk: null, moving: false, swing: 0, phase: 0, speaking: false, pointT: 0 };
  }

  /* ======================= 相机 / 视图 ======================= */
  const VIEWS = {
    overview: { pos: [15.6, 12.4, 18.6], target: [0, 1.0, -3.8], dur: 1.15, fov: 42 },
    aisle: { pos: [-8.4, 1.6, -12], target: [7.6, 1.3, -12], dur: 1.2, fov: 52 },
    roomOrbit: { pos: [16.4, 14.6, 18.4], target: [0, 1.0, -3.8], dur: 1.35, fov: 42 },
    energy: { pos: [-15.5, 10.5, 15.0], target: [-1.0, 1.2, -6.5], dur: 1.35, fov: 44 },
    alarm: { pos: [16.2, 12.2, 18.4], target: [0, 1.4, -3.8], dur: 1.35, fov: 44 },
    props: { pos: [0.6, 2.85, -10.6], target: [0.6, 1.45, -16.5], dur: 1.35, fov: 80 },
  };
  function flyTo(p, t, dur, onDone, ease, fov) {
    tween = {
      t0: performance.now(), dur: Math.max(0.05, dur || 1),
      p0: camera.position.clone(), p1: p.clone(),
      q0: controls.target.clone(), q1: t.clone(),
      f0: camera.fov, f1: fov || 42,
      ease: ease || easeInOut, onDone: onDone || null,
    };
  }
  function updateTween() {
    if (!tween) return;
    const k = clamp((performance.now() - tween.t0) / (tween.dur * 1000), 0, 1);
    const e = tween.ease(k);
    camera.position.lerpVectors(tween.p0, tween.p1, e);
    controls.target.lerpVectors(tween.q0, tween.q1, e);
    if (camera.fov !== tween.f1) { camera.fov = lerp(tween.f0, tween.f1, e); camera.updateProjectionMatrix(); }
    if (k >= 1) { const f = tween.onDone; tween = null; if (f) f(); }
  }
  function rackCam(r, outPos, outTgt) {
    const H = RACK_H;
    const d = H * 2.5 + 1.0;
    const back = r.def.rot === 0 ? 1 : -1;
    const dir = new THREE.Vector3(0.42, 0, back).normalize();
    outPos.set(r.def.x + dir.x * d, H * 0.5 + H * 0.85, r.def.z + dir.z * d);
    outTgt.set(r.def.x, H * 0.66, r.def.z);
    return outPos;
  }
  function flyToRack(r, dur, onDone) {
    const p = new THREE.Vector3(), t = new THREE.Vector3();
    rackCam(r, p, t);
    flyTo(p, t, dur, onDone, null, 34);
  }

  /* ======================= 指针交互 ======================= */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downX = 0, downY = 0, downT = 0, dragged = false, lastHover = 0;
  function ndcFromEvent(ev) {
    const rect = canvasEl.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return ndc;
  }
  function selectRack(id, fly) {
    const r = rackById[id];
    api.highlightRack(id, null);
    if (fly && r) flyToRack(r, 1.0);
    if (bus) bus.emit("rack:select", id);
  }
  function selectDevice(info) {
    api.highlightRack(info.rackId, null);
    devHighlight.visible = true;
    devHighlight.position.set(info.x, info.y, info.z);
    devHighlight.rotation.set(0, info.yaw, 0);
    devHighlight.scale.set(0.97, Math.max(info.sy * 1.5, 0.05), 0.62);
    selectedDevice = { rackId: info.rackId, deviceId: info.deviceId };
    api.openRack(info.rackId, true);
    if (bus) bus.emit("device:select", { rackId: info.rackId, deviceId: info.deviceId });
  }
  function setupPointer() {
    canvasEl.addEventListener("pointerdown", (e) => {
      downX = e.clientX; downY = e.clientY; downT = performance.now(); dragged = false;
      if (intro) finishIntro();
    });
    canvasEl.addEventListener("pointermove", (e) => {
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 7) dragged = true;
      const now = performance.now();
      if (now - lastHover < 110 || !ready) return;
      lastHover = now;
      ndcFromEvent(e);
      const hit = raycaster.intersectObject(IM.pick, false);
      let id = hit.length ? racks[hit[0].instanceId] && racks[hit[0].instanceId].def.id : null;
      if (id && rackById[id] && rackById[id].hidden) id = null;
      hoveredId = id;
      if (id) {
        const r = rackById[id];
        hoverBox.visible = true;
        hoverBox.position.set(r.def.x, RACK_H / 2, r.def.z);
        hoverBox.rotation.y = r.yaw;
        canvasEl.style.cursor = "pointer";
      } else {
        const dhH = raycaster.intersectObject(IM.dhPick, false);
        const exH = extraPickList.length ? raycaster.intersectObjects(extraPickList, false) : [];
        hoverBox.visible = false;
        canvasEl.style.cursor = (dhH.length || exH.length) ? "pointer" : "";
      }
    });
    canvasEl.addEventListener("pointerup", (e) => {
      if (dragged || performance.now() - downT > 700 || !ready) return;
      ndcFromEvent(e);
      /* 1) 优先拾取 U 位设备 */
      let best = null;
      for (let i = 0; i < pickDevs.length; i++) {
        const pd = pickDevs[i];
        const hits = raycaster.intersectObject(pd.im, false);
        for (let h = 0; h < hits.length; h++) {
          const hh = hits[h];
          const info = pd.map[hh.instanceId];
          if (!info) continue;
          const rr = rackById[info.rackId];
          if (!rr || !rr.near || rr.hidden) continue;
          if (!best || hh.distance < best.distance) best = { distance: hh.distance, info: info };
        }
      }
      /* 2) 动环点位 / 机柜：按距离就近取一个 */
      const exHit = extraPickList.length ? (raycaster.intersectObjects(extraPickList, false)[0] || null) : null;
      const dhHit = raycaster.intersectObject(IM.dhPick, false)[0] || null;
      const ph = raycaster.intersectObject(IM.pick, false)[0] || null;
      const exD = exHit ? exHit.distance : Infinity;
      const dhD = dhHit ? dhHit.distance : Infinity;
      const devD = best ? best.distance : Infinity;
      const rackD = ph ? ph.distance : Infinity;
      if (exHit && exD <= dhD && exD <= devD && exD <= rackD) {
        const eid = exHit.object.userData.extraId;
        if (eid) {
          if (bus) bus.emit("plan:select", { type: "extra", ref: eid });
          api.focusExtra(eid, { duration: 0.95 });
          return;
        }
      }
      if (dhHit && dhD <= devD && dhD <= rackD) {
        const de = dhPickMap[dhHit.instanceId];
        if (de) {
          if (bus) bus.emit("dh:select", { devId: de.devId, pointId: de.pointId });
          api.focusDevice(de.devId, { duration: 0.95 });
          return;
        }
      }
      if (best) { selectDevice(best.info); return; }
      if (ph) { const r = racks[ph.instanceId]; if (r) selectRack(r.def.id, true); }
    });
    canvasEl.addEventListener("pointerleave", () => {
      hoverBox.visible = false;
      canvasEl.style.cursor = "";
    });
    canvasEl.addEventListener("dblclick", () => {
      if (hoveredId) api.focusRack(hoveredId, { open: true, duration: 1.0 });
    });
  }

  /* ======================= 颜色刷新 ======================= */
  const FLOOR_TINT = { status: [0x22d3ee, 0.03], temp: [0x2f7fe8, 0.10], load: [0x7c6cf0, 0.10], alarm: [0xff4d4f, 0.12] };
  function updateRackColors() {
    if (!IM.posts) return;
    const n = racks.length;
    for (let i = 0; i < n; i++) {
      const r = racks[i], d = r.def;
      const rowI = "ABCDEF".indexOf(d.row);
      const rl = rowI >= 0 && rowLight[rowI] != null ? rowLight[rowI] : 1;
      const acc = accentOf(r, mode);
      const tint = bodyTintOf(r, mode);
      const dim = 0.35 + 0.65 * rl;
      instColor(IM.posts, i * 4, tint); instColor(IM.posts, i * 4 + 1, tint);
      instColor(IM.posts, i * 4 + 2, tint); instColor(IM.posts, i * 4 + 3, tint);
      instColor(IM.capTop, i, tint); instColor(IM.base, i, tint);
      instColor(IM.sides, i * 2, tint); instColor(IM.sides, i * 2 + 1, tint);
      instColor(IM.back, i, tint);
      instColor(IM.farBox, i, tmpC.copy(tint).multiplyScalar(0.92));
      instColor(IM.farTop, i, tint);
      const sc = stripColorOf(r, mode);
      const bright = (0.7 + 0.3 * rl) * dim;
      instColor(IM.strips, i * 2, tmpC2.copy(sc).multiplyScalar(bright));
      instColor(IM.strips, i * 2 + 1, tmpC2.copy(sc).multiplyScalar(bright));
      instColor(IM.topbar, i, tmpC2.copy(sc).multiplyScalar(0.85 * dim));
      instColor(IM.leds, i, tmpC2.copy(acc).multiplyScalar(0.5 + 0.5 * rl));
    }
    flushColors(["posts", "capTop", "base", "sides", "back", "farBox", "farTop", "strips", "leds", "topbar"]);
    if (floorTint) {
      const ft = FLOOR_TINT[mode] || FLOOR_TINT.status;
      floorTint.material.color.setHex(ft[0]);
      floorTint.material.opacity = ft[1];
    }
  }
  let lastZoneUpd = -99;
  function updateZoneLabels(force) {
    if (!zoneSprites.length || !D) return;
    if (!force && elapsed - lastZoneUpd < 1.4) return;
    lastZoneUpd = elapsed;
    const zones = [["A", "B"], ["C", "D"], ["E", "F"]];
    zones.forEach((rows, i) => {
      let t = 0, c = 0;
      racks.forEach((r) => { if (rows.indexOf(r.def.row) >= 0) { t += r.def.tempIn; c++; } });
      if (!c) return;
      t = t / c;
      const sp = zoneSprites[i];
      const tex = makeTextTexture(["A 区", "B 区", "C 区"][i] + " · " + t.toFixed(1) + "℃", {
        fs: 44, color: "#eaf7ff", bg: "rgba(8,16,26,.82)", border: "rgba(53,224,255,.5)",
        radius: 14, padX: 26, padY: 14, glow: "rgba(53,224,255,.6)",
      });
      if (sp.material.map) sp.material.map.dispose();
      sp.material.map = tex.texture;
      sp.material.needsUpdate = true;
      sp.scale.set(sp.userData.baseH * tex.w / tex.h, sp.userData.baseH, 1);
    });
  }

  /* ======================= 每帧更新 ======================= */
  function updateDoors(dt) {
    for (let i = 0; i < racks.length; i++) {
      const r = racks[i];
      const tgt = r.doorTarget;
      if (Math.abs(r.doorOpen - tgt) < 0.0015) r.doorOpen = tgt;
      else r.doorOpen = damp(r.doorOpen, tgt, 7, dt);
      if (r.doorPivot) r.doorPivot.rotation.y = r.yaw - r.doorOpen * 1.22;
    }
  }
  function updateBeacons(dt) {
    for (let i = 0; i < beacons.length; i++) {
      const b = beacons[i];
      if (b.rackId && b.rackId === selectedId) { b.group.visible = false; continue; }
      if (!b.group.visible) continue;
      const p = 0.5 + 0.5 * Math.sin(elapsed * 3.1 + b.phase);
      b.pillar.material.opacity = 0.07 + 0.13 * p;
      b.pillar.rotation.y += dt * 0.6;
      const s = 0.86 + 0.34 * p;
      b.ring.scale.set(s, s, 1);
      b.ring.material.opacity = 0.5 + 0.5 * p;
      b.glow.scale.set(s, s, 1);
      b.glow.material.opacity = 0.24 + 0.34 * p;
    }
  }
  function updateSelection() {
    if (!selGroup || !selGroup.visible) return;
    const p = 0.5 + 0.5 * Math.sin(elapsed * 3.6);
    const u = selGroup.userData;
    u.ring.material.opacity = 0.45 + 0.5 * p;
    u.glow.material.opacity = 0.25 + 0.32 * p;
    const s = 0.92 + 0.12 * p;
    u.ring.scale.set(s, s, 1);
    u.glow.scale.set(s, s, 1);
  }
  function updateAvatar(dt) {
    if (!avatar) return;
    const a = avatar;
    if (a.walk) {
      a.walk.t += dt;
      const k = clamp(a.walk.t / a.walk.dur, 0, 1);
      a.root.position.lerpVectors(a.walk.from, a.walk.to, easeInOut(k));
      a.root.position.y = 0;
      const dir = tmpV.copy(a.walk.to).sub(a.walk.from);
      if (dir.lengthSq() > 0.0004) {
        const yaw = Math.atan2(dir.x, dir.z);
        let d = yaw - a.root.rotation.y;
        while (d > Math.PI) d -= TAU;
        while (d < -Math.PI) d += TAU;
        a.root.rotation.y += d * Math.min(1, dt * 6);
      }
      a.moving = true;
      if (k >= 1) {
        a.root.position.copy(a.walk.to);
        a.root.rotation.y = a.walk.yaw;
        a.walk = null; a.moving = false; a.pointT = 2.0;
      }
    } else a.moving = false;
    a.phase += dt * (a.moving ? 9.4 : 0);
    a.swing = damp(a.swing, a.moving ? 0.62 : 0, 9, dt);
    const s = Math.sin(a.phase) * a.swing;
    a.legL.rotation.x = s; a.legR.rotation.x = -s;
    a.armL.rotation.x = -s * 0.85;
    if (a.pointT > 0) {
      a.pointT -= dt;
      a.armR.rotation.x = damp(a.armR.rotation.x, -1.35, 8, dt);
      a.armR.rotation.z = damp(a.armR.rotation.z, 0.35, 8, dt);
    } else {
      a.armR.rotation.x = s * 0.85;
      a.armR.rotation.z = damp(a.armR.rotation.z, 0, 6, dt);
    }
    a.body.position.y = a.moving ? Math.abs(Math.sin(a.phase)) * 0.05 : Math.sin(elapsed * 1.7) * 0.018;
    a.cursor.rotation.y += dt * 2.2;
    a.cursor.position.y = 2.32 + Math.sin(elapsed * 2.4) * 0.05;
    a.groundGlow.material.opacity = 0.35 + 0.2 * Math.sin(elapsed * 2.6);
    if (a.speaking) {
      for (let i = 0; i < a.bars.length; i++) {
        const h = 0.07 + (Math.sin(elapsed * 13 + i * 1.3) * 0.5 + 0.5) * 0.24;
        a.bars[i].scale.set(1, h / 0.12, 1);
        a.bars[i].position.y = -0.08 + h * 0.5;
      }
      a.bubble.position.y = 2.42 + Math.sin(elapsed * 3.2) * 0.03;
      a.light.intensity = 8 + 4 * Math.sin(elapsed * 8.5);
    } else a.light.intensity = damp(a.light.intensity, 3.5, 4, dt);
  }
  function updateIntro() {
    if (!intro) return;
    const t = (performance.now() - intro.t0) / 1000;
    intro.t = t;
    const amb = clamp((t - 0.3) / 1.7, 0, 1);
    lights.amb.intensity = 0.04 + amb * (LOW ? 0.72 : 0.42);
    lights.hemi.intensity = 0.02 + amb * (LOW ? 0.55 : 0.38);
    lights.key.intensity = amb * (LOW ? 2.5 : 2.6);
    lights.rim.intensity = amb * (LOW ? 0.5 : 0.5);
    lights.fill.intensity = amb * (LOW ? 0.35 : 0.35);
    const bgv = clamp((t - 0.1) / 1.9, 0, 1);
    scene.background.setRGB(bgv * 0.0196, bgv * 0.0314, bgv * 0.0588);
    for (let i = 0; i < 6; i++) rowLight[i] = clamp((t - 0.7 - i * 0.26) / 0.55, 0, 1);
    if (frames % 2 === 0) updateRackColors();
    const k = clamp((t - 1.2) / 3.4, 0, 1);
    camera.position.lerpVectors(intro.from, intro.to, easeInOut(k));
    controls.target.set(0, 1.0, -3.8);
    camera.lookAt(controls.target);
    if (t >= intro.dur) finishIntro();
  }
  function finishIntro() {
    if (!intro) return;
    const cb = intro.cb;
    intro = null;
    rowLight = [1, 1, 1, 1, 1, 1];
    lights.amb.intensity = LOW ? 0.72 : 0.42;
    lights.hemi.intensity = LOW ? 0.55 : 0.38;
    lights.key.intensity = LOW ? 2.5 : 2.6;
    lights.rim.intensity = LOW ? 0.5 : 0.5;
    lights.fill.intensity = LOW ? 0.35 : 0.35;
    scene.background.setHex(BG);
    if (backdrop) backdrop.visible = true;
    updateRackColors();
    controls.enabled = true;
    const v = VIEWS.overview;
    camera.position.set(v.pos[0], v.pos[1], v.pos[2]);
    controls.target.set(v.target[0], v.target[1], v.target[2]);
    camera.fov = 42; camera.updateProjectionMatrix();
    controls.update();
    updateLOD(true);
    if (cb) cb();
  }
  function bindBus() {
    if (!bus) return;
    bus.on("page", (p) => {
      if (p === "alarms") api.setMode("alarm");
      else if (p === "energy") api.setMode("load");
      else api.setMode("status");
    });
    bus.on("data:tick", () => { updateRackColors(); updateZoneLabels(); });
    bus.on("dh:alarm", (a) => { if (a && a.devId) setDhAlarm(a.devId, a.level || "critical"); });
    bus.on("dh:alarm:clear", (a) => { if (a && a.devId) setDhAlarm(a.devId, null); });
    bus.on("dh:data", () => { dhLabelClock = -99; });
    bus.on("alarm:add", (a) => {
      if (a && a.rackId) {
        const ids = beacons.filter((b) => b.rackId).map((b) => b.rackId);
        if (ids.indexOf(a.rackId) < 0) ids.push(a.rackId);
        api.setAlarmBeacons(ids);
      }
      updateRackColors();
    });
  }

  /* ======================= 对外 API ======================= */
  const api = {
    ready: false,
    _racks: racks,

    init(el, opts) {
      if (ready) return api;
      canvasEl = el;
      D = (opts && opts.data) || IDC.data || { racks: [] };
      bus = IDC.bus || null;

      renderer = new THREE.WebGLRenderer({
        canvas: el, antialias: true, powerPreference: "high-performance",
        alpha: false, stencil: false, depth: true,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
      renderer.shadowMap.enabled = SHADOWS;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      initTextures(renderer);

      scene = new THREE.Scene();
      scene.background = new THREE.Color(BG);
      scene.fog = new THREE.FogExp2(BG, LOW ? 0.0022 : 0.0034);

      camera = new THREE.PerspectiveCamera(42, (el.clientWidth || 1440) / (el.clientHeight || 810), 0.1, 420);
      const v0 = VIEWS.overview;
      camera.position.set(v0.pos[0], v0.pos[1], v0.pos[2]);

      controls = new OrbitControls(camera, el);
      controls.target.set(v0.target[0], v0.target[1], v0.target[2]);
      controls.enableDamping = true;
      controls.dampingFactor = 0.075;
      controls.minDistance = 1.6;
      controls.maxDistance = 110;
      controls.maxPolarAngle = 88 * DEG;
      controls.minPolarAngle = 4 * DEG;
      controls.autoRotateSpeed = 0.5;
      controls.update();

      buildLights();
      buildEnv();
      backdrop = new THREE.Mesh(
        new THREE.SphereGeometry(180, 24, 16),
        new THREE.MeshBasicMaterial({ map: makeBackdropTexture(), side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false })
      );
      backdrop.position.set(0, 12, 0);
      scene.add(backdrop);

      extraGroup.name = "planExtras";
      scene.add(extraGroup);
      buildRoom();
      buildDhPoints();
      buildRacks();
      buildSelection();
      buildBeacons();
      buildAvatar();
      setupPointer();
      bindBus();

      updateLOD(true);
      updateRackColors();
      updateZoneLabels(true);
      api.setAlarmBeacons(((D.alarms || []).map((a) => a.rackId)).filter(Boolean));

      ready = true;
      api.ready = true;
      api.resize(el.clientWidth || 1440, el.clientHeight || 810);
      return api;
    },

    frame(ts, dt) {
      if (!ready) return;
      const now = ts || performance.now();
      const raw = lastTs ? Math.min(0.34, (now - lastTs) / 1000) : 0.016;
      lastTs = now;
      dt = dt != null ? Math.min(0.05, dt) : 0.016;
      elapsed += dt;
      frames++;
      if (intro) updateIntro();
      updateTween();
      updateDoors(dt);
      updateAvatar(dt);
      updateBeacons(dt);
      updateSelection();
      updateZoneLabels(false);
      updateDhAlarmFx();
      updateDhLabels(false);
      updateExtraFx();
      if (elapsed - lodClock > 0.35) { lodClock = elapsed; updateLOD(false); }
      if (frames % 4 === 0) updateRackColors();
      controls.update();
      renderer.render(scene, camera);
    },

    resize(w, h) {
      if (!renderer || !camera) return api;
      w = Math.max(2, w | 0); h = Math.max(2, h | 0);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      return api;
    },

    setView(name, opts) {
      if (!ready) return api;
      if (intro) finishIntro();
      name = name || "overview";
      opts = opts || {};
      controls.autoRotate = false;
      if (name === "rack") {
        const id = selectedId && rackById[selectedId] ? selectedId : "A-02";
        return api.focusRack(id, { open: opts.open !== false, duration: opts.duration || 1.1 });
      }
      if (name === "intro") { api.playIntro(opts.cb); return api; }
      const v = VIEWS[name] || VIEWS.overview;
      const p = new THREE.Vector3(v.pos[0], v.pos[1], v.pos[2]);
      const t = new THREE.Vector3(v.target[0], v.target[1], v.target[2]);
      setFocusBlockers(null);
      setShowcase(name === "props");
      if (name === "roomOrbit") { controls.autoRotate = true; api.setMode("status"); }
      else if (name === "energy") api.setMode("load");
      else if (name === "alarm") api.setMode("alarm");
      else api.setMode("status");
      flyTo(p, t, v.dur || 1.15, null, null, v.fov || 42);
      updateLOD(true);
      return api;
    },

    focusRack(id, opts) {
      if (!ready) return api;
      opts = opts || {};
      const r = rackById[id];
      if (!r) return api;
      selectedId = id;
      api.highlightRack(id, opts.mode || null);
      setShowcase(false);
      setFocusBlockers(r);
      updateLOD(true);
      flyToRack(r, opts.duration != null ? opts.duration : 1.2);
      if (opts.open) api.openRack(id, true);
      return api;
    },

    openRack(id, flag) {
      const r = rackById[id];
      if (r) r.doorTarget = flag === false ? 0 : 1;
      return api;
    },

    highlightRack(id, m) {
      if (!ready) return api;
      if (id == null) { selGroup.visible = false; selectedId = null; return api; }
      const r = rackById[id];
      if (!r) return api;
      selectedId = id;
      selectedMode = m || null;
      selGroup.visible = true;
      selGroup.position.set(r.def.x, 0, r.def.z);
      selGroup.rotation.y = r.yaw;
      let col;
      if (m === "alarm") col = tmpA.setHex(C_CRIT);
      else if (m === "normal") col = tmpA.setHex(C_OK);
      else if (m === "temp") col = tempColor(r.def.tempIn, tmpA);
      else col = tmpA.setHex(r.def.status === "alarm" ? C_CRIT : r.def.status === "offline" ? C_OFF : C_CYAN2);
      selGroup.userData.mats.forEach((mm) => mm.color.copy(col));
      const tex = makeTextTexture(r.def.id + " · " + (r.def.zoneLabel || ""), {
        fs: 46, color: "#eaf7ff", bg: "rgba(8,16,26,.88)", border: "rgba(53,224,255,.6)",
        radius: 14, padX: 24, glow: "rgba(53,224,255,.7)",
        sub: r.def.tempIn.toFixed(1) + "℃ · " + r.def.powerKW.toFixed(2) + "kW · 负载 " + r.def.loadPct + "%",
        color2: "#9fd8f5",
      });
      const sp = selGroup.userData.sprite;
      if (sp.material.map) sp.material.map.dispose();
      sp.material.map = tex.texture;
      sp.material.needsUpdate = true;
      sp.scale.set(sp.userData.baseH * tex.w / tex.h, sp.userData.baseH, 1);
      return api;
    },

    setMode(m) {
      mode = (m === "temp" || m === "load" || m === "alarm") ? m : "status";
      if (ready) updateRackColors();
      return api;
    },

    setAlarmBeacons(list) {
      const ids = (list || []).map((x) => (typeof x === "string" ? x : x && (x.rackId || x.id))).filter(Boolean);
      beacons.forEach((b, i) => {
        const id = ids[i];
        if (id && rackById[id]) {
          b.rackId = id;
          b.group.visible = true;
          b.group.position.set(rackById[id].def.x, 0, rackById[id].def.z);
        } else { b.rackId = null; b.group.visible = false; }
      });
      return api;
    },

    /** 图纸扩展：覆盖式同步图纸图元到 3D（传 [] / null 清空）；与动环报警互不影响 */
    setExtras(list) {
      if (!ready) return api;
      const arr = Array.isArray(list) ? list : [];
      const seen = Object.create(null);
      for (let i = 0; i < arr.length; i++) {
        const it = arr[i];
        if (!it || !it.id) continue;
        seen[it.id] = 1;
        const cur = extras.get(it.id);
        const sig = extraSign(it);
        if (!cur) createExtra(it);
        else if (cur.sig !== sig) updateExtra(cur, it);
      }
      const drop = [];
      extras.forEach((e, id) => { if (!seen[id]) drop.push(id); });
      for (let i = 0; i < drop.length; i++) removeExtra(drop[i]);
      return api;
    },

    /** 图纸扩展：清空全部扩展图元（不影响机柜/动环） */
    clearExtras() {
      const ids = [];
      extras.forEach((e, id) => ids.push(id));
      for (let i = 0; i < ids.length; i++) removeExtra(ids[i]);
      return api;
    },

    /** 图纸扩展：镜头定位到某个扩展图元 */
    focusExtra(id, opts) {
      if (!ready) return api;
      opts = opts || {};
      const e = extras.get(id);
      if (!e) return api;
      const c = e.outline.position.clone();
      const wp = e.group.localToWorld(c.clone());
      const dist = Math.max(4.2, Math.max(e.size.x, e.size.z) * 3.0 + e.size.y * 1.4);
      const dir = new THREE.Vector3(0.3, 0, 1).normalize();
      const cam = wp.clone().addScaledVector(dir, dist).add(new THREE.Vector3(0, dist * 0.85, 0));
      flyTo(cam, wp.clone().setY(wp.y - e.size.y * 0.05), opts.duration != null ? opts.duration : 1.2, null, null, 40);
      return api;
    },

    /** 动环：报警点位（[{devId, level}]），未列出的恢复正常 */
    setSensorAlarms(list) {
      if (!ready) return api;
      const ids = Object.keys(dhAlarmState);
      for (let i = 0; i < ids.length; i++) delete dhAlarmState[ids[i]];
      (list || []).forEach((x) => {
        const id = typeof x === "string" ? x : x && x.devId;
        if (id) dhAlarmState[id] = (x && x.level) || "critical";
      });
      applyDhAlarms();
      return api;
    },

    /** 动环：镜头飞到设备/点位并高亮 + 浮空标签（设备名 + 主要测点值） */
    focusDevice(devId, opts) {
      if (!ready) return api;
      opts = opts || {};
      const e = dhById[devId];
      const b = dhBind[devId];
      if (!e && !b) return api;
      const pos = (e ? e.pos : b.pos).clone();
      const face = (e ? e.face : b.face).clone();
      const kind = e ? e.place.kind : "power";
      const cam = new THREE.Vector3();
      if (kind === "smoke") cam.set(pos.x + 1.9, pos.y - 1.35, pos.z + 2.6);
      else if (kind === "water" || kind === "water-rope") cam.set(pos.x + face.x * 1.6, 1.35, pos.z + face.z * 1.6 + 0.5);
      else if (kind === "power") cam.copy(pos).addScaledVector(face, 3.3).add(new THREE.Vector3(0, 0.8, 0));
      else cam.copy(pos).addScaledVector(face, 2.4).add(new THREE.Vector3(0, 0.35, 0));
      flyTo(cam, pos, opts.duration != null ? opts.duration : 1.2, null, null, 38);
      dhFocusId = devId;
      dhFocusUntil = performance.now() + 900000;
      applyDhAlarms();
      const nm = e ? e.name : (b && b.name) || devId;
      let sub = "";
      const dapi = IDC.dh;
      if (dapi && dapi.pointsOf) {
        const pts = dapi.pointsOf(devId).filter((p) => p.kind === "ai" && p.unit);
        sub = pts.slice(0, 3).map((p) => p.name + " " + (dapi.value(p.id) != null ? dapi.value(p.id) : "--") + (p.unit || "")).join("  ");
      }
      const tex = makeTextTexture(nm, { fs: 46, color: "#eaf7ff", bg: "rgba(8,16,26,.92)", border: "rgba(53,224,255,.7)", radius: 14, padX: 22, padY: 12, sub: sub || null, color2: "#9fd8f5", fs2: 26 });
      if (dhFocusLabel.material.map) dhFocusLabel.material.map.dispose();
      dhFocusLabel.material.map = tex.texture;
      dhFocusLabel.material.needsUpdate = true;
      dhFocusLabel.scale.set(dhFocusLabel.userData.baseH * tex.w / tex.h, dhFocusLabel.userData.baseH, 1);
      const toCam = cam.clone().sub(pos).normalize();
      dhFocusLabel.position.set(pos.x + toCam.x * 0.45, pos.y + 0.78, pos.z + toCam.z * 0.45);
      dhFocusLabel.visible = true;
      return api;
    },

    /** 动环：强制刷新温湿度标签（可传 {devId: value} 覆盖） */
    setSensorValues(map) {
      if (map && typeof map === "object") dhValueOverride = map;
      updateDhLabels(true);
      updateDhAlarmFx();
      return api;
    },

    assistantTo(id, opts) {
      opts = opts || {};
      const r = rackById[id];
      if (!r || !avatar) return api;
      const to = rackFrontPoint(r, 1.42, new THREE.Vector3());
      avatar.walk = {
        from: avatar.root.position.clone(), to: to.clone(), t: 0,
        dur: Math.max(0.7, avatar.root.position.distanceTo(to) / 4.0),
        yaw: r.yaw + Math.PI,
      };
      api.highlightRack(id, opts.mode || null);
      if (opts.open !== false) api.openRack(id, true);
      if (opts.focus === true) flyToRack(r, Math.max(1.0, opts.duration || 1.2));
      return api;
    },

    setAssistantSpeaking(flag) {
      if (!avatar) return api;
      avatar.speaking = !!flag;
      avatar.bubble.visible = !!flag;
      if (flag) avatar.pointT = 0;
      return api;
    },

    resetCamera() {
      if (!ready) return api;
      if (intro) finishIntro();
      setShowcase(false);
      setFocusBlockers(null);
      controls.autoRotate = false;
      const v = VIEWS.overview;
      flyTo(new THREE.Vector3(v.pos[0], v.pos[1], v.pos[2]), new THREE.Vector3(v.target[0], v.target[1], v.target[2]), 0.9, null, null, 42);
      updateLOD(true);
      return api;
    },

    playIntro(cb) {
      if (!ready) { if (cb) cb(); return api; }
      intro = {
        t0: performance.now(), t: 0, dur: 5.0, cb: cb || null,
        from: new THREE.Vector3(-33, 37, 45),
        to: new THREE.Vector3(VIEWS.overview.pos[0], VIEWS.overview.pos[1], VIEWS.overview.pos[2]),
      };
      rowLight = [0, 0, 0, 0, 0, 0];
      controls.enabled = false;
      camera.position.copy(intro.from);
      scene.background.setHex(0x000000);
      if (backdrop) backdrop.visible = false;
      updateRackColors();
      return api;
    },
  };

  IDC.scene = api;
})(window);
