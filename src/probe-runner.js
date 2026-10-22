// 探針執行器（ProbeRunner）：每個候選 harness 在隔離的 DSH_HOME 與工作區複本裡跑一次真實的 `dsh --profile headless --json`。
// 併發號誌、時間窗策略、逾時/取消（Windows 用 taskkill 砍整棵行程樹）、暫存目錄清理與啟動時清掃殘留。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeHarnessToDir } from './harness-loader.js';
import { parseHeadlessJsonStream } from './trajectory.js';
import { validateCandidateProposal } from './security.js';

const TEMP_PREFIX = 'dshp-';
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 簡易非同步併發號誌（Semaphore）
 */
export class Semaphore {
  /**
   * @param {number} maxConcurrency
   */
  constructor(maxConcurrency = 2) {
    this.maxConcurrency = Math.max(1, Math.floor(maxConcurrency));
    this.activeCount = 0;
    /** @type {Array<() => void>} */
    this.queue = [];
  }

  /**
   * @returns {Promise<() => void>} release 函式
   */
  acquire() {
    return new Promise((resolve) => {
      const tryEnter = () => {
        if (this.activeCount < this.maxConcurrency) {
          this.activeCount += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.activeCount -= 1;
            const next = this.queue.shift();
            if (next) next();
          });
        } else {
          this.queue.push(tryEnter);
        }
      };
      tryEnter();
    });
  }
}

/**
 * 檢查目前時間是否符合時間窗策略（Time-Window Policy）
 * @param {{ enabled?: boolean, allowedHoursStart?: number, allowedHoursEnd?: number }} policy
 * @param {Date} [now]
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkTimeWindowPolicy(policy = {}, now = new Date()) {
  if (!policy || !policy.enabled) {
    return { allowed: true };
  }
  const hour = now.getHours();
  const start = Number.isFinite(policy.allowedHoursStart) ? policy.allowedHoursStart : 0;
  const end = Number.isFinite(policy.allowedHoursEnd) ? policy.allowedHoursEnd : 24;
  const inWindow = start <= end ? hour >= start && hour < end : hour >= start || hour < end;
  if (!inWindow) {
    return {
      allowed: false,
      reason: `目前時間（${hour}:00）不在允許的探針時間窗（${start}:00–${end}:00）內`,
    };
  }
  return { allowed: true };
}

/**
 * 找出可用的 dsh CLI 入口（lib/bin.js）
 * 順序：明確設定 → 環境變數 DSH_CLI_ENTRY → 目前行程就是 dsh（process.argv[1]）
 * @param {string|null|undefined} configured
 * @param {{ env?: Record<string, string|undefined>, argv?: string[] }} [options]
 * @returns {string|null}
 */
