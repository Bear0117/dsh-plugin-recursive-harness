// 反思器（Reflector）與 Git 友善之跨任務經驗庫（Experience Library）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeHarnessToDir, loadHarnessFromDir } from './harness-loader.js';
import { redactSensitiveText } from './security.js';

/**
 * 格式化單筆經驗之 EXPERIENCE.md
 * @param {Record<string, any>} entry
 * @returns {string}
 */
export function renderExperienceMarkdown(entry) {
  const workedList = Array.isArray(entry.whatWorked) && entry.whatWorked.length > 0
    ? entry.whatWorked.map((x) => `- ${redactSensitiveText(x)}`).join('\n')
    : '- （無採用之正向變更）';

  const failedList = Array.isArray(entry.whatFailed) && entry.whatFailed.length > 0
    ? entry.whatFailed.map((x) => `- ${redactSensitiveText(x)}`).join('\n')
    : '- （無顯著失敗候選紀錄）';

  return [
    `# ${redactSensitiveText(entry.title || entry.entryId)}`,
    '',
    `- **條目編號**：\`${entry.entryId}\``,
    `- **狀態**：\`${entry.status || 'active'}\``,
    `- **領域**：\`${entry.domain || 'general'}\``,
    `- **來源事件**：\`${entry.sourceEventId || 'manual'}\``,
    `- **任務時序索引**：\`${entry.taskSequenceIndex ?? 0}\``,
    `- **建立時間**：\`${entry.createdAt}\``,
    `- **適用任務類型**：${(entry.applicableTaskTypes || []).map((t) => `\`${t}\``).join(', ') || '通用'}`,
    `- **錯誤指紋特徵**：${(entry.failureFingerprints || []).map((f) => `\`${f}\``).join(', ') || '無'}`,
    '',
    '## 經驗摘要',
    redactSensitiveText(entry.summary || ''),
    '',
    '## 有效策略（What Worked）',
    workedList,
    '',
    '## 失敗教訓與反模式（What Failed）',
    failedList,
    '',
  ].join('\n');
}

/**
 * 格式化經驗庫索引 INDEX.md
 * @param {Array<Record<string, any>>} entries
 * @returns {string}
 */
export function renderExperienceIndexMarkdown(entries) {
  const lines = [
    '# Recursive Harness 跨任務經驗庫索引（INDEX.md）',
    '',
    '> 本檔案由 `dsh-plugin-recursive-harness` 自動維護。僅狀態為 `active` 之條目會參與後續任務檢索。',
    '',
    '| 條目編號 | 狀態 | 領域 | 時序 | 適用任務類型 | 摘要 | 路徑 |',
    '| :--- | :--- | :--- | :---: | :--- | :--- | :--- |',
  ];

  for (const e of entries) {
    const types = (e.applicableTaskTypes || []).join(', ') || 'general';
    const summary = redactSensitiveText(String(e.summary || '').replace(/\|/g, '｜').replace(/\r?\n/g, ' '));
    lines.push(
      `| \`${e.entryId}\` | \`${e.status}\` | \`${e.domain || 'general'}\` | ${e.taskSequenceIndex ?? 0} | ${types} | ${summary} | [${e.entryId}/EXPERIENCE.md](./${e.entryId}/EXPERIENCE.md) |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * 跨任務經驗庫管理器
 */
export class ExperienceLibrary {
  /**
   * @param {string} experienceDir
   */
  constructor(experienceDir) {
    this.experienceDir = path.resolve(experienceDir);
    fs.mkdirSync(this.experienceDir, { recursive: true });
    this._ensureIndex();
  }

  _ensureIndex() {
    const indexPath = path.join(this.experienceDir, 'INDEX.md');
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(indexPath, renderExperienceIndexMarkdown([]), 'utf8');
    }
  }

  /**
   * 讀取所有經驗條目中繼資料
   * @param {{ includeInactive?: boolean, maxSequenceIndex?: number }} [options]
   * @returns {Array<Record<string, any>>}
   */
  listEntries(options = {}) {
    if (!fs.existsSync(this.experienceDir)) return [];

    const dirs = fs
      .readdirSync(this.experienceDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    const result = [];
    for (const dirName of dirs) {
      const metaPath = path.join(this.experienceDir, dirName, 'entry.meta.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (!options.includeInactive && meta.status !== 'active') {
          continue;
        }
        if (
          Number.isFinite(options.maxSequenceIndex) &&
          Number(meta.taskSequenceIndex ?? 0) >= Number(options.maxSequenceIndex)
        ) {
          // 嚴格時間序快照：任務 #i 僅能讀取時序索引 < i 之既有經驗
          continue;
        }
        result.push(meta);
      } catch {
        // 略過損毀條目
      }
    }

    return result.sort(
      (a, b) =>
        (a.taskSequenceIndex ?? 0) - (b.taskSequenceIndex ?? 0) ||
        String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')),
    );
  }

  /**
   * 依據任務特徵檢索相關經驗（支援嚴格時間序快照與 leave-one-out 排除）
   * @param {{
   *   domain?: string,
   *   taskType?: string,
   *   keywords?: string[],
   *   errorFingerprints?: string[],
   *   maxSequenceIndex?: number,
   *   excludeTaskIds?: string[],
   *   limit?: number
   * }} query
   */
  queryRelevantExperiences(query = {}) {
    const candidates = this.listEntries({
      includeInactive: false,
      maxSequenceIndex: query.maxSequenceIndex,
    });

    const excludeSet = new Set(query.excludeTaskIds || []);
    const qKeywords = new Set((query.keywords || []).map((k) => String(k).toLowerCase()));
    const qFingerprints = new Set(query.errorFingerprints || []);

    const scored = [];
    for (const entry of candidates) {
      if (entry.sourceTaskId && excludeSet.has(entry.sourceTaskId)) {
        continue;
      }

      let score = 0;
      if (query.domain && entry.domain === query.domain) {
        score += 3;
      }
      if (
        query.taskType &&
        Array.isArray(entry.applicableTaskTypes) &&
        entry.applicableTaskTypes.includes(query.taskType)
      ) {
        score += 3;
      }
      for (const kw of entry.keywords || []) {
        if (qKeywords.has(String(kw).toLowerCase())) {
          score += 1.5;
        }
      }
      for (const fp of entry.failureFingerprints || []) {
        if (qFingerprints.has(fp)) {
          score += 4;
        }
      }

      scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score || (b.entry.taskSequenceIndex ?? 0) - (a.entry.taskSequenceIndex ?? 0));
    const limit = Number.isFinite(query.limit) ? Number(query.limit) : 3;
    return scored.slice(0, limit).map((s) => {
      const entryDir = path.join(this.experienceDir, s.entry.entryId);
      const harnessDir = path.join(entryDir, 'harness');
      let harnessSnapshot = null;
      if (fs.existsSync(harnessDir)) {
        try {
          harnessSnapshot = loadHarnessFromDir(harnessDir, { validateSecurity: false });
        } catch {
          harnessSnapshot = null;
        }
      }
      return {
        ...s.entry,
        relevanceScore: s.score,
        harnessSnapshot,
      };
    });
  }

  /**
   * 寫入或冪等更新經驗條目（同一 sourceEventId 僅產生一筆條目，避免重播重複寫入）
   * @param {Record<string, any>} rawEntry
   * @param {any} [harnessVersion]
   */
  recordExperience(rawEntry, harnessVersion = null) {
    const allEntries = this.listEntries({ includeInactive: true });
    if (rawEntry.sourceEventId) {
      const existing = allEntries.find((e) => e.sourceEventId === rawEntry.sourceEventId);
      if (existing) {
        return existing;
      }
    }

    // 以時間戳 + sourceEventId 雜湊產生條目編號（避免使用者刪除條目後 count+1 撞到既有 ID 而靜默覆蓋）
    const domainSegment = String(rawEntry.domain || 'general').replace(/[^a-z0-9-]/gi, '') || 'general';
    const eventSeed = rawEntry.sourceEventId
      ? String(rawEntry.sourceEventId)
      : crypto.randomBytes(8).toString('hex');
    const eventHash = crypto.createHash('sha1').update(eventSeed, 'utf8').digest('hex').slice(0, 6);
    const baseEntryId =
      rawEntry.entryId ||
      `exp-${Date.now().toString(36)}-${eventHash}-${domainSegment}`;

    // 寫入前確認目錄不存在；若已存在則加序號
    let entryId = baseEntryId;
    for (let seq = 2; fs.existsSync(path.join(this.experienceDir, entryId)); seq += 1) {
      entryId = `${baseEntryId}-${seq}`;
    }

    const entryDir = path.join(this.experienceDir, entryId);
    fs.mkdirSync(entryDir, { recursive: true });

    const normalized = {
      entryId,
      title: redactSensitiveText(rawEntry.title || `經驗條目 ${entryId}`),
      summary: redactSensitiveText(rawEntry.summary || ''),
      domain: rawEntry.domain || 'general',
      sourceTaskId: rawEntry.sourceTaskId || null,
      sourceEventId: rawEntry.sourceEventId || `evt-${entryId}`,
      taskSequenceIndex: Number.isFinite(rawEntry.taskSequenceIndex)
        ? Number(rawEntry.taskSequenceIndex)
        : allEntries.length,
      applicableTaskTypes: Array.isArray(rawEntry.applicableTaskTypes)
        ? rawEntry.applicableTaskTypes
        : [],
      keywords: Array.isArray(rawEntry.keywords) ? rawEntry.keywords : [],
      failureFingerprints: Array.isArray(rawEntry.failureFingerprints)
        ? rawEntry.failureFingerprints
        : [],
      whatWorked: (rawEntry.whatWorked || []).map(redactSensitiveText),
      whatFailed: (rawEntry.whatFailed || []).map(redactSensitiveText),
      status: rawEntry.status || 'active',
      retractedReason: rawEntry.retractedReason || null,
      deprecatedBy: rawEntry.deprecatedBy || null,
      createdAt: rawEntry.createdAt || new Date().toISOString(),
    };

    if (harnessVersion && harnessVersion.components) {
      const sanitizedComponents = {};
      for (const [k, v] of Object.entries(harnessVersion.components)) {
        sanitizedComponents[k] = redactSensitiveText(v);
      }
      const sanitizedSkills = (harnessVersion.skills || []).map((s) => ({
        ...s,
        content: redactSensitiveText(s.content),
      }));
      writeHarnessToDir(
        {
          ...harnessVersion,
          components: sanitizedComponents,
          skills: sanitizedSkills,
        },
        path.join(entryDir, 'harness'),
        { validateSecurity: true },
      );
    }

    fs.writeFileSync(
      path.join(entryDir, 'EXPERIENCE.md'),
      renderExperienceMarkdown(normalized),
      'utf8',
    );
    fs.writeFileSync(
      path.join(entryDir, 'entry.meta.json'),
      JSON.stringify(normalized, null, 2),
      'utf8',
    );

    this.rebuildIndex();
    return normalized;
  }

  /**
   * 撤回（Retract）遭污染或導致退化之經驗條目
   * @param {string} entryId
   * @param {string} reason
   */
  retractEntry(entryId, reason = '驗證發現導致後續任務退化') {
    return this._updateEntryStatus(entryId, {
      status: 'retracted',
      retractedReason: redactSensitiveText(reason),
    });
  }

  /**
   * 淘汰（Deprecate）舊版經驗條目並指向新版條目
   * @param {string} entryId
   * @param {string} replacedByEntryId
   * @param {string} [reason]
   */
  deprecateEntry(entryId, replacedByEntryId, reason = '已被更新之經驗條目取代') {
    return this._updateEntryStatus(entryId, {
      status: 'deprecated',
      deprecatedBy: replacedByEntryId,
      retractedReason: redactSensitiveText(reason),
    });
  }

  _updateEntryStatus(entryId, patch) {
    const entryDir = path.join(this.experienceDir, entryId);
    const metaPath = path.join(entryDir, 'entry.meta.json');
    if (!fs.existsSync(metaPath)) {
      throw new Error(`找不到經驗條目：${entryId}`);
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const updated = {
      ...meta,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2), 'utf8');
    fs.writeFileSync(path.join(entryDir, 'EXPERIENCE.md'), renderExperienceMarkdown(updated), 'utf8');
    this.rebuildIndex();
    return updated;
  }

  /**
   * 重建 INDEX.md
   */
  rebuildIndex() {
    const all = this.listEntries({ includeInactive: true });
    fs.writeFileSync(
      path.join(this.experienceDir, 'INDEX.md'),
      renderExperienceIndexMarkdown(all),
      'utf8',
    );
  }
}

/**
 * 反思器（Reflector）：從 PPC 執行與比較紀錄提煉結構化經驗條目
 */
export class Reflector {
  /**
   * @param {ExperienceLibrary} library
   */
  constructor(library) {
    this.library = library;
  }

  /**
   * @param {{
   *   eventId: string,
   *   task: Record<string, any>,
   *   taskSequenceIndex?: number,
   *   baseHarness: any,
   *   finalHarness: any,
   *   proposals: Array<Record<string, any>>,
   *   probeRecords: Array<Record<string, any>>,
   *   comparisonReport: Record<string, any>,
   *   adopted: boolean
   * }} context
   */
  reflect(context) {
    const {
      eventId,
      task,
      taskSequenceIndex = 0,
      finalHarness,
      proposals = [],
      probeRecords = [],
      comparisonReport = {},
      adopted,
    } = context;

    const whatWorked = [];
    const whatFailed = [];
    const failureFingerprints = new Set();

    for (const pr of probeRecords) {
      for (const fp of pr.executionRecord?.errorFingerprints || []) {
        failureFingerprints.add(fp);
      }
      const proposal = proposals.find((p) => p.proposalId === pr.proposalId);
      const label = proposal ? `[${proposal.axis}] ${proposal.rationale}` : pr.proposalId;
      if (pr.passedObjective && pr.scoreDelta > 0) {
        whatWorked.push(`${label}（客觀檢查通過，分數提升 +${pr.scoreDelta.toFixed(2)}）`);
      } else {
        const failReason = pr.rejectionReason || '未超越基準或客觀檢查未通過';
        whatFailed.push(`${label}：${failReason}`);
      }
    }

    if (adopted && comparisonReport.composedSummary) {
      whatWorked.push(`Compose 合併驗證通過：${comparisonReport.composedSummary}`);
    }

    const summary = adopted
      ? `任務 ${task.taskId}（${task.domain || 'general'}）成功演進並採用新版 Harness（${finalHarness?.versionId}）。`
      : `任務 ${task.taskId}（${task.domain || 'general'}）候選方案未超越基準，保留原版並記錄失敗邊界。`;

    return this.library.recordExperience(
      {
        title: `${task.title || task.taskId} 演進反思`,
        summary,
        domain: task.domain || 'general',
        sourceTaskId: task.taskId,
        sourceEventId: eventId,
        taskSequenceIndex,
        applicableTaskTypes: task.taskTypes || [task.domain || 'general'],
        keywords: task.keywords || [],
        failureFingerprints: Array.from(failureFingerprints),
        whatWorked,
        whatFailed,
        status: 'active',
      },
      adopted ? finalHarness : null,
    );
  }
}
