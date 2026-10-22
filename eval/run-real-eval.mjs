// 真實模型評測：探針是真實的 dsh headless 子行程，提案器與裁判是設定檔指定的模型端點。
// 閘門 G1（同探針預算下單步 PPC vs best-of-k）與 G2（跨任務經驗庫 + leave-one-out）。
// 所有探針與提案呼叫都以 runId + harness hash 做快取（--out 目錄下 cache/），中斷後 --resume 可接續。
//
//   node eval/run-real-eval.mjs --config .dev/real-config.json [--out eval/real-results] [--split dev,heldout]
//        [--baseRuns 3] [--bestOfK 5] [--tasks gen-dev-01,gen-dev-02] [--report docs/evaluation-report.md]
//
// 設定檔內容與插件 config 相同（proposer、probe…）。內網 IP 不要寫進 repo：放在 .dev/（已 gitignore）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeConfig } from '../src/config.js';
import { ensureHarnessDir, loadHarnessFromDir } from '../src/harness-loader.js';
import { HarnessStateStore } from '../src/store.js';
import { ExperienceLibrary, Reflector } from '../src/experience.js';
import { Comparator } from '../src/ppc.js';
import { buildEngine } from '../src/index.js';
import { TASK_SET_V0, getTasksBySplit } from '../tasks/task-set-v0.js';
import { redactSensitiveText } from '../src/security.js';

