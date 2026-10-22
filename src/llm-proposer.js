// LLM 提案器（LlmProposer）與模型裁判（judge）：透過 OpenAI 相容端點，依參考軌跡與經驗庫提出 General / Domain 兩軸候選。
// 提案器看不到任務的標準答案（task.expected），客觀檢查的細節也會先把數字遮掉，避免把答案寫進 harness。
import { HARNESS_COMPONENT_FILES } from './types.js';
import { computeHarnessHash } from './harness-loader.js';
import { chatCompletion, extractJsonObject } from './endpoint.js';
import { redactSensitiveText } from './security.js';

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCRIPT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const PROPOSER_SYSTEM_PROMPT = `You improve the "harness" of a coding agent whose model weights are frozen (Harness², arXiv:2610.14224).
The harness has four text components that are injected into the agent's system prompt, plus optional skills:
- systemprompt: general working instructions
- guardrails: things the agent must never do
- tool_guidance: how to use tools efficiently
- longTermMemory: durable domain knowledge and lessons
- skills: each has a kebab-case name, a one-line description, a Markdown body with step-by-step instructions, and optional small helper scripts.

You will see the task, the current harness, what happened when the agent ran the task with the current harness (reference runs), and relevant past experience.
Propose two candidate harnesses:
1. "general": improves systemprompt and/or tool_guidance with reasoning discipline, self-checks before answering, and tool efficiency. Must stay useful for OTHER tasks of the same kind.
2. "domain": improves longTermMemory and/or guardrails and adds or revises at most one skill that captures a reusable procedure for this task family.

Rules:
- Never hard-code the answer to this specific task (no specific numbers, names or values from the inputs). Write procedures and checks that generalize.
- Keep every component under 4000 characters. Keep the existing text that is still good; edit, do not restart from scratch unless it is clearly wrong.
- Write the harness text in the same language as the task prompt and the current harness.
- Never write instructions that bypass sandboxes, grant permissions, modify AGENTS.md, or disable guardrails.
- Return ONLY one JSON object, no prose, in this exact shape:
{"general":{"rationale":"...","components":{"systemprompt":"...","tool_guidance":"..."}},
 "domain":{"rationale":"...","components":{"longTermMemory":"...","guardrails":"..."},
           "skills":[{"name":"kebab-case","description":"one line","body":"markdown","scripts":{"check.js":"..."}}]}}
Omit any component you do not change. "skills" may be an empty list.`;

const JUDGE_SYSTEM_PROMPT = `You compare two runs of the same task by a coding agent. Both runs passed the objective checks, so judge only the quality of the process and the final answer: fewer wasted tool calls, no repeated errors, clear and complete final output, no unsafe actions.
Return ONLY a JSON object: {"winner":"a"|"b"|"tie","reason":"one sentence"}.`;

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

/** 把客觀檢查細節裡的數字遮掉，避免標準答案流進提案器 */
export function maskNumbers(text) {
  return String(text ?? '').replace(/-?\d+(?:[.,]\d+)*/g, '#');
}

/**
 * 把一筆參考執行紀錄整理成提案器看得懂的摘要（不含標準答案）
 * @param {any} record
 * @param {any} evaluation
 * @param {number} index
 */
export function summarizeReferenceRun(record, evaluation, index) {
  const lines = [
    `### Reference run ${index + 1}`,
    `- passed objective checks: ${evaluation?.passedObjective ? 'yes' : 'no'}`,
    `- steps: ${record?.stepCount ?? '?'}, tool calls: ${record?.toolCallCount ?? '?'}, tool errors: ${record?.toolErrorCount ?? 0}, ask-denied: ${record?.askDeniedCount ?? 0}, tokens: ${record?.usage?.totalTokens ?? '?'}`,
    `- termination: ${record?.terminationReason ?? '?'}`,
  ];
  const details = Array.isArray(evaluation?.details) ? evaluation.details : [];
  if (details.length > 0) {
    lines.push(`- objective check feedback (numbers masked): ${details.slice(0, 6).map(maskNumbers).join('; ')}`);
  }
  const calls = Array.isArray(record?.toolCalls) ? record.toolCalls.slice(0, 15) : [];
  if (calls.length > 0) {
    lines.push('- tool calls:');
    for (const c of calls) {
      const input = clip(JSON.stringify(c.input ?? {}), 160);
      const err = c.status === 'error' ? ` -> ERROR: ${clip(c.result, 160)}` : '';
      lines.push(`  - ${c.tool} ${input}${err}`);
    }
  }
  if (record?.finalOutput) {
    lines.push('- final output (excerpt):', '```', clip(redactSensitiveText(record.finalOutput), 800), '```');
  }
  return lines.join('\n');
}

/**
 * 把目前 harness 轉成提示文字
 * @param {any} harness
 */
