// 探針執行器（ProbeRunner）：隔離 DSH_HOME、工作區快照複製、併發號誌、取消與殘留清理
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeHarnessToDir } from './harness-loader.js';
import { parseHeadlessJsonStream } from './trajectory.js';
import { validateCandidateProposal } from './security.js';

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

  const inWindow = start <= end
    ? hour >= start && hour < end
    : hour >= start || hour < end;

  if (!inWindow) {
    return {
      allowed: false,
      reason: `目前時間（${hour}:00）不在允許之探針時間窗（${start}:00–${end}:00）內`,
    };
  }
  return { allowed: true };
}

/**
 * 探針執行器（實作計畫定義之 ProbeRunner 介面）
 */
export class ProbeRunner {
  /**
   * @param {{
   *   maxConcurrency?: number,
   *   maxWallTimeMs?: number,
   *   timeWindowPolicy?: { enabled?: boolean, allowedHoursStart?: number, allowedHoursEnd?: number },
   *   templateDshHome?: string,
   *   pluginRootDir?: string,
   *   dshCliEntry?: string,
   *   lockedSurfaces?: string[],
   *   protectedPatterns?: string[],
   *   blockedTools?: string[],
   *   preApprovedTools?: string[],
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
    this.pluginRootDir = config.pluginRootDir ?? process.cwd();
    this.dshCliEntry = config.dshCliEntry ?? null;
    this.lockedSurfaces = config.lockedSurfaces;
    this.protectedPatterns = config.protectedPatterns ?? [];
    this.blockedTools = Array.isArray(config.blockedTools) ? config.blockedTools.map(String) : [];
    this.preApprovedTools = config.preApprovedTools ?? [
      'read_file',
      'glob',
      'grep',
      'list_dir',
      'skill',
    ];
    this.executor = config.executor ?? null;
    this.semaphore = new Semaphore(this.maxConcurrency);

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

    // 1. 檢查時間窗策略
    const tw = checkTimeWindowPolicy(this.timeWindowPolicy, options.now);
    if (!tw.allowed) {
      reasons.push(tw.reason);
    }

    // 2. 任務可宣告 exclusive: true（例如一次只能接一個外部程式的任務）→ 探針不平行
    // 3. 任務所需工具若在 blockedTools 清單裡（設定可加），拒絕自動探針
    if (Array.isArray(task?.requiredTools)) {
      for (const tool of task.requiredTools) {
        if (this.blockedTools.includes(tool)) {
          reasons.push(`任務需要的工具在封鎖清單中，禁止自動探針：${tool}`);
        }
      }
    }

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
   * @param {string} runId
   * @param {any} task
   * @param {any} harnessVersion
   */
  prepareIsolatedEnvironment(runId, task, harnessVersion) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-probe-${runId}-`));
    const dshHome = path.join(tempRoot, 'dsh-home');
    const workspaceDir = path.join(tempRoot, 'workspace');
    const harnessDir = path.join(dshHome, 'candidate-harness');

    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    // 若提供基礎 DSH_HOME 模板，僅複製必要設定檔（排除歷史 sessions / logs）
    if (this.templateDshHome && fs.existsSync(this.templateDshHome)) {
      for (const sub of ['config.yml', 'profiles']) {
        const srcPath = path.join(this.templateDshHome, sub);
        if (fs.existsSync(srcPath)) {
          fs.cpSync(srcPath, path.join(dshHome, sub), { recursive: true });
        }
      }
    }

    // 寫入候選 Harness 至隔離目錄（含安全檢查）
    writeHarnessToDir(harnessVersion, harnessDir, {
      validateSecurity: true,
      lockedSurfaces: this.lockedSurfaces,
    });

    // 建立 headless profile 設定，強制將插件設為 apply-only 以避免遞迴自觸發
    const headlessProfileDir = path.join(dshHome, 'profiles', 'headless');
    fs.mkdirSync(headlessProfileDir, { recursive: true });
    const patchYmlPath = path.join(headlessProfileDir, 'cordis.patch.yml');
    const normalizedHarnessDir = harnessDir.replace(/\\/g, '/');
    const patchBlock = [
      '',
      '# Auto-generated by dsh-plugin-recursive-harness ProbeRunner (apply-only mode)',
      'plugins:',
      '  dsh-plugin-recursive-harness:',
      '    mode: apply-only',
      `    harnessDir: "${normalizedHarnessDir}"`,
      '',
    ].join('\n');

    if (fs.existsSync(patchYmlPath)) {
      fs.appendFileSync(patchYmlPath, patchBlock, 'utf8');
    } else {
      fs.writeFileSync(patchYmlPath, patchBlock.trimStart(), 'utf8');
    }

    // 複製任務工作區快照或初始檔案
    if (task?.workspaceDir && fs.existsSync(task.workspaceDir)) {
      fs.cpSync(task.workspaceDir, workspaceDir, { recursive: true });
    }
    if (task?.workspaceFiles && typeof task.workspaceFiles === 'object') {
      for (const [relPath, fileContent] of Object.entries(task.workspaceFiles)) {
        const dest = path.join(workspaceDir, relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, String(fileContent), 'utf8');
      }
    }

    this.tempRoots.set(runId, tempRoot);
    return { tempRoot, dshHome, workspaceDir, harnessDir };
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
    const runId = options.runId || `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
      };
      this.activeRuns.set(runId, runState);

      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          abortController.abort(new Error('PROBE_TIMEOUT'));
          reject(new Error(`探針執行逾時（超過 ${timeoutMs}ms）`));
        }, timeoutMs);
      });

      const startTime = Date.now();
      const execPromise = this._executeProbeInternal(
        runState,
        task,
        harnessVersion,
        envInfo,
        options,
      );

      const execResult = await Promise.race([execPromise, timeoutPromise]);
      const wallClockMs = Date.now() - startTime;

      const record = parseHeadlessJsonStream(
        execResult.events ?? execResult.rawStdout ?? '',
        {
          runId,
          taskId: task?.taskId ?? 'unknown-task',
          harnessVersionId: harnessVersion?.versionId ?? 'unknown-harness',
          wallClockMs,
        },
      );

      // 若任務工作區內產生了產物，一併快照供客觀檢查器驗證
      record.workspaceDir = envInfo.workspaceDir;
      record.dshHome = envInfo.dshHome;
      record.exitCode = execResult.exitCode ?? 0;

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
   * 內部執行：優先使用注入之 executor，否則呼叫真實 dsh --profile headless --json
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

    if (!this.dshCliEntry) {
      throw new Error('未設定 dshCliEntry 或自訂 executor，無法啟動子行程探針');
    }

    return await new Promise((resolve, reject) => {
      const args = [
        this.dshCliEntry,
        '--profile',
        'headless',
        '--prompt',
        String(task.prompt || ''),
        '--cwd',
        envInfo.workspaceDir,
        '--json',
      ];

      const child = spawn(process.execPath, args, {
        cwd: envInfo.workspaceDir,
        env: {
          ...process.env,
          DSH_HOME: envInfo.dshHome,
          ...(options.extraEnv || {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      runState.childProcess = child;
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      const onAbort = () => {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        reject(new Error(`探針執行已取消（runId=${runState.runId}）`));
      };

      if (runState.abortController.signal.aborted) {
        onAbort();
        return;
      }
      runState.abortController.signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        runState.abortController.signal.removeEventListener('abort', onAbort);
        reject(err);
      });

      child.on('close', (code) => {
        runState.abortController.signal.removeEventListener('abort', onAbort);
        resolve({
          rawStdout: stdout,
          rawStderr: stderr,
          exitCode: code ?? 0,
        });
      });
    });
  }

  /**
   * 取消執行中之探針
   * @param {string} runId
   * @returns {Promise<boolean>}
   */
  async cancel(runId) {
    const state = this.activeRuns.get(runId);
    if (!state) return false;

    state.status = 'cancelled';
    state.abortController.abort(new Error('USER_CANCELLED'));
    if (state.childProcess && !state.childProcess.killed) {
      try {
        state.childProcess.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.activeRuns.delete(runId);
    await this.cleanup(runId);
    return true;
  }

  /**
   * 清理指定探針之暫存目錄
   * @param {string} runId
   * @returns {Promise<boolean>}
   */
  async cleanup(runId) {
    const tempRoot = this.tempRoots.get(runId);
    if (!tempRoot) return false;
    this.tempRoots.delete(runId);
    if (fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    return true;
  }

  /**
   * 清理所有已登錄之探針暫存目錄
   */
  async cleanupAll() {
    for (const runId of Array.from(this.tempRoots.keys())) {
      await this.cleanup(runId);
    }
  }
}
