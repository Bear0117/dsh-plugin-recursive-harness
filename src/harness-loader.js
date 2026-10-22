// Harness 載入器、內容定址雜湊計算與 dsh Context 掛載（systemPrompt.section + skills）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_HARNESS_COMPONENTS,
  HARNESS_COMPONENT_FILES,
} from './types.js';
import { validateCandidateProposal } from './security.js';

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 判斷字串是否為安全之單一路徑片段（不含分隔符、不含 `..`、非 `.`、不以 `.` 開頭）
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeSegment(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\') || value.includes('..')) return false;
  if (path.basename(value) !== value) return false;
  return SAFE_SEGMENT_PATTERN.test(value);
}

/**
 * 斷言 skill 資料夾名／script 檔名為安全之單一路徑片段，否則丟出 HARNESS_UNSAFE_PATH
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
export function assertSafeSegment(value, label) {
  if (!isSafeSegment(value)) {
    const err = new Error(`${label} 含不安全之路徑片段：${JSON.stringify(value)}`);
    err.code = 'HARNESS_UNSAFE_PATH';
    err.value = value;
    throw err;
  }
  return value;
}

/**
 * 解析 SKILL.md 簡易 YAML frontmatter（name, description）與內文
 * @param {string} rawMarkdown
 * @param {string} fallbackName
 * @returns {{ name: string, description: string, body: string, raw: string }}
 */
export function parseSkillMarkdown(rawMarkdown, fallbackName) {
  const raw = String(rawMarkdown ?? '');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    const firstParagraph = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    return {
      name: fallbackName,
      description: firstParagraph || `Candidate skill ${fallbackName}`,
      body: raw.trim(),
      raw,
    };
  }

  const frontmatter = match[1];
  const body = match[2].trim();
  let name = fallbackName;
  let description = `Candidate skill ${fallbackName}`;

  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim().replace(/^['"]|['"]$/g, '');
    if (key === 'name' && val) name = val;
    if (key === 'description' && val) description = val;
  }

  return { name, description, body, raw };
}

/**
 * 確保 Harness 資料夾存在；若缺少基礎元件檔案則寫入預設值
 * @param {string} harnessDir
 * @param {Partial<Record<string, string>>} [initialComponents]
 */
export function ensureHarnessDir(harnessDir, initialComponents = {}) {
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'skills'), { recursive: true });

  for (const item of HARNESS_COMPONENT_FILES) {
    const filePath = path.join(harnessDir, item.fileName);
    if (!fs.existsSync(filePath)) {
      const content =
        initialComponents[item.key] ??
        DEFAULT_HARNESS_COMPONENTS[item.key] ??
        '';
      fs.writeFileSync(filePath, `${content.trim()}\n`, 'utf8');
    }
  }
}

/**
 * 計算 Harness 內容定址雜湊值（SHA-256）
 * @param {{
 *   components: Record<string, string>,
 *   skills: Array<{ name: string, content: string, scripts?: Record<string, string> }>
 * }} payload
 * @returns {{ hash: string, versionId: string }}
 */
export function computeHarnessHash(payload) {
  const canonical = {
    components: {},
    skills: [],
  };

  for (const item of HARNESS_COMPONENT_FILES) {
    canonical.components[item.key] = String(payload.components?.[item.key] ?? '')
      .replace(/\r\n/g, '\n')
      .trim();
  }

  const sortedSkills = [...(payload.skills ?? [])].sort((a, b) =>
    String(a.name).localeCompare(String(b.name)),
  );
  for (const s of sortedSkills) {
    const sortedScripts = {};
    if (s.scripts && typeof s.scripts === 'object') {
      for (const k of Object.keys(s.scripts).sort()) {
        sortedScripts[k] = String(s.scripts[k]).replace(/\r\n/g, '\n').trim();
      }
    }
    canonical.skills.push({
      name: s.name,
      content: String(s.content ?? '').replace(/\r\n/g, '\n').trim(),
      scripts: sortedScripts,
    });
  }

  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');

  return {
    hash,
    versionId: `h-${hash.slice(0, 12)}`,
  };
}

/**
 * 從指定目錄載入 HarnessVersion
 * @param {string} harnessDir
 * @param {{ parentVersionId?: string | null, createdAt?: string, validateSecurity?: boolean, lockedSurfaces?: string[] }} [options]
 */
