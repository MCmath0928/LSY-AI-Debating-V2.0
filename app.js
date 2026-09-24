/* =========================================================
 * app.js —— 辩论流程控制、DeepSeek API 调用（流式）、界面交互
 * ========================================================= */
(function () {
  "use strict";

  const CFG = window.DEBATE_CONFIG;
  const P = window.DEBATE_PROMPTS;

  /* ---------------- 工具 ---------------- */
  const $ = (id) => document.getElementById(id);
  const len = (s) => [...String(s)].length; // 按码点计字数（中文/emoji 正确）

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /* ---------------- 全局状态 ---------------- */
  const state = {
    settings: null,          // { apiKey, topic, side, effort }
    format: null,            // 当前赛制（环节数组，含每环节最大字数）
    adv: null,               // 高级设置（质询/自由辩论流程参数）
    humanSide: "正方",
    aiSide: "反方",
    strategy: "",            // AI 方宏观战略（正文）
    transcript: [],          // { label, side, text, by }
    stageIndex: 0,
    cx: null,                // 质询子状态
    free: null,              // 自由辩论子状态
    judgeQ: null,            // 评委提问子状态
    showThinking: false,     // 是否显示 AI 思考过程（调试）
    busy: false,
    pendingHuman: null,      // { max, label, onDone, endable }
    pendingRetry: null,      // 失败后重试回调
  };

  let draftFormat = null; // 高级设置页中正在编辑的赛制草稿

  const el = {
    screens: {
      setup: $("screen-setup"),
      strategy: $("screen-strategy"),
      debate: $("screen-debate"),
      judge: $("screen-judge"),
      settings: $("screen-settings"),
    },
    setup: {
      apiKey: $("apiKey"), topic: $("topic"), effort: $("effort"),
      start: $("btnStart"), settingsBtn: $("btnOpenSettings"), error: $("setupError"),
    },
    settings: {
      format: $("formatEditor"), addStage: $("btnAddStage"),
      crossRounds: $("setCrossRounds"),
      freeBudget: $("setFreeBudget"), freeTurns: $("setFreeTurns"),
      save: $("btnSettingsSave"), reset: $("btnSettingsReset"), back: $("btnSettingsBack"),
      error: $("settingsError"),
    },
    strategy: {
      status: $("strategyStatus"), details: $("strategyDetails"), body: $("strategyBody"),
      viewBtn: $("btnViewStrategy"), enterBtn: $("btnEnterDebate"), retryBtn: $("btnRetryStrategy"),
      thinking: $("strategyThinking"), thinkingBody: $("strategyThinkingBody"),
    },
    debate: {
      topic: $("debateTopic"), side: $("debateSide"),
      stageProgress: $("stageProgress"), stageName: $("stageName"), stageLimit: $("stageLimit"),
      stageLine: $("stageLine"), stageList: $("stageListPanel"),
      transcript: $("transcript"), status: $("status"),
      inputArea: $("inputArea"), inputLabel: $("inputLabel"), input: $("input"),
      inputCounter: $("inputCounter"), submit: $("btnSubmit"), endStage: $("btnEndStage"),
      retry: $("btnRetryAI"), strategyPanel: $("strategyPanelDebate"), strategyBtn: $("btnViewStrategyDebate"),
      chkThinking: $("chkThinking"), restart: $("btnRestart"),
    },
    judge: {
      status: $("judgeStatus"), verdict: $("verdictBox"),
      thinking: $("verdictThinking"), thinkingBody: $("verdictThinkingBody"),
      exportBtn: $("btnExport"), again: $("btnAgain"),
    },
  };

  /* ---------------- 屏幕切换 ---------------- */
  function showScreen(name) {
    Object.values(el.screens).forEach((s) => s.classList.remove("active"));
    el.screens[name].classList.add("active");
    window.scrollTo(0, 0);
  }

  /* ---------------- 设置持久化 ---------------- */
  function loadSettings() {
    try {
      const raw = localStorage.getItem(CFG.STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return null;
  }
  function saveSettings(s) {
    try { localStorage.setItem(CFG.STORAGE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  /* ---------------- 赛制（自定义流程） ---------------- */
  function validKind(k) {
    return CFG.KINDS.some((x) => x.value === k);
  }
  function sanitizeStage(s, i) {
    const kind = validKind(s && s.kind) ? s.kind : "constructive";
    const defMin = kind === "judgeQuestion" ? 0 : (kind === "freeDebate" ? 4 : (kind === "crossExam" ? 1.5 : 3));
    const minutes = Number(s && s.minutes) > 0 ? Number(s.minutes) : defMin;
    const pick = (arr, v, dflt) => (arr.indexOf(v) >= 0 ? v : dflt);
    return {
      id: (s && s.id) ? String(s.id) : ("stage_" + i + "_" + Math.random().toString(36).slice(2, 8)),
      name: String((s && s.name) || "").trim() || ("环节" + (i + 1)),
      kind: kind,
      side: (s && s.side === "反方") ? "反方" : "正方",
      pos: pick(["一辩", "二辩", "三辩", "四辩"], s && s.pos, "一辩"),
      minutes: minutes,
      limit: (s && Number(s.limit) > 0) ? Math.round(Number(s.limit)) : CFG.defaultCharLimit({ kind: kind, minutes: minutes }),
      questioner: {
        side: (s && s.questioner && s.questioner.side === "正方") ? "正方" : "反方",
        pos: pick(["一辩", "二辩", "三辩", "四辩"], s && s.questioner && s.questioner.pos, "四辩"),
      },
      answerer: {
        side: (s && s.answerer && s.answerer.side === "正方") ? "正方" : "反方",
        pos: pick(["一辩", "二辩", "三辩", "四辩"], s && s.answerer && s.answerer.pos, "一辩"),
      },
    };
  }
  function sanitizeFormat(arr) { return arr.map((s, i) => sanitizeStage(s, i)); }
  function defaultFormat() { return CFG.STAGES.map((s, i) => sanitizeStage(s, i)); }
  function loadFormat() {
    try {
      const raw = localStorage.getItem(CFG.FORMAT_STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) return sanitizeFormat(arr);
      }
    } catch (e) { /* ignore */ }
    // 迁移：旧版本把"每环节字数"存在 ai-debate-advanced.stageLimits（数组，按序）
    const fmt = defaultFormat();
    try {
      const advRaw = localStorage.getItem(CFG.ADVANCED_STORAGE_KEY);
      if (advRaw) {
        const adv = JSON.parse(advRaw);
        if (Array.isArray(adv.stageLimits)) {
          fmt.forEach((st, i) => {
            const n = Number(adv.stageLimits[i]);
            if (n > 0) st.limit = Math.round(n);
          });
        }
      }
    } catch (e) { /* ignore */ }
    return fmt;
  }
  function saveFormat(f) {
    try { localStorage.setItem(CFG.FORMAT_STORAGE_KEY, JSON.stringify(f)); } catch (e) { /* ignore */ }
  }
  function deepCopyStage(s) {
    return { ...s, questioner: { ...(s.questioner || {}) }, answerer: { ...(s.answerer || {}) } };
  }
  function newStage() {
    return sanitizeStage({ kind: "constructive", side: "正方", pos: "一辩", minutes: 3 }, draftFormat.length);
  }

  /* ---------------- 高级设置（流程参数） ---------------- */
  function defaultAdvanced() {
    return {
      crossExamRounds: CFG.LIMITS.crossExamRounds,
      freeDebateBudget: CFG.LIMITS.freeDebateBudget,
      freeDebateMaxTurns: CFG.LIMITS.freeDebateMaxTurns,
    };
  }
  function loadAdvanced() {
    const d = defaultAdvanced();
    try {
      const raw = localStorage.getItem(CFG.ADVANCED_STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (Number(s.crossExamRounds) > 0) d.crossExamRounds = Math.round(Number(s.crossExamRounds));
        if (Number(s.freeDebateBudget) > 0) d.freeDebateBudget = Math.round(Number(s.freeDebateBudget));
        if (Number(s.freeDebateMaxTurns) > 0) d.freeDebateMaxTurns = Math.round(Number(s.freeDebateMaxTurns));
      }
    } catch (e) { /* ignore */ }
    return d;
  }
  function saveAdvanced(a) {
    try { localStorage.setItem(CFG.ADVANCED_STORAGE_KEY, JSON.stringify(a)); } catch (e) { /* ignore */ }
  }
  // 当前环节的最大字数（环节对象自带 limit）
  function stageLimit(stage) {
    if (stage && Number(stage.limit) > 0) return Number(stage.limit);
    return CFG.defaultCharLimit(stage);
  }

  /* ---------------- DeepSeek API ---------------- */
  function isV4Model(model) {
    return model === "deepseek-flash" || model.indexOf("deepseek-v4") === 0;
  }

  function buildBody(opts, stream) {
    // 分角色模型：宏观战略用 Pro，辩论/评委用 Flash；也可由调用方显式传入 model 覆盖
    const model = opts.model || CFG.MODELS.debate;
    const body = {
      model: model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      stream: stream,
      max_tokens: opts.maxTokens || 2000,
    };
    if (isV4Model(model)) {
      body.thinking = { type: "enabled" };
      body.reasoning_effort = opts.effort || CFG.DEFAULT_EFFORT;
    }
    return body;
  }

  function apiErrorMessage(status, body) {
    let detail = "";
    try {
      const j = JSON.parse(body);
      if (j && j.error && j.error.message) detail = j.error.message;
    } catch (e) {
      detail = String(body).slice(0, 200);
    }
    const map = {
      400: "请求参数错误", 401: "API Key 无效或未提供", 402: "余额不足",
      403: "无权限", 404: "接口或模型不存在", 429: "请求过于频繁或额度受限",
      500: "服务器错误", 502: "网关错误", 503: "服务不可用",
    };
    const base = map[status] || ("HTTP " + status);
    return detail ? base + "：" + detail : base;
  }

  // 流式调用，返回 { content, reasoning }。
  // reasoning_content 仅用于进度显示与调试，不写入辩论实录。
  async function callModel(opts) {
    const body = buildBody(opts, true);
    let resp;
    try {
      resp = await fetch(CFG.API_BASE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + state.settings.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error("网络错误，无法连接 API：" + e.message);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(apiErrorMessage(resp.status, text));
    }

    // 无流式 body 的降级（读取完整 JSON）
    if (!resp.body || !resp.body.getReader) {
      const json = await resp.json().catch(() => ({}));
      const msg = (json.choices && json.choices[0] && json.choices[0].message) || {};
      const content = msg.content || "";
      const reasoning = msg.reasoning_content || "";
      if (opts.onReasoning && reasoning) opts.onReasoning(reasoning);
      if (opts.onChunk && content) opts.onChunk(content);
      return { content: content, reasoning: reasoning };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || line.indexOf("data:") !== 0) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices && json.choices[0] && json.choices[0].delta;
          if (!delta) continue;
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            if (opts.onReasoning) opts.onReasoning(delta.reasoning_content);
          }
          if (delta.content) {
            content += delta.content;
            if (opts.onChunk) opts.onChunk(delta.content);
          }
        } catch (e) { /* 忽略半包 */ }
      }
    }
    return { content: content, reasoning: reasoning };
  }

  /* ---------------- 界面：气泡 ---------------- */
  function addBubble(label, text, cls, live) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + cls;
    const head = document.createElement("div");
    head.className = "msg-head";
    head.textContent = label;
    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = text;
    if (live) body.classList.add("streaming");
    wrap.appendChild(head);
    wrap.appendChild(body);
    el.debate.transcript.appendChild(wrap);
    scrollBottom();
    return { wrap, body };
  }

  function setBubbleText(bubble, text) {
    bubble.body.textContent = text;
    scrollBottom();
  }

  function markBubbleError(bubble, message) {
    bubble.body.classList.remove("streaming");
    bubble.body.classList.add("error");
    bubble.body.textContent = "⚠️ " + message;
    scrollBottom();
  }

  function scrollBottom() {
    el.debate.transcript.scrollTop = el.debate.transcript.scrollHeight;
  }

  function setStatus(text) { el.debate.status.textContent = text || ""; }

  /* ---------------- 思考进度指示 + 调试流 ---------------- */
  // 返回 { onReasoning, onOutput, stop }：实时显示"思考/输出"进度与用时
  function startProgress(setter) {
    const set = setter || setStatus;
    const t0 = Date.now();
    let rLen = 0, phase = "think";
    const tick = () => {
      const s = ((Date.now() - t0) / 1000).toFixed(1);
      set(phase === "think"
        ? "AI 思考中… 已思考 " + rLen + " 字 · " + s + " 秒"
        : "AI 输出中… " + s + " 秒");
    };
    tick();
    const timer = setInterval(tick, 400);
    return {
      onReasoning: (c) => { rLen += len(c); },
      onOutput: () => { phase = "output"; },
      stop: () => { clearInterval(timer); },
    };
  }

  // 在指定父节点下创建"思考过程"折叠调试区，返回追加函数
  function makeDebugDetails(parent) {
    const details = document.createElement("details");
    details.className = "think-debug";
    const summary = document.createElement("summary");
    summary.textContent = "💭 思考过程（流式调试）";
    const body = document.createElement("div");
    body.className = "think-body";
    details.appendChild(summary);
    details.appendChild(body);
    parent.appendChild(details);
    return (chunk) => { body.textContent += chunk; };
  }

  // 绑定到页面里已有的 <details>（战略/裁决页），返回追加函数
  function bindDebugDetails(detailsEl, bodyEl) {
    return (chunk) => {
      if (detailsEl.hidden) detailsEl.hidden = false;
      bodyEl.textContent += chunk;
    };
  }

  /* ---------------- 进度 / 环节标题 ---------------- */
  function updateStageHeader() {
    const stage = state.format[state.stageIndex];
    el.debate.stageProgress.textContent = "流程 " + (state.stageIndex + 1) + "/" + state.format.length;
    el.debate.stageName.textContent = stage ? stage.name : "比赛结束";
    let limit = "";
    if (stage) {
      const n = stageLimit(stage);
      if (stage.kind === "crossExam") limit = "· 每次发言 ≤ " + n + " 字";
      else if (stage.kind === "freeDebate") limit = "· 每次发言 ≤ " + n + " 字";
      else if (stage.kind === "judgeQuestion") limit = "· 回答 ≤ " + n + " 字";
      else limit = "· 最大 " + n + " 字";
    }
    el.debate.stageLimit.textContent = limit;
    renderStageList();
  }

  function stageMetaText(stage) {
    const n = stageLimit(stage);
    if (stage.kind === "crossExam") return "每次 ≤ " + n + " 字";
    if (stage.kind === "freeDebate") return "每次 ≤ " + n + " 字";
    if (stage.kind === "judgeQuestion") return "回答 ≤ " + n + " 字";
    return "≤ " + n + " 字";
  }

  function renderStageList() {
    const panel = el.debate.stageList;
    panel.textContent = "";
    state.format.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "stage-item" + (i === state.stageIndex ? " current" : i < state.stageIndex ? " done" : "");
      const icon = document.createElement("span");
      icon.className = "stage-icon";
      icon.textContent = i < state.stageIndex ? "✓" : (i === state.stageIndex ? "▶" : "○");
      const name = document.createElement("span");
      name.className = "stage-name";
      name.textContent = (i + 1) + ". " + s.name;
      const meta = document.createElement("span");
      meta.className = "stage-meta";
      meta.textContent = stageMetaText(s);
      row.appendChild(icon);
      row.appendChild(name);
      row.appendChild(meta);
      panel.appendChild(row);
    });
  }

  /* ---------------- 输入框控制 ---------------- */
  function showInput(on) {
    el.debate.inputArea.style.display = on ? "flex" : "none";
  }
  function setInputConfig(label, max) {
    el.debate.inputLabel.textContent = label;
    state.inputMax = max;
    el.debate.input.value = "";
    el.debate.input.disabled = false;
    el.debate.submit.disabled = false;
    updateCounter();
    el.debate.input.focus();
  }
  function updateCounter() {
    const n = len(el.debate.input.value);
    el.debate.inputCounter.textContent = n + " / " + (state.inputMax || 0) + " 字";
    el.debate.inputCounter.classList.toggle("over", state.inputMax && n > state.inputMax);
  }
  function disableInput() {
    el.debate.input.disabled = true;
    el.debate.submit.disabled = true;
    el.debate.endStage.disabled = true;
  }
  function hideEndButton() { el.debate.endStage.hidden = true; }
  function showEndButton() { el.debate.endStage.hidden = false; el.debate.endStage.disabled = false; }
  function hideRetry() { el.debate.retry.hidden = true; state.pendingRetry = null; }
  function showRetry() { el.debate.retry.hidden = false; el.debate.retry.disabled = false; }

  /* ---------------- 记录 ---------------- */
  function pushTranscript(label, side, text, by) {
    state.transcript.push({ label: label, side: side, text: text, by: by });
  }
  function transcriptText() {
    if (!state.transcript.length) return "（暂无）";
    return state.transcript.map((e) => "【" + e.label + "】\n" + e.text).join("\n\n");
  }

  /* ---------------- 通用 AI 发言（写入辩论实录） ---------------- */
  async function aiTurn(opts) {
    // opts: { label, side, system, user, effort, maxTokens, onDone(content) }
    state.busy = true;
    hideRetry();
    disableInput();
    hideEndButton();
    showInput(false);
    const progress = startProgress(setStatus);
    const bubble = addBubble("AI · " + opts.label, "", "ai", true);
    const debug = state.showThinking ? makeDebugDetails(bubble.wrap) : null;
    let content = "", sawOutput = false;
    try {
      const res = await callModel({
        system: opts.system, user: opts.user,
        effort: opts.effort, maxTokens: opts.maxTokens,
        onReasoning: (c) => { progress.onReasoning(c); if (debug) debug(c); },
        onChunk: (c) => {
          if (!sawOutput) { sawOutput = true; progress.onOutput(); }
          content += c; setBubbleText(bubble, content);
        },
      });
      content = res.content || "";
      progress.stop();
      if (!content.trim()) throw new Error("模型返回了空回复（可能思考过长导致预算耗尽，请重试）");
      setBubbleText(bubble, content);
      pushTranscript(opts.label, opts.side, content, "ai");
      state.busy = false;
      setStatus("");
      opts.onDone(content);
    } catch (err) {
      progress.stop();
      markBubbleError(bubble, err.message);
      state.busy = false;
      state.pendingRetry = () => { bubble.wrap.remove(); aiTurn(opts); };
      showRetry();
      setStatus("出错：" + err.message + "（可点击\"重试\"）");
    }
  }

  /* ================= 流程控制 ================= */
  function advance() {
    if (state.busy) return;
    if (state.stageIndex >= state.format.length) { finishDebate(); return; }
    updateStageHeader();
    const stage = state.format[state.stageIndex];
    switch (stage.kind) {
      case "constructive":
      case "rebuttal":
      case "summary":
      case "closing":
        doSpeech(stage); break;
      case "crossExam":
        doCrossExam(stage); break;
      case "judgeQuestion":
        doJudgeQuestion(stage); break;
      case "freeDebate":
        doFreeDebate(stage); break;
    }
  }

  function advanceStage() {
    state.stageIndex++;
    state.cx = null; state.free = null; state.judgeQ = null;
    advance();
  }

  /* ---------- 常规发言：立论/申论/小结/结辩 ---------- */
  function doSpeech(stage) {
    const charLimit = stageLimit(stage);
    const oppSide = stage.side === "正方" ? "反方" : "正方";
    const hasOpponentSpoken = state.transcript.some((e) => e.side === oppSide);
    if (stage.side === state.humanSide) {
      waitForHuman({
        max: charLimit,
        label: "你 · " + stage.side + stage.pos + "（" + stage.name + "）",
        recordLabel: stage.side + stage.pos + "·" + stage.name,
        onDone: advanceStage,
        endable: false,
        hint: "轮到你发言：" + stage.side + stage.pos + "·" + stage.name + "（≤ " + charLimit + " 字）",
      });
    } else {
      aiTurn({
        label: stage.side + stage.pos + "·" + stage.name,
        side: stage.side,
        system: P.roundSystem({ topic: state.settings.topic, side: stage.side, pos: stage.pos,
          stageName: stage.name, minutes: stage.minutes, charLimit: charLimit,
          kind: stage.kind, hasOpponentSpoken: hasOpponentSpoken }),
        user: P.roundUser({ topic: state.settings.topic, side: stage.side, pos: stage.pos,
          stageName: stage.name, strategy: state.strategy, transcript: transcriptText() }),
        effort: state.settings.effort || CFG.EFFORT.round,
        maxTokens: CFG.MAX_TOKENS.speech,
        onDone: advanceStage,
      });
    }
  }

  /* ---------- 质询环节 ---------- */
  function doCrossExam(stage) {
    if (!state.cx) state.cx = { exchange: 0, phase: "question" };
    const charLimit = stageLimit(stage);
    const q = stage.questioner, a = stage.answerer;

    if (state.cx.phase === "question") {
      if (q.side === state.humanSide) {
        waitForHuman({
          max: charLimit,
          label: "你 · " + q.side + q.pos + "（质询）",
          recordLabel: q.side + q.pos + "·质询",
          onDone: () => { state.cx.phase = "answer"; advance(); },
          endable: true,
          hint: "第 " + (state.cx.exchange + 1) + "/" + state.adv.crossExamRounds + " 回合 · 你质询 " + a.side + a.pos + "（问内容→质疑→下结论定性，≤ " + charLimit + " 字）",
        });
      } else {
        const round = state.cx.exchange + 1;
        const totalRounds = state.adv.crossExamRounds;
        aiTurn({
          label: q.side + q.pos + "·质询",
          side: q.side,
          system: P.crossExamQuestionerSystem({ topic: state.settings.topic, side: q.side, pos: q.pos,
            targetSide: a.side, targetPos: a.pos, charLimit: charLimit,
            totalRounds: totalRounds, currentRound: round }),
          user: P.crossExamUser({ topic: state.settings.topic, side: q.side, strategy: state.strategy,
            transcript: transcriptText(),
            roleDesc: "作为质询方，进行第 " + round + "/" + totalRounds + " 个问答回合的质询（问内容→质疑→下结论定性）。" }),
          effort: state.settings.effort || CFG.EFFORT.round,
          maxTokens: CFG.MAX_TOKENS.crossExam,
          onDone: () => { state.cx.phase = "answer"; advance(); },
        });
      }
    } else { // phase === "answer"
      if (a.side === state.humanSide) {
        waitForHuman({
          max: charLimit,
          label: "你 · " + a.side + a.pos + "（应答）",
          recordLabel: a.side + a.pos + "·应答",
          onDone: () => {
            state.cx.exchange++;
            if (state.cx.exchange >= state.adv.crossExamRounds) advanceStage();
            else { state.cx.phase = "question"; advance(); }
          },
          endable: true,
          hint: "你回应 " + q.side + q.pos + " 的质询：输入你的回答（≤ " + charLimit + " 字）",
        });
      } else {
        aiTurn({
          label: a.side + a.pos + "·应答",
          side: a.side,
          system: P.crossExamAnswererSystem({ topic: state.settings.topic, side: a.side, pos: a.pos,
            questionerSide: q.side, questionerPos: q.pos, charLimit: charLimit }),
          user: P.crossExamUser({ topic: state.settings.topic, side: a.side, strategy: state.strategy,
            transcript: transcriptText(),
            roleDesc: "作为被质询方，回应" + q.side + q.pos + "的质询。" }),
          effort: state.settings.effort || CFG.EFFORT.round,
          maxTokens: CFG.MAX_TOKENS.crossExam,
          onDone: () => {
            state.cx.exchange++;
            if (state.cx.exchange >= state.adv.crossExamRounds) advanceStage();
            else { state.cx.phase = "question"; advance(); }
          },
        });
      }
    }
  }

  /* ---------- 评委提问 ---------- */
  function doJudgeQuestion(stage) {
    if (!state.judgeQ) state.judgeQ = { step: 0, questions: null };

    if (state.judgeQ.step === 0) {
      // 评委（新对话）生成两个问题
      state.busy = true;
      hideRetry(); disableInput(); hideEndButton(); showInput(false);
      const progress = startProgress(setStatus);
      const bubble = addBubble("评委 · 提问", "", "judge", true);
      const debug = state.showThinking ? makeDebugDetails(bubble.wrap) : null;
      let content = "", sawOutput = false;
      callModel({
        system: P.judgeQuestionSystem(state.settings.topic),
        user: P.judgeQuestionUser(state.settings.topic, transcriptText()),
        effort: state.settings.effort || CFG.EFFORT.judge,
        maxTokens: CFG.MAX_TOKENS.judgeQuestion,
        onReasoning: (c) => { progress.onReasoning(c); if (debug) debug(c); },
        onChunk: (c) => {
          if (!sawOutput) { sawOutput = true; progress.onOutput(); }
          content += c; setBubbleText(bubble, content);
        },
      }).then((res) => {
        progress.stop();
        content = res.content || "";
        if (!content.trim()) throw new Error("评委返回了空提问（请重试）");
        setBubbleText(bubble, content);
        const qs = parseJudgeQuestions(content);
        // 将两个问题作为评委发言写入实录
        pushTranscript("评委·提问（正方）", "评委", qs["正方"], "ai");
        pushTranscript("评委·提问（反方）", "评委", qs["反方"], "ai");
        state.judgeQ.questions = qs;
        state.judgeQ.step = 1;
        state.busy = false;
        setStatus("");
        advance();
      }).catch((err) => {
        progress.stop();
        markBubbleError(bubble, err.message);
        state.busy = false;
        state.pendingRetry = () => { bubble.wrap.remove(); doJudgeQuestion(stage); };
        showRetry();
        setStatus("出错：" + err.message + "（可点击\"重试\"）");
      });
      return;
    }

    // step 1：正方回答；step 2：反方回答
    const order = ["正方", "反方"];
    const idx = state.judgeQ.step - 1;
    const side = order[idx];
    const question = state.judgeQ.questions[side];
    const charLimit = stageLimit(stage);

    if (side === state.humanSide) {
      waitForHuman({
        max: charLimit,
        label: "你 · " + side + "（回答评委）",
        recordLabel: side + "·回答评委",
        onDone: () => { state.judgeQ.step++; if (state.judgeQ.step > 2) advanceStage(); else advance(); },
        endable: false,
        hint: "评委向你（" + side + "）提问：" + question + " —— 请回答（≤ " + charLimit + " 字）",
      });
    } else {
      aiTurn({
        label: side + "·回答评委",
        side: side,
        system: P.judgeAnswerSystem({ topic: state.settings.topic, side: side, charLimit: charLimit }),
        user: P.judgeAnswerUser({ topic: state.settings.topic, side: side, strategy: state.strategy,
          transcript: transcriptText(), question: question }),
        effort: state.settings.effort || CFG.EFFORT.round,
        maxTokens: CFG.MAX_TOKENS.judgeAnswer,
        onDone: () => { state.judgeQ.step++; if (state.judgeQ.step > 2) advanceStage(); else advance(); },
      });
    }
  }

  function parseJudgeQuestions(text) {
    const q = { 正方: "", 反方: "" };
    const m1 = text.match(/【向正方提问】\s*([\s\S]*?)(?=【向反方提问】|$)/);
    const m2 = text.match(/【向反方提问】\s*([\s\S]*)/);
    if (m1) q["正方"] = m1[1].trim();
    if (m2) q["反方"] = m2[1].trim();
    if (!q["正方"] && !q["反方"]) {
      // 兜底：把整段文字作为同一个问题给双方
      const t = text.trim();
      q["正方"] = t; q["反方"] = t;
    } else {
      // 只缺失其中一方时，用另一方补齐，避免出现空问题
      if (!q["正方"]) q["正方"] = q["反方"];
      if (!q["反方"]) q["反方"] = q["正方"];
    }
    return q;
  }

  /* ---------- 自由辩论 ---------- */
  function doFreeDebate(stage) {
    if (!state.free) state.free = { turn: "正方", proUsed: 0, conUsed: 0, turnCount: 0 };
    const f = state.free;
    const charLimit = stageLimit(stage);
    const budget = state.adv.freeDebateBudget;
    const maxTurns = state.adv.freeDebateMaxTurns;

    if (f.turnCount >= maxTurns) { advanceStage(); return; }

    const proOk = f.proUsed < budget;
    const conOk = f.conUsed < budget;
    if (!proOk && !conOk) { advanceStage(); return; }
    // 当前应发言的一方已用尽预算 → 轮到另一方
    if ((f.turn === "正方" && !proOk) || (f.turn === "反方" && !conOk)) {
      f.turn = f.turn === "正方" ? "反方" : "正方";
    }

    const side = f.turn;
    const used = side === "正方" ? f.proUsed : f.conUsed;
    const budgetInfo = side + "已用 " + used + "/" + budget + " 字";

    if (side === state.humanSide) {
      waitForHuman({
        max: charLimit,
        label: "你 · " + side + "（自由辩论）",
        recordLabel: side + "·自由辩论",
        onDone: () => {
          const u = (side === "正方" ? f.proUsed : f.conUsed) + len(lastHumanText());
          if (side === "正方") f.proUsed = u; else f.conUsed = u;
          f.turn = (side === "正方") ? "反方" : "正方";
          f.turnCount++;
          advance();
        },
        endable: true,
        hint: "自由辩论 · " + side + "发言（≤ " + charLimit + " 字）· " + budgetInfo,
      });
    } else {
      aiTurn({
        label: side + "·自由辩论",
        side: side,
        system: P.freeDebateSystem({ topic: state.settings.topic, side: side, charLimit: charLimit }),
        user: P.freeDebateUser({ topic: state.settings.topic, side: side, strategy: state.strategy,
          transcript: transcriptText() }),
        effort: state.settings.effort || CFG.EFFORT.round,
        maxTokens: CFG.MAX_TOKENS.freeDebate,
        onDone: (content) => {
          const u = (side === "正方" ? f.proUsed : f.conUsed) + len(content);
          if (side === "正方") f.proUsed = u; else f.conUsed = u;
          f.turn = (side === "正方") ? "反方" : "正方";
          f.turnCount++;
          advance();
        },
      });
    }
  }

  function lastHumanText() {
    for (let i = state.transcript.length - 1; i >= 0; i--) {
      if (state.transcript[i].by === "human") return state.transcript[i].text;
    }
    return "";
  }

  /* ---------- 人类输入 ---------- */
  function waitForHuman(opts) {
    state.pendingHuman = opts;
    showInput(true);
    hideRetry();
    setInputConfig(opts.label, opts.max);
    if (opts.endable) showEndButton(); else hideEndButton();
    setStatus(opts.hint || ("轮到你发言：" + opts.label));
  }

  function onHumanSubmit() {
    const p = state.pendingHuman;
    if (!p || state.busy) return;
    const text = el.debate.input.value.trim();
    if (!text) { setStatus("请输入内容后再提交。"); return; }
    if (len(text) > p.max) { setStatus("字数超限：" + len(text) + " / " + p.max + " 字，请删减。"); return; }
    pushTranscript(p.recordLabel, state.humanSide, text, "human");
    addBubble(p.label, text, "human");
    el.debate.input.value = "";
    updateCounter();
    const cb = p.onDone;
    state.pendingHuman = null;
    showInput(false);
    hideEndButton();
    cb();
  }

  function onEndStage() {
    if (state.busy) return;
    state.pendingHuman = null;
    showInput(false);
    hideEndButton();
    hideRetry();
    setStatus("");
    advanceStage();
  }

  /* ================= 战略 / 裁决 ================= */
  function generateStrategy() {
    el.strategy.enterBtn.hidden = true;
    el.strategy.retryBtn.hidden = true;
    el.strategy.viewBtn.hidden = true;
    el.strategy.details.hidden = true;
    el.strategy.thinking.hidden = true;
    el.strategy.thinkingBody.textContent = "";
    el.strategy.body.textContent = "";
    const set = (t) => { el.strategy.status.textContent = t; };
    const progress = startProgress(set);
    const debug = bindDebugDetails(el.strategy.thinking, el.strategy.thinkingBody);
    let content = "", sawOutput = false;
    callModel({
      system: P.strategySystem(state.settings.topic, state.aiSide),
      user: P.strategyUser(state.settings.topic, state.aiSide),
      model: CFG.MODELS.strategy,
      effort: CFG.EFFORT.strategy,
      maxTokens: CFG.MAX_TOKENS.strategy,
      onReasoning: (c) => { progress.onReasoning(c); debug(c); },
      onChunk: (c) => {
        if (!sawOutput) { sawOutput = true; progress.onOutput(); }
        content += c; el.strategy.body.textContent = content;
      },
    }).then((res) => {
      progress.stop();
      content = res.content || "";
      if (!content.trim()) throw new Error("模型返回了空战略（可能思考过长导致预算耗尽，请重试）");
      state.strategy = content;
      set("✅ 宏观战略已生成。");
      el.strategy.body.textContent = state.strategy;
      el.strategy.viewBtn.hidden = false;
      el.strategy.enterBtn.hidden = false;
    }).catch((err) => {
      progress.stop();
      set("❌ 战略生成失败：" + err.message);
      el.strategy.retryBtn.hidden = false;
    });
  }

  function finishDebate() {
    showScreen("judge");
    generateVerdict();
  }

  function generateVerdict() {
    el.judge.verdict.textContent = "";
    el.judge.thinking.hidden = true;
    el.judge.thinkingBody.textContent = "";
    const set = (t) => { el.judge.status.textContent = t; };
    const progress = startProgress(set);
    const debug = bindDebugDetails(el.judge.thinking, el.judge.thinkingBody);
    let content = "", sawOutput = false;
    callModel({
      system: P.verdictSystem(state.settings.topic),
      user: P.verdictUser(state.settings.topic, transcriptText()),
      model: CFG.MODELS.judge,
      effort: state.settings.effort || CFG.EFFORT.judge,
      maxTokens: CFG.MAX_TOKENS.verdict,
      onReasoning: (c) => { progress.onReasoning(c); debug(c); },
      onChunk: (c) => {
        if (!sawOutput) { sawOutput = true; progress.onOutput(); }
        content += c; renderVerdict(content);
      },
    }).then((res) => {
      progress.stop();
      if (!(res.content || "").trim()) throw new Error("模型返回了空裁决（请重试）");
      renderVerdict(res.content);
      set("✅ 裁决完成。");
    }).catch((err) => {
      progress.stop();
      set("❌ 裁决生成失败：" + err.message);
      if (!el.judge.verdict.textContent.trim()) el.judge.verdict.textContent = "⚠️ " + err.message;
    });
  }

  // 轻量 Markdown 渲染（安全）
  function renderVerdict(text) {
    const lines = esc(text).split("\n");
    let html = "";
    for (const line of lines) {
      let l = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      if (/^[一二三四五六]、/.test(l)) {
        html += "<h3>" + l + "</h3>";
      } else {
        html += "<div>" + l + "</div>";
      }
    }
    el.judge.verdict.innerHTML = html;
  }

  /* ================= 导出 ================= */
  function exportTranscript() {
    const meta = [
      "# AI 辩论记录",
      "",
      "- 辩题：" + state.settings.topic,
      "- 你的持方：" + state.humanSide + "（AI 持方：" + state.aiSide + "）",
      "- 模型：宏观战略 " + CFG.MODELS.strategy + " / 辩论 " + CFG.MODELS.debate + " / 评委裁决 " + CFG.MODELS.judge,
      "",
      "---",
      "",
      "## 辩论实录",
      "",
      transcriptText(),
      "",
      "---",
      "",
      "## AI 宏观战略（" + state.aiSide + "）",
      "",
      state.strategy,
      "",
    ].join("\n");
    const blob = new Blob([meta], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ai-debate-" + Date.now() + ".md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  /* ================= 高级设置界面 ================= */
  function openSettings() {
    draftFormat = state.format.map(deepCopyStage);
    renderFormatEditor();
    el.settings.crossRounds.value = state.adv.crossExamRounds;
    el.settings.freeBudget.value = state.adv.freeDebateBudget;
    el.settings.freeTurns.value = state.adv.freeDebateMaxTurns;
    el.settings.error.hidden = true;
    showScreen("settings");
  }

  /* ---- 赛制编辑器 ---- */
  function makeSelect(cls, opts, current) {
    const sel = document.createElement("select");
    sel.className = cls;
    opts.forEach((o) => {
      const v = typeof o === "string" ? o : o.value;
      const lab = typeof o === "string" ? o : o.label;
      const opt = document.createElement("option");
      opt.value = v; opt.textContent = lab;
      if (v === current) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }
  function field(labelText, control, wrapClass) {
    const l = document.createElement("label");
    l.className = "fmt-field " + (wrapClass || "");
    const s = document.createElement("span");
    s.textContent = labelText;
    l.appendChild(s); l.appendChild(control);
    return l;
  }
  function fmtBtn(text, cls, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }
  function applyKindVisibility(row, kind) {
    const single = kind === "constructive" || kind === "rebuttal" || kind === "summary" || kind === "closing";
    const cross = kind === "crossExam";
    const free = kind === "freeDebate";
    const show = (sel, on) => { const e = row.querySelector(sel); if (e) e.style.display = on ? "" : "none"; };
    show(".fmt-sidewrap", single);
    show(".fmt-poswrap", single);
    show(".fmt-minwrap", single || free);
    show(".fmt-cx", cross);
  }
  function syncStageLimit(i) {
    const s = draftFormat[i];
    s.limit = CFG.defaultCharLimit(s);
    const row = el.settings.format.children[i];
    if (row) { const inp = row.querySelector(".fmt-limit"); if (inp) inp.value = s.limit; }
  }
  function moveStage(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= draftFormat.length) return;
    const t = draftFormat[i]; draftFormat[i] = draftFormat[j]; draftFormat[j] = t;
    renderFormatEditor();
  }
  function removeStage(i) {
    if (draftFormat.length <= 1) { el.settings.error.textContent = "至少保留一个环节。"; el.settings.error.hidden = false; return; }
    draftFormat.splice(i, 1);
    renderFormatEditor();
  }
  function addStage() {
    draftFormat.push(newStage());
    renderFormatEditor();
  }
  function renderStageRow(s, i) {
    const row = document.createElement("div");
    row.className = "fmt-row";

    const head = document.createElement("div");
    head.className = "fmt-head";
    const num = document.createElement("span");
    num.className = "fmt-num";
    num.textContent = i + 1;
    const nameInp = document.createElement("input");
    nameInp.className = "fmt-name";
    nameInp.value = s.name;
    nameInp.placeholder = "环节名称";
    nameInp.addEventListener("input", () => { draftFormat[i].name = nameInp.value; });
    head.appendChild(num);
    head.appendChild(nameInp);
    head.appendChild(fmtBtn("↑", "fmt-up", () => moveStage(i, -1)));
    head.appendChild(fmtBtn("↓", "fmt-down", () => moveStage(i, +1)));
    head.appendChild(fmtBtn("✕", "fmt-del", () => removeStage(i)));
    row.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "fmt-grid";

    const kindSel = makeSelect("fmt-kind", CFG.KINDS, s.kind);
    kindSel.addEventListener("change", () => { draftFormat[i].kind = kindSel.value; applyKindVisibility(row, kindSel.value); syncStageLimit(i); });
    grid.appendChild(field("类型", kindSel, "fmt-kindwrap"));

    const sideSel = makeSelect("fmt-side", CFG.SIDES, s.side);
    sideSel.addEventListener("change", () => { draftFormat[i].side = sideSel.value; });
    grid.appendChild(field("持方", sideSel, "fmt-sidewrap"));

    const posSel = makeSelect("fmt-pos", CFG.POSITIONS, s.pos);
    posSel.addEventListener("change", () => { draftFormat[i].pos = posSel.value; });
    grid.appendChild(field("辩位", posSel, "fmt-poswrap"));

    const minInp = document.createElement("input");
    minInp.type = "number"; minInp.min = "0"; minInp.step = "0.5"; minInp.className = "fmt-minutes";
    minInp.value = s.minutes;
    minInp.addEventListener("input", () => { draftFormat[i].minutes = Number(minInp.value); syncStageLimit(i); });
    grid.appendChild(field("时长(分)", minInp, "fmt-minwrap"));

    const limInp = document.createElement("input");
    limInp.type = "number"; limInp.min = "1"; limInp.step = "1"; limInp.className = "fmt-limit";
    limInp.value = s.limit;
    limInp.addEventListener("input", () => { draftFormat[i].limit = Number(limInp.value); });
    grid.appendChild(field("最大字数", limInp, "fmt-limwrap"));

    row.appendChild(grid);

    const cx = document.createElement("div");
    cx.className = "fmt-cx";
    const qSide = makeSelect("fmt-q-side", CFG.SIDES, s.questioner.side);
    qSide.addEventListener("change", () => { draftFormat[i].questioner.side = qSide.value; });
    const qPos = makeSelect("fmt-q-pos", CFG.POSITIONS, s.questioner.pos);
    qPos.addEventListener("change", () => { draftFormat[i].questioner.pos = qPos.value; });
    const aSide = makeSelect("fmt-a-side", CFG.SIDES, s.answerer.side);
    aSide.addEventListener("change", () => { draftFormat[i].answerer.side = aSide.value; });
    const aPos = makeSelect("fmt-a-pos", CFG.POSITIONS, s.answerer.pos);
    aPos.addEventListener("change", () => { draftFormat[i].answerer.pos = aPos.value; });
    const qWrap = document.createElement("label");
    qWrap.className = "fmt-cx-item";
    qWrap.appendChild(document.createTextNode("质询方 "));
    qWrap.appendChild(qSide); qWrap.appendChild(qPos);
    const aWrap = document.createElement("label");
    aWrap.className = "fmt-cx-item";
    aWrap.appendChild(document.createTextNode("被质询方 "));
    aWrap.appendChild(aSide); aWrap.appendChild(aPos);
    cx.appendChild(qWrap); cx.appendChild(aWrap);
    row.appendChild(cx);

    applyKindVisibility(row, s.kind);
    return row;
  }
  function renderFormatEditor() {
    const container = el.settings.format;
    container.textContent = "";
    draftFormat.forEach((s, i) => container.appendChild(renderStageRow(s, i)));
  }

  /* ---- 保存 / 重置 ---- */
  function validateDraftFormat() {
    for (let i = 0; i < draftFormat.length; i++) {
      const s = draftFormat[i];
      if (!String(s.name).trim()) return "第 " + (i + 1) + " 个环节缺少名称。";
      if (!(Number(s.limit) > 0)) return "第 " + (i + 1) + " 个环节的最大字数必须是正整数。";
      if (s.kind !== "judgeQuestion" && s.kind !== "crossExam" && !(Number(s.minutes) > 0)) return "第 " + (i + 1) + " 个环节的时长必须大于 0。";
    }
    return null;
  }
  function saveSettingsAdv() {
    const err = validateDraftFormat();
    if (err) { el.settings.error.textContent = err; el.settings.error.hidden = false; return; }
    const rounds = Math.round(Number(el.settings.crossRounds.value));
    const budget = Math.round(Number(el.settings.freeBudget.value));
    const turns = Math.round(Number(el.settings.freeTurns.value));
    if (!(rounds > 0) || !(budget > 0) || !(turns > 0)) {
      el.settings.error.textContent = "质询/自由辩论参数必须是正整数。";
      el.settings.error.hidden = false;
      return;
    }
    state.format = draftFormat.map((s, i) => sanitizeStage(s, i));
    state.adv = { crossExamRounds: rounds, freeDebateBudget: budget, freeDebateMaxTurns: turns };
    saveFormat(state.format);
    saveAdvanced(state.adv);
    showScreen("setup");
  }
  function resetSettingsAdv() {
    state.format = defaultFormat();
    state.adv = defaultAdvanced();
    saveFormat(state.format);
    saveAdvanced(state.adv);
    draftFormat = state.format.map(deepCopyStage);
    renderFormatEditor();
    el.settings.crossRounds.value = state.adv.crossExamRounds;
    el.settings.freeBudget.value = state.adv.freeDebateBudget;
    el.settings.freeTurns.value = state.adv.freeDebateMaxTurns;
    el.settings.error.hidden = true;
  }

  /* ================= 初始化 ================= */
  function bindEvents() {
    el.setup.start.addEventListener("click", onStart);
    el.setup.topic.addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "Enter") onStart(); });
    el.setup.settingsBtn.addEventListener("click", openSettings);
    el.settings.save.addEventListener("click", saveSettingsAdv);
    el.settings.reset.addEventListener("click", resetSettingsAdv);
    el.settings.back.addEventListener("click", () => showScreen("setup"));
    el.settings.addStage.addEventListener("click", addStage);
    el.strategy.viewBtn.addEventListener("click", () => {
      const hidden = el.strategy.details.hidden;
      el.strategy.details.hidden = !hidden;
      el.strategy.viewBtn.textContent = hidden ? "收起 AI 宏观战略" : "查看 AI 宏观战略（调试用）";
    });
    el.strategy.enterBtn.addEventListener("click", () => { showScreen("debate"); advance(); });
    el.strategy.retryBtn.addEventListener("click", generateStrategy);

    el.debate.submit.addEventListener("click", onHumanSubmit);
    el.debate.input.addEventListener("input", updateCounter);
    el.debate.input.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") onHumanSubmit();
    });
    el.debate.endStage.addEventListener("click", onEndStage);
    el.debate.retry.addEventListener("click", () => {
      const r = state.pendingRetry;
      hideRetry();
      if (r) r();
    });
    el.debate.restart.addEventListener("click", () => { if (confirm("确定重新开始吗？当前进度将丢失。")) location.reload(); });
    el.debate.strategyBtn.addEventListener("click", () => {
      const hidden = el.debate.strategyPanel.hidden;
      el.debate.strategyPanel.hidden = !hidden;
      el.debate.strategyPanel.textContent = hidden ? ("AI 宏观战略（" + state.aiSide + "）\n\n" + state.strategy) : "";
    });
    el.debate.chkThinking.addEventListener("change", () => {
      state.showThinking = el.debate.chkThinking.checked;
    });
    el.debate.stageLine.addEventListener("click", () => {
      el.debate.stageList.hidden = !el.debate.stageList.hidden;
    });

    el.judge.exportBtn.addEventListener("click", exportTranscript);
    el.judge.again.addEventListener("click", () => location.reload());
  }

  function onStart() {
    const apiKey = el.setup.apiKey.value.trim();
    const topic = el.setup.topic.value.trim();
    const effort = el.setup.effort.value || CFG.DEFAULT_EFFORT;
    const side = (document.querySelector('input[name="side"]:checked') || {}).value || "正方";

    if (!apiKey) { showSetupError("请填写 DeepSeek API Key。"); return; }
    if (!topic) { showSetupError("请填写辩题。"); return; }

    state.settings = { apiKey, topic, side, effort };
    state.humanSide = side;
    state.aiSide = side === "正方" ? "反方" : "正方";
    saveSettings(state.settings);

    el.debate.topic.textContent = topic;
    el.debate.side.textContent = side;
    el.debate.strategyPanel.textContent = "";

    showScreen("strategy");
    generateStrategy();
  }

  function showSetupError(msg) {
    el.setup.error.textContent = msg;
    el.setup.error.hidden = false;
  }

  function restoreForm() {
    const s = loadSettings();
    if (s) {
      el.setup.apiKey.value = s.apiKey || "";
      el.setup.topic.value = s.topic || "";
      if (s.effort) el.setup.effort.value = s.effort;
      const radio = document.querySelector('input[name="side"][value="' + s.side + '"]');
      if (radio) radio.checked = true;
    }
  }

  function init() {
    state.format = loadFormat();
    state.adv = loadAdvanced();
    restoreForm();
    bindEvents();
    showScreen("setup");
  }

  init();
})();
