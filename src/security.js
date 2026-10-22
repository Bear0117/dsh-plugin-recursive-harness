// 安全驗證器：不可演進表面鎖定、權限提升/危險指令攔截、設定化的受保護樣式、敏感資訊與內網 IP 遮罩
import path from 'node:path';
import { DEFAULT_LOCKED_SURFACES } from './config.js';

/**
 * 危險指令與權限提升特徵（通用規則；專案專屬紅線請用設定 protectedPatterns 加入）
 * 注意：中文分支不能用 \b（CJK 字元不是 \w），所以中英文分開寫。
 */
const FORBIDDEN_CONTENT_PATTERNS = [
  {
    id: 'privilege-escalation-full-access',
    pattern: /grant\s+all\s+permissions|bypass\s*sandbox|disable\s+guard(rails)?|完全權限|關閉護欄|解除所有限制/i,
    reason: '候選內容包含權限提升或解除護欄指令',
  },
  {
    id: 'acl-or-system-permission-change',
    pattern: /\b(icacls|cacls|takeown|chmod\s+777|chown\s+root)\b/i,
    reason: '候選內容嘗試修改作業系統檔案權限（ACL）',
  },
  {
    id: 'prompt-injection-override',
    pattern: /ignore\s+(all\s+)?previous\s+instructions|disregard\s+system\s+guardrails|忽略(先前|以上)所有(指令|規則)|覆寫安全規則/i,
    reason: '候選內容包含疑似 Prompt Injection 覆寫安全規則之語句',
  },
  {
    id: 'locked-surface-tamper',
    pattern: /overwrite\s+AGENTS\.md|(modify|edit|rewrite)\s+AGENTS\.md|修改\s*AGENTS\.md|改寫\s*AGENTS\.md/i,
    reason: '候選內容嘗試竄改鎖定表面（AGENTS.md）',
  },
];

/**
 * 把設定裡的 protectedPatterns（正規表達式來源字串）轉成規則
 * @param {string[]} [sources]
 */
function compileProtectedPatterns(sources = []) {
  const rules = [];
  for (const src of Array.isArray(sources) ? sources : []) {
    try {
      rules.push({
        id: `protected-pattern:${src}`,
        pattern: new RegExp(src, 'i'),
        reason: `候選內容命中受保護樣式：${src}`,
      });
    } catch {
      // 無效樣式已在 normalizeConfig 過濾
    }
  }
  return rules;
}

/**
 * 檢查檔案路徑是否觸碰鎖定表面（Locked Surface）
 * @param {string} targetPath
 * @param {string[]} [lockedSurfaces]
 * @returns {{ ok: boolean, matchedLock?: string, reason?: string }}
 */
export function validatePathAgainstLockedSurfaces(
  targetPath,
  lockedSurfaces = DEFAULT_LOCKED_SURFACES,
) {
  const normalized = String(targetPath || '').replace(/\\/g, '/');
  const baseName = path.posix.basename(normalized);

  for (const lock of lockedSurfaces) {
    const normLock = String(lock).replace(/\\/g, '/');
    if (
      normalized === normLock ||
      baseName === normLock ||
      normalized.endsWith(`/${normLock}`) ||
      normalized.includes(`/${normLock}/`) ||
      normalized.startsWith(`${normLock}/`)
    ) {
      return {
        ok: false,
        matchedLock: lock,
        reason: `禁止修改鎖定表面（Locked Surface）：${lock}（目標路徑：${targetPath}）`,
      };
    }
  }
  return { ok: true };
}

/**
 * 掃描候選 Harness 文字或腳本內容是否違反安全護欄
 * @param {string} content
 * @param {string} [sourceLabel]
 * @param {string[]} [protectedPatterns] 設定裡的額外正規表達式來源字串
 * @returns {{ ok: boolean, violations: Array<{ id: string, reason: string, source: string }> }}
 */
export function validateCandidateContent(content, sourceLabel = 'unknown', protectedPatterns = []) {
  const text = String(content ?? '');
  const violations = [];

  for (const rule of [...FORBIDDEN_CONTENT_PATTERNS, ...compileProtectedPatterns(protectedPatterns)]) {
    if (rule.pattern.test(text)) {
      violations.push({
        id: rule.id,
        reason: rule.reason,
        source: sourceLabel,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

/**
 * 驗證整個候選提案（Proposal / Harness Snapshot）是否合規
 * @param {{
 *   targetPaths?: string[],
 *   components?: Record<string, string>,
 *   skills?: Array<{ name: string, content: string, scripts?: Record<string, string> }>
 * }} candidate
 * @param {string[]} [lockedSurfaces]
 * @param {string[]} [protectedPatterns]
 * @returns {{ ok: boolean, violations: Array<{ id: string, reason: string, source: string }> }}
 */
export function validateCandidateProposal(candidate = {}, lockedSurfaces = DEFAULT_LOCKED_SURFACES, protectedPatterns = []) {
  const violations = [];

  if (Array.isArray(candidate.targetPaths)) {
    for (const p of candidate.targetPaths) {
      const pathCheck = validatePathAgainstLockedSurfaces(p, lockedSurfaces);
      if (!pathCheck.ok) {
        violations.push({
          id: 'locked-surface-path',
          reason: pathCheck.reason,
          source: p,
        });
      }
    }
  }

  if (candidate.components && typeof candidate.components === 'object') {
    for (const [key, text] of Object.entries(candidate.components)) {
      const res = validateCandidateContent(text, `component:${key}`, protectedPatterns);
      violations.push(...res.violations);
    }
  }

  if (Array.isArray(candidate.skills)) {
    for (const skill of candidate.skills) {
      const res = validateCandidateContent(skill.content, `skill:${skill.name}/SKILL.md`, protectedPatterns);
      violations.push(...res.violations);
      if (skill.scripts && typeof skill.scripts === 'object') {
        for (const [scriptName, scriptBody] of Object.entries(skill.scripts)) {
          const scriptPathCheck = validatePathAgainstLockedSurfaces(scriptName, lockedSurfaces);
          if (!scriptPathCheck.ok) {
            violations.push({
              id: 'locked-surface-script',
              reason: scriptPathCheck.reason,
              source: `skill:${skill.name}/${scriptName}`,
            });
          }
          const scriptRes = validateCandidateContent(
            scriptBody,
            `skill:${skill.name}/scripts/${scriptName}`,
            protectedPatterns,
          );
          violations.push(...scriptRes.violations);
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

/**
 * 遮罩敏感資訊（API Key、Bearer Token、內網 IPv4 位址、本機使用者路徑）
 * 確保寫入經驗庫與評測報告時不洩漏機敏資料或內網 IP
 * @param {string} input
 * @returns {string}
 */
export function redactSensitiveText(input) {
  let text = String(input ?? '');

  // 1. 遮罩內網 IPv4 位址 (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
  text = text.replace(
    /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b/g,
    '<REDACTED_LAN_IP>',
  );

  // 2. 遮罩常見 API Key / Bearer Token
  text = text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '<REDACTED_API_KEY>');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}\b/gi, 'Bearer <REDACTED_TOKEN>');
  text = text.replace(
    /("?(?:api[_-]?key|token|secret|password)"?\s*:\s*")([^"]+)(")/gi,
    '$1<REDACTED_SECRET>$3',
  );

  return text;
}
