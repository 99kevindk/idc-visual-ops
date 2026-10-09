/* =========================================================================
 *  src/textures.js — 程序化 PBR 贴图与材质库（离线、零外部图片资源）
 *  用途：把机房/机柜从"低模示意"升级为"拟真三维"
 *  对外：initTextures(renderer) / TEX.xxx(opts) / MAT.xxx(opts) / pbr(mapset, over)
 *  说明：所有贴图用 Canvas 2D 现场绘制，法线贴图由高度图经 Sobel 生成，
 *        颜色贴图走 sRGB，数据贴图走线性；结果全部 memo 缓存，重复调用零开销。
 * ========================================================================= */
import * as THREE from "../vendor/three.module.js";

let MAX_ANISO = 4;
export function initTextures(renderer) {
  try { MAX_ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy() || 4); } catch (e) { MAX_ANISO = 4; }
}

/* ---------------- 基础工具 ---------------- */
function C(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d");
  x.imageSmoothingEnabled = true;
  return { c, x };
}
function TX(canvas, o) {
  o = o || {};
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (o.repeat) t.repeat.set(o.repeat[0], o.repeat[1]);
  t.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = MAX_ANISO;
  t.needsUpdate = true;
  return t;
}
/** 由灰度高度画布生成切线空间法线贴图（Sobel） */
function normalMap(srcCanvas, strength) {
  strength = strength == null ? 1.6 : strength;
  const w = srcCanvas.width, h = srcCanvas.height;
  const sctx = srcCanvas.getContext("2d");
  const src = sctx.getImageData(0, 0, w, h).data;
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const octx = out.getContext("2d");
  const img = octx.createImageData(w, h);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255;
  const at = (x, y) => lum[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const i = (y * w + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}
/** 确定性伪随机（同一 seed 每次生成完全一致） */
function mk(seed) { let s = seed || 1; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
/** 叠噪点/划痕 */
function grain(x, w, h, amount, alpha, r) {
  const R = r || mk(amount * 7919 + w);
  const img = x.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (R() - 0.5) * amount * 255;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
  }
  x.putImageData(img, 0, 0);
}
function rrect(x, px, py, w, h, r) {
  x.beginPath(); x.moveTo(px + r, py);
  x.arcTo(px + w, py, px + w, py + h, r); x.arcTo(px + w, py + h, px, py + h, r);
  x.arcTo(px, py + h, px, py, r); x.arcTo(px, py, px + w, py, r); x.closePath();
}
function txt(x, s, px, py, font, color, align, baseline) {
  x.font = font; x.fillStyle = color;
  x.textAlign = align || "left"; x.textBaseline = baseline || "middle";
  x.fillText(s, px, py);
}
const _memo = new Map();
function memo(key, fn) { if (!_memo.has(key)) _memo.set(key, fn()); return _memo.get(key); }

/* ======================================================================
 *  贴图
 * ==================================================================== */
export const TEX = {
  /** 拉丝金属板（机柜侧板/后板/型材/墙板通用） */
  metalPanel(o) {
    o = o || {};
    const w = o.size || 512, h = o.size || 512;
    const base = o.base || "#5a626c", dark = o.dark || "#343a42";
    return memo("mp" + JSON.stringify(o), () => {
      const { c, x } = C(w, h);
      const g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, base); g.addColorStop(0.55, dark); g.addColorStop(1, base);
      x.globalAlpha = 1;
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      // 拉丝
      const R = mk(7);
      for (let i = 0; i < 1400; i++) {
        const y = R() * h, len = 40 + R() * (w * 0.7), xx = R() * w;
        x.strokeStyle = "rgba(255,255,255," + (0.010 + R() * 0.035).toFixed(3) + ")";
        x.lineWidth = 0.6 + R() * 0.9;
        x.beginPath(); x.moveTo(xx, y); x.lineTo(xx + len, y); x.stroke();
        x.strokeStyle = "rgba(0,0,0," + (0.02 + R() * 0.05).toFixed(3) + ")";
        x.beginPath(); x.moveTo(xx, y + 1.2); x.lineTo(xx + len, y + 1.2); x.stroke();
      }
      // 面板拼缝
      x.strokeStyle = "rgba(0,0,0,.45)"; x.lineWidth = 2;
      for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo((w / 4) * i, 0); x.lineTo((w / 4) * i, h); x.stroke(); }
      grain(x, w, h, 0.045, 0, mk(11));
      // 高度图（拉丝很浅 → 法线只给一点质感；拼缝为凹槽）
      const hc = C(w, h);
      hc.x.fillStyle = "#8a8a8a"; hc.x.fillRect(0, 0, w, h);
      for (let i = 0; i < 900; i++) {
        const R2 = mk(i + 3)(); const y = R2 * h;
        hc.x.strokeStyle = "rgba(255,255,255,.5)"; hc.x.lineWidth = 1;
        hc.x.beginPath(); hc.x.moveTo(0, y); hc.x.lineTo(w, y); hc.x.stroke();
      }
      hc.x.strokeStyle = "#000"; hc.x.lineWidth = 3;
      for (let i = 1; i < 4; i++) { hc.x.beginPath(); hc.x.moveTo((w / 4) * i, 0); hc.x.lineTo((w / 4) * i, h); hc.x.stroke(); }
      // 粗糙度
      const rc = C(w, h);
      rc.x.fillStyle = "#6e6e6e"; rc.x.fillRect(0, 0, w, h);
      grain(rc.x, w, h, 0.22, 0, mk(23));
      return { map: TX(c, { srgb: true }), normalMap: TX(normalMap(hc.c, o.nstrength || 0.9)), roughnessMap: TX(rc.c) };
    });
  },

  /** 机柜前门：真实镂空网孔（alphaMap 挖洞） */
  doorMesh(o) {
    o = o || {};
    const w = o.size || 512, h = o.size || 512;
    const cell = o.cell || 12, hole = o.hole || 5.6, base = o.base || "#454d57";
    return memo("dm" + JSON.stringify(o), () => {
      const { c, x } = C(w, h);
      x.fillStyle = base; x.fillRect(0, 0, w, h);
      const R = mk(31);
      const hc = C(w, h), ac = C(w, h);
      ac.x.fillStyle = "#ffffff"; ac.x.fillRect(0, 0, w, h);
      hc.x.fillStyle = "#b9b9b9"; hc.x.fillRect(0, 0, w, h);
      // 网孔（交错排布，更像真门）
      for (let ry = 0, row = 0; ry < h + cell; ry += cell, row++) {
        const off = row % 2 ? cell / 2 : 0;
        for (let rx = -cell; rx < w + cell; rx += cell) {
          const cx = rx + off + cell / 2, cy = ry + cell / 2;
          const rr = hole / 2;
          x.beginPath(); x.arc(cx, cy, rr, 0, Math.PI * 2);
          x.fillStyle = "rgba(6,8,11,.96)"; x.fill();
          x.strokeStyle = "rgba(190,205,220,.16)"; x.lineWidth = 1; x.stroke();
          ac.x.beginPath(); ac.x.arc(cx, cy, rr, 0, Math.PI * 2); ac.x.fillStyle = "#000"; ac.x.fill();
          hc.x.beginPath(); hc.x.arc(cx, cy, rr * 1.15, 0, Math.PI * 2); hc.x.fillStyle = "#2a2a2a"; hc.x.fill();
        }
      }
      // 四周实心加强边
      const bw = 26;
      x.strokeStyle = "rgba(120,135,150,.35)"; x.lineWidth = 2;
      x.strokeRect(bw / 2, bw / 2, w - bw, h - bw);
      x.fillStyle = "rgba(0,0,0,0)";
      // 中间竖向加强筋（留实心条）
      x.fillStyle = base; x.fillRect(w / 2 - 9, 0, 18, h);
      ac.x.fillStyle = "#ffffff"; ac.x.fillRect(w / 2 - 9, 0, 18, h);
      grain(x, w, h, 0.05, 0, mk(37));
      const rc = C(w, h); rc.x.fillStyle = "#5a5a5a"; rc.x.fillRect(0, 0, w, h);
      return {
        map: TX(c, { srgb: true }), alphaMap: TX(ac.c), normalMap: TX(normalMap(hc.c, 1.15)), roughnessMap: TX(rc.c),
      };
    });
  },

  /** 19" 安装立柱（方孔 + 卡扣刻度），竖向 repeat.y = U 数 / 3 */
  rail(o) {
    o = o || {};
    const w = o.w || 128, uH = o.uH || 64;
    return memo("rail" + w + uH, () => {
      const h = uH * 3;
      const { c, x } = C(w, h);
      const g = x.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, "#3d434b"); g.addColorStop(0.5, "#565e68"); g.addColorStop(1, "#343a42");
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      const hc = C(w, h); hc.x.fillStyle = "#c8c8c8"; hc.x.fillRect(0, 0, w, h);
      for (let u = 0; u < 3; u++) {
        const y0 = u * uH + uH / 2;
        [-1, 1].forEach((side) => {
          const cx = w / 2 + side * (w * 0.26), cw = 17, ch = 15;
          x.fillStyle = "#0a0d11"; rrect(x, cx - cw / 2, y0 - ch / 2, cw, ch, 2); x.fill();
          x.strokeStyle = "rgba(200,215,230,.35)"; x.lineWidth = 1.2; x.stroke();
          hc.x.fillStyle = "#2c2c2c"; rrect(hc.x, cx - cw / 2, y0 - ch / 2, cw, ch, 2); hc.x.fill();
        });
        x.strokeStyle = "rgba(0,0,0,.35)"; x.lineWidth = 1;
        x.beginPath(); x.moveTo(0, u * uH); x.lineTo(w, u * uH); x.stroke();
      }
      grain(x, w, h, 0.05, 0, mk(41));
      return { map: TX(c, { srgb: true }), normalMap: TX(normalMap(hc.c, 1.1)) };
    });
  },

  /** U 位刻度条（1..42），贴到立柱内侧 */
  uScale(o) {
    o = o || {};
    const count = o.count || 42, uH = o.uH || 64, w = o.w || 96;
    return memo("us" + count + uH + w, () => {
      const { c, x } = C(w, uH * count / 4);
      x.fillStyle = "#0d1218"; x.fillRect(0, 0, w, c.height);
      for (let u = 1; u <= count; u++) {
        const y = c.height - (u - 1) * uH / 4 - uH / 8;
        if (u % 5 === 0 || u <= 3) {
          x.strokeStyle = "rgba(150,175,200,.75)"; x.lineWidth = 1.4;
          x.beginPath(); x.moveTo(w * 0.55, y); x.lineTo(w * 0.95, y); x.stroke();
        }
        if (u % 10 === 0 || u === 1) {
          txt(x, String(u), w * 0.06, y, "bold " + Math.round(uH / 6) + 'px Consolas,monospace', "#8fd8f5", "left");
        }
      }
      return { map: TX(c, { srgb: true }) };
    });
  },

  /** 服务器/网络设备前面板（含 LED 自发光贴图） */
  serverFront(o) {
    o = o || {};
    const uSize = o.uSize || 1, kind = o.kind || "server", seed = o.seed || 1;
    return memo("sf" + uSize + kind + seed, () => {
      const W = 1024, H = 112 * uSize;
      const { c, x } = C(W, H);
      const R = mk(seed * 977 + 13);
      const g = x.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#2d333a"); g.addColorStop(0.5, "#22272d"); g.addColorStop(1, "#2a3037");
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      const hc = C(W, H); hc.x.fillStyle = "#808080"; hc.x.fillRect(0, 0, W, H);
      const ec = C(W, H); ec.x.fillStyle = "#000"; ec.x.fillRect(0, 0, W, H);
      // 安装耳朵 + 螺钉
      [[0, 0], [W - 62, 0]].forEach(([ex]) => {
        x.fillStyle = "#262b31"; x.fillRect(ex, 0, 62, H);
        x.strokeStyle = "rgba(0,0,0,.5)"; x.strokeRect(ex + 0.5, 0.5, 61, H - 1);
        [-1, 1].forEach((s) => {
          const cy = H / 2 + s * (H * 0.28), cx = ex + 31;
          x.fillStyle = "#0c0e12"; x.beginPath(); x.arc(cx, cy, 8, 0, Math.PI * 2); x.fill();
          x.strokeStyle = "#6d7681"; x.lineWidth = 2; x.beginPath(); x.arc(cx, cy, 8, 0, Math.PI * 2); x.stroke();
          x.strokeStyle = "#3a4048"; x.lineWidth = 2;
          x.beginPath(); x.moveTo(cx - 5, cy); x.lineTo(cx + 5, cy); x.stroke();
        });
      });
      const inner = { x0: 74, x1: W - 74, y0: 10, y1: H - 10 };
      const kindDraw = {
        server() {
          // 左：2 个 3.5" 硬盘托架
          for (let i = 0; i < 2; i++) {
            const bx = inner.x0 + i * 150, by = inner.y0 + 6, bw = 138, bh = H - 20;
            x.fillStyle = "#20252b"; rrect(x, bx, by, bw, bh, 4); x.fill();
            x.strokeStyle = "rgba(0,0,0,.6)"; x.lineWidth = 2; x.stroke();
            x.strokeStyle = "rgba(140,155,170,.28)"; x.lineWidth = 1;
            for (let k = 1; k < 3; k++) { x.beginPath(); x.moveTo(bx + (bw / 3) * k, by + 4); x.lineTo(bx + (bw / 3) * k, by + bh - 4); x.stroke(); }
            x.fillStyle = "#171b20"; rrect(x, bx + bw / 2 - 6, by + bh * 0.18, 12, bh * 0.62, 6); x.fill();
            hc.x.fillStyle = "#a5a5a5"; rrect(hc.x, bx, by, bw, bh, 4); hc.x.fill();
            ec.x.fillStyle = i === 0 ? "#1cff7a" : "#0a3a1e"; rrect(ec.x, bx + 8, by + 6, 7, 7, 2); ec.x.fill();
          }
          // 中：散热格栅
          const vx = inner.x0 + 316, vw = 300;
          for (let i = 0; i < Math.max(6, uSize * 9); i++) {
            const vy = inner.y0 + 8 + i * ((H - 26) / Math.max(6, uSize * 9));
            x.fillStyle = "#0b0e12"; x.fillRect(vx, vy, vw, 4.2);
            x.fillStyle = "rgba(150,170,190,.10)"; x.fillRect(vx, vy + 4.2, vw, 1.6);
          }
          // 右：小屏 + 指示灯 + USB
          const rx = inner.x1 - 250;
          x.fillStyle = "#0a0d11"; rrect(x, rx, inner.y0 + H * 0.2, 96, H * 0.42, 4); x.fill();
          x.strokeStyle = "rgba(120,220,255,.35)"; x.lineWidth = 1.4; x.stroke();
          ec.x.fillStyle = "#123"; rrect(ec.x, rx + 3, inner.y0 + H * 0.2 + 3, 90, H * 0.42 - 6, 3); ec.x.fill();
          txt(ec.x, "U" + (seed % 40 + 1), rx + 12, inner.y0 + H * 0.41, "bold 22px Consolas,monospace", "#7ff0ff", "left");
          const leds = [["#4cff8a", 1], ["#59d7ff", 1], ["#ffb648", R() < 0.5 ? 1 : 0.25]];
          leds.forEach(([col, on], i) => {
            const lx = rx + 118 + i * 30, ly = inner.y0 + H * 0.3;
            x.fillStyle = "#05070a"; x.beginPath(); x.arc(lx, ly, 8, 0, Math.PI * 2); x.fill();
            x.fillStyle = col; x.globalAlpha = on === 1 ? 1 : 0.3;
            x.beginPath(); x.arc(lx, ly, 5.4, 0, Math.PI * 2); x.fill(); x.globalAlpha = 1;
            if (on === 1) { ec.x.fillStyle = col; ec.x.beginPath(); ec.x.arc(lx, ly, 5.6, 0, Math.PI * 2); ec.x.fill(); }
          });
          x.fillStyle = "#151a20"; rrect(x, rx + 112, inner.y0 + H * 0.5, 84, H * 0.3, 3); x.fill();
          txt(x, "USB", rx + 154, inner.y0 + H * 0.65, "9px Consolas,monospace", "#6c7a88", "center");
          txt(x, "IDC-SRV", rx + 214, inner.y0 + H * 0.36, "bold 13px Consolas,monospace", "#7d8b99", "left");
        },
        storage() {
          for (let r = 0; r < (uSize > 1 ? 4 : 2); r++) {
            for (let i = 0; i < 12; i++) {
              const bw = (inner.x1 - inner.x0 - 24) / 12, bh = (H - 24) / (uSize > 1 ? 4 : 2) - 4;
              const bx = inner.x0 + i * bw, by = inner.y0 + r * (bh + 4) + 4;
              x.fillStyle = "#1b2026"; rrect(x, bx + 2, by, bw - 4, bh, 3); x.fill();
              x.strokeStyle = "rgba(120,140,160,.22)"; x.lineWidth = 1; x.stroke();
              x.fillStyle = "#101418"; rrect(x, bx + bw * 0.25, by + bh * 0.3, bw * 0.5, bh * 0.4, 2); x.fill();
              hc.x.fillStyle = "#9a9a9a"; rrect(hc.x, bx + 2, by, bw - 4, bh, 3); hc.x.fill();
              if (i % 3 === 0) { ec.x.fillStyle = "#1cff7a"; ec.x.fillRect(bx + 6, by + 5, 5, 5); }
            }
          }
        },
        network() {
          const rows = uSize > 1 ? 4 : 2, cols = uSize > 1 ? 24 : 24;
          for (let r = 0; r < rows; r++) {
            for (let i = 0; i < cols; i++) {
              const bw = (inner.x1 - inner.x0 - 130) / cols, bh = (H - 24) / rows - 5;
              const bx = inner.x0 + i * bw + 2, by = inner.y0 + r * (bh + 5) + 3;
              x.fillStyle = "#0d1116"; x.fillRect(bx, by, Math.max(6, bw - 4), bh);
              x.strokeStyle = "rgba(130,180,220,.35)"; x.lineWidth = 1; x.strokeRect(bx + 0.5, by + 0.5, Math.max(6, bw - 4) - 1, bh - 1);
              hc.x.fillStyle = "#3a3a3a"; hc.x.fillRect(bx, by, Math.max(6, bw - 4), bh);
            }
          }
          const rx = inner.x1 - 120;
          x.fillStyle = "#161b21"; rrect(x, rx, inner.y0 + 4, 108, H - 18, 3); x.fill();
          [0x1cff7a, 0x59d7ff].forEach((col, i) => {
            const sx = rx + 16 + i * 26, sy = inner.y0 + H * 0.32;
            x.fillStyle = "#05070a"; x.beginPath(); x.arc(sx, sy, 7, 0, Math.PI * 2); x.fill();
            x.fillStyle = "#" + col.toString(16).padStart(6, "0"); x.beginPath(); x.arc(sx, sy, 4.6, 0, Math.PI * 2); x.fill();
            ec.x.fillStyle = "#" + col.toString(16).padStart(6, "0"); ec.x.beginPath(); ec.x.arc(sx, sy, 4.8, 0, Math.PI * 2); ec.x.fill();
          });
          txt(x, "48x1G", rx + 66, inner.y0 + H * 0.34, "bold 12px Consolas,monospace", "#8697a6", "left");
        },
        security() {
          x.fillStyle = "#12171d"; rrect(x, inner.x0, inner.y0 + 6, 300, H - 24, 4); x.fill();
          x.strokeStyle = "rgba(150,200,240,.25)"; x.lineWidth = 1.4; x.stroke();
          txt(ec.x, "IPS", inner.x0 + 24, H / 2, "bold 34px Consolas,monospace", "#7ff0ff", "left");
          ec.x.fillStyle = "#0e2a3a"; rrect(ec.x, inner.x0 + 190, inner.y0 + 18, 96, H - 48, 3); ec.x.fill();
          for (let i = 0; i < 8; i++) {
            x.fillStyle = "#0d1116"; x.fillRect(inner.x0 + 330 + i * 42, inner.y0 + 14, 34, H - 40);
            x.strokeStyle = "rgba(130,180,220,.3)"; x.strokeRect(inner.x0 + 330 + i * 42, inner.y0 + 14, 34, H - 40);
          }
          txt(x, "FIREWALL", inner.x1 - 150, H * 0.42, "bold 14px Consolas,monospace", "#7d8b99", "left");
        },
      };
      (kindDraw[kind] || kindDraw.server)();
      grain(x, W, H, 0.03, 0, mk(seed + 5));
      return {
        map: TX(c, { srgb: true }), normalMap: TX(normalMap(hc.c, 0.85)),
        emissiveMap: TX(ec.c, { srgb: true }),
      };
    });
  },

  /** 空位挡板 / 盲板（1U 通风盲板） */
  blankPanel(o) {
    o = o || {};
    return memo("bp" + JSON.stringify(o), () => {
      const W = 512, H = 56;
      const { c, x } = C(W, H);
      x.fillStyle = "#2b3138"; x.fillRect(0, 0, W, H);
      const hc = C(W, H); hc.x.fillStyle = "#b0b0b0"; hc.x.fillRect(0, 0, W, H);
      for (let i = 0; i < 40; i++) {
        for (let j = 0; j < 4; j++) {
          x.beginPath(); x.arc(80 + i * 9, 10 + j * 12, 2.6, 0, Math.PI * 2); x.fillStyle = "#0a0d11"; x.fill();
          hc.x.beginPath(); hc.x.arc(80 + i * 9, 10 + j * 12, 2.9, 0, Math.PI * 2); hc.x.fillStyle = "#3a3a3a"; hc.x.fill();
        }
      }
      x.strokeStyle = "rgba(255,255,255,.06)"; x.lineWidth = 1; x.strokeRect(0.5, 0.5, W - 1, H - 1);
      [[16, H / 2], [W - 16, H / 2]].forEach(([cx, cy]) => {
        x.fillStyle = "#2a3038"; x.beginPath(); x.arc(cx, cy, 6, 0, Math.PI * 2); x.fill();
        x.strokeStyle = "#5c6670"; x.lineWidth = 1.4; x.stroke();
      });
      return { map: TX(c, { srgb: true }), normalMap: TX(normalMap(hc.c, 1.0)) };
    });
  },

  /** 风扇模组（3 风扇 + 防护网） */
  fanModule(o) {
    o = o || {};
    return memo("fan" + JSON.stringify(o), () => {
      const W = 256, H = 128;
      const { c, x } = C(W, H);
      x.fillStyle = "#272c33"; x.fillRect(0, 0, W, H);
      const hc = C(W, H); hc.x.fillStyle = "#808080"; hc.x.fillRect(0, 0, W, H);
      for (let i = 0; i < 3; i++) {
        const cx = 44 + i * 84, cy = H / 2, r = 36;
        x.fillStyle = "#0d1116"; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
        for (let b = 0; b < 7; b++) {
          const a = (b / 7) * Math.PI * 2;
          x.save(); x.translate(cx, cy); x.rotate(a);
          x.fillStyle = "rgba(120,140,160,.30)";
          x.beginPath(); x.moveTo(0, 0); x.ellipse(r * 0.62, 0, r * 0.55, r * 0.16, 0, 0, Math.PI * 2); x.fill();
          x.restore();
        }
        x.fillStyle = "#2b323a"; x.beginPath(); x.arc(cx, cy, 8, 0, Math.PI * 2); x.fill();
        x.strokeStyle = "rgba(150,170,190,.5)"; x.lineWidth = 1;
        for (let k = -3; k <= 3; k++) { x.beginPath(); x.moveTo(cx + k * 10, cy - r + 3); x.lineTo(cx + k * 10, cy + r - 3); x.stroke(); }
        hc.x.fillStyle = "#3c3c3c"; hc.x.beginPath(); hc.x.arc(cx, cy, r, 0, Math.PI * 2); hc.x.fill();
      }
      return { map: TX(c, { srgb: true }), normalMap: TX(normalMap(hc.c, 0.9)) };
    });
  },

  /** 竖装 PDU（插座排 + 数码表） */
  pduStrip(o) {
    o = o || {};
    const count = o.count || 24;
    return memo("pdu" + count, () => {
      const W = 64, H = 1600;
      const { c, x } = C(W, H);
      x.fillStyle = "#2a3037"; x.fillRect(0, 0, W, H);
      const hc = C(W, H); hc.x.fillStyle = "#808080"; hc.x.fillRect(0, 0, W, H);
      const ec = C(W, H); ec.x.fillStyle = "#000"; ec.x.fillRect(0, 0, W, H);
      x.fillStyle = "#0a0d11"; x.fillRect(10, 8, W - 20, 90); x.fill();
      txt(ec.x, "16A", W / 2, 40, "bold 20px Consolas,monospace", "#5fe6ff", "center");
      txt(ec.x, "2.2kW", W / 2, 70, "bold 15px Consolas,monospace", "#7effa8", "center");
      ec.x.fillStyle = "#123"; ec.x.fillRect(12, 10, W - 24, 86);
      for (let i = 0; i < count; i++) {
        const col = i % 2, row = Math.floor(i / 2);
        const cx = col ? W * 0.66 : W * 0.34, cy = 150 + row * 60;
        x.fillStyle = "#0d1116"; rrect(x, cx - 17, cy - 20, 34, 40, 4); x.fill();
        x.strokeStyle = "rgba(160,180,200,.35)"; x.lineWidth = 1.4; x.stroke();
        x.fillStyle = "#05070a";
        [[-8, -9], [8, -9], [-8, 9], [8, 9]].forEach(([dx, dy]) => { x.beginPath(); x.arc(cx + dx, cy + dy, 3.4, 0, Math.PI * 2); x.fill(); });
        hc.x.fillStyle = "#2f2f2f"; rrect(hc.x, cx - 17, cy - 20, 34, 40, 4); hc.x.fill();
      }
      x.fillStyle = "#0a0d11"; x.fillRect(10, H - 96, W - 20, 84);
      txt(ec.x, "PDU", W / 2, H - 56, "bold 18px Consolas,monospace", "#9fd8f5", "center");
      return { map: TX(c, { srgb: true }), normalMap: TX(normalMap(hc.c, 0.9)), emissiveMap: TX(ec.c, { srgb: true }) };
    });
  },

  /** 架空地板方砖（600×600） */
  floorTile(o) {
    o = o || {};
    return memo("ft" + JSON.stringify(o), () => {
      const S = 512;
      const { c, x } = C(S, S);
      x.fillStyle = "#23272c"; x.fillRect(0, 0, S, S);
      const R = mk(61);
      for (let i = 0; i < 5200; i++) {
        const px = R() * S, py = R() * S, r = R() * 1.5 + 0.3;
        x.fillStyle = "rgba(" + (R() < 0.5 ? "190,200,210" : "10,12,15") + "," + (0.02 + R() * 0.07).toFixed(3) + ")";
        x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
      }
      // 倒角 + 砖缝
      x.strokeStyle = "rgba(0,0,0,.75)"; x.lineWidth = 10; x.strokeRect(5, 5, S - 10, S - 10);
      x.strokeStyle = "rgba(140,160,180,.10)"; x.lineWidth = 2; x.strokeRect(12, 12, S - 24, S - 24);
      const hc = C(S, S); hc.x.fillStyle = "#8f8f8f"; hc.x.fillRect(0, 0, S, S);
      hc.x.strokeStyle = "#1a1a1a"; hc.x.lineWidth = 14; hc.x.strokeRect(7, 7, S - 14, S - 14);
      // 四角螺丝
      [[26, 26], [S - 26, 26], [26, S - 26], [S - 26, S - 26]].forEach(([cx, cy]) => {
        x.fillStyle = "#15181c"; x.beginPath(); x.arc(cx, cy, 9, 0, Math.PI * 2); x.fill();
        x.strokeStyle = "#4b545e"; x.lineWidth = 2; x.beginPath(); x.arc(cx, cy, 9, 0, Math.PI * 2); x.stroke();
        x.strokeStyle = "#39414a"; x.lineWidth = 2.4;
        x.beginPath(); x.moveTo(cx - 5, cy); x.lineTo(cx + 5, cy); x.stroke();
        hc.x.fillStyle = "#e8e8e8"; hc.x.beginPath(); hc.x.arc(cx, cy, 10, 0, Math.PI * 2); hc.x.fill();
      });
      grain(x, S, S, 0.05, 0, mk(67));
      const rc = C(S, S); rc.x.fillStyle = "#7a7a7a"; rc.x.fillRect(0, 0, S, S);
      for (let i = 0; i < 2200; i++) {
        const R2 = mk(i + 9)();
        rc.x.fillStyle = "rgba(255,255,255," + (R2 * 0.22).toFixed(3) + ")";
        rc.x.beginPath(); rc.x.arc(R2 * S, ((i * 37) % S), 2, 0, Math.PI * 2); rc.x.fill();
      }
      return { map: TX(c, { srgb: true }), normalMap: TX(normalMap(hc.c, 1.5)), roughnessMap: TX(rc.c) };
    });
  },

  /** 冷通道通风格栅地砖 */
  floorGrille(o) {
    o = o || {};
    return memo("fg" + JSON.stringify(o), () => {
      const S = 512;
      const { c, x } = C(S, S);
      x.fillStyle = "#1a1e23"; x.fillRect(0, 0, S, S);
      const hc = C(S, S); hc.x.fillStyle = "#c8c8c8"; hc.x.fillRect(0, 0, S, S);
      for (let i = 0; i < 26; i++) {
        for (let j = 0; j < 26; j++) {
          const px = 12 + i * 19, py = 12 + j * 19;
          x.fillStyle = "#05070a"; x.fillRect(px, py, 12, 12);
          x.strokeStyle = "rgba(150,170,190,.18)"; x.lineWidth = 1; x.strokeRect(px + 0.5, py + 0.5, 12, 12);
          hc.x.fillStyle = "#202020"; hc.x.fillRect(px, py, 12, 12);
        }
      }
      x.strokeStyle = "rgba(0,0,0,.7)"; x.lineWidth = 8; x.strokeRect(4, 4, S - 8, S - 8);
      return { map: TX(c, { srgb: true }), normalMap: TX(normalMap(hc.c, 1.8)) };
    });
  },

  /** 墙面金属板（带检修缝与通风口） */
  wallPanel(o) {
    o = o || {};
    return memo("wp" + JSON.stringify(o), () => {
      const W = 512, H = 512;
      const { c, x } = C(W, H);
      const g = x.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#182a3f"); g.addColorStop(0.5, "#12202f"); g.addColorStop(1, "#0e1a27");
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      x.strokeStyle = "rgba(0,0,0,.5)"; x.lineWidth = 3;
      for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo((W / 4) * i, 0); x.lineTo((W / 4) * i, H); x.stroke(); }
      x.strokeStyle = "rgba(120,190,255,.07)"; x.lineWidth = 1;
      for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo((W / 4) * i + 2, 0); x.lineTo((W / 4) * i + 2, H); x.stroke(); }
      // 通风百叶
      x.fillStyle = "rgba(0,0,0,.45)";
      for (let i = 0; i < 12; i++) x.fillRect(W - 96, 40 + i * 15, 76, 6);
      grain(x, W, H, 0.04, 0, mk(71));
      return { map: TX(c, { srgb: true }) };
    });
  },

  /** 顶部桥架（梯式） */
  cableTray(o) {
    o = o || {};
    return memo("ct" + JSON.stringify(o), () => {
      const W = 128, H = 512;
      const { c, x } = C(W, H);
      x.fillStyle = "#20262d"; x.fillRect(0, 0, W, H);
      const hc = C(W, H); hc.x.fillStyle = "#909090"; hc.x.fillRect(0, 0, W, H);
      for (let i = 0; i < 22; i++) {
        const y = i * 24 + 6;
        x.fillStyle = "#2c333b"; x.fillRect(6, y, W - 12, 9);
        x.strokeStyle = "rgba(0,0,0,.5)"; x.lineWidth = 1; x.strokeRect(6.5, y + 0.5, W - 13, 8);
        hc.x.fillStyle = "#e0e0e0"; hc.x.fillRect(6, y, W - 12, 9);
      }
      x.fillStyle = "#171c22"; x.fillRect(0, 0, 7, H); x.fillRect(W - 7, 0, 7, H);
      return { map: TX(c, { srgb: true }), normalMap: TX(normalMap(hc.c, 1.2)) };
    });
  },

  /** 线缆束（多色平行线，配合圆柱/长方体使用） */
  cableBundle(o) {
    o = o || {};
    const cols = o.colors || ["#e8c33a", "#2f7fe8", "#22c55e", "#e2e8f0", "#f5576c"];
    return memo("cb" + cols.join(), () => {
      const W = 128, H = 128;
      const { c, x } = C(W, H);
      x.fillStyle = "#0d1116"; x.fillRect(0, 0, W, H);
      const R = mk(83);
      for (let i = 0; i < 9; i++) {
        const y = 8 + i * 13, col = cols[i % cols.length];
        x.strokeStyle = col; x.lineWidth = 9 + R() * 2; x.globalAlpha = 0.92;
        x.beginPath(); x.moveTo(0, y);
        for (let px = 0; px <= W; px += 16) x.lineTo(px, y + Math.sin(px / 22 + i) * 1.6);
        x.stroke(); x.globalAlpha = 1;
        x.strokeStyle = "rgba(255,255,255,.18)"; x.lineWidth = 2;
        x.beginPath(); x.moveTo(0, y - 3);
        for (let px = 0; px <= W; px += 16) x.lineTo(px, y - 3 + Math.sin(px / 22 + i) * 1.6);
        x.stroke();
      }
      return { map: TX(c, { srgb: true }) };
    });
  },

  /** 屏幕类贴图（UPS / 精密空调 / 监控大屏 / 电脑屏） */
  screen(o) {
    o = o || {};
    const title = o.title || "IDC", lines = o.lines || ["STATUS  NORMAL", "LOAD    68%", "TEMP    24.3C"], theme = o.theme || "#5fe6ff";
    return memo("scr" + title + lines.join() + theme, () => {
      const W = 512, H = 256;
      const { c, x } = C(W, H);
      x.fillStyle = "#04080d"; x.fillRect(0, 0, W, H);
      x.fillStyle = "rgba(10,30,45,.9)"; x.fillRect(0, 0, W, 44);
      txt(x, title, 16, 22, "bold 22px 'Microsoft YaHei',sans-serif", theme, "left");
      x.strokeStyle = "rgba(120,200,255,.35)"; x.lineWidth = 1; x.beginPath(); x.moveTo(0, 44); x.lineTo(W, 44); x.stroke();
      lines.forEach((t, i) => txt(x, t, 20, 78 + i * 40, "20px Consolas,monospace", i === 0 ? "#dff3ff" : theme, "left"));
      // 右侧柱状
      [0.4, 0.62, 0.5, 0.78, 0.68].forEach((v, i) => {
        x.fillStyle = "rgba(95,230,255,.75)";
        x.fillRect(W - 150 + i * 26, H - 30 - v * 120, 16, v * 120);
      });
      x.strokeStyle = "rgba(95,230,255,.25)"; x.strokeRect(0.5, 0.5, W - 1, H - 1);
      return { map: TX(c, { srgb: true }), emissiveMap: TX(c, { srgb: true }) };
    });
  },

  /** 铭牌 / 标签（支持中英文） */
  label(text, o) {
    o = o || {};
    const sub = o.sub || "", bg = o.bg || "#0d1622", fg = o.fg || "#eaf9ff", border = o.border || "#2f7fe8";
    return memo("lb" + text + sub + bg + fg + border, () => {
      const W = o.w || 512, H = o.h || 128;
      const { c, x } = C(W, H);
      x.fillStyle = bg; rrect(x, 4, 4, W - 8, H - 8, 10); x.fill();
      x.strokeStyle = border; x.lineWidth = 3; x.stroke();
      const size = o.size || Math.round(H * 0.42);
      txt(x, text, W / 2, sub ? H * 0.38 : H / 2, "bold " + size + "px 'Microsoft YaHei',sans-serif", fg, "center");
      if (sub) txt(x, sub, W / 2, H * 0.74, Math.round(size * 0.62) + "px 'Microsoft YaHei',sans-serif", o.subFg || "#8aa0bd", "center");
      return { map: TX(c, { srgb: true }), emissiveMap: TX(c, { srgb: true }) };
    });
  },

  /** 发光灯带/光晕（配合自发光材质或 Sprite） */
  glow(o) {
    o = o || {};
    const col = o.color || "#5fe6ff";
    return memo("gl" + col + (o.soft ? "s" : ""), () => {
      const S = 256;
      const { c, x } = C(S, S);
      const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      g.addColorStop(0, col); g.addColorStop(o.soft ? 0.25 : 0.45, col + "66");
      g.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = g; x.fillRect(0, 0, S, S);
      return { map: TX(c, { srgb: true }) };
    });
  },
};

