// Propose → Probe → Compose (PPC) 核心協調器、三層證據比較器与等算力評測支援
import {
  EVOLUTION_STATES,
} from './types.js';
import {
  computeHarnessHash,
} from './harness-loader.js';
import {
  validateCandidateProposal,
} from './security.js';

/**
 * 三層證據比較器（Comparator）
 * 第 1 層：客觀契約檢查（Objective Check，最高優先權，不可被模型偏好推翻）
 * 第 2 層：行為與效率指標（Behavioral Metrics：錯誤指紋數、步數、Token 消耗）
 * 第 3 層：模型裁判或啟發式細分（Model Judge，僅在客觀檢查通過且平手時輔助）
 */
export class Comparator {
  /**
   * @param {{
   *   judgeFn?: (a: any, b: any, task: any) => Promise<{ winner: 'a' | 'b' | 'tie', reason: string }>
   * }} [options]
   */
  constructor(options = {}) {
    this.judgeFn = options.judgeFn || null;
  }

  /**
   * 評估單次 ExecutionRecord
   * @param {any} executionRecord
   * @param {any} task
   */
  evaluateRecord(executionRecord, task) {
    // 若因 headless 權限詢問被拒，單獨標記為 ask_denied，不混同一般邏輯錯誤
    if (executionRecord.askDeniedCount > 0) {
      return {
        passedObjective: false,
        objectiveScore: 0,
        behavioralScore: 0,
        compositeScore: 0,
        failureCategory: 'ask_denied',
        details: [`工具呼叫遭非互動模式權限拒絕（askDeniedCount=${executionRecord.askDeniedCount}）`],
      };
    }

    let passedObjective = true;
    let objectiveScore = 1.0;
    const details = [];

    if (typeof task?.objectiveCheck === 'function') {
      const checkRes = task.objectiveCheck(executionRecord, task);
      passedObjective = Boolean(checkRes?.passed);
      objectiveScore = Number.isFinite(checkRes?.score)
        ? Number(checkRes.score)
        : passedObjective
          ? 1.0
          : 0.0;
      if (Array.isArray(checkRes?.details)) {
        details.push(...checkRes.details);
      } else if (checkRes?.reason) {
        details.push(String(checkRes.reason));
      }
    } else {
      // 無客觀檢查器之任務，至少須正常完成且無未恢復之串流錯誤
      passedObjective =
        executionRecord.terminationReason !== 'error' &&
        executionRecord.streamErrors.length === 0 &&
        Boolean(String(executionRecord.finalOutput || '').trim());
      objectiveScore = passedObjective ? 1.0 : 0.0;
    }

    // 計算行為指標分數（0..1）：錯誤越少、步數越精簡、Token 越省分數越高
    const errorPenalty = Math.min(0.6, (executionRecord.toolErrorCount || 0) * 0.2);
    const stepPenalty = Math.min(0.25, Math.max(0, (executionRecord.stepCount || 1) - 1) * 0.04);
    const tokenPenalty = Math.min(
      0.15,
      ((executionRecord.usage?.totalTokens || 0) / 10000) * 0.05,
    );
    const behavioralScore = Math.max(0, Number((1.0 - errorPenalty - stepPenalty - tokenPenalty).toFixed(4)));

    // 關鍵不變量：若未通過客觀契約檢查，總分上限鎖死在 < 1.0，絕不可能擊敗任何通過客觀檢查之版本
    const compositeScore = passedObjective
      ? Number((1.0 + objectiveScore + behavioralScore * 0.5).toFixed(4))
      : Number((objectiveScore * 0.5 + behavioralScore * 0.1).toFixed(4));

    return {
      passedObjective,
      objectiveScore,
      behavioralScore,
      compositeScore,
      failureCategory: passedObjective ? null : 'objective_contract_failed',
      details,
    };
  }