export function loadHarnessFromDir(harnessDir, options = {}) {
  const absDir = path.resolve(harnessDir);
  const components = {};

  for (const item of HARNESS_COMPONENT_FILES) {
    const filePath = path.join(absDir, item.fileName);
    if (fs.existsSync(filePath)) {
      components[item.key] = fs.readFileSync(filePath, 'utf8').trim();
    } else {
      components[item.key] = '';
    }
  }

  const skills = [];
  const skillsRoot = path.join(absDir, 'skills');
  if (fs.existsSync(skillsRoot)) {
    const entries = fs
      .readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const dirEntry of entries) {
      const skillDir = path.join(skillsRoot, dirEntry.name);
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;

      const rawMd = fs.readFileSync(skillMdPath, 'utf8');
      const parsed = parseSkillMarkdown(rawMd, dirEntry.name);
      // frontmatter name 未經驗證；不合法時退回使用資料夾名，避免後續寫回時成為路徑穿越來源
      if (!isSafeSegment(parsed.name)) {
        parsed.name = dirEntry.name;
      }
      const scripts = {};
      const scriptsDir = path.join(skillDir, 'scripts');
      if (fs.existsSync(scriptsDir)) {
        const scriptFiles = fs
          .readdirSync(scriptsDir, { withFileTypes: true })
          .filter((f) => f.isFile())
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const sf of scriptFiles) {
          scripts[sf.name] = fs.readFileSync(path.join(scriptsDir, sf.name), 'utf8');
        }
      }

      skills.push({
        name: parsed.name,
        folderName: dirEntry.name,
        description: parsed.description,
        body: parsed.body,
        content: rawMd,
        basePath: skillDir,
        scripts,
      });
    }
  }

  if (options.validateSecurity !== false) {
    const check = validateCandidateProposal(
      { components, skills },
      options.lockedSurfaces,
    );
    if (!check.ok) {
      const reasons = check.violations.map((v) => `[${v.source}] ${v.reason}`).join('；');
      const err = new Error(`Harness 安全驗證失敗：${reasons}`);
      err.code = 'HARNESS_SECURITY_VIOLATION';
      err.violations = check.violations;
      throw err;
    }
  }

  const { hash, versionId } = computeHarnessHash({ components, skills });
  let meta = {};
  const metaPath = path.join(absDir, 'harness.meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      meta = {};
    }
  }

  return {
    versionId,
    hash,
    parentVersionId: options.parentVersionId ?? meta.parentVersionId ?? null,
    createdAt: options.createdAt ?? meta.createdAt ?? new Date().toISOString(),
    harnessDir: absDir,
    components,
    skills,
  };
}

/**
 * 將 Harness 結構完整寫入指定目錄
 * @param {{
 *   parentVersionId?: string | null,
 *   createdAt?: string,
 *   components: Record<string, string>,
 *   skills?: Array<{ name: string, folderName?: string, content: string, scripts?: Record<string, string> }>
 * }} harness
 * @param {string} targetDir
 * @param {{ validateSecurity?: boolean, lockedSurfaces?: string[] }} [options]
 */