/* ======================================================================
 *  材质
 * ==================================================================== */
export function pbr(set, over) {
  const m = new THREE.MeshStandardMaterial(Object.assign({
    map: set && set.map || null, normalMap: set && set.normalMap || null,
    roughnessMap: set && set.roughnessMap || null, emissiveMap: set && set.emissiveMap || null,
    metalness: 0.65, roughness: 0.45, envMapIntensity: 1.0,
  }, over || {}));
  return m;
}

export const MAT = {
  /** 机柜框架（型材/立柱） */
  rackFrame() { return memo("m-rf", () => pbr(TEX.metalPanel({ base: "#5d656f", dark: "#3a4049" }), { metalness: 0.8, roughness: 0.36, color: 0xffffff, envMapIntensity: 1.25 })); },
  /** 机柜侧板/后板/顶板 */
  rackSide() { return memo("m-rs", () => pbr(TEX.metalPanel({ base: "#565d66", dark: "#333941" }), { metalness: 0.58, roughness: 0.48, color: 0xffffff, envMapIntensity: 1.1 })); },
  /** 机柜前门（真实镂空网孔） */
  rackDoor() {
    return memo("m-rd", () => {
      const t = TEX.doorMesh({});
      const m = pbr(t, { metalness: 0.7, roughness: 0.32, color: 0xffffff, alphaTest: 0.5, side: THREE.DoubleSide, transparent: false, envMapIntensity: 1.3 });
      m.alphaMap = t.alphaMap; return m;
    });
  },
  /** 19" 安装立柱 */
  rail(rep) {
    return memo("m-rail" + rep, () => {
      const t = TEX.rail();
      if (rep) { t.map.repeat.set(1, rep); t.normalMap.repeat.set(1, rep); }
      return pbr(t, { metalness: 0.86, roughness: 0.28, color: 0xffffff, envMapIntensity: 1.3 });
    });
  },
  /** 服务器 / 存储 / 网络 / 安全 设备面板 */
  device(kind, uSize, seed) {
    return memo("m-dev" + kind + uSize + seed, () => pbr(TEX.serverFront({ kind, uSize, seed: seed || 1 }), {
      metalness: 0.6, roughness: 0.42, color: 0xffffff, envMapIntensity: 1.15,
      emissive: new THREE.Color(0xffffff), emissiveIntensity: 1.0,
    }));
  },
  /** 盲板 */
  blank() { return memo("m-blank", () => pbr(TEX.blankPanel(), { metalness: 0.62, roughness: 0.48, color: 0xffffff, envMapIntensity: 1.15 })); },
  /** 风扇模组 */
  fan() { return memo("m-fan", () => pbr(TEX.fanModule(), { metalness: 0.55, roughness: 0.52, color: 0xffffff, envMapIntensity: 1.1 })); },
  /** PDU */
  pdu() { return memo("m-pdu", () => pbr(TEX.pduStrip(), { metalness: 0.68, roughness: 0.4, color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.7, envMapIntensity: 1.15 })); },
  /** 架空地板 */
  floor() { return memo("m-floor", () => pbr(TEX.floorTile(), { metalness: 0.08, roughness: 0.5, color: 0xd4dde8, envMapIntensity: 0.62 })); },
  /** 冷通道格栅地板 */
  floorGrille() { return memo("m-fg", () => pbr(TEX.floorGrille(), { metalness: 0.35, roughness: 0.6, color: 0x9fb0c0 })); },
  /** 墙板 */
  wall() { return memo("m-wall", () => pbr(TEX.wallPanel(), { metalness: 0.35, roughness: 0.75, color: 0x93a8c0, envMapIntensity: 0.5 })); },
  /** 桥架 */
  tray() { return memo("m-tray", () => pbr(TEX.cableTray(), { metalness: 0.7, roughness: 0.5, color: 0x9aa6b4 })); },
  /** 线缆 */
  cable(cols) { return memo("m-cable" + (cols || []).join(), () => pbr(TEX.cableBundle({ colors: cols }), { metalness: 0.25, roughness: 0.62, color: 0xffffff })); },
  /** 屏幕（自发光） */
  screen(title, lines, theme) {
    return memo("m-scr" + title + (lines || []).join() + theme, () => pbr(TEX.screen({ title, lines, theme }), {
      metalness: 0.2, roughness: 0.25, color: 0x223040, emissive: new THREE.Color(0xffffff), emissiveIntensity: 1.15,
    }));
  },
  /** 铭牌（自发光） */
  label(text, o) {
    return memo("m-lb" + text + JSON.stringify(o || {}), () => pbr(TEX.label(text, o), {
      metalness: 0.25, roughness: 0.4, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.75,
      transparent: false,
    }));
  },
  /** 玻璃幕墙 */
  glass() {
    return memo("m-glass", () => new THREE.MeshPhysicalMaterial({
      color: 0xbcd6ee, metalness: 0, roughness: 0.06, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, envMapIntensity: 1.6, clearcoat: 0.6, clearcoatRoughness: 0.1, depthWrite: false,
    }));
  },
  /** 发光条 */
  ledStrip(color, intensity) {
    return memo("m-led" + color + intensity, () => new THREE.MeshStandardMaterial({
      color: 0x0b1016, emissive: new THREE.Color(color || "#5fe6ff"), emissiveIntensity: intensity == null ? 2.2 : intensity,
      metalness: 0.3, roughness: 0.4,
    }));
  },
  /** 通用纯色 PBR */
  solid(color, metalness, roughness) {
    return memo("m-s" + [color, metalness, roughness].join(), () => new THREE.MeshStandardMaterial({
      color, metalness: metalness == null ? 0.4 : metalness, roughness: roughness == null ? 0.55 : roughness, envMapIntensity: 1,
    }));
  },
};

export function disposeAll() { _memo.forEach((v) => { if (v && v.dispose) v.dispose(); }); _memo.clear(); }