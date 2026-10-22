// 核心資料型別、狀態機與常數定義

/**
 * 演進狀態機主路徑與終止狀態
 */
export const EVOLUTION_STATES = Object.freeze({
  OBSERVED: 'Observed',
  PROPOSED: 'Proposed',
  PROBING: 'Probing',
  COMPARED: 'Compared',
  COMPOSED: 'Composed',
  VALIDATED: 'Validated',
  ADOPTED: 'Adopted',
  REFLECTED: 'Reflected',
  // 終止狀態
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  BUDGET_EXHAUSTED: 'BudgetExhausted',
  FAILED: 'Failed',
});

export const TERMINAL_STATES = new Set([
  EVOLUTION_STATES.REFLECTED,
  EVOLUTION_STATES.REJECTED,
  EVOLUTION_STATES.CANCELLED,
  EVOLUTION_STATES.BUDGET_EXHAUSTED,
  EVOLUTION_STATES.FAILED,
]);

/**
 * 合法的狀態轉換表
 */
export const VALID_STATE_TRANSITIONS = Object.freeze({
  [EVOLUTION_STATES.OBSERVED]: new Set([
    EVOLUTION_STATES.PROPOSED,
    EVOLUTION_STATES.CANCELLED,
    EVOLUTION_STATES.BUDGET_EXHAUSTED,
    EVOLUTION_STATES.FAILED,
  ]),
  [EVOLUTION_STATES.PROPOSED]: new Set([
    EVOLUTION_STATES.PROBING,
    EVOLUTION_STATES.REJECTED,
    EVOLUTION_STATES.CANCELLED,
    EVOLUTION_STATES.BUDGET_EXHAUSTED,
    EVOLUTION_STATES.FAILED,
  ]),
  [EVOLUTION_STATES.PROBING]: new Set([
    EVOLUTION_STATES.COMPARED,
    EVOLUTION_STATES.CANCELLED,
    EVOLUTION_STATES.BUDGET_EXHAUSTED,
    EVOLUTION_STATES.FAILED,
  ]),
  [EVOLUTION_STATES.COMPARED]: new Set([
    EVOLUTION_STATES.COMPOSED,
    EVOLUTION_STATES.VALIDATED, // 單一候選勝出且無需多候選合併時可直接進入驗證
    EVOLUTION_STATES.REJECTED,
    EVOLUTION_STATES.CANCELLED,
    EVOLUTION_STATES.BUDGET_EXHAUSTED,
    EVOLUTION_STATES.FAILED,
  ]),
  [EVOLUTION_STATES.COMPOSED]: new Set([
    EVOLUTION_STATES.VALIDATED,
    EVOLUTION_STATES.REJECTED,
    EVOLUTION_STATES.CANCELLED,
    EVOLUTION_STATES.BUDGET_EXHAUSTED,
    EVOLUTION_STATES.FAILED,
  ]),
  [EVOLUTION_STATES.VALIDATED]: new Set([
    EVOLUTION_STATES.ADOPTED,
    EVOLUTION_STATES.REFLECTED, // 若未採用但仍記錄失敗經驗
    EVOLUTION_STATES.REJECTED,
    EVOLUTION_STATES.CANCELLED,
    EVOLUTION_STATES.BUDGET_EXHAUSTED,
    EVOLUTION_STATES.FAILED,
  ]),
  [EVOLUTION_STATES.ADOPTED]: new Set([
    EVOLUTION_STATES.REFLECTED,
    EVOLUTION_STATES.CANCELLED,
    EVOLUTION_STATES.FAILED,
  ]),
  [EVOLUTION_STATES.REFLECTED]: new Set([]),
  [EVOLUTION_STATES.REJECTED]: new Set([]),
  [EVOLUTION_STATES.CANCELLED]: new Set([]),
  [EVOLUTION_STATES.BUDGET_EXHAUSTED]: new Set([]),
  [EVOLUTION_STATES.FAILED]: new Set([]),
});

/**
 * 檢查狀態轉換是否合法
 * @param {string} fromState
 * @param {string} toState
 * @returns {boolean}
 */
export function isValidStateTransition(fromState, toState) {
  const allowed = VALID_STATE_TRANSITIONS[fromState];
  return Boolean(allowed && allowed.has(toState));
}

/**
 * 可演進之 Harness 元件檔名與對應之 systemPrompt section 名稱
 */
export const HARNESS_COMPONENT_FILES = Object.freeze([
  {
    fileName: 'systemprompt.md',
    key: 'systemprompt',
    sectionName: 'recursive-harness:systemprompt',
    orderOffset: 0,
    title: 'Recursive Harness — System Prompt',
  },
  {
    fileName: 'guardrails.md',
    key: 'guardrails',
    sectionName: 'recursive-harness:guardrails',
    orderOffset: 10,
    title: 'Recursive Harness — Guardrails',
  },
  {
    fileName: 'tool_guidance.md',
    key: 'tool_guidance',
    sectionName: 'recursive-harness:tool_guidance',
    orderOffset: 20,
    title: 'Recursive Harness — Tool Guidance',
  },
  {
    fileName: 'LongTermMEMORY.md',
    key: 'longTermMemory',
    sectionName: 'recursive-harness:memory',
    orderOffset: 30,
    title: 'Recursive Harness — Long-Term Memory',
  },
]);

/**
 * 預設初始 Harness 內容（當目錄尚未初始化時使用）
 */
export const DEFAULT_HARNESS_COMPONENTS = Object.freeze({
  systemprompt: [
    '# Recursive Harness 基礎系統指引',
    '- 先閱讀任務契約與輸入檔案，再決定工具呼叫順序。',
    '- 輸出結果前請核對所有客觀格式、欄位與不變量要求。',
  ].join('\n'),
  guardrails: [
    '# Recursive Harness 行為護欄',
    '- 嚴禁修改唯讀參考目錄或外部模型狀態。',
    '- 嚴禁執行任何列印（print）或權限提升操作。',
  ].join('\n'),
  tool_guidance: [
    '# Recursive Harness 工具使用指引',
    '- 優先使用最小必要工具完成查詢與驗證。',
    '- 若工具回傳錯誤，請先分析錯誤訊息與參數，勿盲目重複相同呼叫。',
  ].join('\n'),
  longTermMemory: [
    '# Recursive Harness 長期經驗摘要',
    '- 尚無累積之跨任務經驗條目。',
  ].join('\n'),
});
