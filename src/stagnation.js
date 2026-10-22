// 階段 4：執行期停滯偵測器（StagnationDetector）與三級漸進式介入機制
// 與 dsh-repeat-tool-reminder（僅檢查完全相同之 tool + input）互補：
// 涵蓋錯誤指紋重複、近似參數失敗、跨工具乒乓無進展，並排除合法輪詢與 429 重試。
import { computeErrorFingerprint } from './trajectory.js';

/**
 * 判斷是否屬於合法輪詢等待（Polling / Build Wait）或暫時性速率限制（429 / 503）
 * @param {string} toolName
 * @param {any} input
 * @param {string} resultText
 * @param {boolean} isError
 * @returns {boolean}
 */
export function isExemptPollingOrRateLimit(toolName, input, resultText, isError) {
  const name = String(toolName || '').toLowerCase();
  const text = String(resultText || '').toLowerCase();

  // 1. 合法任務狀態輪詢（例如等待背景編譯或測試完成）
  if (
    !isError &&
    (name.includes('poll') ||
      name.includes('status') ||
      name.includes('wait') ||
      name === 'manage_task' ||
      input?.action === 'status') &&
    /\b(running|pending|in_progress|building|waiting|執行中|等待中)\b/i.test(text)
  ) {
    return true;
  }

  // 2. 暫時性 Rate Limit / 伺服器忙碌重試
  if (
    isError &&
    /\b(429|503|rate[\s_-]?limit|too\s+many\s+requests|temporarily\s+unavailable|eagain)\b/i.test(
      text,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * 計算兩個工具輸入物件之詞元 Jaccard 相似度（0..1）
 * @param {any} inputA
 * @param {any} inputB
 * @returns {number}
 */
export function computeInputSimilarity(inputA, inputB) {
  const tokenize = (val) => {
    const raw = typeof val === 'string' ? val : JSON.stringify(val ?? {});
    return new Set(
      raw
        .toLowerCase()
        .split(/[^a-z0-9_\u4e00-\u9fa5]+/)
        .filter((t) => t.length > 1),
    );
  };

  const setA = tokenize(inputA);
  const setB = tokenize(inputB);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const tok of setA) {
    if (setB.has(tok)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 執行期停滯偵測與三級漸進式介入器
 */
export class RuntimeStagnationDetector {
  /**
   * @param {{
   *   threshold?: number,
   *   similarityThreshold?: number,
   *   sectionOrder?: number
   * }} [options]
   */
  constructor(options = {}) {
    this.threshold = Math.max(2, Number(options.threshold) || 3);
    this.similarityThreshold = Number(options.similarityThreshold) || 0.72;
    this.sectionOrder = Number(options.sectionOrder) || 795;
    /** @type {WeakMap<object, { history: Array<any>, interventionCount: number }>} */
    this.agentStates = new WeakMap();
  }

  _getState(agentKey) {
    let state = this.agentStates.get(agentKey);
    if (!state) {
      state = {
        history: [],
        interventionCount: 0,
      };
      this.agentStates.set(agentKey, state);
    }
    return state;
  }

  /**
   * 記錄單次工具執行結果並評估是否觸發停滯介入
   * @param {{
   *   agent?: any,
   *   toolName: string,
   *   input: any,
   *   outputText: string,
   *   isError: boolean
   * }} event
   */
  observeToolExecution(event) {
    const agentKey = event.agent && typeof event.agent === 'object' ? event.agent : this;
    const state = this._getState(agentKey);

    if (
      isExemptPollingOrRateLimit(
        event.toolName,
        event.input,
        event.outputText,
        event.isError,
      )
    ) {
      return { stagnant: false, exempt: true };
    }

    const errorFingerprint = event.isError
      ? computeErrorFingerprint(event.toolName, event.outputText)
      : null;

    const entry = {
      toolName: event.toolName,
      input: event.input,
      outputText: event.outputText,
      isError: Boolean(event.isError),
      errorFingerprint,
      timestamp: Date.now(),
    };
    state.history.push(entry);

    const recent = state.history.slice(-Math.max(this.threshold * 2, 6));
    const tail = recent.slice(-this.threshold);

    // 偵測模式 A：連續或近期重複相同錯誤指紋（即使參數微調仍觸發相同底層錯誤）
    let repeatedFingerprintCount = 0;
    if (errorFingerprint) {
      repeatedFingerprintCount = recent.filter(
        (h) => h.errorFingerprint === errorFingerprint,
      ).length;
    }

    // 偵測模式 B：同一工具近似參數（0.72 <= similarity < 1.0）連續失敗或無新進展
    let similarInputFailCount = 0;
    if (tail.length >= this.threshold) {
      const allSameTool = tail.every((h) => h.toolName === entry.toolName && h.isError);
      if (allSameTool) {
        let allSimilar = true;
        for (let i = 1; i < tail.length; i++) {
          const sim = computeInputSimilarity(tail[i - 1].input, tail[i].input);
          if (sim < this.similarityThreshold) {
            allSimilar = false;
            break;
          }
        }
        if (allSimilar) {
          similarInputFailCount = tail.length;
        }
      }
    }

    // 偵測模式 C：跨工具 A -> B -> A -> B 乒乓交替且持續發生錯誤
    let alternatingLoop = false;
    if (recent.length >= 4) {
      const last4 = recent.slice(-4);
      const isPingPong =
        last4[0].toolName === last4[2].toolName &&
        last4[1].toolName === last4[3].toolName &&
        last4[0].toolName !== last4[1].toolName &&
        last4.filter((h) => h.isError).length >= 2;
      if (isPingPong) {
        alternatingLoop = true;
      }
    }

    const isStagnant =
      repeatedFingerprintCount >= this.threshold ||
      similarInputFailCount >= this.threshold ||
      alternatingLoop;

    if (!isStagnant) {
      return { stagnant: false, exempt: false };
    }

    state.interventionCount += 1;
    const tier = Math.min(3, state.interventionCount);

    let patternType = 'repeated_error_fingerprint';
    if (alternatingLoop) patternType = 'cross_tool_ping_pong';
    else if (similarInputFailCount >= this.threshold) patternType = 'approximate_input_retry';

    const additionalContext = [
      `[Recursive-Harness 停滯偵測介入（第 ${tier} 級 / 模式：${patternType}）]`,
      `系統偵測到近期工具呼叫陷入無進展迴圈（工具：${event.toolName}${errorFingerprint ? `，錯誤指紋：${errorFingerprint}` : ''}）。`,
      '請立即停止微調相同指令重試，改採以下步驟：',
      '1. 先檢查前置假設（檔案路徑、型別契約或環境權限）是否不成立。',
      '2. 切換替代工具或先讀取完整上下文再重新規劃。',
    ];

    if (tier >= 2 && event.agent?.ctx?.systemPrompt?.section) {
      // 第 2 級介入：動態更新 agent.ctx 之 systemPrompt section，於下一 LLM step 生效
      event.agent.ctx.systemPrompt.section({
        name: 'recursive-harness:stagnation-override',
        order: this.sectionOrder,
        text: [
          '<!-- recursive-harness:stagnation-override -->',
          '## 執行期停滯強制轉向指引',
          `- 已偵測到停滯模式：\`${patternType}\`（工具：\`${event.toolName}\`）。`,
          '- 嚴禁繼續以近似參數重複呼叫失敗工具；請先驗證輸入契約或改用唯讀診斷工具。',
        ].join('\n'),
        interpolate: false,
      });
      additionalContext.push(
        '（系統已同步更新下一輪 System Prompt 之 `recursive-harness:stagnation-override` 區段以輔助轉向。）',
      );
    }

    let recommendNewSession = false;
    if (tier >= 3) {
      // 第 3 級介入：當現有 Session 之 preset 或長歷史已造成鎖定，建議切換/分叉新 Session
      recommendNewSession = true;
      additionalContext.push(
        '3. [第 3 級建議] 目前 Session 歷史可能已鎖定錯誤假設，建議執行 `/harness start` 或開啟新 Session 套用演進後之 Harness。',
      );
    }

    return {
      stagnant: true,
      exempt: false,
      tier,
      patternType,
      errorFingerprint,
      recommendNewSession,
      additionalContext: additionalContext.join('\n'),
    };
  }
}
