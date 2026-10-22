// Headless --json 事件流解析器、軌跡重建與錯誤指紋計算
import crypto from 'node:crypto';

/**
 * 計算工具錯誤之穩定指紋（忽略動態時間戳、行號與隨機暫存路徑）
 * @param {string} toolName
 * @param {string} errorMessage
 * @returns {string}
 */
export function computeErrorFingerprint(toolName, errorMessage) {
  const normalizedError = String(errorMessage ?? '')
    .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>')
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, '<WIN_PATH>')
    .replace(/\/tmp\/[^\s"'`]+/g, '<TMP_PATH>')
    .replace(/\bline\s+\d+\b/gi, 'line <N>')
    .replace(/\b\d{4,}\b/g, '<NUM>')
    .trim()
    .toLowerCase();

  const digest = crypto
    .createHash('sha1')
    .update(`${toolName}::${normalizedError}`, 'utf8')
    .digest('hex')
    .slice(0, 10);

  return `${toolName}:${digest}`;
}

/**
 * 判斷工具錯誤是否屬於「Headless 權限拒絕（ask-denied）」而非候選 Harness 本身之邏輯失敗
 * @param {string} errorText
 * @returns {boolean}
 */
export function isPermissionAskDeniedError(errorText) {
  const text = String(errorText ?? '');
  return /permission\s+denied|approval\s+required|non-interactive|ask\s+denied|requires\s+user\s+confirmation|未授權|需要使用者確認/i.test(
    text,
  );
}

/**
 * 解析 dsh --profile headless --json 輸出之 NDJSON 字串或事件陣列為 ExecutionRecord
 * @param {string | Array<Record<string, any>>} rawInput
 * @param {{
 *   runId?: string,
 *   taskId?: string,
 *   harnessVersionId?: string,
 *   wallClockMs?: number
 * }} [meta]
 */
export function parseHeadlessJsonStream(rawInput, meta = {}) {
  const events = [];
  const parseErrors = [];

  if (Array.isArray(rawInput)) {
    events.push(...rawInput);
  } else {
    const lines = String(rawInput ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith('{')) continue;
      try {
        events.push(JSON.parse(line));
      } catch (err) {
        parseErrors.push({ lineIndex: i, line, error: err.message });
      }
    }
  }

  let sessionId = null;
  let cwd = null;
  let currentTurn = 0;
  let currentStep = 0;
  let terminationReason = 'unknown';

  const turns = new Map();
  const toolCallsById = new Map();
  const toolCalls = [];
  const toolErrors = [];
  const askDeniedCalls = [];
  const thinkingChunks = [];
  const textChunks = [];
  let finalOutput = '';
  const streamErrors = [];

  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    stepsWithUsage: 0,
  };

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;

    switch (ev.type) {
      case 'session': {
        sessionId = ev.sessionId ?? sessionId;
        cwd = ev.cwd ?? cwd;
        break;
      }

      case 'status': {
        if (typeof ev.turn === 'number') currentTurn = ev.turn;
        if (typeof ev.step === 'number') currentStep = ev.step;
        if (!turns.has(currentTurn)) {
          turns.set(currentTurn, { turn: currentTurn, steps: 0, reason: null });
        }
        const turnInfo = turns.get(currentTurn);
        if (ev.phase === 'step_start' || ev.phase === 'step_end') {
          turnInfo.steps = Math.max(turnInfo.steps, currentStep);
        }
        if (ev.phase === 'step_end' && ev.usage && typeof ev.usage === 'object') {
          const inTok = Number(ev.usage.inputTokens) || 0;
          const outTok = Number(ev.usage.outputTokens) || 0;
          const totTok = Number(ev.usage.totalTokens) || inTok + outTok;
          usage.inputTokens += inTok;
          usage.outputTokens += outTok;
          usage.totalTokens += totTok;
          usage.cacheReadTokens += Number(ev.usage.cacheReadTokens) || 0;
          usage.cacheWriteTokens += Number(ev.usage.cacheWriteTokens) || 0;
          usage.reasoningTokens += Number(ev.usage.reasoningTokens) || 0;
          usage.stepsWithUsage += 1;
        }
        if (ev.phase === 'turn_end' && ev.reason) {
          turnInfo.reason = ev.reason;
          terminationReason = ev.reason;
        }
        break;
      }

      case 'thinking': {
        if (typeof ev.text === 'string') {
          thinkingChunks.push(ev.text);
        }
        break;
      }

      case 'text': {
        if (typeof ev.text === 'string') {
          textChunks.push(ev.text);
        }
        break;
      }

      case 'tool_call': {
        const record = {
          callId: ev.callId ?? `call-${toolCalls.length + 1}`,
          turn: currentTurn,
          step: currentStep,
          tool: ev.tool ?? 'unknown',
          input: ev.input ?? {},
          status: 'pending',
          result: null,
          errorFingerprint: null,
          askDenied: false,
        };
        toolCalls.push(record);
        toolCallsById.set(record.callId, record);
        break;
      }

      case 'tool_result': {
        const target = toolCallsById.get(ev.callId);
        const status = ev.status === 'error' ? 'error' : 'completed';
        const resultText = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '');
        if (target) {
          target.status = status;
          target.result = resultText;
          if (status === 'error') {
            target.errorFingerprint = computeErrorFingerprint(target.tool, resultText);
            target.askDenied = isPermissionAskDeniedError(resultText);
            toolErrors.push(target);
            if (target.askDenied) {
              askDeniedCalls.push(target);
            }
          }
        } else {
          const orphan = {
            callId: ev.callId ?? `orphan-${toolCalls.length + 1}`,
            turn: currentTurn,
            step: currentStep,
            tool: 'unknown',
            input: {},
            status,
            result: resultText,
            errorFingerprint: status === 'error' ? computeErrorFingerprint('unknown', resultText) : null,
            askDenied: status === 'error' ? isPermissionAskDeniedError(resultText) : false,
          };
          toolCalls.push(orphan);
          if (status === 'error') {
            toolErrors.push(orphan);
            if (orphan.askDenied) askDeniedCalls.push(orphan);
          }
        }
        break;
      }

      case 'final': {
        if (typeof ev.text === 'string') {
          finalOutput = ev.text;
        }
        if (terminationReason === 'unknown') {
          terminationReason = 'completed';
        }
        break;
      }

      case 'error': {
        streamErrors.push(String(ev.message ?? 'unknown error'));
        terminationReason = 'error';
        break;
      }

      default:
        break;
    }
  }

  if (!finalOutput && textChunks.length > 0) {
    finalOutput = textChunks.join('');
  }

  const totalSteps = Array.from(turns.values()).reduce((acc, t) => acc + t.steps, 0) ||
    Math.max(currentStep, toolCalls.length > 0 ? 1 : 0);

  return {
    runId: meta.runId ?? `run-${Date.now()}`,
    taskId: meta.taskId ?? 'unknown-task',
    harnessVersionId: meta.harnessVersionId ?? 'unknown-harness',
    sessionId,
    cwd,
    turnCount: turns.size || (events.length > 0 ? 1 : 0),
    stepCount: totalSteps,
    toolCalls,
    toolCallCount: toolCalls.length,
    toolErrorCount: toolErrors.length,
    errorFingerprints: [...new Set(toolErrors.map((e) => e.errorFingerprint).filter(Boolean))],
    askDeniedCount: askDeniedCalls.length,
    thinkingText: thinkingChunks.join(''),
    finalOutput,
    streamErrors,
    parseErrors,
    usage,
    wallClockMs: Number(meta.wallClockMs) || 0,
    terminationReason,
    eventsCount: events.length,
  };
}