function calcStats(nums) {
  if (!nums.length) return { mean: 0, stdDev: 0 };
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((acc, x) => acc + (x - mean) ** 2, 0) / nums.length;
  return { mean: Number(mean.toFixed(4)), stdDev: Number(Math.sqrt(variance).toFixed(4)) };
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

/** 用檔案快取包住 probeRunner.run 與 proposer.propose，讓評測可以續跑 */
function installCaches({ probeRunner, proposer, cacheDir, log, stats }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const originalRun = probeRunner.run.bind(probeRunner);
  probeRunner.run = async (task, harness, options = {}) => {
    const key = sha1(`probe:${task.taskId}:${harness.hash}:${options.runId}`);
    const file = path.join(cacheDir, `probe-${key}.json`);
    if (fs.existsSync(file)) {
      stats.cachedProbes += 1;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    const started = Date.now();
    const record = await originalRun(task, harness, options);
    stats.probes += 1;
    stats.probeMs += Date.now() - started;
    stats.probeTokens += record.usage?.totalTokens || 0;
    log(`probe ${options.runId}: ${record.terminationReason}, steps=${record.stepCount}, tokens=${record.usage?.totalTokens}, ${((Date.now() - started) / 1000).toFixed(0)}s`);
    fs.writeFileSync(file, JSON.stringify(record, null, 1), 'utf8');
    return record;
  };
  if (proposer && typeof proposer.propose === 'function') {
    const originalPropose = proposer.propose.bind(proposer);
    proposer.propose = async (context) => {
      const key = sha1(`propose:${context.task.taskId}:${context.baseHarness.hash}:${context.runId || ''}:${context.disableExperience ? 'noexp' : 'exp'}:${context.maxSequenceIndex ?? ''}:${(context.excludeExperienceTaskIds || []).join(',')}`);
      const file = path.join(cacheDir, `propose-${key}.json`);
      if (fs.existsSync(file)) {
        stats.cachedProposals += 1;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      }
      const started = Date.now();
      const proposals = await originalPropose(context);
      stats.proposals += 1;
      log(`propose ${context.task.taskId}: ${proposals.length} proposal(s), ${((Date.now() - started) / 1000).toFixed(0)}s`);
      fs.writeFileSync(file, JSON.stringify(proposals, null, 1), 'utf8');
      return proposals;
    };
  }
}

export async function runRealEvaluation(options) {
  const { config, outDir, log, baseRuns, bestOfK, tasks } = options;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-real-eval-'));
  const cacheDir = path.join(outDir, 'cache');
  const stats = { probes: 0, cachedProbes: 0, probeMs: 0, probeTokens: 0, proposals: 0, cachedProposals: 0 };
  const comparator = new Comparator();
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();

  try {
    const baseHarnessDir = path.join(tempRoot, 'base-harness');
    ensureHarnessDir(baseHarnessDir);
    const baseHarness = loadHarnessFromDir(baseHarnessDir);

    const makeEngine = (label, experienceLibrary) => {
      const store = new HarnessStateStore({
        storageDir: path.join(tempRoot, `store-${label}`),
        activeHarnessDir: path.join(tempRoot, `active-${label}`),
      });
      const reflector = new Reflector(experienceLibrary);
      const engine = buildEngine(config, { store, experienceLibrary, reflector, logger: log });
      installCaches({ probeRunner: engine.probeRunner, proposer: engine.proposer, cacheDir, log, stats });
      // 協調器內的 proposer 也要用快取版本
      engine.coordinator.proposer = engine.proposer;
      return engine;
    };

    // 中途快照（writeSummary）會用到後面階段的陣列，先宣告
    const equalComputeResults = [];
    const ppcWithExperienceResults = [];
    const leaveOneOutResults = [];
    const sharedExp = new ExperienceLibrary(path.join(tempRoot, 'stage2-shared-experience'));

    // 1. Base variance：每題 baseRuns 次
    const baseEngine = makeEngine('base', new ExperienceLibrary(path.join(tempRoot, 'exp-base')));
    const baseVarianceByTask = [];
    for (const task of tasks) {
      const runs = [];
      for (let r = 1; r <= baseRuns; r++) {
        const rec = await baseEngine.probeRunner.run(task, baseHarness, { runId: `base-var-${task.taskId}-r${r}`, autoCleanup: true });
        const ev = comparator.evaluateRecord(rec, task);
        runs.push({ runIndex: r, passedObjective: ev.passedObjective, objectiveScore: ev.objectiveScore, compositeScore: ev.compositeScore, stepCount: rec.stepCount, totalTokens: rec.usage.totalTokens, details: ev.details });
      }
      const summary = comparator.summarizeBaseline(runs);
      baseVarianceByTask.push({
        taskId: task.taskId, split: task.split, domain: task.domain, title: task.title,
        passRate: summary.passRate, meanCompositeScore: summary.meanCompositeScore, stdDevCompositeScore: summary.stdDevCompositeScore,
        meanTokens: calcStats(runs.map((x) => x.totalTokens)).mean, runs,
      });
    }
    const devVariance = calcStats(baseVarianceByTask.filter((t) => t.split === 'dev').map((t) => t.stdDevCompositeScore));
    const heldoutVariance = calcStats(baseVarianceByTask.filter((t) => t.split === 'heldout').map((t) => t.stdDevCompositeScore));

    // 2. G1：同探針預算比較（best-of-k vs PPC 無 Compose vs 單步 PPC）
    for (const task of tasks) {
      const boRuns = [];
      let boTokens = 0;
      for (let k = 1; k <= bestOfK; k++) {
        const rec = await baseEngine.probeRunner.run(task, baseHarness, { runId: `bo${bestOfK}-${task.taskId}-k${k}`, autoCleanup: true });
        boTokens += rec.usage.totalTokens;
        boRuns.push(comparator.evaluateRecord(rec, task));
      }
      boRuns.sort((a, b) => b.compositeScore - a.compositeScore);
      const bestOfWinner = boRuns[0];

      const noCompose = makeEngine(`nocompose-${task.taskId}`, new ExperienceLibrary(path.join(tempRoot, `exp-nocompose-${task.taskId}`)));
      const ppcNoComposeRes = await noCompose.coordinator.runPpcLoop(task, baseHarness, {
        runId: `ppc-nocompose-${task.taskId}`, referenceRunsCount: 2, kPerAxis: 1, sequentialSteps: 1,
        enableCompose: false, disableExperience: true, recordExperience: false, adoptToStore: false,
      });

      const single = makeEngine(`single-${task.taskId}`, new ExperienceLibrary(path.join(tempRoot, `exp-single-${task.taskId}`)));
      const ppcSingleRes = await single.coordinator.runPpcLoop(task, baseHarness, {
        runId: `ppc-single-${task.taskId}`, referenceRunsCount: 2, kPerAxis: 1, sequentialSteps: 1,
        enableCompose: true, disableExperience: true, recordExperience: false, adoptToStore: false,
      });

      const baseRow = baseVarianceByTask.find((b) => b.taskId === task.taskId);
      equalComputeResults.push({
        taskId: task.taskId, split: task.split, domain: task.domain,
        base: { passRate: baseRow.passRate, compositeScore: baseRow.meanCompositeScore, probes: baseRuns, tokens: Math.round(baseRow.meanTokens * baseRuns) },
        bestOfK: { k: bestOfK, passedObjective: bestOfWinner.passedObjective, compositeScore: bestOfWinner.compositeScore, probes: bestOfK, tokens: boTokens },
        ppcNoCompose: { adopted: ppcNoComposeRes.adopted, passedObjective: ppcNoComposeRes.finalEvaluation.passedObjective, compositeScore: ppcNoComposeRes.finalEvaluation.compositeScore, probes: ppcNoComposeRes.totalProbesExecuted, tokens: ppcNoComposeRes.totalTokensUsed, finalVersionId: ppcNoComposeRes.finalHarnessVersionId },
        ppcSingleStep: { adopted: ppcSingleRes.adopted, passedObjective: ppcSingleRes.finalEvaluation.passedObjective, compositeScore: ppcSingleRes.finalEvaluation.compositeScore, probes: ppcSingleRes.totalProbesExecuted, tokens: ppcSingleRes.totalTokensUsed, finalVersionId: ppcSingleRes.finalHarnessVersionId, stepSummary: ppcSingleRes.stepHistory[0]?.composedSummary || null, judge: ppcSingleRes.stepHistory[0]?.judgeVerdict || null },
      });
      writeSummary();
    }

    // 3. G2：依序跑所有任務並累積共用經驗庫；heldout 再做 leave-one-out
    const s2 = makeEngine('stage2', sharedExp);
    for (let idx = 0; idx < tasks.length; idx++) {
      const task = tasks[idx];
      const store = new HarnessStateStore({ storageDir: path.join(tempRoot, `store-s2-${task.taskId}`), activeHarnessDir: path.join(tempRoot, `active-s2-${task.taskId}`) });
      s2.coordinator.store = store;
      const res = await s2.coordinator.runPpcLoop(task, baseHarness, {
        runId: `ppc-s2-exp-${task.taskId}`, referenceRunsCount: 2, kPerAxis: 1, sequentialSteps: 1,
        enableCompose: true, disableExperience: false, recordExperience: true, taskSequenceIndex: idx, adoptToStore: false,
      });
      ppcWithExperienceResults.push({
        taskId: task.taskId, split: task.split, domain: task.domain, taskSequenceIndex: idx,
        adopted: res.adopted, passedObjective: res.finalEvaluation.passedObjective, compositeScore: res.finalEvaluation.compositeScore,
        tokens: res.totalTokensUsed, probes: res.totalProbesExecuted, experienceEntryId: res.experienceEntry?.entryId || null,
      });
      writeSummary();
    }
    const heldoutTasks = tasks.filter((t) => t.split === 'heldout');
    for (const task of heldoutTasks) {
      const taskIdx = tasks.findIndex((t) => t.taskId === task.taskId);
      const priorTaskIds = tasks.slice(0, taskIdx).map((t) => t.taskId);
      const store = new HarnessStateStore({ storageDir: path.join(tempRoot, `store-loo-${task.taskId}`), activeHarnessDir: path.join(tempRoot, `active-loo-${task.taskId}`) });
      s2.coordinator.store = store;
      const looRes = await s2.coordinator.runPpcLoop(task, baseHarness, {
        runId: `ppc-loo-${task.taskId}`, referenceRunsCount: 2, kPerAxis: 1, sequentialSteps: 1,
        enableCompose: true, disableExperience: false, recordExperience: false, taskSequenceIndex: taskIdx,
        excludeExperienceTaskIds: priorTaskIds, adoptToStore: false,
      });
      const withExpRow = ppcWithExperienceResults.find((r) => r.taskId === task.taskId);
      leaveOneOutResults.push({
        taskId: task.taskId, domain: task.domain,
        withExperienceScore: withExpRow.compositeScore, withExperienceTokens: withExpRow.tokens,
        leaveOneOutScore: looRes.finalEvaluation.compositeScore, leaveOneOutTokens: looRes.totalTokensUsed,
        scoreGainFromExperience: Number((withExpRow.compositeScore - looRes.finalEvaluation.compositeScore).toFixed(4)),
        tokenSavingFromExperience: looRes.totalTokensUsed - withExpRow.tokens,
      });
      writeSummary();
    }

    function summarizeSplit(splitName) {
      const rows = equalComputeResults.filter((r) => r.split === splitName);
      const s2Rows = ppcWithExperienceResults.filter((r) => r.split === splitName);
      const count = rows.length;
      const avg = (arr) => (arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(4)) : 0);
      return {
        taskCount: count,
        basePassRate: avg(rows.map((r) => r.base.passRate)),
        baseMeanScore: avg(rows.map((r) => r.base.compositeScore)),
        bestOfKPassRate: avg(rows.map((r) => (r.bestOfK.passedObjective ? 1 : 0))),
        bestOfKMeanScore: avg(rows.map((r) => r.bestOfK.compositeScore)),
        ppcNoComposePassRate: avg(rows.map((r) => (r.ppcNoCompose.passedObjective ? 1 : 0))),
        ppcNoComposeMeanScore: avg(rows.map((r) => r.ppcNoCompose.compositeScore)),
        ppcSingleStepPassRate: avg(rows.map((r) => (r.ppcSingleStep.passedObjective ? 1 : 0))),
        ppcSingleStepMeanScore: avg(rows.map((r) => r.ppcSingleStep.compositeScore)),
        ppcSingleStepAdoptRate: avg(rows.map((r) => (r.ppcSingleStep.adopted ? 1 : 0))),
        ppcWithExperiencePassRate: avg(s2Rows.map((r) => (r.passedObjective ? 1 : 0))),
        ppcWithExperienceMeanScore: avg(s2Rows.map((r) => r.compositeScore)),
      };
    }

    function buildSummary(final) {
      const devSummary = summarizeSplit('dev');
      const heldoutSummary = summarizeSplit('heldout');
      const g1GainOverBestOfKDev = Number((devSummary.ppcSingleStepMeanScore - devSummary.bestOfKMeanScore).toFixed(4));
      const g1GainOverBestOfKHeldout = Number((heldoutSummary.ppcSingleStepMeanScore - heldoutSummary.bestOfKMeanScore).toFixed(4));
      const composeGainHeldout = Number((heldoutSummary.ppcSingleStepMeanScore - heldoutSummary.ppcNoComposeMeanScore).toFixed(4));
      const g1Passed = g1GainOverBestOfKDev > devVariance.mean && g1GainOverBestOfKHeldout > heldoutVariance.mean && composeGainHeldout > 0;
      const g2ScoreGainHeldout = Number((heldoutSummary.ppcWithExperienceMeanScore - heldoutSummary.ppcSingleStepMeanScore).toFixed(4));
      const g2Passed = heldoutSummary.ppcWithExperiencePassRate >= heldoutSummary.ppcSingleStepPassRate && g2ScoreGainHeldout > 0;
      return {
        kind: 'real-model-evaluation',
        complete: Boolean(final),
        startedAt,
        generatedAt: new Date().toISOString(),
        wallClockMs: Date.now() - wallStart,
        setup: {
          proposer: { engine: config.proposer.engine, model: config.proposer.model, judge: config.proposer.judge },
          probe: { provider: config.probe.provider, model: config.probe.model, templateProfile: config.probe.templateProfile },
          baseRuns, bestOfK, taskCount: tasks.length, taskIds: tasks.map((t) => t.taskId),
          platform: `${os.platform()} ${os.release()}`, node: process.version,
        },
        stats,
        baseVariance: { devMeanStdDev: devVariance.mean, heldoutMeanStdDev: heldoutVariance.mean, byTask: baseVarianceByTask },
        stage1EqualCompute: { devSummary, heldoutSummary, g1GainOverBestOfKDev, g1GainOverBestOfKHeldout, composeGainHeldout, g1Passed, byTask: equalComputeResults },
        stage2Experience: { experienceEntriesCount: sharedExp.listEntries().length, ppcWithExperienceResults, leaveOneOutResults, g2ScoreGainHeldout, g2Passed },
      };
    }

    function writeSummary(final = false) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(buildSummary(final), null, 2), 'utf8');
    }

    writeSummary(true);
    return buildSummary(true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

/**
 * 評測報告（繁體中文）。措辭只寫真實量到的東西。
 */
export function renderRealReport(s) {
  const s1 = s.stage1EqualCompute;
  const s2 = s.stage2Experience;
  const hours = (s.wallClockMs / 3600000).toFixed(1);
  const lines = [
    '# dsh-plugin-recursive-harness 真實模型評測報告',
    '',
    `> 產生時間：\`${s.generatedAt}\`${s.complete ? '' : '（**未完成**，中途快照）'} · 探針：真實 \`dsh --profile headless\` 子行程，模型 \`${s.setup.probe.provider}/${s.setup.probe.model}\` · 提案器與裁判：\`${s.setup.proposer.model}\`（裁判${s.setup.proposer.judge ? '啟用' : '停用'}） · 任務 ${s.setup.taskCount} 題（${s.setup.taskIds.join(', ')}） · 平台 ${s.setup.platform}，Node ${s.setup.node}`,
    `> 探針 ${s.stats.probes} 次（另 ${s.stats.cachedProbes} 次來自快取）、探針 token 合計 ${s.stats.probeTokens}、提案呼叫 ${s.stats.proposals} 次、總時長 ${hours} 小時。`,
    '',
    '## 1. 結論',
    '',
    `- **閘門 G1（同探針預算：單步 PPC vs best-of-${s.setup.bestOfK}）：${s1.g1Passed ? '通過' : '未通過'}**。開發集單步 PPC 平均綜合分數 ${s1.devSummary.ppcSingleStepMeanScore.toFixed(3)}（通過率 ${pct(s1.devSummary.ppcSingleStepPassRate)}）對 best-of-${s.setup.bestOfK} ${s1.devSummary.bestOfKMeanScore.toFixed(3)}（${pct(s1.devSummary.bestOfKPassRate)}），差 ${s1.g1GainOverBestOfKDev >= 0 ? '+' : ''}${s1.g1GainOverBestOfKDev.toFixed(3)}，基準變異 ${s.baseVariance.devMeanStdDev.toFixed(3)}；保留集 ${s1.heldoutSummary.ppcSingleStepMeanScore.toFixed(3)}（${pct(s1.heldoutSummary.ppcSingleStepPassRate)}）對 ${s1.heldoutSummary.bestOfKMeanScore.toFixed(3)}（${pct(s1.heldoutSummary.bestOfKPassRate)}），差 ${s1.g1GainOverBestOfKHeldout >= 0 ? '+' : ''}${s1.g1GainOverBestOfKHeldout.toFixed(3)}，基準變異 ${s.baseVariance.heldoutMeanStdDev.toFixed(3)}；Compose 對無 Compose 在保留集差 ${s1.composeGainHeldout >= 0 ? '+' : ''}${s1.composeGainHeldout.toFixed(3)}。`,
    `- **閘門 G2（跨任務經驗庫，保留集 leave-one-out）：${s2.g2Passed ? '通過' : '未通過'}**。累積 ${s2.experienceEntriesCount} 筆經驗；保留集啟用經驗庫對單步 PPC 差 ${s2.g2ScoreGainHeldout >= 0 ? '+' : ''}${s2.g2ScoreGainHeldout.toFixed(3)}。`,
    `- 單步 PPC 在開發集有 ${pct(s1.devSummary.ppcSingleStepAdoptRate)} 的題目採用了新版 harness，保留集 ${pct(s1.heldoutSummary.ppcSingleStepAdoptRate)}。`,
    '- 綜合分數：通過客觀檢查的執行是 1 + 客觀分數 + 0.5 × 行為分數（行為分數扣工具錯誤、步數、token），未通過者上限小於 1。數字只在同一個模型與同一組任務內可比較。',
    '',
    '## 2. 基準變異（Base harness，每題 ' + s.setup.baseRuns + ' 次）',
    '',
    '| 任務 | 分割 | 通過率 | 平均綜合分數 | 標準差 | 平均 token |',
    '| :--- | :---: | :---: | :---: | :---: | :---: |',
    ...s.baseVariance.byTask.map((r) => `| \`${r.taskId}\` | ${r.split} | ${pct(r.passRate)} | ${r.meanCompositeScore.toFixed(4)} | ${r.stdDevCompositeScore.toFixed(4)} | ${Math.round(r.meanTokens)} |`),
    '',
    `## 3. G1：同探針預算比較（best-of-${s.setup.bestOfK} 用 ${s.setup.bestOfK} 次探針；單步 PPC 用 2 次參考 + 2 次候選 + 1 次驗證，再加 1 次最終評分）`,
    '',
    '| 分割 | 指標 | Base | best-of-k | PPC 無 Compose | 單步 PPC | PPC + 經驗庫 |',
    '| :--- | :--- | :---: | :---: | :---: | :---: | :---: |',
    ...['dev', 'heldout'].flatMap((split) => {
      const d = split === 'dev' ? s1.devSummary : s1.heldoutSummary;
      return [
        `| ${split}（${d.taskCount} 題） | 通過率 | ${pct(d.basePassRate)} | ${pct(d.bestOfKPassRate)} | ${pct(d.ppcNoComposePassRate)} | ${pct(d.ppcSingleStepPassRate)} | ${pct(d.ppcWithExperiencePassRate)} |`,
        `| ${split}（${d.taskCount} 題） | 平均綜合分數 | ${d.baseMeanScore.toFixed(4)} | ${d.bestOfKMeanScore.toFixed(4)} | ${d.ppcNoComposeMeanScore.toFixed(4)} | ${d.ppcSingleStepMeanScore.toFixed(4)} | ${d.ppcWithExperienceMeanScore.toFixed(4)} |`,
      ];
    }),
    '',
    '### 逐題',
    '',
    '| 任務 | 分割 | best-of-k 分數 | PPC 無 Compose | 單步 PPC | 採用？ | 單步 PPC 結果 |',
    '| :--- | :---: | :---: | :---: | :---: | :---: | :--- |',
    ...s1.byTask.map((r) => `| \`${r.taskId}\` | ${r.split} | ${r.bestOfK.compositeScore.toFixed(3)} | ${r.ppcNoCompose.compositeScore.toFixed(3)} | ${r.ppcSingleStep.compositeScore.toFixed(3)} | ${r.ppcSingleStep.adopted ? '是' : '否'} | ${r.ppcSingleStep.stepSummary || '—'} |`),
    '',
    '## 4. G2：保留集 leave-one-out',
    '',
    '| 任務 | 啟用經驗庫分數 | leave-one-out 分數 | 差 | token 差 |',
    '| :--- | :---: | :---: | :---: | :---: |',
    ...s2.leaveOneOutResults.map((r) => `| \`${r.taskId}\` | ${r.withExperienceScore.toFixed(4)} | ${r.leaveOneOutScore.toFixed(4)} | ${r.scoreGainFromExperience >= 0 ? '+' : ''}${r.scoreGainFromExperience.toFixed(4)} | ${r.tokenSavingFromExperience} |`),
    '',
    '## 5. 限制',
    '',
    '- 任務集是 12 題合成的結構化資料任務，不是真實專案；結果只說明在這類任務、這個模型上的行為。',
    '- 探針模型 temperature 由 dsh 的模型設定決定，基準變異就是為了量這個波動；每題只跑了 ' + s.setup.baseRuns + ' 次基準。',
    '- 提案器看不到任務的標準答案，客觀檢查回饋裡的數字也先遮掉了，但開發集上的提案仍可能過擬合，所以結論以保留集為準。',
    '',
  ];
  return redactSensitiveText(lines.join('\n'));
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: 'string' },
      out: { type: 'string', default: 'eval/real-results' },
      report: { type: 'string', default: 'docs/evaluation-report.md' },
      split: { type: 'string', default: 'dev,heldout' },
      tasks: { type: 'string' },
      baseRuns: { type: 'string', default: '3' },
      bestOfK: { type: 'string', default: '5' },
    },
  });
  if (!values.config) {
    console.error('用法：node eval/run-real-eval.mjs --config <config.json> [--out dir] [--split dev,heldout] [--tasks id,id] [--baseRuns 3] [--bestOfK 5]');
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(path.resolve(values.config), 'utf8'));
  const config = normalizeConfig(raw, path.resolve(values.out, 'harness-root'));
  const splits = values.split.split(',').map((s) => s.trim());
  let tasks = TASK_SET_V0.filter((t) => splits.includes(t.split));
  if (values.tasks) {
    const ids = values.tasks.split(',').map((s) => s.trim());
    tasks = tasks.filter((t) => ids.includes(t.taskId));
  }
  const outDir = path.resolve(values.out);
  const log = (line) => console.error(`[real-eval ${new Date().toISOString().slice(11, 19)}] ${line}`);
  log(`tasks: ${tasks.map((t) => t.taskId).join(', ')}; proposer=${config.proposer.engine}/${config.proposer.model}; probe=${config.probe.provider}/${config.probe.model}`);
  runRealEvaluation({ config, outDir, log, baseRuns: Number(values.baseRuns), bestOfK: Number(values.bestOfK), tasks })
    .then((summary) => {
      const reportPath = path.resolve(values.report);
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, renderRealReport(summary), 'utf8');
      log(`done: G1=${summary.stage1EqualCompute.g1Passed} G2=${summary.stage2Experience.g2Passed}; summary ${path.join(outDir, 'summary.json')}; report ${reportPath}`);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