  /**
   * 計算多筆基準執行之統計摘要與變異量（Base Variance）
   * @param {Array<any>} baseEvaluations
   */
  summarizeBaseline(baseEvaluations) {
    if (!Array.isArray(baseEvaluations) || baseEvaluations.length === 0) {
      return {
        passRate: 0,
        meanCompositeScore: 0,
        stdDevCompositeScore: 0,
        allPassed: false,
      };
    }

    const scores = baseEvaluations.map((e) => e.compositeScore);
    const passCount = baseEvaluations.filter((e) => e.passedObjective).length;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance =
      scores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / scores.length;
    const stdDev = Math.sqrt(variance);

    return {
      passRate: Number((passCount / baseEvaluations.length).toFixed(4)),
      meanCompositeScore: Number(mean.toFixed(4)),
      stdDevCompositeScore: Number(stdDev.toFixed(4)),
      allPassed: passCount === baseEvaluations.length,
    };
  }

  /**
   * 比較候選評估結果是否顯著優於基準（扣除基準自然波動）
   * @param {ReturnType<Comparator['evaluateRecord']>} candidateEval
   * @param {ReturnType<Comparator['summarizeBaseline']>} baseSummary
   * @param {{ minDelta?: number }} [options]
   */
  compareAgainstBaseline(candidateEval, baseSummary, options = {}) {
    // 規則 1：客觀檢查未通過者一律拒絕採用（即使語言風格或 LLM Judge 偏好它）
    if (!candidateEval.passedObjective) {
      return {
        isBetter: false,
        scoreDelta: Number((candidateEval.compositeScore - baseSummary.meanCompositeScore).toFixed(4)),
        reason: `未通過客觀契約檢查（${candidateEval.details.join('；') || candidateEval.failureCategory}）`,
      };
    }

    const scoreDelta = Number(
      (candidateEval.compositeScore - baseSummary.meanCompositeScore).toFixed(4),
    );
    const varianceMargin = Math.max(options.minDelta ?? 0.02, baseSummary.stdDevCompositeScore);

    // 規則 2：若基準並非每次都通過客觀檢查（passRate < 1），而候選通過客觀檢查，視為顯著改善
    if (baseSummary.passRate < 1.0 && candidateEval.passedObjective) {
      return {
        isBetter: true,
        scoreDelta,
        reason: `基準通過率僅 ${(baseSummary.passRate * 100).toFixed(0)}%，候選方案通過客觀契約檢查（+${scoreDelta.toFixed(3)}）`,
      };
    }

    // 規則 3：基準已通過時，候選之分數提升必須大於基準自然變異邊界（varianceMargin）
    if (scoreDelta > varianceMargin) {
      return {
        isBetter: true,
        scoreDelta,
        reason: `候選綜合分數提升 +${scoreDelta.toFixed(3)}，超越基準變異邊界（${varianceMargin.toFixed(3)}）`,
      };
    }

    return {
      isBetter: false,
      scoreDelta,
      reason: `候選分數變化（${scoreDelta >= 0 ? '+' : ''}${scoreDelta.toFixed(3)}）未超越基準自然變異邊界（${varianceMargin.toFixed(3)}）`,
    };
  }
}

/**
 * 模板提案器（Proposer）：依據參考軌跡失敗模式與歷史經驗庫，用固定模板生成 General 與 Domain 兩軸之候選變更。
 * 不呼叫模型；正式用途請改用 LlmProposer（customProposeFn）。
 */
export class Proposer {
  /**
   * @param {{
   *   experienceLibrary?: import('./experience.js').ExperienceLibrary,
   *   customProposeFn?: (ctx: any) => Promise<Array<any>>
   * }} [options]
   */
  constructor(options = {}) {
    this.experienceLibrary = options.experienceLibrary || null;
    this.customProposeFn = options.customProposeFn || null;
  }

