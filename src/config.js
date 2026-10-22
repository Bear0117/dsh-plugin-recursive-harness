// 設定正規化與預設值管理
import os from 'node:os';
import path from 'node:path';

/**
 * 候選 Harness 永遠不得觸碰的路徑（相對於工作區或絕對路徑皆可比對）。
 * 這裡只放與 dsh 本身有關的通用項目；使用者專案專屬的路徑請透過 `lockedSurfaces` 設定加入。
 */
export const DEFAULT_LOCKED_SURFACES = Object.freeze([
  'AGENTS.md',
  '.dsh/AGENTS.md',
  '.dsh',
  '.git',
]);

export const DEFAULT_PRE_APPROVED_TOOLS = Object.freeze([
  'read_file',
  'glob',
  'grep',
  'list_dir',
  'skill',
]);

/**
 * 插件模式下的預設根目錄：$DSH_HOME/recursive-harness（與其他 dsh 插件一樣放在 dsh 的家目錄）
 */
export function defaultPluginBaseDir(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh');
  return path.join(home, 'recursive-harness');
}

function resolveDir(baseDir, value, fallback) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return path.resolve(baseDir, raw.replace(/^~(?=$|[\/])/, os.homedir()));
}

function toRegExpSources(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const source = typeof item === 'string' ? item : item?.source;
    if (typeof source !== 'string' || !source.trim()) continue;
    try {
      // 只保留合法的正規表達式來源字串
      new RegExp(source, 'i');
      out.push(source);
    } catch {
      // 略過無效的樣式
    }
  }
  return [...new Set(out)];
}

/**
 * 正規化插件與協調器設定
 * @param {Record<string, any>} raw
 * @param {string} [baseDir] 相對路徑的基準目錄；預設為 raw.baseDir，再退回目前工作目錄
 */
export function normalizeConfig(raw = {}, baseDir) {
  const mode = raw.mode === 'apply-only' ? 'apply-only' : 'full';
  const resolvedBase = path.resolve(
    typeof baseDir === 'string' && baseDir.trim()
      ? baseDir.trim()
      : typeof raw.baseDir === 'string' && raw.baseDir.trim()
        ? raw.baseDir.trim().replace(/^~(?=$|[\/])/, os.homedir())
        : process.cwd(),
  );

  const harnessDir = resolveDir(resolvedBase, raw.harnessDir, 'active');
  const storageDir = resolveDir(resolvedBase, raw.storageDir, 'state');
  const experienceDir = resolveDir(resolvedBase, raw.experienceDir, 'experience');

  const sectionOrder = Number.isFinite(raw.sectionOrder) ? Number(raw.sectionOrder) : 760;
  const maxConcurrency = Number.isFinite(raw.maxConcurrency) && raw.maxConcurrency > 0
    ? Math.min(8, Math.floor(Number(raw.maxConcurrency)))
    : 2;
  const maxTokensPerIteration = Number.isFinite(raw.maxTokensPerIteration) && raw.maxTokensPerIteration > 0
    ? Number(raw.maxTokensPerIteration)
    : 120000;
  const maxWallTimeMs = Number.isFinite(raw.maxWallTimeMs) && raw.maxWallTimeMs > 0
    ? Number(raw.maxWallTimeMs)
    : 300000;
  const enableRuntimeStagnation = Boolean(raw.enableRuntimeStagnation);
  const stagnationThreshold = Number.isFinite(raw.stagnationThreshold) && raw.stagnationThreshold >= 2
    ? Math.floor(Number(raw.stagnationThreshold))
    : 3;

  const lockedSurfaces = Array.isArray(raw.lockedSurfaces)
    ? [...new Set([...DEFAULT_LOCKED_SURFACES, ...raw.lockedSurfaces.map(String).filter((s) => s.trim())])]
    : [...DEFAULT_LOCKED_SURFACES];

  const protectedPatterns = toRegExpSources(raw.protectedPatterns);

  const preApprovedTools = Array.isArray(raw.preApprovedTools)
    ? [...new Set(raw.preApprovedTools.map(String))]
    : [...DEFAULT_PRE_APPROVED_TOOLS];

  const timeWindowPolicy = {
    enabled: Boolean(raw.timeWindowPolicy?.enabled),
    allowedHoursStart: Number.isFinite(raw.timeWindowPolicy?.allowedHoursStart)
      ? Number(raw.timeWindowPolicy.allowedHoursStart)
      : 0,
    allowedHoursEnd: Number.isFinite(raw.timeWindowPolicy?.allowedHoursEnd)
      ? Number(raw.timeWindowPolicy.allowedHoursEnd)
      : 24,
  };

  const dshCliEntry = typeof raw.dshCliEntry === 'string' && raw.dshCliEntry.trim()
    ? raw.dshCliEntry.trim()
    : null;

  return {
    mode,
    baseDir: resolvedBase,
    harnessDir,
    storageDir,
    experienceDir,
    sectionOrder,
    maxConcurrency,
    maxTokensPerIteration,
    maxWallTimeMs,
    enableRuntimeStagnation,
    stagnationThreshold,
    lockedSurfaces,
    protectedPatterns,
    preApprovedTools,
    timeWindowPolicy,
    dshCliEntry,
  };
}
