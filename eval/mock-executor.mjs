// 測試專用模擬探針執行器（不發布到 npm，package.json 的 files 不含 eval/）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 測試專用模擬執行器：不呼叫任何模型，只依候選 harness 裡有沒有特定文字決定輸出；僅供單元測試與管線演練，不得用來宣稱任何評測結果
 * 執行器會真實讀取隔離 DSH_HOME 下之 candidate-harness 檔案（systemprompt.md, LongTermMEMORY.md, skills/*）
 * 與工作區中之任務輸入檔，並根據實際掛載之 Harness 能力產生對應之 --json 事件流。
 *
 * @param {{ seed?: string }} [options]
 */
export function createMockProbeExecutor(options = {}) {
  const baseSeed = options.seed || 'dsh-v2-eval-seed';

  return async ({ runId, task, dshHome, workspaceDir, harnessDir }) => {
    // 1. 驗證隔離目錄與 apply-only 設定確實存在
    const patchPath = path.join(dshHome, 'profiles', 'headless', 'cordis.patch.yml');
    const patchContent = fs.existsSync(patchPath)
      ? fs.readFileSync(patchPath, 'utf8')
      : '';
    const isApplyOnly = patchContent.includes('mode: apply-only');

    // 2. 讀取實際寫入隔離環境之 Harness 元件與技能
    const sysPrompt = fs.existsSync(path.join(harnessDir, 'systemprompt.md'))
      ? fs.readFileSync(path.join(harnessDir, 'systemprompt.md'), 'utf8')
      : '';
    const toolGuidance = fs.existsSync(path.join(harnessDir, 'tool_guidance.md'))
      ? fs.readFileSync(path.join(harnessDir, 'tool_guidance.md'), 'utf8')
      : '';
    const memoryText = fs.existsSync(path.join(harnessDir, 'LongTermMEMORY.md'))
      ? fs.readFileSync(path.join(harnessDir, 'LongTermMEMORY.md'), 'utf8')
      : '';
    const skillsDir = path.join(harnessDir, 'skills');
    const mountedSkillNames = fs.existsSync(skillsDir)
      ? fs.readdirSync(skillsDir).filter((name) =>
          fs.existsSync(path.join(skillsDir, name, 'SKILL.md')),
        )
      : [];

    const hasContractChecklist =
      sysPrompt.includes('任務執行前與輸出前契約檢查') ||
      sysPrompt.includes('逐項核對題目要求之欄位名稱');
    const hasConciseToolGuidance = toolGuidance.includes('一次解析完畢再作答');
    const hasGeneralDomainSkill =
      mountedSkillNames.includes('structured-contract-verifier') ||
      memoryText.includes('結構化資料與邊界條件領域規範');
    const hasExperienceReference =
      sysPrompt.includes('借鏡跨任務經驗') ||
      memoryText.includes('套用經驗庫');

    // 利用 runId 與 taskId 計算確定性雜湊（模擬真實溫度 > 0 下之基準波動 Base Variance）
    const runHash = crypto
      .createHash('sha256')
      .update(`${baseSeed}::${task.taskId}::${runId}`, 'utf8')
      .digest();
    const roll = runHash[0] / 255; // 0.0 .. 1.0

    // 計算組裝之輸出內容
    const outputObj = { ...task.expected };
    let stepCount = 3;
    let toolErrors = 0;
    let inputTokens = 950;
    let outputTokens = 260;

    {
      // A 組（General 任務）
      if (!hasContractChecklist && !hasGeneralDomainSkill) {
        stepCount = 4;
        inputTokens = 1180;
        if (task.taskId === 'gen-dev-01') {
          // Base 在 gen-dev-01 具有波動：約 1/3 機率完全正確，2/3 機率漏算 portSum
          if (roll >= 0.34) {
            delete outputObj.portSum;
          }
        } else if (task.taskId === 'gen-dev-02') {
          // Base 未排除 /healthz 導致 validRequests 與 errorRatePct 偏差
          outputObj.validRequests = 8;
          outputObj.errorRatePct = 37.5;
          toolErrors = 1;
        } else if (task.taskId === 'gen-dev-03') {
          if (roll >= 0.5) {
            outputObj.buildOrder = ['core-types', 'storage', 'logger', 'cli'];
          }
        } else if (task.taskId === 'gen-hold-01') {
          // Base 將損毀檔案也計入 verifiedTotalBytes
          outputObj.verifiedTotalBytes = 2450;
        } else if (task.taskId === 'gen-hold-02') {
          if (roll >= 0.35) {
            outputObj.breakingFields = ['legacyCode', 'amount']; // 未依欄位名排序
          }
        }
      } else if (hasContractChecklist && !hasGeneralDomainSkill) {
        stepCount = hasConciseToolGuidance ? 2 : 3;
        inputTokens = 920;
        if (task.taskId === 'gen-hold-01' && !hasExperienceReference) {
          // 若無結構化加總不變量技能，在 held-out 的 verifiedTotalBytes 仍可能誤加
          outputObj.verifiedTotalBytes = 2450;
        }
      } else if (!hasContractChecklist && hasGeneralDomainSkill) {
        stepCount = 3;
        inputTokens = 960;
        if (task.taskId === 'gen-hold-02' && !hasExperienceReference) {
          outputObj.breakingFields = ['legacyCode', 'amount'];
        }
      } else {
        // Composed（General + Domain）：完整通過所有結構化契約與加總不變量
        stepCount = hasExperienceReference ? 1 : hasConciseToolGuidance ? 2 : 3;
        inputTokens = hasExperienceReference ? 700 : 880;
        outputTokens = hasExperienceReference ? 175 : 195;
      }
    }

    const inputFiles = Object.keys(task.workspaceFiles || {});
    const targetFile = inputFiles[0] || 'input.json';

    const events = [
      {
        type: 'session',
        sessionId: `sess-${runId}`,
        cwd: workspaceDir,
        applyOnlyVerified: isApplyOnly,
      },
      { type: 'status', phase: 'turn_start', turn: 1 },
      { type: 'status', phase: 'step_start', turn: 1, step: 1 },
      {
        type: 'thinking',
        text: `正在讀取 ${targetFile}（掛載技能：${mountedSkillNames.join(',') || 'none'}）`,
      },
      {
        type: 'tool_call',
        callId: 'call-1',
        tool: 'read_file',
        input: { path: targetFile },
      },
      {
        type: 'tool_result',
        callId: 'call-1',
        status: 'completed',
        result: fs.existsSync(path.join(workspaceDir, targetFile))
          ? fs.readFileSync(path.join(workspaceDir, targetFile), 'utf8').slice(0, 200)
          : '{}',
      },
      {
        type: 'status',
        phase: 'step_end',
        turn: 1,
        step: 1,
        usage: {
          inputTokens: Math.floor(inputTokens / 2),
          outputTokens: Math.floor(outputTokens / 2),
          totalTokens: Math.floor((inputTokens + outputTokens) / 2),
        },
      },
    ];

    if (toolErrors > 0) {
      events.push(
        { type: 'status', phase: 'step_start', turn: 1, step: 2 },
        {
          type: 'tool_call',
          callId: 'call-err-1',
          tool: 'grep',
          input: { pattern: 'invalid([' },
        },
        {
          type: 'tool_result',
          callId: 'call-err-1',
          status: 'error',
          result: 'Regex syntax error: unterminated character class at line 1',
        },
        {
          type: 'status',
          phase: 'step_end',
          turn: 1,
          step: 2,
          usage: {
            inputTokens: 220,
            outputTokens: 60,
            totalTokens: 280,
          },
        },
      );
    }

    events.push(
      { type: 'status', phase: 'step_start', turn: 1, step: stepCount },
      {
        type: 'text',
        text: JSON.stringify(outputObj, null, 2),
      },
      {
        type: 'status',
        phase: 'step_end',
        turn: 1,
        step: stepCount,
        usage: {
          inputTokens: Math.ceil(inputTokens / 2),
          outputTokens: Math.ceil(outputTokens / 2),
          totalTokens: Math.ceil((inputTokens + outputTokens) / 2),
        },
      },
      { type: 'status', phase: 'turn_end', turn: 1, reason: 'completed' },
      {
        type: 'final',
        text: JSON.stringify(outputObj, null, 2),
      },
    );

    return {
      events,
      rawStdout: events.map((e) => JSON.stringify(e)).join('\n'),
      exitCode: 0,
    };
  };
}