export function writeHarnessToDir(harness, targetDir, options = {}) {
  if (options.validateSecurity !== false) {
    const check = validateCandidateProposal(
      {
        components: harness.components,
        skills: harness.skills,
      },
      options.lockedSurfaces,
    );
    if (!check.ok) {
      const reasons = check.violations.map((v) => `[${v.source}] ${v.reason}`).join('；');
      const err = new Error(`禁止寫入違規 Harness：${reasons}`);
      err.code = 'HARNESS_SECURITY_VIOLATION';
      err.violations = check.violations;
      throw err;
    }
  }

  const absTarget = path.resolve(targetDir);
  fs.mkdirSync(absTarget, { recursive: true });

  for (const item of HARNESS_COMPONENT_FILES) {
    const text = String(harness.components?.[item.key] ?? '').trim();
    fs.writeFileSync(
      path.join(absTarget, item.fileName),
      text ? `${text}\n` : '',
      'utf8',
    );
  }

  const skillsRoot = path.join(absTarget, 'skills');
  if (fs.existsSync(skillsRoot)) {
    fs.rmSync(skillsRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(skillsRoot, { recursive: true });

  for (const skill of harness.skills ?? []) {
    const folder = assertSafeSegment(skill.folderName || skill.name, 'skill folderName/name');
    const skillDir = path.join(skillsRoot, folder);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `${String(skill.content ?? '').trim()}\n`, 'utf8');

    if (skill.scripts && typeof skill.scripts === 'object') {
      const scriptsDir = path.join(skillDir, 'scripts');
      fs.mkdirSync(scriptsDir, { recursive: true });
      for (const [scriptName, scriptContent] of Object.entries(skill.scripts)) {
        assertSafeSegment(scriptName, `skill "${folder}" script 檔名`);
        fs.writeFileSync(path.join(scriptsDir, scriptName), String(scriptContent), 'utf8');
      }
    }
  }

  const { hash, versionId } = computeHarnessHash({
    components: harness.components ?? {},
    skills: harness.skills ?? [],
  });

  const meta = {
    versionId,
    hash,
    parentVersionId: harness.parentVersionId ?? null,
    createdAt: harness.createdAt ?? new Date().toISOString(),
  };
  fs.writeFileSync(path.join(absTarget, 'harness.meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  return loadHarnessFromDir(absTarget, {
    parentVersionId: meta.parentVersionId,
    createdAt: meta.createdAt,
    validateSecurity: false,
  });
}

/**
 * 安全取得綁定於 targetCtx 作用域之 systemPrompt 與 skills 服務代理
 * （在 Cordis 4 中，targetCtx.get(name) 免除 inject 宣告即可回傳綁定 targetCtx 作用域之 Traceable 代理；
 * 同時相容直接傳入屬性之測試 mock Context）
 * @param {any} targetCtx
 */
function resolveScopedServices(targetCtx) {
  let systemPrompt = null;
  let skills = null;

  if (typeof targetCtx?.get === 'function') {
    try {
      systemPrompt = targetCtx.get('systemPrompt') ?? null;
    } catch {
      systemPrompt = null;
    }
    try {
      skills = targetCtx.get('skills') ?? null;
    } catch {
      skills = null;
    }
  }

  if (!systemPrompt) {
    try {
      systemPrompt = targetCtx?.systemPrompt ?? null;
    } catch {
      systemPrompt = null;
    }
  }
  if (!skills) {
    try {
      skills = targetCtx?.skills ?? null;
    } catch {
      skills = null;
    }
  }

  return { systemPrompt, skills };
}

/**
 * 將 HarnessVersion 掛載至目標 Context（可為 agent.ctx 或全域 ctx）
 * - 使用 systemPrompt.section({ name, order, text, interpolate: false }) 避免模板語法誤報錯
 * - 使用 skills.registerProvider 或 skills.register 掛載候選技能
 *
 * @param {any} targetCtx
 * @param {ReturnType<typeof loadHarnessFromDir>} harness
 * @param {{ sectionOrder?: number }} [options]
 * @returns {() => void} dispose 函式
 */
export function applyHarnessToContext(targetCtx, harness, options = {}) {
  const disposers = [];
  const baseOrder = Number.isFinite(options.sectionOrder) ? Number(options.sectionOrder) : 760;
  const { systemPrompt: spService, skills: skillsService } = resolveScopedServices(targetCtx);

  if (spService && typeof spService.section === 'function') {
    for (const item of HARNESS_COMPONENT_FILES) {
      const content = String(harness.components?.[item.key] ?? '').trim();
      if (!content) continue;

      const formattedText = [
        `<!-- ${item.sectionName} (${harness.versionId}) -->`,
        content,
      ].join('\n');

      const disposeSection = spService.section({
        name: item.sectionName,
        order: baseOrder + item.orderOffset,
        text: formattedText,
        interpolate: false,
      });

      if (typeof disposeSection === 'function') {
        disposers.push(disposeSection);
      }
    }
  }

  if (skillsService && Array.isArray(harness.skills) && harness.skills.length > 0) {
    const providerName = 'recursive-harness';
    const skillMap = new Map();
    for (const s of harness.skills) {
      const parsed = parseSkillMarkdown(s.content, s.name);
      const invocation = { modelInvocable: true, userInvocable: true };
      const resourceBase = s.basePath
        ? { kind: 'directory', path: s.basePath }
        : undefined;
      skillMap.set(parsed.name, {
        name: parsed.name,
        description: parsed.description,
        content: parsed.body,
        basePath: s.basePath,
        path: s.basePath,
        source: providerName,
        provider: providerName,
        rank: 50, // 高於專案預設 (100) 與使用者 (400)，確保候選技能優先覆寫
        invocation,
        ...(resourceBase ? { resourceBase } : {}),
        load: async () => parsed.body,
      });
    }

    if (typeof skillsService.registerProvider === 'function') {
      const disposeProvider = skillsService.registerProvider(() => ({
        name: providerName,
        list: async () =>
          Array.from(skillMap.values()).map((entry) => ({
            name: entry.name,
            description: entry.description,
            basePath: entry.basePath,
            path: entry.path,
            source: entry.source,
            provider: entry.provider,
            rank: entry.rank,
            invocation: entry.invocation,
            ...(entry.resourceBase ? { resourceBase: entry.resourceBase } : {}),
          })),
        get: async (candidate) => {
          const key = typeof candidate === 'string' ? candidate : candidate?.name;
          return skillMap.get(key);
        },
        resolve: async (name) => skillMap.get(name),
      }));
      if (typeof disposeProvider === 'function') {
        disposers.push(disposeProvider);
      }
    } else if (typeof skillsService.register === 'function') {
      for (const entry of skillMap.values()) {
        const disposeSkill = skillsService.register(entry);
        if (typeof disposeSkill === 'function') {
          disposers.push(disposeSkill);
        }
      }
    }
  }

  return () => {
    while (disposers.length > 0) {
      const fn = disposers.pop();
      try {
        fn();
      } catch {
        // 忽略清理時之例外
      }
    }
  };
}