  /**
   * 生成候選 Harness 提案
   * @param {{
   *   task: any,
   *   baseHarness: any,
   *   referenceRecords: Array<any>,
   *   referenceEvaluations: Array<any>,
   *   kPerAxis?: number,
   *   maxSequenceIndex?: number,
   *   excludeExperienceTaskIds?: string[],
   *   disableExperience?: boolean
   * }} context
   */
  async propose(context) {
    const {
      task,
      baseHarness,
      referenceRecords = [],
      referenceEvaluations = [],
      kPerAxis = 1,
      maxSequenceIndex,
      excludeExperienceTaskIds = [],
      disableExperience = false,
    } = context;

    if (typeof this.customProposeFn === 'function') {
      return await this.customProposeFn(context);
    }

    // 檢索跨任務經驗庫（嚴格遵守時間序快照 maxSequenceIndex）
    const experiences =
      !disableExperience && this.experienceLibrary
        ? this.experienceLibrary.queryRelevantExperiences({
            domain: task.domain,
            taskType: task.taskTypes?.[0],
            keywords: task.keywords,
            errorFingerprints: referenceRecords.flatMap((r) => r.errorFingerprints || []),
            maxSequenceIndex,
            excludeTaskIds: [task.taskId, ...excludeExperienceTaskIds],
            limit: 3,
          })
        : [];

    const failedDetails = referenceEvaluations
      .flatMap((e) => e.details || [])
      .filter(Boolean);

    const proposals = [];

    for (let idx = 0; idx < kPerAxis; idx++) {
      // 1. General 候選提案：強化契約自檢清單、結構化輸出與工具呼叫紀律
      const generalComponents = { ...baseHarness.components };
      const checklistLines = [
        '',
        `## 任務執行前與輸出前契約檢查（General Proposal #${idx + 1}）`,
        '- 輸出最終結果前，必須逐項核對題目要求之欄位名稱、型別、排序規則與數值精確度。',
        '- 嚴格輸出純淨格式（例如要求 JSON 時禁止夾帶未閉合說明或遺漏必填鍵值）。',
        '- 呼叫工具前先確認路徑與參數有效，避免重複無效呼叫。',
      ];
      if (failedDetails.length > 0) {
        checklistLines.push(
          `- 針對基準執行發現之缺失進行強制預檢：${failedDetails.slice(0, 3).join('；')}`,
        );
      }
      if (experiences.length > 0) {
        checklistLines.push(
          `- 借鏡跨任務經驗（${experiences.map((e) => e.entryId).join(', ')}）：優先執行結構化欄位與邊界條件自檢。`,
        );
      }

      generalComponents.systemprompt = `${baseHarness.components.systemprompt}\n${checklistLines.join('\n')}`.trim();
      generalComponents.tool_guidance = `${baseHarness.components.tool_guidance}\n- 若單次讀取即可取得完整結構，請一次解析完畢再作答，減少冗餘步驟。`.trim();

      const generalSkills = [...(baseHarness.skills || [])];
      const generalMeta = computeHarnessHash({
        components: generalComponents,
        skills: generalSkills,
      });

      proposals.push({
        proposalId: `prop-general-${idx + 1}-${generalMeta.versionId}`,
        axis: 'general',
        rationale:
          failedDetails.length > 0
            ? `針對基準缺失（${failedDetails[0]}）強化輸出契約檢查清單与工具步驟精簡度`
            : '強化輸出前契約自檢清單與工具呼叫精確度',
        harnessVersion: {
          versionId: generalMeta.versionId,
          hash: generalMeta.hash,
          parentVersionId: baseHarness.versionId,
          createdAt: new Date().toISOString(),
          components: generalComponents,
          skills: generalSkills,
        },
        usedExperienceIds: experiences.map((e) => e.entryId),
      });

      // 2. Domain 候選提案：注入領域記憶指引與一個領域技能（模板版只有通用的結構化資料領域；
      //    真正的領域提案由 LLM 提案器產生）
      const domainComponents = { ...baseHarness.components };
      const domainSkills = [...(baseHarness.skills || [])].map((s) => ({ ...s }));

      const domainGuidance = [
        '',
        `## 結構化資料與邊界條件領域規範（Domain Proposal #${idx + 1}）`,
        '- 解析輸入資料時，明確處理空值、重複鍵值、極端數值與排序穩定性（Tie-breaking）。',
        '- 產生報表或設定轉換時，確保所有彙總計數（Totals / Subtotals）與明細加總完全一致。',
      ];
      if (experiences.length > 0) {
        domainGuidance.push(
          `- 套用經驗庫（${experiences.map((e) => e.entryId).join(', ')}）之結構化驗證規則。`,
        );
      }
      domainComponents.longTermMemory = `${baseHarness.components.longTermMemory || ''}\n${domainGuidance.join('\n')}`.trim();

      const skillName = 'structured-contract-verifier';
      const skillContent = [
        '---',
        `name: ${skillName}`,
        'description: 結構化資料轉換、數值彙總與不變量驗算技能',
        '---',
        '# 結構化契約驗算技能',
        '1. 驗證輸出 JSON 之所有必填鍵值與型別。',
        '2. 驗證總計（total）是否嚴格等於各分項之加總。',
        '3. 驗證排序順序與邊界條件。',
      ].join('\n');

      const existingSkillIdx = domainSkills.findIndex((s) => s.name === skillName);
      const skillObj = {
        name: skillName,
        folderName: skillName,
        description: '結構化資料轉換、數值彙總與不變量驗算技能',
        content: skillContent,
        scripts: {},
      };
      if (existingSkillIdx >= 0) {
        domainSkills[existingSkillIdx] = skillObj;
      } else {
        domainSkills.push(skillObj);
      }

      const domainMeta = computeHarnessHash({
        components: domainComponents,
        skills: domainSkills,
      });

      proposals.push({
        proposalId: `prop-domain-${idx + 1}-${domainMeta.versionId}`,
        axis: 'domain',
        rationale: '注入結構化資料轉換與數值加總不變量驗算技能',
        harnessVersion: {
          versionId: domainMeta.versionId,
          hash: domainMeta.hash,
          parentVersionId: baseHarness.versionId,
          createdAt: new Date().toISOString(),
          components: domainComponents,
          skills: domainSkills,
        },
        usedExperienceIds: experiences.map((e) => e.entryId),
      });
    }

    return proposals;
  }
}

