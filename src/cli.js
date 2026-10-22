#!/usr/bin/env node
// CLI 協調器入口：inspect | start | status | cancel | rollback | listExperience
// 預設根目錄是 <cwd>/.dsh-harness（插件模式則是 $DSH_HOME/recursive-harness）。
// 設定檔（--config）是 JSON，欄位與插件的 config 相同（proposer、probe、lockedSurfaces、protectedPatterns…）。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeConfig } from './config.js';
import { ensureHarnessDir } from './harness-loader.js';
import { HarnessStateStore } from './store.js';
import { ExperienceLibrary, Reflector } from './experience.js';
import { RecursiveHarnessService, buildEngine } from './index.js';
import { loadTask } from './tasks.js';

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
      config: { type: 'string' },
      proposer: { type: 'string' }, // template | llm（覆蓋設定檔）
    },
    allowPositionals: true,
  });

  const baseDir = values.baseDir || env.baseDir || path.join(process.cwd(), '.dsh-harness');
  let fileConfig = {};
  if (values.config) {
    fileConfig = JSON.parse(fs.readFileSync(path.resolve(values.config), 'utf8'));
  }
  const config = normalizeConfig(
    {
      ...fileConfig,
      harnessDir: values.harnessDir ?? fileConfig.harnessDir,
      storageDir: values.storageDir ?? fileConfig.storageDir,
      experienceDir: values.experienceDir ?? fileConfig.experienceDir,
      proposer: { ...(fileConfig.proposer || {}), ...(values.proposer ? { engine: values.proposer } : {}) },
      probe: { ...(fileConfig.probe || {}), ...(values.dshCli ? { dshCliEntry: values.dshCli } : {}) },
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
  const { probeRunner, coordinator } = buildEngine(config, {
    store,
    experienceLibrary,
    reflector,
    executor,
    logger: (line) => console.error(`[dsh-recursive-harness] ${line}`),
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
  const out = (value) => (values.json ? JSON.stringify(value, null, 2) : value);

  switch (subcommand) {
    case 'inspect':
      return out(service.inspect());

    case 'start': {
      const task = await loadTask(values.task || arg1 || 'gen-dev-01');
      const res = await service.start(task, {
        kPerAxis: values.k ? Number(values.k) : 1,
        sequentialSteps: values.steps ? Number(values.steps) : 1,
        enableCompose: !values.noCompose,
        disableExperience: Boolean(values.noExperience),
        // 模擬執行器的結果絕不寫進 active harness 或經驗庫
        adoptToStore: !useMock,
        recordExperience: !useMock,
      });
      return out(res);
    }

    case 'status':
      return out(service.status(arg1));

    case 'cancel':
      return out(await service.cancel(arg1));

    case 'rollback':
      return out(service.rollback(arg1));

    case 'listexperience':
    case 'experience':
      return out(service.listExperience({ includeInactive: Boolean(values.all) }));

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
      console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
    })
    .catch((err) => {
      console.error(`[dsh-recursive-harness CLI 錯誤] ${err.message}`);
      process.exitCode = 1;
    });
}
