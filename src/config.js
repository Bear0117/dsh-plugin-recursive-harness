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

/** dsh 的家目錄：$DSH_HOME 或 ~/.dsh */
export function resolveDshHome(env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh');
}

/**
 * 插件模式下的預設根目錄：$DSH_HOME/recursive-harness（與其他 dsh 插件一樣放在 dsh 的家目錄）
 */
export function defaultPluginBaseDir(env = process.env) {
  return path.join(resolveDshHome(env), 'recursive-harness');
}

function expandHome(value) {
  return String(value).replace(/^~(?=$|[\\/])/, os.homedir());
}

function resolveDir(baseDir, value, fallback) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return path.resolve(baseDir, expandHome(raw));
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

function num(value, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.floor(clamped) : clamped;
}

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function strList(value) {
  return Array.isArray(value) ? [...new Set(value.map((v) => String(v).trim()).filter(Boolean))] : [];
}

/**
 * 模型端點設定（提案器與裁判共用）
 * @param {Record<string, any>} raw
 */
export function normalizeProposerConfig(raw = {}) {
  const engine = raw.engine === 'llm' ? 'llm' : 'template';
  return {
    engine,
    endpoint: str(raw.endpoint, 'http://127.0.0.1:8000/v1/chat/completions'),
    model: str(raw.model, ''),
    apiKeyEnv: str(raw.apiKeyEnv, ''),
    allowEgress: Boolean(raw.allowEgress),
    allowHttpHosts: strList(raw.allowHttpHosts).map((h) => h.toLowerCase()),
    timeoutMs: num(raw.timeoutMs, 120000, { min: 1000, integer: true }),
    temperature: num(raw.temperature, 0.7, { min: 0, max: 2 }),
    maxTokens: num(raw.maxTokens, 4000, { min: 256, integer: true }),
    extraBody: raw.extraBody && typeof raw.extraBody === 'object' ? raw.extraBody : {},
    maxCandidateChars: num(raw.maxCandidateChars, 6000, { min: 500, integer: true }),
    judge: Boolean(raw.judge),
  };
}

/**
 * 探針子行程設定
 * @param {Record<string, any>} raw
 * @param {Record<string, string|undefined>} env
 */
export function normalizeProbeConfig(raw = {}, env = process.env) {
  const templateDshHome = str(raw.templateDshHome, '') ? path.resolve(expandHome(raw.templateDshHome)) : resolveDshHome(env);
  return {
    templateDshHome,
    templateProfile: str(raw.templateProfile, 'web'),
    provider: str(raw.provider, '') || null,
    model: str(raw.model, '') || null,
    dshCliEntry: str(raw.dshCliEntry, '') ? path.resolve(expandHome(raw.dshCliEntry)) : null,
    blockedTools: strList(raw.blockedTools),
  };
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
        ? expandHome(raw.baseDir.trim())
        : process.cwd(),
  );

  const harnessDir = resolveDir(resolvedBase, raw.harnessDir, 'active');
  const storageDir = resolveDir(resolvedBase, raw.storageDir, 'state');
  const experienceDir = resolveDir(resolvedBase, raw.experienceDir, 'experience');

  const sectionOrder = num(raw.sectionOrder, 760);
  const maxConcurrency = num(raw.maxConcurrency, 2, { min: 1, max: 8, integer: true });
  const maxTokensPerIteration = num(raw.maxTokensPerIteration, 120000, { min: 1, integer: true });
  const maxWallTimeMs = num(raw.maxWallTimeMs, 300000, { min: 1000, integer: true });
  const probeTimeoutMs = num(raw.probeTimeoutMs, 600000, { min: 1000, integer: true });
  const enableRuntimeStagnation = Boolean(raw.enableRuntimeStagnation);
  const stagnationThreshold = num(raw.stagnationThreshold, 3, { min: 2, integer: true });

  const lockedSurfaces = [...new Set([...DEFAULT_LOCKED_SURFACES, ...strList(raw.lockedSurfaces)])];
  const protectedPatterns = toRegExpSources(raw.protectedPatterns);
  const preApprovedTools = Array.isArray(raw.preApprovedTools)
    ? strList(raw.preApprovedTools)
    : [...DEFAULT_PRE_APPROVED_TOOLS];

  const timeWindowPolicy = {
    enabled: Boolean(raw.timeWindowPolicy?.enabled),
    allowedHoursStart: num(raw.timeWindowPolicy?.allowedHoursStart, 0, { min: 0, max: 24 }),
    allowedHoursEnd: num(raw.timeWindowPolicy?.allowedHoursEnd, 24, { min: 0, max: 24 }),
  };

  const proposer = normalizeProposerConfig(raw.proposer);
  const probe = normalizeProbeConfig(raw.probe);
  // 舊欄位相容
  if (!probe.dshCliEntry && str(raw.dshCliEntry, '')) probe.dshCliEntry = path.resolve(expandHome(raw.dshCliEntry));
  if (probe.blockedTools.length === 0 && Array.isArray(raw.blockedTools)) probe.blockedTools = strList(raw.blockedTools);

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
    probeTimeoutMs,
    enableRuntimeStagnation,
    stagnationThreshold,
    lockedSurfaces,
    protectedPatterns,
    preApprovedTools,
    timeWindowPolicy,
    proposer,
    probe,
    dshCliEntry: probe.dshCliEntry,
  };
}
