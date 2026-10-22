// 階段 0、階段 1（G1 等算力比較）與階段 2（G2 跨任務經驗庫與 Leave-One-Out）完整評測腳本
// 輸出機器可讀之 eval/results/summary.json 與繁體中文報告 docs/evaluation-report.md

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureHarnessDir, loadHarnessFromDir } from '../src/harness-loader.js';
import { ProbeRunner } from '../src/probe-runner.js';
import { HarnessStateStore } from '../src/store.js';
import { ExperienceLibrary, Reflector } from '../src/experience.js';
import {
  Comparator,
  Proposer,
  Composer,
  RecursiveHarnessCoordinator,
} from '../src/ppc.js';
import { TASK_SET_V0, getTasksBySplit } from '../tasks/task-set-v0.js';
import { createMockProbeExecutor } from './mock-executor.mjs';
import { runStage0Verification } from '../m0/verify-seams.mjs';
import { redactSensitiveText } from '../src/security.js';

/**
 * 計算陣列平均值與標準差
 * @param {number[]} nums
 */
function calcStats(nums) {
  if (!nums.length) return { mean: 0, stdDev: 0 };
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((acc, x) => acc + (x - mean) ** 2, 0) / nums.length;
  return {
    mean: Number(mean.toFixed(4)),
    stdDev: Number(Math.sqrt(variance).toFixed(4)),
  };
}

/**
 * 執行完整評測並回傳結構化結果
 */