export function resolveDshCliEntry(configured, options = {}) {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const candidates = [configured, env.DSH_CLI_ENTRY, argv[1]].filter((c) => typeof c === 'string' && c.trim());
  for (const c of candidates) {
    const abs = path.resolve(c.trim());
    const normalized = abs.replace(/\\/g, '/');
    if (c === argv[1] && !/@deepseek-ai\/dsh\/lib\/bin\.js$/.test(normalized)) continue;
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/** 把 runId 變成安全、短的目錄名片段 */
function safeSegment(value, max = 24) {
  const s = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
  return s.length > max ? s.slice(0, max) : s || 'run';
}

/** 確認 relPath 落在 rootDir 之內，回傳絕對路徑；否則丟錯 */
function resolveInside(rootDir, relPath) {
  const abs = path.resolve(rootDir, String(relPath));
  const root = path.resolve(rootDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    const err = new Error(`工作區檔案路徑逃出工作區：${relPath}`);
    err.code = 'HARNESS_UNSAFE_PATH';
    throw err;
  }
  return abs;
}

function rmWithRetries(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

/** YAML 單行字串（雙引號，跳脫反斜線與引號） */
function yamlString(value) {
  return JSON.stringify(String(value));
}

/**
 * 探針執行器
 */
export class ProbeRunner {
  /**
   * @param {{
   *   maxConcurrency?: number,
   *   maxWallTimeMs?: number,
   *   timeWindowPolicy?: { enabled?: boolean, allowedHoursStart?: number, allowedHoursEnd?: number },
   *   templateDshHome?: string | null,
   *   templateProfile?: string,
   *   probeProvider?: string | null,
   *   probeModel?: string | null,
   *   pluginRootDir?: string,
   *   dshCliEntry?: string | null,
   *   lockedSurfaces?: string[],
   *   protectedPatterns?: string[],
   *   blockedTools?: string[],
   *   preApprovedTools?: string[],
   *   logger?: (line: string) => void,
   *   executor?: (ctx: {
   *     runId: string,
   *     task: any,
   *     harnessVersion: any,
   *     dshHome: string,
   *     workspaceDir: string,
   *     harnessDir: string,
   *     signal: AbortSignal,
   *     options: Record<string, any>
   *   }) => Promise<{ rawStdout?: string, events?: any[], exitCode?: number }>
   * }} [config]
   */
  constructor(config = {}) {
    this.maxConcurrency = config.maxConcurrency ?? 2;
    this.maxWallTimeMs = config.maxWallTimeMs ?? 120000;
    this.timeWindowPolicy = config.timeWindowPolicy ?? { enabled: false };
    this.templateDshHome = config.templateDshHome ?? null;
    this.templateProfile = config.templateProfile ?? 'web';
    this.probeProvider = config.probeProvider ?? null;
    this.probeModel = config.probeModel ?? null;
    this.pluginRootDir = config.pluginRootDir ?? PLUGIN_ROOT;
    this.dshCliEntry = config.dshCliEntry ?? null;
    this.lockedSurfaces = config.lockedSurfaces;
    this.protectedPatterns = config.protectedPatterns ?? [];
    this.blockedTools = Array.isArray(config.blockedTools) ? config.blockedTools.map(String) : [];
    this.preApprovedTools = config.preApprovedTools ?? ['read_file', 'glob', 'grep', 'list_dir', 'skill'];
    this.executor = config.executor ?? null;
    this.log = config.logger || (() => {});
    this.semaphore = new Semaphore(this.maxConcurrency);

    let pluginPackageName = 'dsh-plugin-recursive-harness';
    try {
      pluginPackageName = JSON.parse(fs.readFileSync(path.join(this.pluginRootDir, 'package.json'), 'utf8')).name || pluginPackageName;
    } catch {
      // 用預設名稱
    }
    this.pluginPackageName = pluginPackageName;

    /** @type {Map<string, { runId: string, tempRoot: string, dshHome: string, workspaceDir: string, abortController: AbortController, childProcess: import('node:child_process').ChildProcess | null, status: string }>} */
    this.activeRuns = new Map();
    /** @type {Map<string, string>} runId -> tempRoot */
    this.tempRoots = new Map();
  }

  /**
   * 檢查任務能力需求、環境相依與安全約束
   * @param {any} task
   * @param {{ now?: Date }} [options]
   * @returns {{ supported: boolean, reasons: string[], executionMode: string, maxParallelism: number }}
   */
  checkCapabilities(task, options = {}) {
    const reasons = [];
    const executionMode = task?.executionMode || 'sandbox';

    // 1. 時間窗策略
    const tw = checkTimeWindowPolicy(this.timeWindowPolicy, options.now);
    if (!tw.allowed) {
      reasons.push(tw.reason);
    }

    // 2. 任務所需工具若在 blockedTools 清單裡，拒絕自動探針
    if (Array.isArray(task?.requiredTools)) {
      for (const tool of task.requiredTools) {
        if (this.blockedTools.includes(tool)) {
          reasons.push(`任務需要的工具在封鎖清單中，禁止自動探針：${tool}`);
        }
      }
    }

    // 3. exclusive 任務（例如一次只能接一個外部程式）不平行
    const maxParallelism = task?.exclusive === true ? 1 : this.maxConcurrency;

    return {
      supported: reasons.length === 0,
      reasons,
      executionMode,
      maxParallelism,
    };
  }

  /**
   * 建立隔離之 DSH_HOME 與工作區複本
   * 目錄名刻意很短（Windows MAX_PATH）：<tmp>/dshp-XXXXXX/{h,w}
   * @param {string} runId
   * @param {any} task
   * @param {any} harnessVersion
   */
  prepareIsolatedEnvironment(runId, task, harnessVersion) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    const dshHome = path.join(tempRoot, 'h');
    const workspaceDir = path.join(tempRoot, 'w');
    const harnessDir = path.join(dshHome, 'harness');
    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'run.json'), JSON.stringify({ runId, taskId: task?.taskId ?? null, pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');

    // 候選 harness（含安全檢查）
    writeHarnessToDir(harnessVersion, harnessDir, {
      validateSecurity: true,
      lockedSurfaces: this.lockedSurfaces,
      protectedPatterns: this.protectedPatterns,
    });

    // headless profile：bundles 裡加上本插件，並把插件目錄接進 profile 的 node_modules（junction，不用系統管理員）
    const profileDir = path.join(dshHome, 'profiles', 'headless');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify(
        {
          name: 'dsh-profile-headless',
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', this.pluginPackageName] } },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    const nm = path.join(profileDir, 'node_modules');
    fs.mkdirSync(nm, { recursive: true });
    const linkPath = path.join(nm, this.pluginPackageName);
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(this.pluginRootDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

    // 本插件的覆蓋層：apply-only、指向候選 harness。放在 profile 的 user layer，並再以 --patch 放到最後，確保一定壓過範本 profile 的設定
    const overlayLines = [
      '# Auto-generated by dsh-plugin-recursive-harness ProbeRunner. apply-only: the child never evolves anything.',
      '- id: recursive-harness',
      '  config:',
      '    mode: apply-only',
      `    baseDir: ${yamlString(dshHome)}`,
      '    harnessDir: harness',
      '',
      '# No session title model calls inside probes: they cost tokens and are not part of the task.',
      '- id: session-title-llm',
      '  disabled: true',
      '',
    ];
    if (this.probeProvider || this.probeModel) {
      overlayLines.push('- id: agent-default-model', '  config:');
      if (this.probeProvider) overlayLines.push(`    provider: ${yamlString(this.probeProvider)}`);
      if (this.probeModel) overlayLines.push(`    model: ${yamlString(this.probeModel)}`);
      overlayLines.push('');
    }
    const overlayText = overlayLines.join('\n');
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), overlayText, 'utf8');
    const overlayPath = path.join(tempRoot, 'probe.patch.yml');
    fs.writeFileSync(overlayPath, overlayText, 'utf8');

    // 範本 DSH_HOME：模型清單與憑證。憑證檔複製到暫存家目錄（同一台機器、同一個使用者，跑完即刪）；模型設定用 --patch 引用範本 profile 的 patch
    const patchFiles = [];
    if (this.templateDshHome && fs.existsSync(this.templateDshHome)) {
      for (const file of ['.credentials.yaml', '.env']) {
        const src = path.join(this.templateDshHome, file);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dshHome, file));
      }
      const templatePatch = path.join(this.templateDshHome, 'profiles', this.templateProfile, 'cordis.patch.yml');
      if (fs.existsSync(templatePatch)) patchFiles.push(templatePatch);
    }
    patchFiles.push(overlayPath);

    // 任務工作區：快照目錄或內嵌檔案（都不得逃出工作區）
    if (task?.workspaceDir && fs.existsSync(task.workspaceDir)) {
      fs.cpSync(task.workspaceDir, workspaceDir, { recursive: true });
    }
    if (task?.workspaceFiles && typeof task.workspaceFiles === 'object') {
      for (const [relPath, fileContent] of Object.entries(task.workspaceFiles)) {
        const dest = resolveInside(workspaceDir, relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, String(fileContent), 'utf8');
      }
    }

    this.tempRoots.set(runId, tempRoot);
    return { tempRoot, dshHome, workspaceDir, harnessDir, profileDir, patchFiles };
  }

  /**
   * 執行單次隔離探針
   * @param {any} task
   * @param {any} harnessVersion
   * @param {{
   *   runId?: string,
   *   timeoutMs?: number,
   *   autoCleanup?: boolean,
   *   extraEnv?: Record<string, string>
   * }} [options]
   */
  async run(task, harnessVersion, options = {}) {
    const runId = options.runId || `probe-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    const cap = this.checkCapabilities(task);
    if (!cap.supported) {
      throw new Error(`任務能力檢查未通過（${task?.taskId || 'unknown'}）：${cap.reasons.join('；')}`);
    }

    const sec = validateCandidateProposal(
      {
        components: harnessVersion?.components,
        skills: harnessVersion?.skills,
      },
      this.lockedSurfaces,
      this.protectedPatterns,
    );
    if (!sec.ok) {
      const msg = sec.violations.map((v) => v.reason).join('；');
      throw new Error(`候選 Harness 安全檢查未通過：${msg}`);
    }

    const release = await this.semaphore.acquire();
    const abortController = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.maxWallTimeMs;
    let timer = null;
    let envInfo = null;
    try {
      envInfo = this.prepareIsolatedEnvironment(runId, task, harnessVersion);
      const runState = {
        runId,
        tempRoot: envInfo.tempRoot,
        dshHome: envInfo.dshHome,
        workspaceDir: envInfo.workspaceDir,
        abortController,
        childProcess: null,
        status: 'running',
        timedOut: false,
      };
      this.activeRuns.set(runId, runState);

      timer = setTimeout(() => {
        runState.timedOut = true;
        abortController.abort(new Error('PROBE_TIMEOUT'));
      }, timeoutMs);

      const startTime = Date.now();
      let execResult;
      try {
        execResult = await this._executeProbeInternal(runState, task, harnessVersion, envInfo, options);
      } catch (err) {
        if (runState.timedOut) {
          const e = new Error(`探針執行逾時（超過 ${timeoutMs}ms，runId=${runId}）`);
          e.code = 'PROBE_TIMEOUT';
          throw e;
        }
        throw err;
      }
      const wallClockMs = Date.now() - startTime;

      const record = parseHeadlessJsonStream(execResult.events ?? execResult.rawStdout ?? '', {
        runId,
        taskId: task?.taskId ?? 'unknown-task',
        harnessVersionId: harnessVersion?.versionId ?? 'unknown-harness',
        wallClockMs,
      });
      record.workspaceDir = envInfo.workspaceDir;
      record.dshHome = envInfo.dshHome;
      record.exitCode = execResult.exitCode ?? 0;
      record.stderrExcerpt = String(execResult.rawStderr ?? '').slice(-2000);

      if (record.eventsCount === 0 && record.exitCode !== 0) {
        const e = new Error(`dsh 子行程失敗（exit ${record.exitCode}）：${record.stderrExcerpt.trim().split('\n').slice(-5).join(' | ')}`);
        e.code = 'PROBE_CHILD_FAILED';
        throw e;
      }

      runState.status = 'completed';
      return record;
    } catch (err) {
      const state = this.activeRuns.get(runId);
      if (state) {
        state.status = abortController.signal.aborted ? 'cancelled' : 'failed';
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      this.activeRuns.delete(runId);
      release();
      if (options.autoCleanup === true) {
        await this.cleanup(runId);
      }
    }
  }

  /**
   * 內部執行：優先使用注入之 executor（測試／模擬），否則啟動真實 dsh 子行程
   */
  async _executeProbeInternal(runState, task, harnessVersion, envInfo, options) {
    if (typeof this.executor === 'function') {
      return await this.executor({
        runId: runState.runId,
        task,
        harnessVersion,
        dshHome: envInfo.dshHome,
        workspaceDir: envInfo.workspaceDir,
        harnessDir: envInfo.harnessDir,
        signal: runState.abortController.signal,
        options,
      });
    }

    const cliEntry = resolveDshCliEntry(this.dshCliEntry);
    if (!cliEntry) {
      const e = new Error(
        '找不到 dsh CLI 入口：請在設定裡填 dshCliEntry（指向 @deepseek-ai/dsh/lib/bin.js），或設環境變數 DSH_CLI_ENTRY；在 dsh 內執行時會自動偵測',
      );
      e.code = 'PROBE_NO_DSH_CLI';
      throw e;
    }

    const args = [cliEntry, '--profile', 'headless'];
    for (const p of envInfo.patchFiles) args.push('--patch', p);
    args.push('--json', String(task.prompt || ''));

    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: envInfo.workspaceDir,
        env: {
          ...process.env,
          DSH_HOME: envInfo.dshHome,
          DSH_TELEMETRY_MODE: 'DISABLED',
          ...(options.extraEnv || {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      runState.childProcess = child;
      let stdout = '';
      let stderr = '';
      let settled = false;
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      const onAbort = () => {
        this._killTree(child);
      };
      if (runState.abortController.signal.aborted) {
        onAbort();
      } else {
        runState.abortController.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        runState.abortController.signal.removeEventListener('abort', onAbort);
        reject(err);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        runState.abortController.signal.removeEventListener('abort', onAbort);
        if (runState.abortController.signal.aborted) {
          reject(new Error(`探針執行已取消（runId=${runState.runId}）`));
          return;
        }
        resolve({ rawStdout: stdout, rawStderr: stderr, exitCode: code ?? 0 });
      });
    });
  }

  /** 砍掉子行程與它再往下開的行程（Windows 用 taskkill /T） */
  _killTree(child) {
    if (!child || child.exitCode !== null || child.killed) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).on('error', () => {
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        });
      } else {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (child.exitCode === null) child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 5000).unref();
      }
    } catch {
      // ignore
    }
  }

  /**
   * 取消執行中之探針（等子行程真的結束後才清目錄）
   * @param {string} runId
   * @returns {Promise<boolean>}
   */
  async cancel(runId) {
    const state = this.activeRuns.get(runId);
    if (!state) return false;
    state.status = 'cancelled';
    state.abortController.abort(new Error('USER_CANCELLED'));
    if (state.childProcess && state.childProcess.exitCode === null) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 10000);
        state.childProcess.once('close', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    this.activeRuns.delete(runId);
    await this.cleanup(runId);
    return true;
  }

  /**
   * 清理指定探針之暫存目錄（刪不掉時保留登錄，cleanupAll 會再試）
   * @param {string} runId
   * @returns {Promise<boolean>}
   */
  async cleanup(runId) {
    const tempRoot = this.tempRoots.get(runId);
    if (!tempRoot) return false;
    try {
      if (fs.existsSync(tempRoot)) rmWithRetries(tempRoot);
      this.tempRoots.delete(runId);
      return true;
    } catch (err) {
      this.log(`cleanup of ${tempRoot} failed: ${err.message}`);
      return false;
    }
  }

  /**
   * 清理所有已登錄之探針暫存目錄
   */
  async cleanupAll() {
    for (const runId of Array.from(this.tempRoots.keys())) {
      await this.cleanup(runId);
    }
  }

  /**
   * 清掃以前的行程留下的暫存目錄（行程被強殺時會殘留）
   * @param {{ olderThanMs?: number, tmpDir?: string }} [options]
   * @returns {number} 刪掉的目錄數
   */
  static sweepStaleTempDirs(options = {}) {
    const olderThanMs = options.olderThanMs ?? 6 * 60 * 60 * 1000;
    const tmpDir = options.tmpDir ?? os.tmpdir();
    let removed = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(tmpDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
      const full = path.join(tmpDir, entry.name);
      try {
        const info = JSON.parse(fs.readFileSync(path.join(full, 'run.json'), 'utf8'));
        const age = Date.now() - Date.parse(info.createdAt || 0);
        let ownerAlive = false;
        if (Number.isInteger(info.pid)) {
          try {
            process.kill(info.pid, 0);
            ownerAlive = true;
          } catch (err) {
            ownerAlive = err?.code === 'EPERM';
          }
        }
        if (ownerAlive && age < olderThanMs) continue;
        rmWithRetries(full);
        removed += 1;
      } catch {
        // 沒有 run.json 或刪不掉：略過
      }
    }
    return removed;
  }
}
