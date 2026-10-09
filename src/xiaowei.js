/* =========================================================================
 *  src/xiaowei.js — 语音巡检助手「小维」
 *  纯前端 · 离线 · 本地规则引擎：Web Speech API 识别 + speechSynthesis 播报
 *  对外暴露：window.IDC.xiaowei
 *  契约：init({data,scene,hud,app}) / listen() / stop() / ask(text) / say(text)
 *        speakEnabled = true / wakeWordEnabled = false / demo() / onState
 *  依赖：只通过 window.IDC 命名空间调用 data / scene / hud，缺方法时全部降级。
 * ========================================================================= */
(function (global) {
  "use strict";

  const IDC = (global.IDC = global.IDC || {});

  /* ---------------------------------------------------------------- 常量 */
  const WAKE_RE = /(小维|小薇|小伟|小围)/;
  const FALLBACK_REPLY = "没听清，可以说『巡检 A-02』或『当前告警』。";
  const CN_DIGITS = { "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
  const MAX_RACK_NO = 7;

  /* ------------------------------------------------------------ 运行时状态 */
  let data = null, scene = null, hud = null, app = null, bus = null;
  let recognition = null, listening = false;
  let seqToken = 0, speakSeq = 0;
  const seqTimers = new Set();
  const demoTimers = new Set();
  const ctx = { lastText: "", lastRackId: "A-02", lastWoId: null, lastIntent: null };

  /* -------------------------------------------------------------- 工具函数 */
  const useData = () => data || IDC.data || null;
  const useScene = () => scene || IDC.scene || null;
  const useHud = () => hud || IDC.hud || null;

  function fmt(v, n) {
    const x = Number(v);
    return isFinite(x) ? x.toFixed(n) : (v == null ? "-" : String(v));
  }
  function callScene(name) {
    const args = Array.prototype.slice.call(arguments, 1);
    try {
      const s = useScene();
      const f = s && s[name];
      if (typeof f === "function") return f.apply(s, args);
    } catch (e) { console.warn("[xiaowei] scene." + name, e); }
    return undefined;
  }
  function callHud(name) {
    const args = Array.prototype.slice.call(arguments, 1);
    try {
      const h = useHud();
      const f = h && h[name];
      if (typeof f === "function") return f.apply(h, args);
    } catch (e) { console.warn("[xiaowei] hud." + name, e); }
    return undefined;
  }
  function emit(evt, payload) {
    try {
      const b = bus || IDC.bus;
      if (b && typeof b.emit === "function") b.emit(evt, payload);
    } catch (e) { /* 事件总线不可用时静默 */ }
  }
  function toast(text, level) { callHud("toast", text, level); }
  function chatAdd(role, text) {
    try {
      const h = useHud();
      if (h && h.chat && typeof h.chat.add === "function") h.chat.add({ role: role, text: text });
    } catch (e) { /* HUD 占位实现也不能中断流程 */ }
  }
  function chatStatus(text) {
    try {
      const h = useHud();
      if (h && h.chat && typeof h.chat.setStatus === "function") h.chat.setStatus(text);
    } catch (e) { /* ignore */ }
  }
  function hudNextStep(text) {
    try {
      const h = useHud();
      if (h && h.chat && typeof h.chat.setNextStep === "function") h.chat.setNextStep(text);
    } catch (e) { /* ignore */ }
  }
  function navTo(page) {
    try {
      if (app && typeof app.goto === "function") { app.goto(page); return; }
      const h = useHud();
      if (h && typeof h.setPage === "function") h.setPage(page);
    } catch (e) { console.warn("[xiaowei] navTo", e); }
  }
  function at(token, ms, fn) {
    const t = setTimeout(function () {
      seqTimers.delete(t);
      if (token !== seqToken) return;              // 被新指令打断后旧步骤直接作废
      try { fn(); } catch (e) { console.warn("[xiaowei] step", e); }
    }, Math.max(0, ms | 0));
    seqTimers.add(t);
    return t;
  }
  function clearSeqTimers() {
    seqTimers.forEach(function (t) { clearTimeout(t); });
    seqTimers.clear();
  }
  function clearDemoTimers() {
    demoTimers.forEach(function (t) { clearTimeout(t); });
    demoTimers.clear();
  }
  function notifyState(intent) {
    const st = {
      text: ctx.lastText,
      intent: (intent && intent.name) || ctx.lastIntent,
      rackId: (intent && intent.rackId) || null,
      listening: listening,
      speaking: false,
    };
    try { if (typeof api.onState === "function") api.onState(st); } catch (e) { console.warn("[xiaowei] onState", e); }
  }

  /* -------------------------------------------------- 文本归一化 / 机柜解析 */
  function normalizeText(s) {
    let t = String(s == null ? "" : s);
    t = t.replace(/[\uFF01-\uFF5E]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); });
    t = t.replace(/[，。！？、；：""''（）【】《》\-—–~·,.!?;:"'()\[\]<>/\\]/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
  }
  function cn2num(str) {
    if (str == null) return NaN;
    const t = String(str).replace(/两/g, "二");
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    let total = 0, num = 0, hit = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t.charAt(i);
      if (Object.prototype.hasOwnProperty.call(CN_DIGITS, ch)) { num = CN_DIGITS[ch]; hit = true; }
      else if (ch === "十") { total += (num || 1) * 10; num = 0; hit = true; }
      else if (ch === "百") { total += (num || 1) * 100; num = 0; hit = true; }
      else return NaN;
    }
    return hit ? total + num : NaN;
  }
  function makeRackId(row, no) {
    const n = Number(no);
    if (!row || !isFinite(n) || n < 1 || n > MAX_RACK_NO) return null;
    const id = String(row).toUpperCase() + "-" + (n < 10 ? "0" + n : String(n));
    const d = useData();
    if (d && typeof d.getRack === "function" && !d.getRack(id)) return null;
    return id;
  }
  /** 支持：A-02 / A02 / A 区 2 号柜 / A排二 / 查看 A-02 的状态 */
  function parseRack(text) {
    const t = normalizeText(text).toUpperCase();
    let m = t.match(/([A-F])\s*(?:-|—|–)?\s*0*([0-9]{1,2})(?![0-9])/);
    if (m) { const id = makeRackId(m[1], m[2]); if (id) return id; }
    m = t.match(/([A-F])\s*(?:区|排|列|通道)?\s*(?:第)?\s*([0-9]{1,2}|[零〇一二两三四五六七八九十百]+)\s*(?:号)?/);
    if (m) { const id = makeRackId(m[1], cn2num(m[2])); if (id) return id; }
    return null;
  }
  function parseRow(text) {
    const t = normalizeText(text).toUpperCase();
    const m = t.match(/([A-F])\s*(?:排|区|列|通道)/);
    return m ? m[1] : null;
  }

  /* ---------------------------------------------------------- 意图解析引擎 */
  function parseIntent(raw) {
    const t = normalizeText(raw);
    const lower = t.toLowerCase();
    const rackId = parseRack(t);
    const row = parseRow(t);
    const hits = [];
    const push = function (name, score) { hits.push({ name: name, score: score }); };

    if (/(处理完成|处置完成|已处理|已完成|已恢复|恢复|复核|归档|闭环|处理好了|搞定了|修好了|恢复正常|处置完毕|完成处理)/.test(t)) push("resolve", 100);
    if (/(生成工单|开工单|建个工单|建工单|派单|派人|派工|安排人|安排处理|工单|联系.*(?:人|工)|通知.*(?:人|工))/.test(t)) push("workorder", 92);
    if (/(分析|原因|根因|怎么处理|怎么办|如何处理|如何处置|处置方案|排查|建议)/.test(t)) push("analyze", 86);
    if (/(电力|用电|功耗|功率|pdu|配电|负载|电流|千瓦|kw|能耗)/.test(lower)) push("power", 80);
    if (/(告警|报警|异常|故障)/.test(t)) push("alarms", 76);
    if (/(总览|全览|整间|整个机房|机房全局|全局|总体|全景|首页|返回)/.test(t)) push("overview", 72);
    if (/(冷通道|热通道|通道|整排|那排|哪排|排机柜|排的机柜)/.test(t) ||
        (!rackId && row && /(打开|看看|看下|查看|切换|去|瞅瞅)/.test(t))) push("row", 66);
    if (/(巡检|查看|看看|检查|看一下|瞅瞅|状态|打开|运行)/.test(t)) push("inspect", 60);
    if (rackId && /(怎么样|情况|如何|状态|巡检|查看|检查|运行)/.test(t)) push("inspect", 62);
    if (rackId && !hits.length) push("inspect", 58);

    /* ---- 动环（动力环境）意图，优先级高于通用告警 / 巡检 ---- */
    if (/(恢复|清除|复位|消警|解除|取消)/.test(t) && /(报警|告警|浸水|漏水|烟感|这些)/.test(t)) push("dh.recover", 130);
    if (/(触发|演示|模拟|注入|制造)/.test(t) && /(报警|告警|浸水|漏水|烟感|烟雾|火)/.test(t)) push("dh.trigger", 128);
    if (/(动环|动力环境|环境报警|环境监控|环境告警)/.test(t) && /(报警|告警|异常|故障|情况|状态|有哪些|几条)/.test(t)) push("dh.alarms", 96);
    if (/(ups|不间断电源|不间断|电源系统)/i.test(lower)) push("dh.ups", 94);
    if (/(浸水|漏水|渗水|水浸|绳式检测)/.test(t)) push("dh.water", 94);
    if (/(烟感|烟雾|烟火|感烟)/.test(t)) push("dh.smoke", 94);
    if (/(温湿度|温度湿度|温度多少|湿度多少|多少度|机房温度|环境温度|机房湿度|平均温度|最高温|室温)/.test(t)) push("dh.th", 90);
    if (/(电流|电压|供电|配电|mdb|列头柜|低压柜|有功功率|功率因数|市电)/i.test(lower)) push("dh.power", 90);

    /* ---- 机房图纸（平面图/图元）意图 ---- */
    if (/(图纸|平面图|图元)/.test(t) && /(告警|报警|异常|故障)/.test(t)) push("plan.alarms", 112);
    if (/(图纸|平面图|图元)/.test(t) && /(同步|扩展|应用|生成三维|推到三维|导入三维)/.test(t)) push("plan.apply", 108);
    if (/扩展机房图形|扩展图形|图纸扩展/.test(t)) push("plan.apply", 108);
    if (/(图纸|平面图)/.test(t) && /(加|新增|添加|放置|画上|摆上)/.test(t)) push("plan.add", 106);
    if (/(新增|添加|加个|加台|加一[台个]|加[0-9一二三四五六七八九十]+[台个])/.test(t) && /(机柜|烟感|灭火器|摄像头|UPS|配电|电池|空调|图元|传感器)/i.test(t)) push("plan.add", 106);
    if (/(图纸|平面图)/.test(t) && /(定位|找|在哪|位置|查到|对准|看一下)/.test(t)) push("plan.locate", 104);
    if (/(图纸|平面图)/.test(t) && /(打开|看|显示|切到|进入)/.test(t)) push("plan.open", 100);
    if (/机房图纸|机房平面图|平面布置图/.test(t)) push("plan.open", 100);

    if (!hits.length) return { name: "unknown", rackId: rackId, row: row, text: t };
    hits.sort(function (a, b) { return b.score - a.score; });
    const top = hits[0];
    if (top.name === "inspect" && rackId) top.score += 10;
    if (top.name === "dh.ups") {
      const mu = t.toUpperCase().match(/UPS\s*0?([12])/);
      if (mu) top.devId = "UPS-0" + mu[1];
      else if (/B\s*区/.test(t)) top.devId = "UPS-02";
    }
    return { name: top.name, rackId: rackId, row: row, text: t, score: top.score, devId: top.devId || null };
  }

  /* ------------------------------------------------------------ 语音播报 */
  function pickChineseVoice() {
    try {
      const synth = global.speechSynthesis;
      if (!synth || typeof synth.getVoices !== "function") return null;
      const vs = synth.getVoices() || [];
      const zh = vs.filter(function (v) {
        return /zh|cmn|Chinese/i.test(String(v.lang || "") + " " + String(v.name || ""));
      });
      const pref = zh.find(function (v) {
        return /Xiaoxiao|晓晓|Huihui|慧慧|Yaoyao|瑶瑶|Tingting|婷婷|Meijia|美佳|Female|女/i.test(String(v.name || ""));
      });
      return pref || zh[0] || null;
    } catch (e) { return null; }
  }
  /** 播报 + 写入对话面板；返回 Promise（onend / 超时兜底都会 resolve，绝不卡死） */
  function say(text) {
    const msg = String(text == null ? "" : text).trim();
    if (!msg) return Promise.resolve();
    chatAdd("assistant", msg);
    chatStatus("小维正在回复：" + msg);
    callScene("setAssistantSpeaking", true);
    emit("assistant:say", { text: msg });
    const mySeq = ++speakSeq;
    return new Promise(function (resolve) {
      let done = false, timer = null;
      const finish = function () {
        if (done) return;
        done = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (mySeq === speakSeq) {
          callScene("setAssistantSpeaking", false);
          chatStatus("");
        }
        resolve();
      };
      const synth = global.speechSynthesis;
      const canSpeak = api.speakEnabled && synth && typeof synth.speak === "function" &&
        typeof global.SpeechSynthesisUtterance === "function";
      if (!canSpeak) { timer = setTimeout(finish, 600); return; }   // 无 TTS 环境：setTimeout 兜底
      try {
        if (typeof synth.cancel === "function") synth.cancel();
        const u = new global.SpeechSynthesisUtterance(msg);
        u.lang = "zh-CN";
        u.rate = 1.05;
        u.pitch = 1;
        u.volume = 1;
        const v = pickChineseVoice();
        if (v) u.voice = v;
        u.onend = finish;
        u.onerror = finish;
        timer = setTimeout(finish, Math.min(9000, Math.max(2000, msg.length * 170))); // 超时兜底
        synth.speak(u);
      } catch (e) { console.warn("[xiaowei] speechSynthesis", e); finish(); }
    });
  }

  /* ------------------------------------------------------------ 语音识别 */
  function getRecognition() {
    const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
    if (!SR) return null;
    if (recognition) return recognition;
    try {
      recognition = new SR();
      recognition.lang = "zh-CN";
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;

      recognition.onstart = function () {
        listening = true;
        callHud("setListening", true);
        emit("assistant:listen", true);
      };
      recognition.onresult = function (ev) {
        let finalText = "", interimText = "";
        try {
          const res = (ev && ev.results) ? ev.results : [];
          const start = (ev && typeof ev.resultIndex === "number") ? ev.resultIndex : 0;
          for (let i = start; i < res.length; i++) {
            const r = res[i];
            const s = (r && r[0]) ? String(r[0].transcript || "") : "";
            if (r && r.isFinal) finalText += s; else interimText += s;
          }
        } catch (e) { /* 结果结构异常时忽略 */ }
        interimText = interimText.trim();
        finalText = finalText.trim();
        if (interimText && !finalText) chatStatus("正在听：" + interimText);
        if (!finalText) return;
        chatStatus("");
        let text = finalText;
        if (api.wakeWordEnabled) {
          if (!WAKE_RE.test(text)) { toast("未检测到唤醒词「小维」，可以说『小维，巡检 A-02』"); return; }
          text = text.replace(WAKE_RE, "").replace(/^[，。！？、,.!?\s]+/, "").trim() || finalText;
        }
        ask(text);
      };
      recognition.onerror = function (ev) {
        listening = false;
        callHud("setListening", false);
        emit("assistant:listen", false);
        const err = ev && ev.error;
        if (err === "aborted") return;
        if (err === "not-allowed" || err === "service-not-allowed") toast("麦克风权限未授权，请用文字输入");
        else if (err === "audio-capture") toast("未检测到麦克风，请用文字输入");
        else if (err === "no-speech") toast("没有听到声音，请再说一次");
        else if (err === "network") toast("语音识别网络不可用，请用文字输入");
        else toast("语音识别不可用，请用文字输入");
      };
      recognition.onend = function () {
        listening = false;
        callHud("setListening", false);
        emit("assistant:listen", false);
      };
    } catch (e) { console.warn("[xiaowei] SpeechRecognition", e); recognition = null; }
    return recognition;
  }
  function listen() {
    try {
      const r = getRecognition();
      if (!r) {
        toast("当前浏览器不支持语音识别，请用文字输入");
        callHud("setListening", false);
        return false;
      }
      if (listening) return true;
      try { r.start(); } catch (e) {
        listening = false;
        callHud("setListening", false);
        toast("语音识别启动失败，请用文字输入");
        return false;
      }
      listening = true;
      callHud("setListening", true);
      emit("assistant:listen", true);
      return true;
    } catch (e) {
      console.warn("[xiaowei] listen", e);
      try { callHud("setListening", false); } catch (_) { /* ignore */ }
      return false;
    }
  }
  function stop() {
    try { if (recognition && typeof recognition.stop === "function") recognition.stop(); } catch (e) { /* ignore */ }
    listening = false;
    callHud("setListening", false);
    emit("assistant:listen", false);
    clearDemoTimers();
  }

  /* ---------------------------------------------------------- 动作编排剧本 */
  function finishWithSay(token, text, next) {
    at(token, 0, function () { say(text); if (next) hudNextStep(next); });
  }

  /* ① 巡检某机柜 */
  function planInspect(token, rackId) {
    const d = useData();
    const id = rackId || ctx.lastRackId || "A-02";
    const rack = d && typeof d.getRack === "function" ? d.getRack(id) : null;
    if (!rack) { finishWithSay(token, "没有找到机柜 " + id + "，可以说『巡检 A-02』。", "试一试：巡检 A-02 →"); return; }
    ctx.lastRackId = rack.id;
    const alarm = d && typeof d.alarmOfRack === "function" ? d.alarmOfRack(rack.id) : null;
    const bad = rack.status === "alarm" || !!alarm;

    navTo("monitor");
    at(token, 0, function () {
      callScene("setView", "rack", { page: "monitor" });
      callScene("setMode", bad ? "alarm" : "status");
    });
    at(token, 160, function () { callScene("focusRack", rack.id, { open: true, duration: 1.4 }); });
    at(token, 520, function () { callScene("assistantTo", rack.id, { duration: 1.2 }); });
    at(token, 760, function () { callHud("setRackDetail", rack.id); });
    at(token, 900, function () {
      callScene("highlightRack", rack.id, bad ? "temp" : "normal");
      callScene("setAlarmBeacons", bad ? [rack.id] : []);
    });

    const tempText = fmt(rack.tempIn, 1);
    const kwText = fmt(rack.powerKW, 2);
    let text, next;
    if (bad) {
      const title = (alarm && alarm.title) || "存在异常";
      const suggest = (alarm && alarm.suggest) || "检查进风通道与冷通道送风，确认温度传感器读数。";
      text = rack.id + " 号机柜，" + title + "，温度 " + tempText + " 度，功率 " + kwText + " 千瓦。" + suggest;
      next = "下一步：确认告警 →";
    } else {
      text = rack.id + " 号机柜运行正常，进风温度 " + tempText + " 度，功率 " + kwText +
        " 千瓦，负载 " + rack.loadPct + "%，U 位使用 " + rack.uUsed + "/" + rack.uTotal + "。无需处理，建议按周期继续巡检。";
      next = "下一步：继续巡检 →";
    }
    at(token, 1000, function () { say(text); hudNextStep(next); });
  }

  /* ② 当前告警 */
  function planAlarms(token) {
    const d = useData();
    const list = (d && d.alarms) ? d.alarms.slice(0, 6) : [];
    if (!list.length) { finishWithSay(token, "当前没有未处理的告警，机房运行正常。", "下一步：继续巡检 →"); return; }
    const ids = [];
    list.forEach(function (a) { if (a && a.rackId && ids.indexOf(a.rackId) < 0) ids.push(a.rackId); });

    navTo("monitor");
    at(token, 0, function () {
      callScene("setView", "overview");
      callScene("setMode", "alarm");
      callScene("setAlarmBeacons", ids);
    });
    list.forEach(function (a, i) {
      if (!a || !a.rackId) return;
      at(token, 320 + i * 550, function () {
        callScene("highlightRack", a.rackId, "alarm");
        callScene("assistantTo", a.rackId, { duration: 0.6 });
        callHud("setRackDetail", a.rackId);
      });
    });
    const lines = list.map(function (a, i) {
      return "第" + (i + 1) + "条，" + a.rackId + " " + a.title + "，" +
        (a.level === "critical" ? "严重" : "一般") + "，" + a.time + "。";
    }).join("");
    const text = "当前共 " + list.length + " 条告警。" + lines + "建议优先处理 A-02 与 C-05 的严重告警。";
    at(token, 500, function () { say(text); hudNextStep("下一步：巡检 A-02 →"); });
  }

  /* ③ 电力数据 / PDU */
  function planPower(token, rackId) {
    const d = useData();
    const id = rackId || ctx.lastRackId || "A-02";
    const rack = d && typeof d.getRack === "function" ? d.getRack(id) : null;
    const k = (d && d.kpi) ? d.kpi : {};

    navTo("monitor");
    at(token, 0, function () {
      callScene("setView", "energy", { rackId: id });
      callScene("setMode", "load");
    });
    if (rack) {
      ctx.lastRackId = rack.id;
      at(token, 200, function () { callScene("focusRack", rack.id, { open: false, duration: 1.2 }); });
      at(token, 520, function () { callScene("assistantTo", rack.id, { duration: 1.1 }); });
      at(token, 700, function () {
        callScene("highlightRack", rack.id, "load");
        callHud("setRackDetail", rack.id);
      });
    }
    const text = "机房总功耗 " + fmt(k.totalPowerKW, 1) + " 千瓦，PUE " + fmt(k.pue, 2) + "。" +
      (rack
        ? rack.id + " 机柜 PDU 实测功率 " + fmt(rack.powerKW, 2) + " 千瓦，额定 " + fmt(rack.powerRatedKW, 2) +
          " 千瓦，负载率 " + rack.loadPct + "%。双路供电需保持均衡，建议复核 PDU 配比。"
        : "当前未指定机柜，可以说『查看 A-02 的电力数据』。");
    at(token, 950, function () { say(text); hudNextStep("下一步：分析原因 →"); });
  }

  /* ④ 返回总览 / 整间机房 */
  function planOverview(token) {
    const d = useData();
    const k = (d && d.kpi) ? d.kpi : {};
    const list = (d && d.alarms) ? d.alarms.filter(function (a) { return !a.acked; }) : [];
    const ids = list.map(function (a) { return a.rackId; });

    navTo("overview");
    at(token, 0, function () {
      callScene("setView", "overview");
      callScene("setMode", "temp");
      callScene("setAlarmBeacons", ids);
    });
    at(token, 260, function () { callScene("resetCamera"); });
    const text = "已返回机房总览。机柜 " + (k.rackTotal || 0) + " 个，设备 " + (k.deviceTotal || 0) +
      " 台，平均温度 " + fmt(k.tempAvg, 1) + " 度，湿度 " + fmt(k.humAvg, 1) + "%，总功耗 " + fmt(k.totalPowerKW, 1) +
      " 千瓦，PUE " + fmt(k.pue, 2) + "。当前未确认告警 " + list.length + " 条。";
    at(token, 620, function () { say(text); hudNextStep("下一步：当前告警 →"); });
  }

  /* ⑤ 分析原因 / 怎么处理 */
  function planAnalyze(token) {
    const d = useData();
    const id = ctx.lastRackId || "A-02";
    const alarm = d && typeof d.alarmOfRack === "function" ? d.alarmOfRack(id) : null;

    navTo("monitor");
    at(token, 0, function () { callScene("setView", "rack"); callScene("setMode", "alarm"); });
    at(token, 180, function () { callScene("focusRack", id, { open: true, duration: 1.2 }); });
    at(token, 500, function () { callScene("highlightRack", id, "temp"); });
    at(token, 680, function () { callHud("setRackDetail", id); });

    const basis = (alarm && alarm.detail) ? "告警依据是「" + alarm.detail + "」" : "当前指标存在异常波动";
    const text = "关于 " + id + "：" + basis + "，这是异常信号，尚不能仅凭该指标确定故障根因。" +
      "建议按顺序排查：第一，检查进风通道是否被遮挡；第二，确认冷通道送风温度与风量；第三，核对温度传感器读数是否漂移。" +
      "助手只提供分析建议，现场处置需由维保人员确认，不会把派单当作维修完成。";
    at(token, 950, function () { say(text); hudNextStep("下一步：生成工单 →"); });
  }

  /* ⑥ 生成工单 / 派人处理 */
  function planWorkOrder(token, rackId) {
    const d = useData();
    const id = rackId || ctx.lastRackId || "A-02";
    const rack = d && typeof d.getRack === "function" ? d.getRack(id) : null;
    const bad = !!(rack && rack.status === "alarm");
    let wo = (d && typeof d.woOfRack === "function") ? d.woOfRack(id) : null;

    navTo("workorder");
    try {
      if (wo && typeof d.updateWorkOrder === "function") {
        d.updateWorkOrder(wo.id, { status: "doing" });
        if (typeof d.pushTimeline === "function") d.pushTimeline(wo.id, "语音助手派单：已通知 " + (wo.owner || "责任人") + "（演示）");
      } else if (d && typeof d.addWorkOrder === "function") {
        wo = d.addWorkOrder({
          title: "检查 " + id + " 运行状态",
          rackId: id,
          level: bad ? "critical" : "warning",
          status: "doing",
          note: "由语音助手生成并派单（演示数据）。"
        });
        if (wo && typeof d.pushTimeline === "function") d.pushTimeline(wo.id, "语音助手生成工单并安排处理（演示）");
      }
    } catch (e) { console.warn("[xiaowei] workorder", e); }
    if (wo && wo.id) ctx.lastWoId = wo.id;

    at(token, 0, function () {
      if (bad) {
        callScene("setView", "rack");
        callScene("focusRack", id, { open: true, duration: 1.2 });
        callScene("highlightRack", id, "alarm");
      }
    });
    at(token, 600, function () { if (wo && wo.id) callHud("openWorkOrder", wo.id); });
    const text = (wo && wo.id)
      ? "已生成工单 " + wo.id + "，关联机柜 " + id + "，负责人 " + (wo.owner || "值班工程师") +
        "，状态推进为进行中。工单已写入运维工单页（演示）。"
      : "工单系统暂不可用，请稍后再试。";
    at(token, 950, function () { say(text); hudNextStep("下一步：现场处理完成 →"); });
  }

  /* ⑦ 现场处理完成 / 复核归档（闭环） */
  function planResolve(token, rackId) {
    const d = useData();
    const id = rackId || ctx.lastRackId || "A-02";
    const alarm = d && typeof d.alarmOfRack === "function" ? d.alarmOfRack(id) : null;
    const wo = d && typeof d.woOfRack === "function" ? d.woOfRack(id) : null;

    navTo("monitor");
    at(token, 0, function () { callScene("setView", "rack"); callScene("setMode", "status"); });
    at(token, 160, function () { callScene("focusRack", id, { open: true, duration: 1.4 }); });
    at(token, 480, function () {
      if (d && typeof d.coolRack === "function") d.coolRack(id, 24.2);
      callScene("highlightRack", id, "normal");
      callScene("setAlarmBeacons", []);
    });
    at(token, 640, function () { if (alarm && d && typeof d.ackAlarm === "function") d.ackAlarm(alarm.id); });
    at(token, 760, function () {
      try {
        if (wo && d && typeof d.updateWorkOrder === "function") d.updateWorkOrder(wo.id, { status: "verify" });
        if (wo && d && typeof d.pushTimeline === "function") d.pushTimeline(wo.id, "现场处理完成，复核并归档（演示）");
      } catch (e) { console.warn("[xiaowei] resolve", e); }
    });
    at(token, 950, function () {
      callHud("setRackDetail", id);
      if (wo && wo.id) callHud("openWorkOrder", wo.id);
    });
    const text = id + " 进风温度已回落至 24.2 度，机柜状态恢复正常，告警已确认归档" +
      (wo && wo.id ? "，工单 " + wo.id + " 已推进到待核验" : "") +
      "。闭环小结：本次异常与进风通道/冷通道送风有关，现场处置完成后已复核归档（演示数据）。";
    at(token, 1150, function () { say(text); hudNextStep("下一步：继续巡检 →"); });
  }

  /* ⑧ 打开某排机柜 / 看冷通道 */
  function planRow(token, row) {
    const d = useData();
    const r = String(row || "B").toUpperCase();
    const racks = (d && typeof d.racksOfRow === "function") ? d.racksOfRow(r) : [];

    navTo("monitor");
    at(token, 0, function () {
      callScene("setView", "aisle", { row: r });
      callScene("setMode", "status");
      callScene("setAlarmBeacons", []);
    });
    if (racks[0]) at(token, 300, function () { callScene("assistantTo", racks[0].id, { duration: 1.0 }); });
    racks.forEach(function (rack, i) {
      at(token, 480 + i * 140, function () { callScene("openRack", rack.id, true); });
      at(token, 2600 + i * 140, function () { callScene("openRack", rack.id, false); });
    });
    const alarmCount = racks.filter(function (x) { return x.status === "alarm"; }).length;
    const text = "已切换到 " + r + " 排冷通道视角。" + r + " 排共 " + racks.length + " 个机柜，正常运行 " +
      (racks.length - alarmCount) + " 个" + (alarmCount ? "，告警 " + alarmCount + " 个" : "，无告警") +
      "。送风与机柜正面已展开，可以继续巡检具体机柜。";
    at(token, 900, function () { say(text); hudNextStep("下一步：巡检 A-02 →"); });
  }

  /* ================================================================
   *  动环（动力环境）指令 —— 数值全部实时读 IDC.dh，未就绪统一降级
   * ================================================================ */
  const DH_LEVEL_CN = { critical: "严重", warning: "一般", info: "提示" };

  function dhApi() {
    try {
      const d = IDC.dh;
      if (!d || typeof d.pick !== "function" || typeof d.byType !== "function") return null;
      if (d.mode === "init" || !d.frames) return null;          // 尚未完成首轮采集
      return d;
    } catch (e) { return null; }
  }
  function dhNotReady(token) {
    finishWithSay(token, "动环数据正在接入，请稍候。", "下一步：查看动环报警 →");
  }
  function dhVal(d, devId, key) {
    try {
      const p = d.getPoint && d.getPoint(devId + "." + key);
      if (!p) return null;
      const n = Number(d.value ? d.value(p.id) : null);
      return isFinite(n) ? n : null;
    } catch (e) { return null; }
  }
  function dhAvg(list) {
    const arr = (list || []).map(function (x) { return Number(x && x.value); }).filter(function (v) { return isFinite(v); });
    return arr.length ? arr.reduce(function (s, v) { return s + v; }, 0) / arr.length : null;
  }
  function dhMax(list) {
    let best = null;
    (list || []).forEach(function (x) {
      const v = Number(x && x.value);
      if (isFinite(v) && (!best || v > Number(best.value))) best = x;
    });
    return best;
  }
  function dhSyncSensors(d) {
    try {
      const list = d.activeAlarms ? d.activeAlarms() : [];
      callScene("setSensorAlarms", list.map(function (a) { return { devId: a.devId, level: a.level }; }));
    } catch (e) { /* ignore */ }
  }
  function dhEnterPage() {
    try {
      if (app && typeof app.goto === "function") app.goto("donghuan");
      else callHud("setPage", "donghuan");
    } catch (e) { console.warn("[xiaowei] donghuan page", e); }
  }
  function dhFindDevice(d, txt) {
    const norm = function (s) { return String(s == null ? "" : s).toUpperCase().replace(/[\s\-_]/g, ""); };
    const tt = norm(txt);
    let found = null;
    ((d && d.devices) || []).forEach(function (dv) { if (!found && tt.indexOf(norm(dv.id)) >= 0) found = dv; });
    return found;
  }
  function dhAlarmsFor(d, devs) {
    const ids = (devs || []).map(function (x) { return x.id; });
    return (d.activeAlarms ? d.activeAlarms() : []).filter(function (a) { return ids.indexOf(a.devId) >= 0; });
  }
  function dhNotifyLevel(list) {
    return (list || []).some(function (a) { return a.level === "critical"; }) ? "critical" : "warning";
  }
  /** 让 HUD 动环页切到对应分区：优先公开 API，其次 dh:select + 页签点选兜底 */
  function dhPageTab(d, devId, type) {
    const map = { ups: "ups", battery: "ups", ac: "th", th: "th", water: "water", smoke: "smoke", mdb: "mdb" };
    let key = type;
    if (!key && devId && d && d.getDevice) { const dv = d.getDevice(devId); key = dv && dv.type; }
    key = map[key] || null;
    try { emit("dh:select", { devId: devId || null, tab: key || null }); } catch (e) { /* ignore */ }
    if (!key) return;
    try {
      const h = useHud();
      if (h && typeof h.setDhTab === "function") { h.setDhTab(key); return; }
    } catch (e) { /* ignore */ }
    try {
      const doc = global.document;
      const btn = doc && doc.querySelector ? doc.querySelector('[data-dhtab="' + key + '"]') : null;
      if (btn && typeof btn.click === "function") btn.click();
    } catch (e) { /* ignore */ }
  }

  /* ⑩ UPS 状态 */
  function planDhUps(token, devId) {
    const d = dhApi(); if (!d) return dhNotReady(token);
    const ups = (devId && d.getDevice && d.getDevice(devId)) || (d.byType("ups") || [])[0];
    if (!ups) return finishWithSay(token, "未找到 UPS 设备，请稍后再试。", "下一步：查看动环报警 →");
    ctx.lastDhDev = ups.id;
    dhEnterPage();
    at(token, 0, function () {
      callHud("setPage", "donghuan");
      callScene("setView", "roomOrbit");
      callScene("setMode", "status");
      dhPageTab(d, ups.id, "ups");
    });
    at(token, 300, function () { callScene("focusDevice", ups.id, { duration: 1.2 }); });
    const ua = dhVal(d, ups.id, "UAA"), ub = dhVal(d, ups.id, "UAB"), uc = dhVal(d, ups.id, "UAC");
    const load = dhVal(d, ups.id, "load"), batV = dhVal(d, ups.id, "batV"), batMin = dhVal(d, ups.id, "batMin");
    const bypass = dhVal(d, ups.id, "bypass");
    const alarms = (d.alarmsOf ? d.alarmsOf(ups.id) : []).filter(function (a) { return a.state === "active" || a.state === "acked"; });
    let text = ups.name + "：三相输入 " + fmt(ua, 0) + "/" + fmt(ub, 0) + "/" + fmt(uc, 0) + " 伏，负载 " +
      fmt(load, 0) + "%，电池 " + fmt(batV, 0) + " 伏，后备 " + fmt(batMin, 0) + " 分钟，";
    if (bypass === 1) text += "当前为旁路供电。";
    if (alarms.length) text += "当前 " + alarms.length + " 条告警：" + alarms.slice(0, 3).map(function (a) { return a.text; }).join("；") + "。";
    else text += "无告警。";
    at(token, 900, function () { say(text); hudNextStep("下一步：查看动环报警 →"); });
  }

  /* ⑪ 浸水 */
  function planDhWater(token) {
    const d = dhApi(); if (!d) return dhNotReady(token);
    const devs = d.byType("water") || [];
    const chans = [], ropes = [];
    devs.forEach(function (dv) {
      (d.pointsOf ? d.pointsOf(dv.id) : []).forEach(function (p) {
        const v = d.value ? d.value(p.id) : null;
        if (/^ch\d+$/.test(p.key)) chans.push({ dev: dv, point: p, value: v });
        else if (p.key === "ropeBreak") ropes.push({ dev: dv, value: v });
      });
    });
    const alarms = dhAlarmsFor(d, devs);
    const badCh = chans.filter(function (x) { return x.value != null && Number(x.value) !== 0; });
    const badRope = ropes.filter(function (x) { return x.value != null && Number(x.value) !== 0; });
    const badIds = [];
    alarms.forEach(function (a) { if (badIds.indexOf(a.devId) < 0) badIds.push(a.devId); });
    badCh.forEach(function (x) { if (badIds.indexOf(x.dev.id) < 0) badIds.push(x.dev.id); });
    badRope.forEach(function (x) { if (badIds.indexOf(x.dev.id) < 0) badIds.push(x.dev.id); });

    dhEnterPage();
    at(token, 0, function () { callHud("setPage", "donghuan"); callScene("setView", "roomOrbit"); dhPageTab(d, badIds[0] || null, "water"); dhSyncSensors(d); });
    at(token, 260, function () { if (badIds.length) { callScene("focusDevice", badIds[0], { duration: 1.2 }); dhPageTab(d, badIds[0], "water"); } });
    let text;
    if (badIds.length) {
      const names = badIds.slice(0, 3).map(function (id) { const dv = d.getDevice && d.getDevice(id); return dv ? dv.name : id; }).join("、");
      text = "注意，浸水检测发现 " + badIds.length + " 处报警：" + names + "，请立即安排现场核查并关闭附近水源。";
    } else {
      text = "浸水检测设备 " + devs.length + " 台，共 " + chans.length + " 路通道，全部正常，无浸水报警。";
    }
    at(token, 900, function () { say(text); hudNextStep(badIds.length ? "下一步：现场处理完成 →" : "下一步：查看动环报警 →"); });
  }

  /* ⑫ 烟感 */
  function planDhSmoke(token) {
    const d = dhApi(); if (!d) return dhNotReady(token);
    const devs = d.byType("smoke") || [];
    const states = d.pick("smoke", "state") || [];
    const pol = d.pick("smoke", "pollution") || [];
    const bad = states.filter(function (x) { return x.value != null && Number(x.value) !== 0; });
    const maxP = dhMax(pol);
    dhEnterPage();
    at(token, 0, function () { callHud("setPage", "donghuan"); callScene("setView", "roomOrbit"); dhPageTab(d, bad.length ? bad[0].devId : null, "smoke"); dhSyncSensors(d); });
    if (bad.length) at(token, 260, function () { callScene("focusDevice", bad[0].devId, { duration: 1.2 }); });
    let text = "烟感探测器共 " + devs.length + " 个点位，" +
      (bad.length
        ? "报警 " + bad.length + " 个：" + bad.slice(0, 3).map(function (x) { return x.dev ? x.dev.name : x.devId; }).join("、") + "。"
        : "全部正常。") +
      (maxP ? "最高污染度 " + fmt(maxP.value, 2) + "%（" + (maxP.dev ? maxP.dev.name : maxP.devId) + "）。" : "");
    at(token, 900, function () { say(text); hudNextStep(bad.length ? "下一步：现场处理完成 →" : "下一步：查看动环报警 →"); });
  }

  /* ⑬ 温湿度 */
  function planDhTh(token) {
    const d = dhApi(); if (!d) return dhNotReady(token);
    const temps = d.pick("th", "temp") || [];
    const hums = d.pick("th", "hum") || [];
    const avgT = temps.avg != null ? temps.avg : dhAvg(temps);
    const avgH = hums.avg != null ? hums.avg : dhAvg(hums);
    const hot = dhMax(temps);
    const over = temps.filter(function (x) { return Number(x.value) > 27; });
    dhEnterPage();
    at(token, 0, function () { callHud("setPage", "donghuan"); callScene("setView", "roomOrbit"); dhPageTab(d, hot && hot.devId, "th"); });
    if (hot && hot.devId) at(token, 260, function () { callScene("focusDevice", hot.devId, { duration: 1.1 }); });
    const text = "全机房平均温度 " + fmt(avgT, 1) + " 度，平均湿度 " + fmt(avgH, 1) + "%。最高温区域：" +
      (hot ? (hot.dev ? hot.dev.name : hot.devId) + " " + fmt(hot.value, 1) + " 度" : "暂无数据") +
      (over.length ? "，其中 " + over.length + " 个点位超过 27 度阈值，建议检查对应区域送风。" : "，全部在阈值内。");
    at(token, 900, function () { say(text); hudNextStep("下一步：查看动环报警 →"); });
  }

  /* ⑭ 电流电压 / 供配电 */
  function planDhPower(token) {
    const d = dhApi(); if (!d) return dhNotReady(token);
    const mdbs = d.byType("mdb") || [];
    const m = mdbs[0];
    dhEnterPage();
    at(token, 0, function () { callHud("setPage", "donghuan"); callScene("setView", "roomOrbit"); callScene("setMode", "status"); dhPageTab(d, m ? m.id : null, "mdb"); });
    if (m) at(token, 260, function () { callScene("focusDevice", m.id, { duration: 1.2 }); });
    let text;
    if (m) {
      const ua = dhVal(d, m.id, "UPA"), ub = dhVal(d, m.id, "UPB"), uc = dhVal(d, m.id, "UPC");
      const ia = dhVal(d, m.id, "IA"), ib = dhVal(d, m.id, "IB"), ic = dhVal(d, m.id, "IC");
      const pw = dhVal(d, m.id, "P"), pf = dhVal(d, m.id, "PF"), brk = dhVal(d, m.id, "brk");
      text = m.name + "：三相电压 " + fmt(ua, 1) + "/" + fmt(ub, 1) + "/" + fmt(uc, 1) + " 伏，三相电流 " +
        fmt(ia, 1) + "/" + fmt(ib, 1) + "/" + fmt(ic, 1) + " 安，有功功率 " + fmt(pw, 2) + " 千瓦，功率因数 " + fmt(pf, 3) +
        (brk != null ? "，断路器" + (Number(brk) === 0 ? "合闸" : "分闸") : "") + "。";
    } else {
      const ups = (d.byType("ups") || [])[0];
      text = ups
        ? "配电回路暂无数据，改报 UPS 侧：负载 " + fmt(dhVal(d, ups.id, "load"), 0) + "%，输出功率 " + fmt(dhVal(d, ups.id, "pOut"), 1) + " 千瓦。"
        : "暂未取到配电数据，请稍后再试。";
    }
    at(token, 900, function () { say(text); hudNextStep("下一步：查看动环报警 →"); });
  }

  /* ⑮ 动环报警 */
  function planDhAlarms(token) {
    const d = dhApi(); if (!d) return dhNotReady(token);
    const rank = { critical: 0, warning: 1, info: 2 };
    const list = (d.activeAlarms ? d.activeAlarms() : []).slice().sort(function (a, b) {
      return (rank[a.level] == null ? 9 : rank[a.level]) - (rank[b.level] == null ? 9 : rank[b.level]);
    });
    dhEnterPage();
    at(token, 0, function () { callHud("setPage", "donghuan"); callScene("setView", "roomOrbit"); dhSyncSensors(d); });
    if (list.length) at(token, 260, function () { callScene("focusDevice", list[0].devId, { duration: 1.2 }); });
    let text;
    if (!list.length) {
      const online = d.devices.filter(function (x) { return x.online !== false; }).length;
      text = "动环系统当前没有活动报警。设备 " + d.devices.length + " 台，在线 " + online + " 台，采集周期 " +
        Math.round((d.poll || 2000) / 1000) + " 秒。";
    } else {
      const crit = list.filter(function (a) { return a.level === "critical"; }).length;
      const warn = list.filter(function (a) { return a.level === "warning"; }).length;
      const lines = list.slice(0, 5).map(function (a, i) {
        return "第" + (i + 1) + "条，" + (DH_LEVEL_CN[a.level] || a.level) + "，" + a.devName + " " + a.text + "。";
      }).join("");
      text = "动环系统当前共 " + list.length + " 条活动报警，严重 " + crit + " 条、一般 " + warn + " 条。" + lines + "已定位到 " + list[0].devName + "。";
    }
    at(token, 900, function () { say(text); hudNextStep("下一步：生成工单 →"); });
  }

  /* ⑯ 触发演示报警 */
  function planDhTrigger(token, rawText) {
    const d = dhApi(); if (!d) return dhNotReady(token);
    const t = normalizeText(rawText).toUpperCase();
    let kind = /浸水|漏水|水浸|渗水/.test(t) ? "water"
      : (/烟感|烟雾|烟火|感烟/.test(t) ? "smoke"
        : (/(UPS|过压)/.test(t) ? "overvoltage" : (Math.random() < 0.5 ? "water" : "smoke")));
    let dev = dhFindDevice(d, t);
    if (!dev) {
      const pool = d.byType(kind === "overvoltage" ? "ups" : kind) || [];
      if (!pool.length) return finishWithSay(token, "动环系统没有可用的演示设备。", "下一步：查看动环报警 →");
      dev = pool[Math.floor(Math.random() * pool.length)];
    }
    try { if (d.trigger) d.trigger(dev.id, kind); } catch (e) { console.warn("[xiaowei] dh.trigger", e); }
    ctx.lastDhDev = dev.id;
    dhEnterPage();
    at(token, 0, function () { callHud("setPage", "donghuan"); callScene("setView", "roomOrbit"); dhPageTab(d, dev.id, kind === "overvoltage" ? "ups" : kind); });
    at(token, 260, function () { callScene("focusDevice", dev.id, { duration: 1.2 }); dhPageTab(d, dev.id, kind === "overvoltage" ? "ups" : kind); dhSyncSensors(d); });
    at(token, 560, function () { dhSyncSensors(d); });
    const label = kind === "water" ? "浸水" : kind === "smoke" ? "烟感" : "UPS 过压";
    const n = d.activeAlarms ? d.activeAlarms().length : 0;
    const text = "已模拟 " + dev.name + " " + label + "报警，当前活动报警 " + n + " 条。请按动环预案处置，处理完成后可以说『恢复这些报警』（演示数据）。";
    at(token, 900, function () { say(text); hudNextStep("下一步：恢复这些报警 →"); });
  }

  /* ⑰ 恢复 / 清除演示报警 */
  function planDhRecover(token) {
    const d = dhApi(); if (!d) return dhNotReady(token);
    const list = (d.activeAlarms ? d.activeAlarms() : []).slice();
    const devIds = [];
    let n = 0;
    list.forEach(function (a) {
      try {
        if (a.devId && d.getDevice && d.getDevice(a.devId) && d.trigger) d.trigger(a.devId, "recover");
        if (a.pointId && d.clear) d.clear(a.pointId);
        if (a.devId && devIds.indexOf(a.devId) < 0) devIds.push(a.devId);
        n++;
      } catch (e) { console.warn("[xiaowei] dh.recover", e); }
    });
    dhEnterPage();
    at(token, 0, function () { callHud("setPage", "donghuan"); callScene("setView", "roomOrbit"); });
    at(token, 260, function () { if (devIds[0]) callScene("focusDevice", devIds[0], { duration: 1.0 }); dhSyncSensors(d); });
    at(token, 560, function () { dhSyncSensors(d); });
    const left = d.activeAlarms ? d.activeAlarms().length : 0;
    const text = n
      ? "已恢复并清除 " + n + " 条演示报警，当前活动报警 " + left + " 条。"
      : "当前没有需要恢复的演示报警，动环系统运行正常。";
    at(token, 900, function () { say(text); hudNextStep("下一步：查看动环报警 →"); });
  }
  /* ================================================================
   *  机房图纸（平面图 / 图元）指令 —— IDC.plan 未就绪时统一降级
   * ================================================================ */
  function planApi() {
    try {
      const p = IDC.plan;
      if (!p || typeof p !== "object") return null;
      if (typeof p.zoomToRef !== "function" && typeof p.addSymbol !== "function" &&
          typeof p.show !== "function" && typeof p.extended !== "function") return null;
      return p;
    } catch (e) { return null; }
  }
  function planNotReady(token) {
    finishWithSay(token, "图纸模块正在加载，请稍候。", "下一步：打开机房图纸 →");
  }
  function callPlan(name) {
    const args = Array.prototype.slice.call(arguments, 1);
    try {
      const p = planApi();
      const f = p && p[name];
      if (typeof f === "function") return f.apply(p, args);
    } catch (e) { console.warn("[xiaowei] plan." + name, e); }
    return undefined;
  }
  function planEnsureMounted() {
    try {
      const p = planApi();
      if (!p || typeof p.mount !== "function") return;
      const root = global.document && global.document.getElementById("plan-root");
      if (root && !root.firstChild) p.mount(root);      // app.js 未挂载时兜底，幂等
    } catch (e) { console.warn("[xiaowei] plan.mount", e); }
  }
  function planEnter() {
    try {
      planEnsureMounted();
      if (app && typeof app.goto === "function") app.goto("plan");
      else callHud("setPage", "plan");
    } catch (e) { console.warn("[xiaowei] plan page", e); }
  }
  function planStat(p) {
    const out = { items: null, bound: null, extras: null };
    try {
      const m = p.model || (typeof p.toJSON === "function" ? p.toJSON() : null);
      const list = (m && m.items) ? m.items : [];
      if (list.length) {
        out.items = list.length;
        out.bound = list.filter(function (it) { return it && it.bind && it.bind.ref; }).length;
      }
    } catch (e) { /* ignore */ }
    try {
      const ex = (typeof p.extended === "function") ? p.extended() : null;
      if (ex && typeof ex.length === "number") out.extras = ex.length;
    } catch (e) { /* ignore */ }
    return out;
  }
  function planFindDhDevice(d, txt) {
    const norm = function (s) { return String(s == null ? "" : s).toUpperCase().replace(/[\s\-_]/g, ""); };
    const tt = norm(txt);
    let found = null;
    ((d && d.devices) || []).forEach(function (dv) { if (!found && tt.indexOf(norm(dv.id)) >= 0) found = dv; });
    if (found) return found;
    const types = [
      [/浸水|漏水|水浸|渗水/, "water"], [/烟感|烟雾|烟火|感烟/, "smoke"],
      [/UPS|不间断/i, "ups"], [/温湿度|温度|湿度/, "th"], [/配电|列头柜|低压柜/, "mdb"]
    ];
    for (let i = 0; i < types.length; i++) {
      if (types[i][0].test(txt)) { const list = d.byType ? d.byType(types[i][1]) : null; if (list && list.length) return list[0]; }
    }
    return null;
  }
  function planGuessDhId(text) {
    const t = normalizeText(text).toUpperCase();
    const m = t.match(/(UPS|SM|WD|TH|MDB|BAT|ATS|AC)\s*-?\s*([A-Z]?\s*[0-9]{1,2})(?![0-9])/);
    if (!m) return null;
    const pre = m[1], num = m[2].replace(/\s+/g, "");
    if (/^[A-Z][0-9]+$/.test(num)) return pre + "-" + num;                 // TH-A01 / WD-A1
    const sg = pre === "MDB" ? 1 : 2;
    return pre + "-" + String(parseInt(num.replace(/\D/g, ""), 10)).padStart(sg, "0");
  }
  function planTarget(text) {
    const t = normalizeText(text);
    const rackId = parseRack(t);
    if (rackId) return { type: "rack", ref: rackId, label: rackId };
    const d = dhApi();
    if (d) {
      const dev = planFindDhDevice(d, t);
      if (dev) return { type: "dh", ref: dev.id, label: dev.name || dev.id };
    }
    const id = planGuessDhId(t);
    if (id) return { type: "dh", ref: id, label: id };
    if (d) {
      const map = [[/浸水|漏水|水浸|渗水/, "water"], [/烟感|烟雾|烟火|感烟/, "smoke"],
        [/UPS|不间断/i, "ups"], [/温湿度|温度|湿度/, "th"], [/配电|列头柜|低压柜/, "mdb"]];
      for (let i = 0; i < map.length; i++) {
        if (map[i][0].test(t)) { const list = d.byType(map[i][1]); if (list && list.length) return { type: "dh", ref: list[0].id, label: list[0].name || list[0].id }; }
      }
    }
    return null;
  }
  function planSymOf(text) {
    const t = normalizeText(text);
    if (/烟感|烟雾|烟火|感烟/.test(t)) return { sym: "smoke", name: "烟感探测器", type: "dh" };
    if (/灭火器|消防|气灭|喷淋/.test(t)) return { sym: "ext", name: "灭火器", type: "extra" };
    if (/UPS|不间断/i.test(t)) return { sym: "ups", name: "UPS 柜", type: "dh" };
    if (/机柜|机架|服务器柜/.test(t)) return { sym: "rack.42u", name: "42U 服务器机柜", type: "rack" };
    return { sym: "rack.42u", name: "42U 服务器机柜", type: "rack" };
  }

  /* ⑱ 打开机房图纸 */
  function planPlanOpen(token) {
    const p = planApi(); if (!p) return planNotReady(token);
    planEnter();
    at(token, 0, function () { callHud("setPage", "plan"); callPlan("show"); });
    const st = planStat(p);
    const text = st.items != null
      ? "已打开机房平面图。图纸当前 " + st.items + " 个图元，其中 " + st.bound + " 个已绑定机柜/动环设备" +
        (st.extras != null ? "，" + st.extras + " 个为新增扩展图元" : "") + "。可直接拖动编辑，说『把图纸同步到三维』即可扩展到三维机房。"
      : "已打开机房平面图，可拖动编辑图元，说『把图纸同步到三维』即可扩展到三维机房。";
    at(token, 800, function () { say(text); hudNextStep("下一步：把图纸同步到三维 →"); });
  }

  /* ⑲ 图纸定位 */
  function planPlanLocate(token, rawText) {
    const p = planApi(); if (!p) return planNotReady(token);
    const target = planTarget(rawText);
    planEnter();
    at(token, 0, function () { callHud("setPage", "plan"); callPlan("show"); });
    if (!target) {
      at(token, 700, function () {
        say("没找到要定位的对象，可以说『在图纸上定位 A-02』或『图纸上找 UPS-01』。");
        hudNextStep("下一步：打开机房图纸 →");
      });
      return;
    }
    at(token, 500, function () {
      callPlan("zoomToRef", target.type, target.ref);
      callPlan("selectByRef", target.type, target.ref);
      emit("plan:select", { type: target.type, ref: target.ref });
    });
    at(token, 900, function () {
      say("已在图纸上定位 " + target.label + "，视图已对准该" + (target.type === "rack" ? "机柜" : "设备") + "。");
      hudNextStep("下一步：图纸上有哪些告警 →");
    });
  }

  /* ⑳ 图纸新增图元 */
  function planPlanAdd(token, rawText) {
    const p = planApi(); if (!p) return planNotReady(token);
    const sym = planSymOf(rawText);
    planEnter();
    at(token, 0, function () { callHud("setPage", "plan"); callPlan("show"); });
    let item = null;
    at(token, 500, function () {
      const r = callPlan("addSymbol", sym.sym);          // 不传坐标：由图纸找空位
      if (r && typeof r === "object") item = r;
      else if (typeof r === "string") {
        try {
          const m = p.model || (typeof p.toJSON === "function" ? p.toJSON() : null);
          if (m && m.items) item = m.items.find(function (x) { return x.id === r; }) || null;
        } catch (e) { /* ignore */ }
      }
    });
    at(token, 900, function () {
      const name = (item && item.name) || sym.name;
      const pos = (item && item.x != null && item.y != null)
        ? "，位置约 (" + Math.round(item.x) + ", " + Math.round(item.y) + ") mm" : "";
      say("已在图纸空位新增一个 " + name + pos + "，可直接拖动调整位置；说『把图纸同步到三维』即可在三维机房中看到它。");
      hudNextStep("下一步：把图纸同步到三维 →");
    });
  }

  /* ㉑ 图纸同步三维 */
  function planPlanApply(token) {
    const p = planApi(); if (!p) return planNotReady(token);
    planEnter();
    at(token, 0, function () { callHud("setPage", "plan"); callPlan("show"); });
    let st = planStat(p);
    let r = null;
    at(token, 500, function () { st = planStat(p); r = callPlan("applyExtras"); });
    at(token, 900, function () {
      const n = (r && typeof r === "object" && r.count != null) ? r.count
        : (typeof r === "number" ? r : (r && r.length != null ? r.length : st.extras));
      const text = (n && n > 0)
        ? "已把图纸同步到三维机房，共 " + n + " 个新增/修改图元生成为三维物件，可在三维场景中查看。"
        : "图纸当前没有新增图元，三维机房与图纸保持一致。";
      say(text);
      hudNextStep("下一步：图纸上有哪些告警 →");
    });
  }

  /* ㉒ 图纸告警 */
  function planPlanAlarms(token) {
    const p = planApi(); if (!p) return planNotReady(token);
    planEnter();
    at(token, 0, function () { callHud("setPage", "plan"); callPlan("show"); });
    const rank = { critical: 0, warning: 1, info: 2 };
    const list = [];
    const d = dhApi();
    if (d && d.activeAlarms) {
      d.activeAlarms().forEach(function (a) {
        list.push({ level: a.level, label: (a.devName || a.devId) + " " + (a.text || ""), ref: a.devId, type: "dh" });
      });
    }
    const data2 = useData();
    if (data2 && data2.alarms) {
      data2.alarms.forEach(function (a) {
        if (!a.acked) list.push({ level: a.level, label: (a.rackId || "") + " " + (a.title || ""), ref: a.rackId, type: "rack" });
      });
    }
    list.sort(function (a, b) { return (rank[a.level] == null ? 9 : rank[a.level]) - (rank[b.level] == null ? 9 : rank[b.level]); });
    at(token, 500, function () {
      if (list.length && list[0].ref) { callPlan("zoomToRef", list[0].type, list[0].ref); callPlan("selectByRef", list[0].type, list[0].ref); }
    });
    let text;
    if (!list.length) {
      text = "图纸上当前没有告警，绑定的机柜与动环设备均正常。";
    } else {
      const crit = list.filter(function (x) { return x.level === "critical"; }).length;
      const warn = list.filter(function (x) { return x.level === "warning"; }).length;
      text = "图纸上共有 " + list.length + " 条告警，严重 " + crit + " 条、一般 " + warn + " 条。" +
        list.slice(0, 5).map(function (x, i) { return "第" + (i + 1) + "条，" + (DH_LEVEL_CN[x.level] || x.level) + "，" + x.label + "。"; }).join("") +
        "已在图纸上定位首条告警。";
    }
    at(token, 900, function () { say(text); hudNextStep("下一步：生成工单 →"); });
  }
  /* ⑨ 未识别 */
  function planUnknown(token) {
    finishWithSay(token, FALLBACK_REPLY, "试一试：巡检 A-02 →");
  }

  /* -------------------------------------------------------------- 主入口 */
  function ask(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return null;
    const token = ++seqToken;
    clearSeqTimers();
    try { if (global.speechSynthesis && typeof global.speechSynthesis.cancel === "function") global.speechSynthesis.cancel(); } catch (e) { /* ignore */ }

    ctx.lastText = raw;
    let intent;
    try { intent = parseIntent(raw); } catch (e) { intent = { name: "unknown", rackId: null, row: null }; }
    ctx.lastIntent = intent.name;

    chatAdd("user", raw);
    emit("voice:cmd", { text: raw, intent: intent.name, rackId: intent.rackId || null, row: intent.row || null, devId: intent.devId || null });
    notifyState(intent);

    try {
      switch (intent.name) {
        case "inspect": planInspect(token, intent.rackId || ctx.lastRackId); break;
        case "alarms": planAlarms(token); break;
        case "power": planPower(token, intent.rackId); break;
        case "overview": planOverview(token); break;
        case "analyze": planAnalyze(token); break;
        case "workorder": planWorkOrder(token, intent.rackId); break;
        case "resolve": planResolve(token, intent.rackId); break;
        case "row": planRow(token, intent.row); break;
        case "dh.ups": planDhUps(token, intent.devId); break;
        case "dh.water": planDhWater(token); break;
        case "dh.smoke": planDhSmoke(token); break;
        case "dh.th": planDhTh(token); break;
        case "dh.power": planDhPower(token); break;
        case "dh.alarms": planDhAlarms(token); break;
        case "dh.trigger": planDhTrigger(token, raw); break;
        case "dh.recover": planDhRecover(token); break;
        case "plan.open": planPlanOpen(token); break;
        case "plan.locate": planPlanLocate(token, raw); break;
        case "plan.add": planPlanAdd(token, raw); break;
        case "plan.apply": planPlanApply(token); break;
        case "plan.alarms": planPlanAlarms(token); break;
        default: planUnknown(token); break;
      }
    } catch (e) {
      console.warn("[xiaowei] ask", e);
      finishWithSay(token, FALLBACK_REPLY, null);
    }
    return intent.name;
  }

  /* ---------------------------------------------------------- 一键演示脚本 */
  function demo() {
    clearDemoTimers();
    const script = [
      { t: 400, text: "巡检 A-02" },
      { t: 6500, text: "当前有哪些告警" },
      { t: 13000, text: "检查电力数据" },
      { t: 19500, text: "怎么处理" },
      { t: 26000, text: "生成工单" },
      { t: 33000, text: "现场处理完成，复核并归档" }
    ];
    script.forEach(function (step) {
      const id = setTimeout(function () {
        demoTimers.delete(id);
        try { ask(step.text); } catch (e) { console.warn("[xiaowei] demo", e); }
      }, step.t);
      demoTimers.add(id);
    });
    toast("小维演示开始：巡检 → 告警 → 电力 → 处置 → 工单 → 闭环（本地规则演示）", "ok");
    return true;
  }

  /* ------------------------------------------------------------------ init */
  function init(opts) {
    opts = opts || {};
    data = opts.data || IDC.data || null;
    scene = opts.scene || IDC.scene || null;
    hud = opts.hud || IDC.hud || null;
    app = opts.app || IDC.app || null;
    bus = IDC.bus || (data && data.bus) || null;
    if (!ctx.lastRackId) ctx.lastRackId = "A-02";
    try {
      if (bus && typeof bus.on === "function") {
        bus.on("rack:select", function (id) { if (id) ctx.lastRackId = id; });
      }
    } catch (e) { /* ignore */ }
    return api;
  }

  /* ------------------------------------------------------------------ API */
  const api = {
    init: init,
    listen: listen,
    stop: stop,
    ask: ask,
    say: say,
    demo: demo,
    speakEnabled: true,      // 语音播报开关（默认开）
    wakeWordEnabled: false,  // 语音唤醒开关（默认关）
    onState: null,
    parseIntent: parseIntent,
    get listening() { return listening; },
    get lastRackId() { return ctx.lastRackId; }
  };

  global.IDC.xiaowei = IDC.xiaowei = api;   // window.IDC.xiaowei = api
})(window);