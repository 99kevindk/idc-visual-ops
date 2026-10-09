/* =========================================================================
 *  src/app.js — 主程序：模块装配、页面路由、时钟/心跳、镜头与片头编排
 *  依赖：data.js / scene3d.js / hud.js / xiaowei.js（均挂载在 window.IDC 上）
 * ========================================================================= */
import "./data.js";
import "./scene3d.js";
import "./hud.js";
import "./xiaowei.js";
import "./donghuan.js";
import "./symbols.js";
import "./floorplan.js";

(function (global) {
  "use strict";
  const IDC = global.IDC || (global.IDC = {});
  const bus = IDC.bus, data = IDC.data, scene = IDC.scene, hud = IDC.hud, xw = IDC.xiaowei;
  const dh = () => IDC.dh;   // 动环模块（donghuan.js，延迟取，避免加载顺序问题）
  const $ = (s) => document.querySelector(s);
  const qs = new URLSearchParams(location.search);
  const call = (obj, fn, ...a) => { try { return obj && typeof obj[fn] === "function" ? obj[fn](...a) : undefined; } catch (e) { console.error(fn, e); } };

  const app = {
    page: "overview",
    rack: null,            // 当前选中机柜
    introDone: false,

    /** 切换页面 */
    goto(name, opts) {
      if (!name) return;
      app.page = name;
      document.querySelectorAll("#tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
      const stage = $("#stage");
      if (stage) stage.dataset.page = name;
      const planRoot = document.getElementById("plan-root");
      const hudRoot = document.getElementById("hud-root");
      if (name !== "plan") {
        if (planRoot) planRoot.classList.add("hidden");
        if (hudRoot) hudRoot.classList.remove("hidden");
        call(IDC.plan, "hide");
      }
      call(hud, "setPage", name, opts || {});
      app.enterPage(name);
      bus.emit("page", name);
    },

    /** 进入页面时的镜头/数据编排（原作的三个页面共享同一个三维机房） */
    enterPage(name) {
      const alarmRack = (data.alarms[0] && data.alarms[0].rackId) || "A-02";
      if (name === "overview") {
        call(scene, "setMode", "status");
        call(scene, "setAlarmBeacons", data.alarms.map((a) => a.rackId));
        call(scene, "setView", "overview");
        call(scene, "resetCamera");
      } else if (name === "monitor") {
        call(scene, "setMode", "status");
        call(scene, "setAlarmBeacons", data.alarms.map((a) => a.rackId));
        const rid = app.rack || alarmRack;
        call(scene, "focusRack", rid, { open: true, duration: 0.6 });
        call(scene, "assistantTo", rid);
        call(hud, "setRackDetail", rid);
        app.rack = rid;
      } else if (name === "plan") {
        const root = document.getElementById("plan-root");
        const hudRoot = document.getElementById("hud-root");
        if (root) root.classList.remove("hidden");
        if (hudRoot) hudRoot.classList.add("hidden");
        call(IDC.plan, "show");
        if (IDC.plan && IDC.plan.model && !IDC.plan.model.items.length) call(IDC.plan, "buildFromScene");
        return;
      } else if (name === "donghuan") {
        call(scene, "setMode", "status");
        call(scene, "setView", "roomOrbit");
        const list = (dh() && dh().activeAlarms) ? dh().activeAlarms() : [];
        call(scene, "setSensorAlarms", list.map((x) => ({ devId: x.devId, level: x.level })));
        const first = list[0];
        if (first) call(scene, "focusDevice", first.devId, { duration: 1.0 });
      } else if (name === "alarms") {
        call(scene, "setMode", "alarm");
        call(scene, "setAlarmBeacons", data.alarms.map((a) => a.rackId));
        call(scene, "focusRack", app.rack || alarmRack, { open: false, duration: 0.9 });
      } else {
        call(scene, "setView", "roomOrbit");
      }
    },

    selectRack(id) {
      app.rack = id;
      call(hud, "setRackDetail", id);
      call(scene, "highlightRack", id, "focus");
    },
    toast(t, lv) { call(hud, "toast", t, lv); },
    /** QA / 录屏钩子：window.IDC.app.ask('巡检 A-02') */
    ask(t) { call(xw, "ask", t); },
    /** QA / 录屏钩子：一键跑完整巡检剧情 */
    demo() { call(xw, "demo"); },

    showIntro() {
      const el = $("#intro");
      if (!el) return;
      el.classList.remove("hidden");
      app.introDone = false;
      const finish = () => {
        if (app.introDone) return;
        app.introDone = true;
        el.classList.add("hidden");
        el.removeEventListener("click", finish);
      };
      el.addEventListener("click", finish);
      setTimeout(finish, 6000);
      try { scene && scene.playIntro && scene.playIntro(finish); } catch (e) { console.warn("intro", e); }
    },
  };

  /* ---------------- 外壳交互 ---------------- */
  function wireShell() {
    document.querySelectorAll("#tabs .tab").forEach((b) => b.addEventListener("click", () => app.goto(b.dataset.page)));
    const mic = $("#btn-mic");
    if (mic) mic.addEventListener("click", () => { app.goto("monitor"); call(xw, "listen"); });
    const guide = $("#btn-guide");
    if (guide) guide.addEventListener("click", () => {
      app.goto("overview");
      app.toast("引导：点击三维机柜查看详情；点底部麦克风进入语音三维巡检（可说「巡检 A-02」）", "ok");
      setTimeout(() => app.demo(), 1200);
    });
    const about = $("#btn-about"), aboutModal = $("#about-modal");
    if (about && aboutModal) {
      const toggle = (on) => {
        const show = on === undefined ? aboutModal.classList.contains("hidden") : on;
        aboutModal.classList.toggle("hidden", !show);
      };
      about.addEventListener("click", () => toggle());
      const close = $("#about-close"); if (close) close.addEventListener("click", () => toggle(false));
      aboutModal.addEventListener("click", (e) => { if (e.target === aboutModal) toggle(false); });
      addEventListener("keydown", (e) => { if (e.key === "Escape") toggle(false); });
    }
    const bell = $("#btn-bell");
    if (bell) bell.addEventListener("click", () => app.goto("alarms"));
    const intro = $("#intro");
    if (intro) intro.addEventListener("click", () => { intro.classList.add("hidden"); app.introDone = true; });
  }

  /* ---------------- 时钟 / 数据心跳 ---------------- */
  function startTimers() {
    const el = $("#clock");
    const updateClock = () => { if (el) el.textContent = data.clock(); };
    updateClock();
    setInterval(updateClock, 1000);
    setInterval(() => data.tick(), 2500);
  }

  /* ---------------- 底部告警 ticker ---------------- */
  function startTicker() {
    const box = $("#ticker");
    if (!box) return;
    let i = 0;
    const render = () => {
      const list = (data.events || []).slice(0, 8);
      if (!list.length) { box.innerHTML = ""; return; }
      const e = list[i % list.length]; i++;
      const tag = e.level === "critical" ? "告警" : e.level === "warning" ? "预警" : "提示";
      box.innerHTML = '<span class="t-time">' + data.clock().slice(0, 10) + " " + e.time + "</span><span>" + e.text +
        '</span><span class="t-tag ' + (e.level || "info") + '">' + tag + "</span>";
    };
    render();
    setInterval(render, 4200);
    bus.on("alarm:add", render);
    bus.on("event:add", render);
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    const canvas = $("#gl");
    call(scene, "init", canvas, { data });
    call(hud, "mount", $("#hud-root"), data, scene);
    call(xw, "init", { data, scene, hud, app });
    const planRoot = document.getElementById("plan-root");
    if (planRoot) call(IDC.plan, "mount", planRoot);       // 机房图纸（2D 图元/平面图）
    try { IDC.dh && IDC.dh.init({ data, scene, hud, app }); } catch (e) { console.error("donghuan init", e); }

    wireShell();
    startTimers();
    startTicker();

    const resize = () => {
      const stage = $("#stage");
      if (!stage) return;
      call(scene, "resize", stage.clientWidth, stage.clientHeight);
    };
    addEventListener("resize", resize);
    resize();

    app.goto(qs.get("page") || "overview");

    let last = performance.now();
    const loop = (ts) => {
      const dt = Math.min(0.05, (ts - last) / 1000); last = ts;
      call(scene, "frame", ts, dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    if (qs.get("noseq") === "1" || qs.get("intro") === "0") {
      const el = $("#intro"); if (el) el.classList.add("hidden");
      app.introDone = true;
    } else {
      app.showIntro();
    }

    /* 事件总线转发 */
    bus.on("rack:select", (id) => app.selectRack(id));
    /* 机房监控页中心视图切换：'3d' 单柜特写 / 'detail' 处置详情（由 HUD 按钮触发） */
    bus.on("monitor:view", (mode) => {
      const rid = app.rack || ((data.alarms[0] && data.alarms[0].rackId) || "A-02");
      if (app.page !== "monitor") app.goto("monitor");
      if (mode === "3d") {
        call(scene, "setView", "rack");
        call(scene, "focusRack", rid, { open: true, duration: 1.0 });
        call(scene, "assistantTo", rid);
      } else {
        call(scene, "setView", "roomOrbit");
      }
    });
    bus.on("device:select", (p) => { if (p) app.toast((p.rackId || "") + " " + (p.name || p.deviceId || "设备") + " 已选中", "ok"); });
    bus.on("alarm:add", (a) => app.toast("新增告警：" + (a && a.title ? a.title : ""), "critical"));
    /* 动环事件 */
    bus.on("dh:alarm", (al) => {
      const lv = al.level === "critical" ? "critical" : al.level === "warning" ? "warning" : "ok";
      app.toast("动环报警：" + al.devName + " " + al.text, lv);
      call(scene, "setSensorAlarms", dh().activeAlarms().map((x) => ({ devId: x.devId, level: x.level })));
    });
    bus.on("dh:alarm:clear", () => { call(scene, "setSensorAlarms", dh().activeAlarms().map((x) => ({ devId: x.devId, level: x.level }))); });
    bus.on("dh:select", (p) => { if (p && p.devId) { if (app.page !== "donghuan") app.goto("donghuan"); call(scene, "focusDevice", p.devId, { duration: 0.8 }); } });
    bus.on("dh:ready", (p) => { console.log("[IDC] 动环接入就绪:", JSON.stringify(p)); call(hud, "updateShell"); });
    bus.on("toast", (p) => app.toast(typeof p === "string" ? p : p && p.text, p && p.level));
    bus.on("shell:refresh", () => call(hud, "updateShell"));

    console.log("[IDC] boot ok · page=" + app.page + " · racks=" + data.racks.length +
      " · devices=" + data.kpi.deviceTotal + " · modules=" +
      ["scene:" + (!!(scene && scene.ready || scene && scene.init)), "hud:" + !!hud, "xiaowei:" + !!xw].join(" "));
  }

  IDC.app = app;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window);