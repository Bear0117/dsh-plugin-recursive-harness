// 真實子行程路徑的測試：用 test/fixtures/fake-dsh.mjs 代替 dsh 的 bin.js，驗證 ProbeRunner 怎麼啟動子行程。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProbeRunner, resolveDshCliEntry } from '../src/probe-runner.js';
import { ensureHarnessDir, loadHarnessFromDir } from '../src/harness-loader.js';

const FAKE_DSH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-dsh.mjs');

test('11. 真實探針子行程：profile 與覆蓋層寫法、插件連結、工作區、環境變數與 NDJSON 解析', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-child-'));
  try {
    // 範本家目錄：一個 web profile 的 patch 與憑證檔
    const templateHome = path.join(tmp, 'template-home');
    fs.mkdirSync(path.join(templateHome, 'profiles', 'web'), { recursive: true });
    fs.writeFileSync(path.join(templateHome, 'profiles', 'web', 'cordis.patch.yml'), '- id: agent-default-model\n  config:\n    provider: tpl\n    model: tpl-model\n', 'utf8');
    fs.writeFileSync(path.join(templateHome, '.credentials.yaml'), 'version: 1\nrefs: {}\n', 'utf8');

    const harnessRoot = path.join(tmp, 'active');
    ensureHarnessDir(harnessRoot);
    const harness = loadHarnessFromDir(harnessRoot);

    const recordPath = path.join(tmp, 'fake-dsh-record.json');
    const runner = new ProbeRunner({
      dshCliEntry: FAKE_DSH,
      templateDshHome: templateHome,
      templateProfile: 'web',
      probeProvider: 'vllm-x',
      probeModel: 'model-x',
      maxWallTimeMs: 60000,
    });
    const task = {
      taskId: 'child-task',
      prompt: '請讀 input.json 並輸出 JSON',
      workspaceFiles: { 'input.json': '{"a":1}', 'sub/notes.txt': 'hi' },
    };
    const rec = await runner.run(task, harness, { runId: 'child-1', autoCleanup: true, extraEnv: { FAKE_DSH_RECORD: recordPath } });

    // NDJSON 解析
    assert.equal(rec.terminationReason, 'completed');
    assert.equal(rec.toolCallCount, 1);
    assert.equal(rec.usage.totalTokens, 15);
    assert.equal(rec.exitCode, 0);
    assert.ok(rec.stderrExcerpt.includes('fake dsh: done'));
    const final = JSON.parse(rec.finalOutput);
    assert.equal(final.echo, task.prompt);
    assert.ok(final.harnessFiles.includes('systemprompt.md'));

    // 子行程怎麼被啟動
    const launched = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assert.deepEqual(launched.args.slice(0, 2), ['--profile', 'headless']);
    assert.equal(launched.args[launched.args.length - 2], '--json');
    assert.equal(launched.args[launched.args.length - 1], task.prompt);
    assert.equal(launched.telemetry, 'DISABLED');
    assert.deepEqual(launched.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', runner.pluginPackageName]);
    assert.equal(launched.linked, true, '插件目錄要接進 profile 的 node_modules');
    assert.ok(launched.cwdFiles.includes('input.json') && launched.cwdFiles.includes('sub'));
    // 覆蓋層順序：範本 profile 的 patch 在前，本插件的 apply-only 覆蓋層在後（後者壓過前者）
    assert.equal(launched.patches.length, 2);
    assert.ok(launched.patches[0].includes('tpl-model'));
    assert.ok(launched.patches[1].includes('mode: apply-only'));
    assert.ok(launched.patches[1].includes('session-title-llm'));
    assert.ok(launched.patches[1].includes('provider: "vllm-x"'));
    assert.ok(launched.patches[1].includes('model: "model-x"'));
    assert.ok(launched.patches[1].includes('harnessDir: harness'));
    // 暫存目錄已清掉
    assert.equal(runner.tempRoots.size, 0);
    assert.equal(fs.existsSync(launched.home), false);

    // 工作區檔案不得逃出工作區
    await assert.rejects(
      runner.run({ taskId: 'evil', prompt: 'x', workspaceFiles: { '../escape.txt': 'no' } }, harness, { runId: 'child-evil', autoCleanup: true }),
      (err) => err.code === 'HARNESS_UNSAFE_PATH',
    );
    assert.equal(runner.tempRoots.size, 0);

    // 逾時：子行程不結束時要被砍掉、目錄要清掉
    const hangRunner = new ProbeRunner({ dshCliEntry: FAKE_DSH, templateDshHome: templateHome, maxWallTimeMs: 1500 });
    const started = Date.now();
    await assert.rejects(
      hangRunner.run(task, harness, { runId: 'child-hang', autoCleanup: true, extraEnv: { FAKE_DSH_HANG: '1' } }),
      (err) => err.code === 'PROBE_TIMEOUT',
    );
    assert.ok(Date.now() - started < 20000, '逾時後要在合理時間內回來');
    assert.equal(hangRunner.tempRoots.size, 0, '逾時後暫存目錄也要清掉');

    // 沒有 dsh CLI 入口時要給清楚的錯誤
    const noCli = new ProbeRunner({ dshCliEntry: path.join(tmp, 'missing.js') });
    await assert.rejects(
      noCli.run(task, harness, { runId: 'child-nocli', autoCleanup: true }),
      (err) => err.code === 'PROBE_NO_DSH_CLI' || /找不到 dsh CLI 入口/.test(err.message),
    );
    assert.equal(resolveDshCliEntry(null, { env: {}, argv: ['node', 'C:/x/@deepseek-ai/dsh/lib/bin.js'] }), null, '不存在的檔案不算');
    assert.equal(resolveDshCliEntry(FAKE_DSH, { env: {}, argv: ['node', 'x'] }), FAKE_DSH);

    // 啟動時清掃：別的行程留下的 dshp-* 目錄
    const stale = fs.mkdtempSync(path.join(tmp, 'dshp-'));
    fs.writeFileSync(path.join(stale, 'run.json'), JSON.stringify({ runId: 'old', pid: 999999, createdAt: new Date(Date.now() - 86400000).toISOString() }));
    const mine = fs.mkdtempSync(path.join(tmp, 'dshp-'));
    fs.writeFileSync(path.join(mine, 'run.json'), JSON.stringify({ runId: 'live', pid: process.pid, createdAt: new Date().toISOString() }));
    assert.equal(ProbeRunner.sweepStaleTempDirs({ tmpDir: tmp }), 1);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(mine), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
