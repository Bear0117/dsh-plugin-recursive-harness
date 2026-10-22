#!/usr/bin/env node
// CLI 協調器入口：支援 inspect | start | status | cancel | rollback | listExperience | eval
import { parseArgs } from 'node:util';
import { normalizeConfig } from './config.js';
import { ensureHarnessDir, loadHarnessFromDir } from './harness-loader.js';
import { HarnessStateStore } from './store.js';
import { ExperienceLibrary, Reflector } from './experience.js';
import { ProbeRunner } from './probe-runner.js';
import { RecursiveHarnessCoordinator } from './ppc.js';
import { RecursiveHarnessService } from './index.js';
import { TASK_SET_V0 } from '../tasks/task-set-v0.js';

export async function runCli(argv = process.argv.slice(2), env = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      baseDir: { type: 'string' },
      harnessDir: { type: 'string' },
      storageDir: { type: 'string' },
      experienceDir: { type: 'string' },
      task: { type: 'string' },
      k: { type: 'string' },
      steps: { type: 'string' },
      noCompose: { type: 'boolean', default: false },
      noExperience: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      executor: { type: 'string' }, // mock：只演練管線，不呼叫模型，也不會採用結果
      dshCli: { type: 'string' },
    },
    allowPositionals: true,
  });

  const baseDir = values.baseDir || env.baseDir || process.cwd();
  const config = normalizeConfig(
    {
      harnessDir: values.harnessDir,
      storageDir: values.storageDir,
      experienceDir: values.experienceDir,
    },
    baseDir,
  );

  ensureHarnessDir(config.harnessDir);
  const store = new HarnessStateStore({
    storageDir: config.storageDir,
    activeHarnessDir: config.harnessDir,
  });
  const experienceLibrary = new ExperienceLibrary(config.experienceDir);
  const reflector = new Reflector(experienceLibrary);
  const useMock = values.executor === 'mock';
  let executor = env.executor || null;
  if (!executor && useMock) {
    const { createMockProbeExecutor } = await import('../eval/mock-executor.mjs');
    executor = createMockProbeExecutor();
  }
  const probeRunner = new ProbeRunner({
    maxConcurrency: config.maxConcurrency,
    maxWallTimeMs: config.maxWallTimeMs,
    lockedSurfaces: config.lockedSurfaces,
    protectedPatterns: config.protectedPatterns,
    dshCliEntry: values.dshCli || config.dshCliEntry || null,
    executor,
  });
  const coordinator = new RecursiveHarnessCoordinator({
    probeRunner,
    store,
    experienceLibrary,
    reflector,
    maxTokensPerIteration: config.maxTokensPerIteration,
    maxWallTimeMs: config.maxWallTimeMs,
    lockedSurfaces: config.lockedSurfaces,
    protectedPatterns: config.protectedPatterns,
  });
  const service = new RecursiveHarnessService({
    config,
    store,
    experienceLibrary,
    probeRunner,
    coordinator,
  });

  const subcommand = (positionals[0] || 'inspect').toLowerCase();
  const arg1 = positionals[1];

  switch (subcommand) {
    case 'inspect': {
      const info = service.inspect();
      return values.json ? JSON.stringify(info, null, 2) : info;
    }

    case 'start': {
      const targetTaskId = values.task || arg1 || 'gen-dev-01';
      const task = TASK_SET_V0.find((t) => t.taskId === targetTaskId);
      if (!task) {
        throw new Error(`找不到指定之任務 ID：${targetTaskId}`);
      }
      const res = await service.start(task, {
        kPerAxis: values.k ? Number(values.k) : 1,
        sequentialSteps: values.steps ? Number(values.steps) : 1,
        enableCompose: !values.noCompose,
        disableExperience: Boolean(values.noExperience),
        // 模擬執行器的結果絕不寫進 active harness 或經驗庫
        adoptToStore: !useMock,
        recordExperience: !useMock,
      });
      return values.json ? JSON.stringify(res, null, 2) : res;
    }

    case 'status': {
      const st = service.status(arg1);
      return values.json ? JSON.stringify(st, null, 2) : st;
    }

    case 'cancel': {
      const res = await service.cancel(arg1);
      return values.json ? JSON.stringify(res, null, 2) : res;
    }

    case 'rollback': {
      const restored = service.rollback(arg1);
      return values.json ? JSON.stringify(restored, null, 2) : restored;
    }

    case 'listexperience':
    case 'experience': {
      const list = service.listExperience({ includeInactive: Boolean(values.all) });
      return values.json ? JSON.stringify(list, null, 2) : list;
    }

    default:
      throw new Error(
        `不支援之 CLI 子指令：${subcommand}（可用：inspect | start | status | cancel | rollback | listExperience）`,
      );
  }
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then((out) => {
      if (typeof out === 'string') {
        console.log(out);
      } else {
        console.log(JSON.stringify(out, null, 2));
      }
    })
    .catch((err) => {
      console.error(`[dsh-recursive-harness CLI 錯誤] ${err.message}`);
      process.exitCode = 1;
    });
}