export function renderHarnessForPrompt(harness, maxChars = 4000) {
  const lines = ['## Current harness'];
  for (const item of HARNESS_COMPONENT_FILES) {
    lines.push(`### ${item.key}`, '```', clip(harness?.components?.[item.key] ?? '', maxChars), '```');
  }
  const skills = Array.isArray(harness?.skills) ? harness.skills : [];
  lines.push(`### skills (${skills.length})`);
  for (const s of skills) {
    lines.push(`- ${s.name}: ${s.description || ''}`, '```', clip(s.content ?? s.body ?? '', 1500), '```');
    for (const [k, v] of Object.entries(s.scripts || {})) {
      lines.push(`  script ${k}:`, '```', clip(v, 800), '```');
    }
  }
  return lines.join('\n');
}

/**
 * 把模型回傳的候選正規化成 HarnessVersion；不合法的部分丟掉，整個提案無效時回傳 null
 * @param {any} raw
 * @param {any} baseHarness
 * @param {'general'|'domain'} axis
 * @param {{ maxCandidateChars: number }} limits
 */
export function materializeProposal(raw, baseHarness, axis, limits) {
  if (!raw || typeof raw !== 'object') return null;
  const components = { ...baseHarness.components };
  let changed = false;
  const allowedKeys = new Set(HARNESS_COMPONENT_FILES.map((i) => i.key));
  for (const [key, value] of Object.entries(raw.components || {})) {
    if (!allowedKeys.has(key) || typeof value !== 'string') continue;
    const text = value.trim().slice(0, limits.maxCandidateChars);
    if (text && text !== String(components[key] ?? '').trim()) {
      components[key] = text;
      changed = true;
    }
  }

  const skills = [...(baseHarness.skills || [])].map((s) => ({ ...s }));
  for (const sk of Array.isArray(raw.skills) ? raw.skills : []) {
    if (!sk || typeof sk !== 'object') continue;
    const name = String(sk.name ?? '').trim().toLowerCase();
    if (!SKILL_NAME_RE.test(name)) continue;
    const description = String(sk.description ?? '').trim().replace(/\s+/g, ' ').slice(0, 200) || `Skill ${name}`;
    const body = String(sk.body ?? sk.content ?? '').trim().slice(0, limits.maxCandidateChars);
    if (!body) continue;
    const scripts = {};
    for (const [scriptName, scriptBody] of Object.entries(sk.scripts || {})) {
      if (!SCRIPT_NAME_RE.test(scriptName) || typeof scriptBody !== 'string') continue;
      if (Object.keys(scripts).length >= 4) break;
      scripts[scriptName] = scriptBody.slice(0, limits.maxCandidateChars);
    }
    const content = body.startsWith('---')
      ? body
      : ['---', `name: ${name}`, `description: ${description}`, '---', body].join('\n');
    const skillObj = { name, folderName: name, description, content, body, scripts };
    const idx = skills.findIndex((s) => s.name === name);
    if (idx >= 0) skills[idx] = skillObj;
    else skills.push(skillObj);
    changed = true;
  }

  if (!changed) return null;
  const { hash, versionId } = computeHarnessHash({ components, skills });
  if (hash === baseHarness.hash) return null;
  return {
    proposalId: `prop-${axis}-${versionId}`,
    axis,
    rationale: String(raw.rationale ?? '').trim().slice(0, 500) || `${axis} proposal from the model`,
    harnessVersion: {
      versionId,
      hash,
      parentVersionId: baseHarness.versionId,
      createdAt: new Date().toISOString(),
      components,
      skills,
    },
  };
}

/**
 * LLM 提案器：介面與模板 Proposer 相同（propose(context) → proposals[]），可直接當 customProposeFn
 */
export class LlmProposer {
  /**
   * @param {{
   *   settings: import('./endpoint.js').chatCompletion extends (s: infer S, ...a: any[]) => any ? S : any,
   *   experienceLibrary?: import('./experience.js').ExperienceLibrary,
   *   maxCandidateChars?: number,
   *   fetchImpl?: typeof fetch,
   *   env?: Record<string, string|undefined>,
   *   logger?: (line: string) => void
   * }} options
   */
  constructor(options) {
    this.settings = options.settings;
    this.experienceLibrary = options.experienceLibrary || null;
    this.maxCandidateChars = options.maxCandidateChars ?? 6000;
    this.fetchImpl = options.fetchImpl;
    this.env = options.env;
    this.log = options.logger || (() => {});
    this.totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
  }

  _account(usage) {
    this.totalUsage.inputTokens += usage?.inputTokens || 0;
    this.totalUsage.outputTokens += usage?.outputTokens || 0;
    this.totalUsage.totalTokens += usage?.totalTokens || 0;
    this.totalUsage.calls += 1;
  }

