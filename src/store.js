// Sidecar 狀態持久化：manifest.json、events.jsonl、內容定址 Harness 快照與中斷點恢復
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  EVOLUTION_STATES,
  TERMINAL_STATES,
  isValidStateTransition,
} from './types.js';
import {
  loadHarnessFromDir,
  writeHarnessToDir,
} from './harness-loader.js';

const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 20;

/**
 * 同步等待（零相依；用於 rename 重試間隔）
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 原子寫入 JSON：先寫入 `<file>.tmp-<pid>-<random>` 再 rename 覆蓋目標檔。
 * Windows 上 rename 覆蓋既有檔案偶爾會 EPERM，最多重試 5 次、每次等 20ms。
 * @param {string} filePath
 * @param {any} data
 */
export function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  let lastError = null;
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < RENAME_MAX_ATTEMPTS && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) {
        sleepSync(RENAME_RETRY_DELAY_MS);
        continue;
      }
      break;
    }
  }
  try {
    fs.rmSync(tmpPath, { force: true });
  } catch {
    // 忽略暫存檔清理失敗
  }
  throw lastError;
}

/**
 * 試探指定 pid 之行程是否仍存在（EPERM 視為存在；ESRCH 等視為不存在）
 * @param {unknown} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (n === process.pid) return true;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export class HarnessStateStore {
  /**
   * @param {{ storageDir: string, activeHarnessDir: string }} options
   */
  constructor(options) {
    this.storageDir = path.resolve(options.storageDir);
    this.activeHarnessDir = path.resolve(options.activeHarnessDir);
    this.harnessesDir = path.join(this.storageDir, 'harnesses');
    this.checkpointsDir = path.join(this.storageDir, 'checkpoints');
    this.sessionsDir = path.join(this.storageDir, 'sessions');
    this.manifestPath = path.join(this.storageDir, 'manifest.json');
    this.eventsPath = path.join(this.storageDir, 'events.jsonl');

    this._ensureDirectories();
  }

  _ensureDirectories() {
    fs.mkdirSync(this.storageDir, { recursive: true });
    fs.mkdirSync(this.harnessesDir, { recursive: true });
    fs.mkdirSync(this.checkpointsDir, { recursive: true });
    fs.mkdirSync(this.sessionsDir, { recursive: true });

    if (!fs.existsSync(this.manifestPath)) {
      const initialManifest = {
        activeVersionId: null,
        previousVersionId: null,
        versions: [],
        activeRunId: null,
        updatedAt: new Date().toISOString(),
      };
      writeJsonAtomic(this.manifestPath, initialManifest);
    }
  }

  /**
   * 讀取 manifest.json
   */
  readManifest() {
    this._ensureDirectories();
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
    } catch {
      return {
        activeVersionId: null,
        previousVersionId: null,
        versions: [],
        activeRunId: null,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * 更新 manifest.json
   * @param {Partial<ReturnType<HarnessStateStore['readManifest']>>} patch
   */
  writeManifest(patch) {
    const current = this.readManifest();
    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(this.manifestPath, next);
    return next;
  }

  /**
   * 追加一筆事件至 events.jsonl
   * @param {Record<string, any>} event
   */
  appendEvent(event) {
    this._ensureDirectories();
    const record = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  /**
   * 讀取所有事件紀錄
   * @returns {Array<Record<string, any>>}
   */
  readEvents() {
    if (!fs.existsSync(this.eventsPath)) return [];
    return fs
      .readFileSync(this.eventsPath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /**
   * 儲存內容定址之 HarnessVersion 快照
   * @param {any} harness
   * @param {{ setActive?: boolean, reason?: string }} [options]
   */
  saveHarnessSnapshot(harness, options = {}) {
    const tempSnapshot = writeHarnessToDir(
      harness,
      path.join(this.harnessesDir, harness.versionId || 'pending'),
    );
    const finalDir = path.join(this.harnessesDir, tempSnapshot.versionId);
    if (tempSnapshot.harnessDir !== finalDir) {
      if (fs.existsSync(finalDir)) {
        fs.rmSync(finalDir, { recursive: true, force: true });
      }
      fs.renameSync(tempSnapshot.harnessDir, finalDir);
    }

    const saved = loadHarnessFromDir(finalDir, {
      parentVersionId: harness.parentVersionId ?? null,
      createdAt: harness.createdAt,
      validateSecurity: false,
    });

    const manifest = this.readManifest();
    const exists = manifest.versions.some((v) => v.versionId === saved.versionId);
    const nextVersions = exists
      ? manifest.versions
      : [
          ...manifest.versions,
          {
            versionId: saved.versionId,
            hash: saved.hash,
            parentVersionId: saved.parentVersionId,
            createdAt: saved.createdAt,
            reason: options.reason || 'snapshot',
          },
        ];

    const patch = { versions: nextVersions };
    if (options.setActive) {
      patch.previousVersionId =
        manifest.activeVersionId && manifest.activeVersionId !== saved.versionId
          ? manifest.activeVersionId
          : manifest.previousVersionId;
      patch.activeVersionId = saved.versionId;
      writeHarnessToDir(saved, this.activeHarnessDir, { validateSecurity: true });
    }

    this.writeManifest(patch);
    return saved;
  }

  /**
   * 依 versionId 載入歷史 HarnessVersion
   * @param {string} versionId
   */
  getHarnessVersion(versionId) {
    const dir = path.join(this.harnessesDir, versionId);
    if (!fs.existsSync(dir)) {
      return null;
    }
    return loadHarnessFromDir(dir, { validateSecurity: false });
  }

  /**
   * 回退（Rollback）至指定版本或上一版本
   * @param {string} [targetVersionId]
   */
  rollback(targetVersionId) {
    const manifest = this.readManifest();
    const resolvedId = targetVersionId || manifest.previousVersionId;
    if (!resolvedId) {
      throw new Error('無可回退之目標 Harness 版本（未指定 versionId 且無 previousVersionId）');
    }

    const targetHarness = this.getHarnessVersion(resolvedId);
    if (!targetHarness) {
      throw new Error(`找不到目標 Harness 版本快照：${resolvedId}`);
    }

    writeHarnessToDir(targetHarness, this.activeHarnessDir, { validateSecurity: true });
    this.writeManifest({
      previousVersionId: manifest.activeVersionId,
      activeVersionId: targetHarness.versionId,
    });

    this.appendEvent({
      type: 'harness/rollback',
      fromVersionId: manifest.activeVersionId,
      toVersionId: targetHarness.versionId,
    });

    return targetHarness;
  }

  /**
   * 建立或更新演進執行中斷點（Checkpoint），並強制驗證狀態轉換合法性
   * @param {string} runId
   * @param {Record<string, any>} patch
   */
  saveCheckpoint(runId, patch) {
    const filePath = path.join(this.checkpointsDir, `${runId}.json`);
    let existing = null;
    if (fs.existsSync(filePath)) {
      try {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        existing = null;
      }
    }

    if (existing && patch.state && existing.state !== patch.state) {
      if (!isValidStateTransition(existing.state, patch.state)) {
        throw new Error(
          `非法狀態機轉換：${existing.state} -> ${patch.state}（runId=${runId}）`,
        );
      }
    }

    const now = new Date().toISOString();
    const record = {
      runId,
      state: existing?.state || EVOLUTION_STATES.OBSERVED,
      createdAt: existing?.createdAt || now,
      ...existing,
      ...patch,
      ownerPid: process.pid,
      heartbeatAt: now,
      updatedAt: now,
    };

    writeJsonAtomic(filePath, record);

    const manifest = this.readManifest();
    if (TERMINAL_STATES.has(record.state)) {
      if (manifest.activeRunId === runId) {
        this.writeManifest({ activeRunId: null });
      }
    } else {
      this.writeManifest({ activeRunId: runId });
    }

    return record;
  }

  /**
   * 僅更新中斷點之 heartbeatAt（不改 state、不走狀態機檢查），供執行中的行程定期心跳
   * @param {string} runId
   */
  touchCheckpoint(runId) {
    const filePath = path.join(this.checkpointsDir, `${runId}.json`);
    const existing = this.getCheckpoint(runId);
    if (!existing) return null;
    const record = {
      ...existing,
      heartbeatAt: new Date().toISOString(),
    };
    writeJsonAtomic(filePath, record);
    return record;
  }

  /**
   * 讀取指定演進執行之中斷點
   * @param {string} runId
   */
  getCheckpoint(runId) {
    const filePath = path.join(this.checkpointsDir, `${runId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * 列出所有中斷點
   */
  listCheckpoints() {
    if (!fs.existsSync(this.checkpointsDir)) return [];
    return fs
      .readdirSync(this.checkpointsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.getCheckpoint(f.slice(0, -5)))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /**
   * 協調器重啟恢復：掃描未終止之中斷點，回傳待續跑清單或將孤兒狀態標記為可安全恢復。
   * 只有「ownerPid 行程已不存在」或「heartbeatAt 超過 staleAfterMs」的 run 才視為孤兒；
   * 其餘（同機另一個 dsh 視窗正在跑的 run）保留，並在回傳值標記 skipped: true。
   * @param {{ markOrphansCancelled?: boolean, staleAfterMs?: number, now?: number }} [options]
   */
  recoverInterruptedRuns(options = {}) {
    const checkpoints = this.listCheckpoints();
    const unfinished = checkpoints.filter((cp) => !TERMINAL_STATES.has(cp.state));
    const recovered = [];
    const staleAfterMs = Number.isFinite(options.staleAfterMs)
      ? Number(options.staleAfterMs)
      : DEFAULT_STALE_AFTER_MS;
    const nowMs = Number.isFinite(options.now) ? Number(options.now) : Date.now();

    for (const cp of unfinished) {
      const ownerAlive = isProcessAlive(cp.ownerPid);
      const heartbeatMs = Date.parse(cp.heartbeatAt || cp.updatedAt || '');
      const stale = !Number.isFinite(heartbeatMs) || nowMs - heartbeatMs > staleAfterMs;
      const orphan = !ownerAlive || stale;

      if (!orphan) {
        recovered.push({ ...cp, skipped: true });
        continue;
      }

      if (options.markOrphansCancelled) {
        const updated = this.saveCheckpoint(cp.runId, {
          state: EVOLUTION_STATES.CANCELLED,
          recoveryNote: ownerAlive
            ? `心跳逾時（heartbeatAt 超過 ${staleAfterMs}ms）自動清理未完成之演進狀態並釋放鎖定`
            : `擁有者行程（pid=${cp.ownerPid ?? 'unknown'}）已不存在，自動清理未完成之演進狀態並釋放鎖定`,
        });
        this.appendEvent({
          type: 'run/recovered-cancelled',
          runId: cp.runId,
          previousState: cp.state,
          ownerPid: cp.ownerPid ?? null,
          reason: ownerAlive ? 'stale-heartbeat' : 'owner-dead',
        });
        recovered.push(updated);
      } else {
        recovered.push(cp);
      }
    }

    return recovered;
  }

  /**
   * 綁定 dsh Session ID 與其採用之 Harness 版本及統計摘要（Sidecar 持久化）
   * @param {string} sessionId
   * @param {Record<string, any>} data
   */
  saveSessionSidecar(sessionId, data) {
    const safeId = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(this.sessionsDir, `${safeId}.json`);
    let existing = {};
    if (fs.existsSync(filePath)) {
      try {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        existing = {};
      }
    }
    const next = {
      sessionId,
      ...existing,
      ...data,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(filePath, next);
    return next;
  }

  /**
   * 讀取指定 Session 之 Sidecar 資料
   * @param {string} sessionId
   */
  getSessionSidecar(sessionId) {
    const safeId = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(this.sessionsDir, `${safeId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }
}
