/* =========================================================
 * 配置：辩论流程、字数限制、模型与 API 参数
 * 说明：本文件为"默认值"；高级设置页可覆盖其中的可调项，
 *       覆盖结果保存在浏览器 localStorage（不修改本文件）。
 * ========================================================= */
window.DEBATE_CONFIG = (function () {
  // 中文辩论语速约 250 字/分钟，用于把"时间限制"换算成"字数限制"
  const CHARS_PER_MINUTE = 250;

  // 各环节定义（数组顺序 = 比赛顺序）
  // kind: constructive(立论) / crossExam(质询) / rebuttal(申论)
  //       judgeQuestion(评委提问) / summary(小结) / freeDebate(自由辩论) / closing(结辩)
  const STAGES = [
    { id: "pro_c1",  name: "正方一辩立论",        kind: "constructive", side: "正方", pos: "一辩", minutes: 3 },
    { id: "con_cx1", name: "反方四辩质询正方一辩", kind: "crossExam",
      questioner: { side: "反方", pos: "四辩" }, answerer: { side: "正方", pos: "一辩" }, minutes: 1.5 },
    { id: "con_c1",  name: "反方一辩立论",        kind: "constructive", side: "反方", pos: "一辩", minutes: 3 },
    { id: "pro_cx1", name: "正方四辩质询反方一辩", kind: "crossExam",
      questioner: { side: "正方", pos: "四辩" }, answerer: { side: "反方", pos: "一辩" }, minutes: 1.5 },
    { id: "pro_c2",  name: "正方二辩申论",        kind: "rebuttal",     side: "正方", pos: "二辩", minutes: 2 },
    { id: "con_cx2", name: "反方三辩质询正方二辩", kind: "crossExam",
      questioner: { side: "反方", pos: "三辩" }, answerer: { side: "正方", pos: "二辩" }, minutes: 1.5 },
    { id: "con_c2",  name: "反方二辩申论",        kind: "rebuttal",     side: "反方", pos: "二辩", minutes: 2 },
    { id: "pro_cx2", name: "正方三辩质询反方二辩", kind: "crossExam",
      questioner: { side: "正方", pos: "三辩" }, answerer: { side: "反方", pos: "二辩" }, minutes: 1.5 },
    { id: "judge_q", name: "评委提问",            kind: "judgeQuestion" },
    { id: "con_s3",  name: "反方三辩小结",        kind: "summary",      side: "反方", pos: "三辩", minutes: 2 },
    { id: "pro_s3",  name: "正方三辩小结",        kind: "summary",      side: "正方", pos: "三辩", minutes: 2 },
    { id: "free",    name: "自由辩论",            kind: "freeDebate",   minutes: 4 },
    { id: "con_c4",  name: "反方四辩结辩",        kind: "closing",      side: "反方", pos: "四辩", minutes: 3 },
    { id: "pro_c4",  name: "正方四辩结辩",        kind: "closing",      side: "正方", pos: "四辩", minutes: 3 },
  ];

  // 字数 / 流程的默认值
  const LIMITS = {
    speech: function (minutes) { return Math.round(minutes * CHARS_PER_MINUTE); }, // 3min→750，2min→500
    crossExamTurn: 150,     // 质询：每次发言（问或答）字数上限
    crossExamRounds: 4,     // 质询：每轮最多问答回合数（超过自动进入下一环节）
    freeDebateTurn: 80,     // 自由辩论：每次发言字数上限
    freeDebateBudget: 1000, // 自由辩论：每方总字数预算（4 分钟 ≈ 1000 字）
    freeDebateMaxTurns: 12, // 自由辩论：总回合数上限（安全阀）
    judgeAnswer: 400,       // 评委提问环节，回答字数上限
  };

  // 计算某个环节的默认最大字数
  function defaultCharLimit(stage) {
    if (stage.kind === "crossExam") return LIMITS.crossExamTurn;
    if (stage.kind === "freeDebate") return LIMITS.freeDebateTurn;
    if (stage.kind === "judgeQuestion") return LIMITS.judgeAnswer;
    return LIMITS.speech(stage.minutes || 0);
  }

  return {
    API_BASE_URL: "https://api.deepseek.com/chat/completions",
    // 分角色模型：宏观大纲与评委裁决用 Pro（更深思考），辩论过程用 Flash（更快更省）
    MODELS: { strategy: "deepseek-v4-pro", debate: "deepseek-flash", judge: "deepseek-v4-pro" },
    DEFAULT_EFFORT: "high",

    // 思考强度（reasoning_effort）：宏观战略用最深思考，常规环节用 high，评委用 high
    EFFORT: { strategy: "max", round: "high", judge: "high" },

    // 输出 token 上限（重要：思考模式下 reasoning_content 与 content 共享该预算，
    // 过小会导致思维链耗尽预算、正文被截断甚至为空，故这里都设得足够大）
    MAX_TOKENS: {
      strategy: 32000,      // 宏观战略（max 深度思考，输出最长）
      verdict: 32000,       // 评委裁决
      speech: 16000,        // 立论/申论/小结/结辩
      crossExam: 8000,      // 质询（150 字正文，但思维链仍需空间）
      freeDebate: 8000,     // 自由辩论
      judgeQuestion: 8000,  // 评委提问
      judgeAnswer: 8000,    // 回答评委
    },

    CHARS_PER_MINUTE,
    STAGES,
    LIMITS,
    defaultCharLimit,

    // 赛制编辑器用到的可选项
    KINDS: [
      { value: "constructive", label: "立论" },
      { value: "rebuttal", label: "申论" },
      { value: "summary", label: "小结" },
      { value: "closing", label: "结辩" },
      { value: "crossExam", label: "质询" },
      { value: "freeDebate", label: "自由辩论" },
      { value: "judgeQuestion", label: "评委提问" },
    ],
    SIDES: ["正方", "反方"],
    POSITIONS: ["一辩", "二辩", "三辩", "四辩"],

    STORAGE_KEY: "ai-debate-settings",
    ADVANCED_STORAGE_KEY: "ai-debate-advanced",
    FORMAT_STORAGE_KEY: "ai-debate-format",
  };
})();