/**
 * 組合器（Composer）：合併通過驗證之 General 與 Domain 候選變更
 */
export class Composer {
  /**
   * 合併多個通過驗證之候選方案
   * @param {any} baseHarness
   * @param {Array<{ proposal: any, evaluation: any }>} winningCandidates
   */
  compose(baseHarness, winningCandidates) {
    if (!Array.isArray(winningCandidates) || winningCandidates.length === 0) {
      return null;
    }
    if (winningCandidates.length === 1) {
      return {
        composedHarness: winningCandidates[0].proposal.harnessVersion,
        isMultiCandidateCompose: false,
        sourceProposalIds: [winningCandidates[0].proposal.proposalId],
        summary: `單一勝出候選（${winningCandidates[0].proposal.axis}）直接進入驗證`,
      };
    }

    const mergedComponents = { ...baseHarness.components };
    const skillMap = new Map();
    for (const s of baseHarness.skills || []) {
      skillMap.set(s.name, { ...s });
    }

    const sourceProposalIds = [];
    for (const item of winningCandidates) {
      const cand = item.proposal.harnessVersion;
      sourceProposalIds.push(item.proposal.proposalId);

      // General 提案優先更新 systemprompt / tool_guidance，Domain 提案優先更新 longTermMemory 與 skills
      if (item.proposal.axis === 'general') {
        if (cand.components.systemprompt !== baseHarness.components.systemprompt) {
          mergedComponents.systemprompt = cand.components.systemprompt;
        }
        if (cand.components.tool_guidance !== baseHarness.components.tool_guidance) {
          mergedComponents.tool_guidance = cand.components.tool_guidance;
        }
      } else {
        if (cand.components.longTermMemory !== baseHarness.components.longTermMemory) {
          mergedComponents.longTermMemory = cand.components.longTermMemory;
        }
        if (cand.components.guardrails !== baseHarness.components.guardrails) {
          mergedComponents.guardrails = cand.components.guardrails;
        }
      }

      for (const s of cand.skills || []) {
        skillMap.set(s.name, { ...s });
      }
    }

    const mergedSkills = Array.from(skillMap.values());
    const { hash, versionId } = computeHarnessHash({
      components: mergedComponents,
      skills: mergedSkills,
    });

    return {
      composedHarness: {
        versionId,
        hash,
        parentVersionId: baseHarness.versionId,
        createdAt: new Date().toISOString(),
        components: mergedComponents,
        skills: mergedSkills,
      },
      isMultiCandidateCompose: true,
      sourceProposalIds,
      summary: `合併 ${winningCandidates.map((w) => w.proposal.axis).join(' + ')} 候選優勢變更（${versionId}）`,
    };
  }
}