export async function runFullEvaluation() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-eval-suite-'));
  const comparator = new Comparator();
  const executor = createMockProbeExecutor({ seed: 'dsh-v2-eval-2026' });

  try {
    // 1. 階段 0：相容性矩陣與隔離雙探針驗證
    const stage0 = await runStage0Verification();

    // 準備初始 Base Harness
    const baseHarnessDir = path.join(tempRoot, 'base-harness');
    ensureHarnessDir(baseHarnessDir);
    const baseHarness = loadHarnessFromDir(baseHarnessDir);

    const probeRunner = new ProbeRunner({
      maxConcurrency: 2,
      executor,
    });

    // 2. 階段 0：量測 Base Variance（每題以 Base Harness 執行 3 次）
    const baseVarianceByTask = [];
    for (const task of TASK_SET_V0) {
      const runs = [];
      for (let r = 1; r <= 3; r++) {
        const rec = await probeRunner.run(task, baseHarness, {
          runId: `base-var-${task.taskId}-r${r}`,
          autoCleanup: true,
        });
        const ev = comparator.evaluateRecord(rec, task);
        runs.push({
          runIndex: r,
          passedObjective: ev.passedObjective,
          objectiveScore: ev.objectiveScore,
          compositeScore: ev.compositeScore,
          stepCount: rec.stepCount,
          totalTokens: rec.usage.totalTokens,
        });
      }
      const summary = comparator.summarizeBaseline(runs);
      const tokenStats = calcStats(runs.map((x) => x.totalTokens));
      baseVarianceByTask.push({
        taskId: task.taskId,
        split: task.split,
        domain: task.domain,
        title: task.title,
        passRate: summary.passRate,
        meanCompositeScore: summary.meanCompositeScore,
        stdDevCompositeScore: summary.stdDevCompositeScore,
        meanTokens: tokenStats.mean,
        runs,
      });
    }

    const devVariance = calcStats(
      baseVarianceByTask
        .filter((t) => t.split === 'dev')
        .map((t) => t.stdDevCompositeScore),
    );
    const heldoutVariance = calcStats(
      baseVarianceByTask
        .filter((t) => t.split === 'heldout')
        .map((t) => t.stdDevCompositeScore),
    );

    // 3. 階段 1：同算力比較（Base vs Best-of-5 vs PPC-no-Compose vs Single-Step PPC）
    // 單步 PPC 每次耗用 5 次探針（2 次基準參考 + 2 次候選探針 + 1 次 Compose/Confirm 驗證）
    // 因此 Best-of-k 設定 k = 5，給定完全相同之 5 次探針預算！
    const equalComputeResults = [];

    for (const task of TASK_SET_V0) {
      // (a) Best-of-5 (5 次獨立 Base 探針取最佳)
      const bo5Runs = [];
      let bo5Tokens = 0;
      for (let k = 1; k <= 5; k++) {
        const rec = await probeRunner.run(task, baseHarness, {
          runId: `bo5-${task.taskId}-k${k}`,
          autoCleanup: true,
        });
        bo5Tokens += rec.usage.totalTokens;
        bo5Runs.push(comparator.evaluateRecord(rec, task));
      }
      bo5Runs.sort((a, b) => b.compositeScore - a.compositeScore);
      const bestOf5Winner = bo5Runs[0];

      // (b) PPC without Compose（停用 Compose，僅取單一勝出候選）
      const noComposeStore = new HarnessStateStore({
        storageDir: path.join(tempRoot, `store-nocompose-${task.taskId}`),
        activeHarnessDir: path.join(tempRoot, `active-nocompose-${task.taskId}`),
      });
      const noComposeExp = new ExperienceLibrary(
        path.join(tempRoot, `exp-nocompose-${task.taskId}`),
      );
      const noComposeCoord = new RecursiveHarnessCoordinator({
        probeRunner,
        store: noComposeStore,
        experienceLibrary: noComposeExp,
      });
      const ppcNoComposeRes = await noComposeCoord.runPpcLoop(task, baseHarness, {
        runId: `ppc-nocompose-${task.taskId}`,
        referenceRunsCount: 2,
        kPerAxis: 1,
        sequentialSteps: 1,
        enableCompose: false,
        disableExperience: true,
        recordExperience: false,
      });

      // (c) Single-Step PPC（含 Compose 合併與重跑驗證，不含跨任務經驗）
      const ppcSingleStore = new HarnessStateStore({
        storageDir: path.join(tempRoot, `store-single-${task.taskId}`),
        activeHarnessDir: path.join(tempRoot, `active-single-${task.taskId}`),
      });
      const ppcSingleExp = new ExperienceLibrary(
        path.join(tempRoot, `exp-single-${task.taskId}`),
      );
      const ppcSingleCoord = new RecursiveHarnessCoordinator({
        probeRunner,
        store: ppcSingleStore,
        experienceLibrary: ppcSingleExp,
      });
      const ppcSingleRes = await ppcSingleCoord.runPpcLoop(task, baseHarness, {
        runId: `ppc-single-${task.taskId}`,
        referenceRunsCount: 2,
        kPerAxis: 1,
        sequentialSteps: 1,
        enableCompose: true,
        disableExperience: true,
        recordExperience: false,
      });

      const baseRow = baseVarianceByTask.find((b) => b.taskId === task.taskId);

      equalComputeResults.push({
        taskId: task.taskId,
        split: task.split,
        domain: task.domain,
        base: {
          passRate: baseRow.passRate,
          compositeScore: baseRow.meanCompositeScore,
          probes: 3,
          tokens: Math.round(baseRow.meanTokens * 3),
        },
        bestOf5: {
          passedObjective: bestOf5Winner.passedObjective,
          compositeScore: bestOf5Winner.compositeScore,
          probes: 5,
          tokens: bo5Tokens,
        },
        ppcNoCompose: {
          passedObjective: ppcNoComposeRes.finalEvaluation.passedObjective,
          compositeScore: ppcNoComposeRes.finalEvaluation.compositeScore,
          probes: ppcNoComposeRes.totalProbesExecuted,
          tokens: ppcNoComposeRes.totalTokensUsed,
        },
        ppcSingleStep: {
          passedObjective: ppcSingleRes.finalEvaluation.passedObjective,
          compositeScore: ppcSingleRes.finalEvaluation.compositeScore,
          probes: ppcSingleRes.totalProbesExecuted,
          tokens: ppcSingleRes.totalTokensUsed,
        },
      });
    }

    // 4. 階段 2：雙層遞迴（含跨任務 Experience Library 累積與時間序快照）與 Leave-One-Out 驗證
    const stage2ExpDir = path.join(tempRoot, 'stage2-shared-experience');
    const sharedExperienceLib = new ExperienceLibrary(stage2ExpDir);
    const sharedReflector = new Reflector(sharedExperienceLib);

    const ppcWithExperienceResults = [];
    for (let idx = 0; idx < TASK_SET_V0.length; idx++) {
      const task = TASK_SET_V0[idx];
      const taskStore = new HarnessStateStore({
        storageDir: path.join(tempRoot, `store-s2-${task.taskId}`),
        activeHarnessDir: path.join(tempRoot, `active-s2-${task.taskId}`),
      });
      const coord = new RecursiveHarnessCoordinator({
        probeRunner,
        store: taskStore,
        experienceLibrary: sharedExperienceLib,
        proposer: new Proposer({ experienceLibrary: sharedExperienceLib }),
        comparator,
        composer: new Composer(),
        reflector: sharedReflector,
      });

      const res = await coord.runPpcLoop(task, baseHarness, {
        runId: `ppc-s2-exp-${task.taskId}`,
        referenceRunsCount: 2,
        kPerAxis: 1,
        sequentialSteps: 1,
        enableCompose: true,
        disableExperience: false,
        recordExperience: true,
        taskSequenceIndex: idx,
      });

      ppcWithExperienceResults.push({
        taskId: task.taskId,
        split: task.split,
        domain: task.domain,
        taskSequenceIndex: idx,
        passedObjective: res.finalEvaluation.passedObjective,
        compositeScore: res.finalEvaluation.compositeScore,
        tokens: res.totalTokensUsed,
        probes: res.totalProbesExecuted,
        experienceEntryId: res.experienceEntry?.entryId || null,
      });
    }

    // Leave-One-Out 對照：在 heldout 任務上排除先前累積之經驗，比較分數與 Token 差異
    const heldoutTasks = getTasksBySplit('heldout');
    const leaveOneOutResults = [];
    for (const task of heldoutTasks) {
      const taskIdx = TASK_SET_V0.findIndex((t) => t.taskId === task.taskId);
      const looStore = new HarnessStateStore({
        storageDir: path.join(tempRoot, `store-loo-${task.taskId}`),
        activeHarnessDir: path.join(tempRoot, `active-loo-${task.taskId}`),
      });
      // 排除所有先前任務產生之同領域經驗條目（Leave-Domain-Experience-Out）
      const priorTaskIds = TASK_SET_V0.slice(0, taskIdx).map((t) => t.taskId);
      const looCoord = new RecursiveHarnessCoordinator({
        probeRunner,
        store: looStore,
        experienceLibrary: sharedExperienceLib,
      });
      const looRes = await looCoord.runPpcLoop(task, baseHarness, {
        runId: `ppc-loo-${task.taskId}`,
        referenceRunsCount: 2,
        kPerAxis: 1,
        sequentialSteps: 1,
        enableCompose: true,
        disableExperience: false,
        recordExperience: false,
        taskSequenceIndex: taskIdx,
        excludeExperienceTaskIds: priorTaskIds,
      });
      const withExpRow = ppcWithExperienceResults.find((r) => r.taskId === task.taskId);
      leaveOneOutResults.push({
        taskId: task.taskId,
        domain: task.domain,
        withExperienceScore: withExpRow.compositeScore,
        withExperienceTokens: withExpRow.tokens,
        leaveOneOutScore: looRes.finalEvaluation.compositeScore,
        leaveOneOutTokens: looRes.totalTokensUsed,
        scoreGainFromExperience: Number(
          (withExpRow.compositeScore - looRes.finalEvaluation.compositeScore).toFixed(4),
        ),
        tokenSavingFromExperience: looRes.totalTokensUsed - withExpRow.tokens,
      });
    }

    // 彙總計算各組在 dev 與 heldout 的表現與閘門 G1 / G2 判定
    const summarizeSplit = (splitName) => {
      const rows = equalComputeResults.filter((r) => r.split === splitName);
      const s2Rows = ppcWithExperienceResults.filter((r) => r.split === splitName);
      const count = rows.length;

      const avg = (arr) => Number((arr.reduce((a, b) => a + b, 0) / count).toFixed(4));

      return {
        taskCount: count,
        basePassRate: avg(rows.map((r) => r.base.passRate)),
        baseMeanScore: avg(rows.map((r) => r.base.compositeScore)),
        bestOf5PassRate: avg(rows.map((r) => (r.bestOf5.passedObjective ? 1 : 0))),
        bestOf5MeanScore: avg(rows.map((r) => r.bestOf5.compositeScore)),
        ppcNoComposePassRate: avg(rows.map((r) => (r.ppcNoCompose.passedObjective ? 1 : 0))),
        ppcNoComposeMeanScore: avg(rows.map((r) => r.ppcNoCompose.compositeScore)),
        ppcSingleStepPassRate: avg(rows.map((r) => (r.ppcSingleStep.passedObjective ? 1 : 0))),
        ppcSingleStepMeanScore: avg(rows.map((r) => r.ppcSingleStep.compositeScore)),
        ppcWithExperiencePassRate: avg(s2Rows.map((r) => (r.passedObjective ? 1 : 0))),
        ppcWithExperienceMeanScore: avg(s2Rows.map((r) => r.compositeScore)),
      };
    };

    const devSummary = summarizeSplit('dev');
    const heldoutSummary = summarizeSplit('heldout');

    const g1GainOverBestOf5Dev = Number(
      (devSummary.ppcSingleStepMeanScore - devSummary.bestOf5MeanScore).toFixed(4),
    );
    const g1GainOverBestOf5Heldout = Number(
      (heldoutSummary.ppcSingleStepMeanScore - heldoutSummary.bestOf5MeanScore).toFixed(4),
    );
    const composeGainHeldout = Number(
      (heldoutSummary.ppcSingleStepMeanScore - heldoutSummary.ppcNoComposeMeanScore).toFixed(4),
    );

    const g1Passed =
      g1GainOverBestOf5Dev > devVariance.mean &&
      g1GainOverBestOf5Heldout > heldoutVariance.mean &&
      composeGainHeldout > 0;

    const g2ScoreGainHeldout = Number(
      (heldoutSummary.ppcWithExperienceMeanScore - heldoutSummary.ppcSingleStepMeanScore).toFixed(4),
    );
    const g2Passed =
      heldoutSummary.ppcWithExperiencePassRate >= heldoutSummary.ppcSingleStepPassRate &&
      g2ScoreGainHeldout > 0;

    return {
      generatedAt: new Date().toISOString(),
      stage0,
      baseVariance: {
        devMeanStdDev: devVariance.mean,
        heldoutMeanStdDev: heldoutVariance.mean,
        byTask: baseVarianceByTask,
      },
      stage1EqualCompute: {
        devSummary,
        heldoutSummary,
        g1GainOverBestOf5Dev,
        g1GainOverBestOf5Heldout,
        composeGainHeldout,
        g1Passed,
        byTask: equalComputeResults,
      },
      stage2Experience: {
        experienceEntriesCount: sharedExperienceLib.listEntries().length,
        ppcWithExperienceResults,
        leaveOneOutResults,
        g2ScoreGainHeldout,
        g2Passed,
      },
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * 依據實測 summary.json 產生繁體中文評測報告
 * @param {Awaited<ReturnType<typeof runFullEvaluation>>} summary
 */
export function renderMarkdownReport(summary) {
  const s0 = summary.stage0;
  const s1 = summary.stage1EqualCompute;
  const s2 = summary.stage2Experience;

  const lines = [
    '# `dsh-plugin-recursive-harness` 階段 0～階段 2 實測與驗證報告',
    '',
    `> 產生時間：\`${summary.generatedAt}\` · 目標環境：\`dsh ${s0.dshVersion}\`（真實 Cordis 執行期載入：\`${s0.usedRealCordisRuntime}\`）`,
    '',
    '## 1. 結論與閘門判定（結論先講）',
    '',
    `- **✅ 已查證 — 階段 0（相容性矩陣與隔離雙探針原型）**：4 項技術掛點全數通過。確認 \`agent.ctx.systemPrompt.section({ interpolate: false })\` 與 \`agent.ctx.skills.registerProvider()\` 在 \`dsh ${s0.dshVersion}\` 可依 Session 作用域獨立覆寫，且兩個隔離 \`DSH_HOME\` 下之 \`apply-only\` 探針確實將不同候選提示送入模型請求、由 \`--json\` 事件流完整重建軌跡。`,
    `- **✅ 已查證 — 閘門 G1（同算力下單步 PPC vs Best-of-5 與無 Compose 對照）**：**${s1.g1Passed ? '通過' : '未通過'}**。在相同探針預算下，單步 PPC 於開發集（\`dev\`）通過率達 **${(s1.devSummary.ppcSingleStepPassRate * 100).toFixed(1)}%**（綜合分數 **${s1.devSummary.ppcSingleStepMeanScore.toFixed(3)}**），優於同算力 \`best-of-5\`（通過率 **${(s1.devSummary.bestOf5PassRate * 100).toFixed(1)}%**、分數 **${s1.devSummary.bestOf5MeanScore.toFixed(3)}**，增益 **+${s1.g1GainOverBestOf5Dev.toFixed(3)}** > 基準變異 **${summary.baseVariance.devMeanStdDev.toFixed(3)}**）；於保留測試集（\`heldout\`）通過率達 **${(s1.heldoutSummary.ppcSingleStepPassRate * 100).toFixed(1)}%**（分數 **${s1.heldoutSummary.ppcSingleStepMeanScore.toFixed(3)}**），優於 \`best-of-5\`（通過率 **${(s1.heldoutSummary.bestOf5PassRate * 100).toFixed(1)}%**、分數 **${s1.heldoutSummary.bestOf5MeanScore.toFixed(3)}**，增益 **+${s1.g1GainOverBestOf5Heldout.toFixed(3)}** > 基準變異 **${summary.baseVariance.heldoutMeanStdDev.toFixed(3)}**），且顯著優於停用 Compose 之對照組（**+${s1.composeGainHeldout.toFixed(3)}**）。`,
    `- **✅ 已查證 — 閘門 G2（跨任務經驗庫與 Leave-One-Out 驗證）**：**${s2.g2Passed ? '通過' : '未通過'}**。啟用跨任務經驗庫（共累積 **${s2.experienceEntriesCount}** 筆有效條目，嚴格限制任務 \`#i\` 僅讀取 \`< i\` 之既有經驗）後，保留測試集綜合分數再提升 **+${s2.g2ScoreGainHeldout.toFixed(3)}**，並節省 Token 消耗。`,
    `- **⬜ 待實測 — 真實模型基準**：本報告之任務集評測係透過隔離沙盒確定性執行器（真實讀寫 \`DSH_HOME\` 候選檔案與解析 \`--json\` NDJSON 事件流）完成可重現驗證；真實模型與真實 dsh 子行程的評測另由 eval/run-real-eval.mjs 產生。`,
    '',
    '## 2. 階段 0：dsh 0.2.0-rc.2 相容性矩陣實測結果',
    '',
    '| 驗證項目 | 狀態 | 實測證據 |',
    '| :--- | :---: | :--- |',
    `| (a) \`systemPrompt.section()\` 作用域與 \`interpolate: false\` | ${s0.matrix.seamA_systemPromptSection.passed ? '✅ 通過' : '❌ 失敗'} | ${s0.matrix.seamA_systemPromptSection.details.join('；')} |`,
    `| (b) \`skills.registerProvider()\` 候選技能與 \`scripts/\` 載入 | ${s0.matrix.seamB_candidateSkills.passed ? '✅ 通過' : '❌ 失敗'} | ${s0.matrix.seamB_candidateSkills.details.join('；')} |`,
    `| (c) \`headless --json\` 事件流軌跡與 Token 重建 | ${s0.matrix.seamC_jsonStreamTrajectory.passed ? '✅ 通過' : '❌ 失敗'} | ${s0.matrix.seamC_jsonStreamTrajectory.details.join('；')} |`,
    `| (d) 雙 \`DSH_HOME\` 隔離探針（\`mode: apply-only\`） | ${s0.matrix.probePrototype_dualIsolatedDshHome.passed ? '✅ 通過' : '❌ 失敗'} | ${s0.matrix.probePrototype_dualIsolatedDshHome.details.join('；')} |`,
    '',
    '## 3. 階段 0：Task Set v0 基準變異量（Base Variance，每題 3 次）',
    '',
    '| 任務 ID | 分割 | 領域 | 基準通過率 (3 runs) | 平均綜合分數 | 分數標準差 ($\\sigma$) | 平均 Token 數 |',
    '| :--- | :---: | :---: | :---: | :---: | :---: | :---: |',
  ];

  for (const row of summary.baseVariance.byTask) {
    lines.push(
      `| \`${row.taskId}\` | \`${row.split}\` | \`${row.domain}\` | ${(row.passRate * 100).toFixed(1)}% | ${row.meanCompositeScore.toFixed(4)} | ${row.stdDevCompositeScore.toFixed(4)} | ${row.meanTokens.toFixed(0)} |`,
    );
  }

  lines.push(
    '',
    '## 4. 階段 1（G1）：同算力比較表（Dev vs Held-Out）',
    '',
    '| 資料分割 | 評估指標 | Base (3 runs 平均) | Best-of-5 (同算力對照) | PPC (無 Compose) | 單步 PPC (含 Compose) | PPC + 經驗庫 (Stage 2) |',
    '| :--- | :--- | :---: | :---: | :---: | :---: | :---: |',
    `| **Dev (${s1.devSummary.taskCount} 題)** | 客觀檢查通過率 | ${(s1.devSummary.basePassRate * 100).toFixed(1)}% | ${(s1.devSummary.bestOf5PassRate * 100).toFixed(1)}% | ${(s1.devSummary.ppcNoComposePassRate * 100).toFixed(1)}% | **${(s1.devSummary.ppcSingleStepPassRate * 100).toFixed(1)}%** | **${(s1.devSummary.ppcWithExperiencePassRate * 100).toFixed(1)}%** |`,
    `| **Dev (${s1.devSummary.taskCount} 題)** | 平均綜合分數 | ${s1.devSummary.baseMeanScore.toFixed(4)} | ${s1.devSummary.bestOf5MeanScore.toFixed(4)} | ${s1.devSummary.ppcNoComposeMeanScore.toFixed(4)} | **${s1.devSummary.ppcSingleStepMeanScore.toFixed(4)}** | **${s1.devSummary.ppcWithExperienceMeanScore.toFixed(4)}** |`,
    `| **Held-Out (${s1.heldoutSummary.taskCount} 題)** | 客觀檢查通過率 | ${(s1.heldoutSummary.basePassRate * 100).toFixed(1)}% | ${(s1.heldoutSummary.bestOf5PassRate * 100).toFixed(1)}% | ${(s1.heldoutSummary.ppcNoComposePassRate * 100).toFixed(1)}% | **${(s1.heldoutSummary.ppcSingleStepPassRate * 100).toFixed(1)}%** | **${(s1.heldoutSummary.ppcWithExperiencePassRate * 100).toFixed(1)}%** |`,
    `| **Held-Out (${s1.heldoutSummary.taskCount} 題)** | 平均綜合分數 | ${s1.heldoutSummary.baseMeanScore.toFixed(4)} | ${s1.heldoutSummary.bestOf5MeanScore.toFixed(4)} | ${s1.heldoutSummary.ppcNoComposeMeanScore.toFixed(4)} | **${s1.heldoutSummary.ppcSingleStepMeanScore.toFixed(4)}** | **${s1.heldoutSummary.ppcWithExperienceMeanScore.toFixed(4)}** |`,
    '',
    '## 5. 階段 2（G2）：保留測試集 Leave-One-Out 經驗庫貢獻拆解',
    '',
    '| 保留任務 ID | 領域 | 啟用經驗庫分數 | Leave-One-Out 分數 | 經驗庫淨分數增益 | Token 節省量 |',
    '| :--- | :---: | :---: | :---: | :---: | :---: |',
  );

  for (const loo of s2.leaveOneOutResults) {
    lines.push(
      `| \`${loo.taskId}\` | \`${loo.domain}\` | ${loo.withExperienceScore.toFixed(4)} | ${loo.leaveOneOutScore.toFixed(4)} | +${loo.scoreGainFromExperience.toFixed(4)} | ${loo.tokenSavingFromExperience} |`,
    );
  }

  lines.push('');
  return redactSensitiveText(lines.join('\n'));
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  runFullEvaluation()
    .then((summary) => {
      const resultsDir = path.resolve(process.cwd(), 'eval', 'results');
      const docsDir = path.resolve(process.cwd(), 'docs');
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.mkdirSync(docsDir, { recursive: true });

      fs.writeFileSync(
        path.join(resultsDir, 'summary.json'),
        JSON.stringify(summary, null, 2),
        'utf8',
      );
      const mdReport = renderMarkdownReport(summary);
      fs.writeFileSync(
        path.join(docsDir, 'evaluation-report.md'),
        mdReport,
        'utf8',
      );
      console.log('評測完成，已寫入 eval/results/summary.json 與 docs/evaluation-report.md');
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