  /**
   * 組合提案提示（可單獨測試）
   */
  buildPrompt(context) {
    const { task, baseHarness, referenceRecords = [], referenceEvaluations = [], experiences = [] } = context;
    const parts = [
      '## Task',
      `- id: ${task.taskId}`,
      `- title: ${task.title || ''}`,
      `- types: ${(task.taskTypes || []).join(', ')}`,
      `- input files: ${Object.keys(task.workspaceFiles || {}).join(', ') || '(none)'}`,
      '- prompt:',
      '```',
      clip(task.prompt || '', 3000),
      '```',
      '',
      renderHarnessForPrompt(baseHarness),
      '',
      '## Reference runs with the current harness',
      ...referenceRecords.map((r, i) => summarizeReferenceRun(r, referenceEvaluations[i], i)),
    ];
    if (experiences.length > 0) {
      parts.push('', '## Relevant past experience');
      for (const e of experiences.slice(0, 3)) {
        parts.push(
          `### ${e.entryId}: ${e.title || ''}`,
          clip(e.summary || '', 600),
          ...(Array.isArray(e.whatWorked) && e.whatWorked.length ? ['- worked: ' + e.whatWorked.slice(0, 3).map((w) => clip(w, 200)).join(' | ')] : []),
          ...(Array.isArray(e.whatFailed) && e.whatFailed.length ? ['- failed: ' + e.whatFailed.slice(0, 3).map((w) => clip(w, 200)).join(' | ')] : []),
        );
      }
    }
    parts.push('', 'Now return the JSON object with "general" and "domain".');
    return parts.join('\n');
  }

  /**
   * @param {{ task: any, baseHarness: any, referenceRecords?: any[], referenceEvaluations?: any[], kPerAxis?: number, maxSequenceIndex?: number, excludeExperienceTaskIds?: string[], disableExperience?: boolean, signal?: AbortSignal }} context
   */
  async propose(context) {
    const { task, baseHarness, kPerAxis = 1, disableExperience = false } = context;
    const experiences =
      !disableExperience && this.experienceLibrary
        ? this.experienceLibrary.queryRelevantExperiences({
            domain: task.domain,
            taskType: task.taskTypes?.[0],
            keywords: task.keywords,
            errorFingerprints: (context.referenceRecords || []).flatMap((r) => r.errorFingerprints || []),
            maxSequenceIndex: context.maxSequenceIndex,
            excludeTaskIds: [task.taskId, ...(context.excludeExperienceTaskIds || [])],
            limit: 3,
          })
        : [];
    const userPrompt = this.buildPrompt({ ...context, experiences });
    const proposals = [];
    for (let k = 0; k < kPerAxis; k++) {
      const res = await chatCompletion(
        { ...this.settings, temperature: k === 0 ? this.settings.temperature : Math.min(1, (this.settings.temperature ?? 0.7) + 0.2 * k) },
        [
          { role: 'system', content: PROPOSER_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        { signal: context.signal, fetchImpl: this.fetchImpl, env: this.env, responseFormatJson: Boolean(this.settings.jsonMode) },
      );
      this._account(res.usage);
      this.lastRawReply = res.text;
      const parsed = extractJsonObject(res.text);
      if (!parsed) {
        const excerpt = res.text.replace(/\s+/g, ' ').slice(0, 160);
        this.log(
          `proposer: response ${k + 1} is not JSON (finish=${res.finishReason ?? '?'}, ${res.usage.outputTokens} output tokens${res.finishReason === 'length' ? ', truncated: raise proposer.maxTokens' : ''}): ${excerpt}`,
        );
        continue;
      }
      const limits = { maxCandidateChars: this.maxCandidateChars };
      for (const axis of ['general', 'domain']) {
        const prop = materializeProposal(parsed[axis], baseHarness, axis, limits);
        if (!prop) continue;
        prop.proposalId = `${prop.proposalId}-${k + 1}`;
        prop.usedExperienceIds = experiences.map((e) => e.entryId);
        prop.proposerUsage = res.usage;
        proposals.push(prop);
      }
    }
    return proposals;
  }

  /**
   * 模型裁判（Comparator 第三層）：兩個都通過客觀檢查時才呼叫
   * @param {any} a 執行紀錄 A
   * @param {any} b 執行紀錄 B
   * @param {any} task
   * @returns {Promise<{ winner: 'a'|'b'|'tie', reason: string }>}
   */
  async judge(a, b, task) {
    const render = (label, r) =>
      [
        `## Run ${label}`,
        `- steps: ${r.stepCount}, tool calls: ${r.toolCallCount}, tool errors: ${r.toolErrorCount}, tokens: ${r.usage?.totalTokens ?? '?'}`,
        ...(Array.isArray(r.toolCalls) ? r.toolCalls.slice(0, 15).map((c) => `  - ${c.tool} ${c.status}`) : []),
        '- final output:',
        '```',
        clip(redactSensitiveText(r.finalOutput || ''), 1500),
        '```',
      ].join('\n');
    const res = await chatCompletion(
      { ...this.settings, temperature: 0, maxTokens: 400 },
      [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: ['## Task', clip(task.prompt || '', 2000), '', render('a', a), '', render('b', b), '', 'Return the JSON object.'].join('\n') },
      ],
      { fetchImpl: this.fetchImpl, env: this.env },
    );
    this._account(res.usage);
    const parsed = extractJsonObject(res.text);
    const winner = parsed?.winner === 'a' || parsed?.winner === 'b' ? parsed.winner : 'tie';
    return { winner, reason: String(parsed?.reason ?? '').slice(0, 300) };
  }
}