/**
 * 雙層遞迴協調器（RecursiveHarnessCoordinator）
 * 支援：
 * - 單步 PPC（Stage 1）
 * - 平行 k 候選與序列 k 步遞迴（Stage 2）
 * - 禁用 Compose 對照模式（PPC-without-Compose）
 * - 等算力 Best-of-k 對照模式
 * - 嚴格預算控制、取消與中斷點恢復
 */
export class RecursiveHarnessCoordinator {
  /**
   * @param {{
   *   probeRunner: import('./probe-runner.js').ProbeRunner,
   *   store: import('./store.js').HarnessStateStore,
   *   experienceLibrary: import('./experience.js').ExperienceLibrary,
   *   proposer?: Proposer,
   *   comparator?: Comparator,
   *   composer?: Composer,
   *   reflector?: import('./experience.js').Reflector,
   *   maxTokensPerIteration?: number,
   *   maxWallTimeMs?: number,
   *   lockedSurfaces?: string[],
   *   protectedPatterns?: string[]
   * }} deps
   */
  constructor(deps) {
    this.probeRunner = deps.probeRunner;
    this.store = deps.store;
    this.experienceLibrary = deps.experienceLibrary;
    this.proposer = deps.proposer || new Proposer({ experienceLibrary: this.experienceLibrary });
    this.comparator = deps.comparator || new Comparator();
    this.composer = deps.composer || new Composer();
    this.reflector = deps.reflector || null;
    this.maxTokensPerIteration = deps.maxTokensPerIteration ?? 120000;
    this.maxWallTimeMs = deps.maxWallTimeMs ?? 300000;
    this.lockedSurfaces = deps.lockedSurfaces;
    this.protectedPatterns = deps.protectedPatterns || [];
    /** @type {Set<string>} */
    this.cancelledRuns = new Set();
  }

  /**
   * 取消指定演進執行
   * @param {string} runId
   */
  async cancelRun(runId) {
    this.cancelledRuns.add(runId);
    const cp = this.store.getCheckpoint(runId);
    if (cp && cp.activeProbeRunIds) {
      for (const pId of cp.activeProbeRunIds) {
        await this.probeRunner.cancel(pId);
      }
    }
    if (cp) {
      this.store.saveCheckpoint(runId, {
        state: EVOLUTION_STATES.CANCELLED,
      });
    }
    await this.probeRunner.cleanupAll();
    return true;
  }

  /**
   * 執行完整 PPC 演進迴圈
   * @param {any} task
   * @param {any} initialHarness
   * @param {{
   *   runId?: string,
   *   referenceRunsCount?: number,
   *   kPerAxis?: number,
   *   sequentialSteps?: number,
   *   enableCompose?: boolean,
   *   disableExperience?: boolean,
   *   recordExperience?: boolean,
   *   taskSequenceIndex?: number,
   *   excludeExperienceTaskIds?: string[],
   *   adoptToStore?: boolean
   * }} [options]
   */
  async runPpcLoop(task, initialHarness, options = {}) {
    const runId = options.runId || `ppc-${task.taskId}-${Date.now()}`;
    const referenceRunsCount = Math.max(1, Number(options.referenceRunsCount ?? 2) || 1);
    const kPerAxis = options.kPerAxis ?? 1;
    const sequentialSteps = options.sequentialSteps ?? 1;
    const enableCompose = options.enableCompose !== false;
    const disableExperience = Boolean(options.disableExperience);
    const shouldRecordExperience = options.recordExperience !== false;
    const startTime = Date.now();

    let totalTokensUsed = 0;
    let totalProbesExecuted = 0;
    let currentHarness = initialHarness;
    let overallAdopted = false;
    const stepHistory = [];

    const checkBudgetAndCancel = () => {
      if (this.cancelledRuns.has(runId)) {
        this.store.saveCheckpoint(runId, { state: EVOLUTION_STATES.CANCELLED });
        const err = new Error(`演進執行已取消（${runId}）`);
        err.code = 'EVOLUTION_CANCELLED';
        throw err;
      }
      if (totalTokensUsed > this.maxTokensPerIteration) {
        this.store.saveCheckpoint(runId, {
          state: EVOLUTION_STATES.BUDGET_EXHAUSTED,
          totalTokensUsed,
        });
        const err = new Error(
          `演進 Token 預算耗盡（已用 ${totalTokensUsed} > 上限 ${this.maxTokensPerIteration}）`,
        );
        err.code = 'BUDGET_EXHAUSTED';
        throw err;
      }
      if (Date.now() - startTime > this.maxWallTimeMs) {
        this.store.saveCheckpoint(runId, {
          state: EVOLUTION_STATES.BUDGET_EXHAUSTED,
          wallClockMs: Date.now() - startTime,
        });
        const err = new Error(`演進時間預算耗盡（超過 ${this.maxWallTimeMs}ms）`);
        err.code = 'BUDGET_EXHAUSTED';
        throw err;
      }
    };

    // 1. Observed 狀態：建立初始快照與基準參考執行（Reference Runs）
    this.store.saveCheckpoint(runId, {
      state: EVOLUTION_STATES.OBSERVED,
      taskId: task.taskId,
      baseVersionId: currentHarness.versionId,
    });

    const referenceRecords = [];
    const referenceEvaluations = [];
    for (let i = 0; i < referenceRunsCount; i++) {
      checkBudgetAndCancel();
      const rec = await this.probeRunner.run(task, currentHarness, {
        runId: `${runId}-ref-${i + 1}`,
        autoCleanup: true,
      });
      totalProbesExecuted += 1;
      totalTokensUsed += rec.usage?.totalTokens || 0;
      referenceRecords.push(rec);
      referenceEvaluations.push(this.comparator.evaluateRecord(rec, task));
    }

    let currentBaselineSummary = this.comparator.summarizeBaseline(referenceEvaluations);

    for (let stepIdx = 0; stepIdx < sequentialSteps; stepIdx++) {
      checkBudgetAndCancel();

      // 2. Proposed 狀態：生成候選提案並驗證安全紅線
      if (stepIdx === 0) {
        this.store.saveCheckpoint(runId, { state: EVOLUTION_STATES.PROPOSED });
      }

      const rawProposals = await this.proposer.propose({
        task,
        baseHarness: currentHarness,
        referenceRecords,
        referenceEvaluations,
        kPerAxis,
        maxSequenceIndex: options.taskSequenceIndex,
        excludeExperienceTaskIds: options.excludeExperienceTaskIds,
        disableExperience,
      });

      const validProposals = [];
      const rejectedProposals = [];
      for (const prop of rawProposals) {
        const secCheck = validateCandidateProposal(
          {
            components: prop.harnessVersion?.components,
            skills: prop.harnessVersion?.skills,
          },
          this.lockedSurfaces,
          this.protectedPatterns,
        );
        if (secCheck.ok) {
          validProposals.push(prop);
        } else {
          rejectedProposals.push({
            proposal: prop,
            violations: secCheck.violations,
          });
        }
      }

      if (validProposals.length === 0) {
        if (!overallAdopted) {
          this.store.saveCheckpoint(runId, {
            state: EVOLUTION_STATES.REJECTED,
            reason: '所有候選提案皆因違反安全護欄而遭攔截',
          });
        }
        stepHistory.push({
          step: stepIdx + 1,
          proposalsCount: 0,
          rejectedBySecurityCount: rejectedProposals.length,
          probeResults: [],
          adoptedInStep: false,
          chosenVersionId: currentHarness.versionId,
          composedSummary: '所有候選提案皆因違反安全護欄而遭攔截',
        });
        break;
      }

      // 3. Probing 狀態：隔離執行各候選探針
      if (stepIdx === 0) {
        this.store.saveCheckpoint(runId, { state: EVOLUTION_STATES.PROBING });
      }

      const probeResults = await Promise.all(
        validProposals.map(async (prop, pIdx) => {
          checkBudgetAndCancel();
          const probeRunId = `${runId}-step${stepIdx + 1}-cand${pIdx + 1}`;
          const execRec = await this.probeRunner.run(task, prop.harnessVersion, {
            runId: probeRunId,
            autoCleanup: true,
          });
          totalProbesExecuted += 1;
          totalTokensUsed += execRec.usage?.totalTokens || 0;
          const evalRes = this.comparator.evaluateRecord(execRec, task);
          const vsBase = this.comparator.compareAgainstBaseline(
            evalRes,
            currentBaselineSummary,
          );
          return {
            proposalId: prop.proposalId,
            proposal: prop,
            executionRecord: execRec,
            evaluation: evalRes,
            passedObjective: evalRes.passedObjective,
            scoreDelta: vsBase.scoreDelta,
            isBetter: vsBase.isBetter,
            rejectionReason: vsBase.isBetter ? null : vsBase.reason,
          };
        }),
      );

      // 4. Compared 狀態：篩選優於基準之勝出候選
      if (stepIdx === 0) {
        this.store.saveCheckpoint(runId, { state: EVOLUTION_STATES.COMPARED });
      }

      const winners = probeResults
        .filter((r) => r.isBetter && r.passedObjective)
        .sort((a, b) => b.evaluation.compositeScore - a.evaluation.compositeScore);

      // 供 Compose 使用之正向候選：通過客觀檢查之勝出者，或（當基準尚未完全通過時）在部分客觀指標/綜合分數上有淨提升之互補候選
      const composableCandidates = probeResults
        .filter(
          (r) =>
            (r.isBetter && r.passedObjective) ||
            (currentBaselineSummary.passRate < 1.0 &&
              r.evaluation.compositeScore > currentBaselineSummary.meanCompositeScore),
        )
        .sort((a, b) => b.evaluation.compositeScore - a.evaluation.compositeScore);

      let chosenHarness = null;
      let chosenEvaluation = null;
      let composedSummary = null;

      if (enableCompose && composableCandidates.length > 1) {
        // 5. Composed 狀態：合併 General 與 Domain 互補變更，並強制重跑驗證！
        if (stepIdx === 0) {
          this.store.saveCheckpoint(runId, { state: EVOLUTION_STATES.COMPOSED });
        }
        const composed = this.composer.compose(currentHarness, composableCandidates);
        checkBudgetAndCancel();
        const composeVerifyRec = await this.probeRunner.run(
          task,
          composed.composedHarness,
          {
            runId: `${runId}-step${stepIdx + 1}-compose-verify`,
            autoCleanup: true,
          },
        );
        totalProbesExecuted += 1;
        totalTokensUsed += composeVerifyRec.usage?.totalTokens || 0;
        const composeEval = this.comparator.evaluateRecord(composeVerifyRec, task);
        const composeVsBase = this.comparator.compareAgainstBaseline(
          composeEval,
          currentBaselineSummary,
        );
        const bestSingleWinner = winners[0] || null;
        const bestSingleScore = bestSingleWinner
          ? bestSingleWinner.evaluation.compositeScore
          : 0;

        // Compose 後必須通過客觀檢查、顯著優於基準，且不退化於最佳單一合格候選
        if (
          composeEval.passedObjective &&
          composeVsBase.isBetter &&
          composeEval.compositeScore + 0.02 >= bestSingleScore
        ) {
          chosenHarness = composed.composedHarness;
          chosenEvaluation = composeEval;
          composedSummary = composed.summary;
        } else if (bestSingleWinner) {
          // 若合併後出現衝突退化，安全回退至最佳單一合格候選
          chosenHarness = bestSingleWinner.proposal.harnessVersion;
          chosenEvaluation = bestSingleWinner.evaluation;
          composedSummary = `合併驗證未達最佳單一候選水準，回退採用單一勝出候選（${bestSingleWinner.proposal.axis}）`;
        }
      } else if (winners.length > 0) {
        // 單一勝出候選或停用 Compose 時，執行一次重跑確認（Holdout Confirmation Run）
        chosenHarness = winners[0].proposal.harnessVersion;
        checkBudgetAndCancel();
        const confirmRec = await this.probeRunner.run(task, chosenHarness, {
          runId: `${runId}-step${stepIdx + 1}-confirm`,
          autoCleanup: true,
        });
        totalProbesExecuted += 1;
        totalTokensUsed += confirmRec.usage?.totalTokens || 0;
        const confirmEval = this.comparator.evaluateRecord(confirmRec, task);
        if (confirmEval.passedObjective) {
          chosenEvaluation = confirmEval;
          composedSummary = `單一勝出候選（${winners[0].proposal.axis}）通過二次驗證`;
        }
      }

      stepHistory.push({
        step: stepIdx + 1,
        proposalsCount: validProposals.length,
        rejectedBySecurityCount: rejectedProposals.length,
        probeResults,
        adoptedInStep: Boolean(chosenHarness && chosenEvaluation?.passedObjective),
        chosenVersionId: chosenHarness?.versionId || currentHarness.versionId,
        composedSummary,
      });

      if (chosenHarness && chosenEvaluation?.passedObjective) {
        currentHarness = chosenHarness;
        overallAdopted = true;
        currentBaselineSummary = this.comparator.summarizeBaseline([chosenEvaluation]);
      } else {
        // 本步無正增益，提前結束序列遞迴
        break;
      }
    }

    // 6. Validated -> Adopted / Rejected -> Reflected 狀態轉換
    const currentCp = this.store.getCheckpoint(runId);
    if (
      currentCp &&
      (currentCp.state === EVOLUTION_STATES.COMPARED ||
        currentCp.state === EVOLUTION_STATES.COMPOSED)
    ) {
      this.store.saveCheckpoint(runId, { state: EVOLUTION_STATES.VALIDATED });
    }

    let finalEvaluation = referenceEvaluations[0];
    if (overallAdopted) {
      const lastStep = stepHistory[stepHistory.length - 1];
      this.store.saveCheckpoint(runId, {
        state: EVOLUTION_STATES.ADOPTED,
        adoptedVersionId: currentHarness.versionId,
      });
      if (options.adoptToStore !== false) {
        this.store.saveHarnessSnapshot(currentHarness, {
          setActive: true,
          reason: `Adopted on task ${task.taskId} (${runId})`,
        });
      }
      // 在最終採用之 Harness 上取最後驗證分數
      const verifyRec = await this.probeRunner.run(task, currentHarness, {
        runId: `${runId}-final-eval`,
        autoCleanup: true,
      });
      totalProbesExecuted += 1;
      totalTokensUsed += verifyRec.usage?.totalTokens || 0;
      finalEvaluation = this.comparator.evaluateRecord(verifyRec, task);
    } else {
      const cpNow = this.store.getCheckpoint(runId);
      if (cpNow && cpNow.state !== EVOLUTION_STATES.REJECTED) {
        this.store.saveCheckpoint(runId, {
          state: EVOLUTION_STATES.REJECTED,
          reason: '候選方案未顯著超越基準或未通過驗證',
        });
      }
    }

    let experienceEntry = null;
    if (shouldRecordExperience && this.reflector) {
      const allProbeRecords = stepHistory.flatMap((s) => s.probeResults);
      const allProposals = stepHistory.flatMap((s) =>
        s.probeResults.map((pr) => pr.proposal),
      );
      experienceEntry = this.reflector.reflect({
        eventId: `evt-${runId}`,
        task,
        taskSequenceIndex: options.taskSequenceIndex ?? 0,
        baseHarness: initialHarness,
        finalHarness: currentHarness,
        proposals: allProposals,
        probeRecords: allProbeRecords,
        comparisonReport: {
          composedSummary: stepHistory[stepHistory.length - 1]?.composedSummary || null,
        },
        adopted: overallAdopted,
      });

      const cpAfter = this.store.getCheckpoint(runId);
      if (cpAfter && cpAfter.state === EVOLUTION_STATES.ADOPTED) {
        this.store.saveCheckpoint(runId, {
          state: EVOLUTION_STATES.REFLECTED,
          experienceEntryId: experienceEntry.entryId,
        });
      }
    }

    return {
      runId,
      taskId: task.taskId,
      adopted: overallAdopted,
      baseHarnessVersionId: initialHarness.versionId,
      finalHarnessVersionId: currentHarness.versionId,
      finalHarness: currentHarness,
      baseSummary: this.comparator.summarizeBaseline(referenceEvaluations),
      finalEvaluation,
      stepHistory,
      experienceEntry,
      totalProbesExecuted,
      totalTokensUsed,
      wallClockMs: Date.now() - startTime,
    };
  }
}
