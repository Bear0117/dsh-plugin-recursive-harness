// dsh-plugin-recursive-harness：Cordis 插件入口與 RecursiveHarnessService
// 支援兩種模式：
// 1. apply-only（探針子行程專用）：僅掛載指定候選 Harness 之 systemPrompt.section 與 skills，不註冊任何觸發或控制介面，從結構上杜絕遞迴自觸發。
// 2. full（一般互動與協調模式）：提供 ctx.recursiveHarness 服務、/harness 指令、新 Session 主動套用、Sidecar 軌跡持久化與選配之執行期停滯偵測。

import { randomUUID } from 'node:crypto';
import { defaultPluginBaseDir, normalizeConfig } from './config.js';
import {
  ensureHarnessDir,
  loadHarnessFromDir,
  applyHarnessToContext,
} from './harness-loader.js';
import { HarnessStateStore } from './store.js';
import { ExperienceLibrary, Reflector } from './experience.js';
import { ProbeRunner } from './probe-runner.js';
import { RecursiveHarnessCoordinator } from './ppc.js';
import { RuntimeStagnationDetector } from './stagnation.js';

export const name = 'dsh-plugin-recursive-harness';
// Cordis 4 沒有「選用」注入：列出的服務都必須存在，插件才會啟動（dsh-base 四者皆有）
export const inject = ['systemPrompt', 'skills', 'commands', 'tools'];

/**
 * RecursiveHarness 服務類別（暴露於 ctx.recursiveHarness）
 */
export class RecursiveHarnessService {
  /**
   * @param {{
   *   config: ReturnType<typeof normalizeConfig>,
   *   store: HarnessStateStore,
   *   experienceLibrary: ExperienceLibrary,
   *   probeRunner: ProbeRunner,
   *   coordinator: RecursiveHarnessCoordinator,
   *   onActiveHarnessChanged?: (newHarness: any) => void
   * }} deps
   */
  constructor(deps) {
    this.config = deps.config;
    this.store = deps.store;
    this.experienceLibrary = deps.experienceLibrary;
    this.probeRunner = deps.probeRunner;
    this.coordinator = deps.coordinator;
    this.onActiveHarnessChanged = deps.onActiveHarnessChanged || null;
  }

  /**
   * 檢視目前啟用之 Harness 版本、元件摘要與技能清單
   */
  inspect() {
    ensureHarnessDir(this.config.harnessDir);
    const active = loadHarnessFromDir(this.config.harnessDir, {
      lockedSurfaces: this.config.lockedSurfaces,
    });
    const manifest = this.store.readManifest();
    const experiences = this.experienceLibrary.listEntries({ includeInactive: false });

    return {
      mode: this.config.mode,
      versionId: active.versionId,
      hash: active.hash,
      parentVersionId: active.parentVersionId ?? manifest.previousVersionId,
      harnessDir: active.harnessDir,
      components: Object.fromEntries(
        Object.entries(active.components).map(([k, v]) => [k, v.length]),
      ),
      skills: active.skills.map((s) => ({
        name: s.name,
        description: s.description,
        scriptsCount: Object.keys(s.scripts || {}).length,
      })),
      activeRunId: manifest.activeRunId,
      versionsCount: manifest.versions.length,
      activeExperienceCount: experiences.length,
    };
  }

  /**
   * 啟動單步或多步 PPC 演進
   * @param {any} task
   * @param {Record<string, any>} [options]
   */
  async start(task, options = {}) {
    ensureHarnessDir(this.config.harnessDir);
    const initialHarness = loadHarnessFromDir(this.config.harnessDir, {
      lockedSurfaces: this.config.lockedSurfaces,
    });
    this.store.saveHarnessSnapshot(initialHarness, {
      setActive: true,
      reason: 'baseline-before-start',
    });

    const result = await this.coordinator.runPpcLoop(task, initialHarness, options);
    if (result.adopted && typeof this.onActiveHarnessChanged === 'function') {
      this.onActiveHarnessChanged(result.finalHarness);
    }
    return result;
  }

  /**
   * 查詢目前或指定 runId 之演進狀態
   * @param {string} [runId]
   */
  status(runId) {
    const manifest = this.store.readManifest();
    const targetId = runId || manifest.activeRunId;
    if (targetId) {
      const cp = this.store.getCheckpoint(targetId);
      if (cp) return cp;
    }
    const all = this.store.listCheckpoints();
    return {
      activeVersionId: manifest.activeVersionId,
      previousVersionId: manifest.previousVersionId,
      activeRunId: manifest.activeRunId,
      latestCheckpoint: all[0] || null,
      totalCheckpoints: all.length,
    };
  }

  /**
   * 取消執行中之演進任務
   * @param {string} [runId]
   */
  async cancel(runId) {
    const manifest = this.store.readManifest();
    const targetId = runId || manifest.activeRunId;
    if (!targetId) {
      return { cancelled: false, reason: '目前無執行中之演進任務' };
    }
    await this.coordinator.cancelRun(targetId);
    return { cancelled: true, runId: targetId };
  }

  /**
   * 回退至指定或上一版 Harness
   * @param {string} [targetVersionId]
   */
  rollback(targetVersionId) {
    const restored = this.store.rollback(targetVersionId);
    if (typeof this.onActiveHarnessChanged === 'function') {
      this.onActiveHarnessChanged(restored);
    }
    return restored;
  }

  /**
   * 列出跨任務經驗庫條目
   * @param {{ includeInactive?: boolean }} [options]
   */
  listExperience(options = {}) {
    return this.experienceLibrary.listEntries(options);
  }
}

/**
 * 建立 /harness 斜線指令定義
 * @param {RecursiveHarnessService} service
 */
export function createHarnessCommand(service) {
  return {
    name: 'harness',
    description: '檢視或控制雙層遞迴 Harness（inspect | start | status | cancel | rollback | listExperience）',
    input: {
      hint: 'inspect | status [runId] | cancel [runId] | rollback [versionId] | listExperience',
    },
    handler: async ({ rawInput = '' } = {}) => {
      const tokens = String(rawInput || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const sub = (tokens[0] || 'inspect').toLowerCase();
      const arg = tokens[1];

      try {
        switch (sub) {
          case 'inspect': {
            const info = service.inspect();
            const skillNames = info.skills.map((s) => s.name).join(', ') || '無';
            return {
              kind: 'success',
              text: [
                `### Recursive Harness 狀態檢視`,
                `- **模式**：\`${info.mode}\``,
                `- **目前版本**：\`${info.versionId}\`（父版本：\`${info.parentVersionId || '無'}\`）`,
                `- **掛載技能**：${skillNames}`,
                `- **經驗庫有效條目數**：${info.activeExperienceCount}`,
                `- **歷史快照版本數**：${info.versionsCount}`,
              ].join('\n'),
            };
          }

          case 'status': {
            const st = service.status(arg);
            return {
              kind: 'success',
              text: `\`\`\`json\n${JSON.stringify(st, null, 2)}\n\`\`\``,
            };
          }

          case 'cancel': {
            const res = await service.cancel(arg);
            return {
              kind: res.cancelled ? 'success' : 'error',
              text: res.cancelled
                ? `已取消演進執行：\`${res.runId}\``
                : `取消失敗：${res.reason}`,
            };
          }

          case 'rollback': {
            const restored = service.rollback(arg);
            return {
              kind: 'success',
              text: `已成功回退至 Harness 版本：\`${restored.versionId}\`（將於新建立之 Session 或下一輪生效）`,
            };
          }

          case 'listexperience':
          case 'experience': {
            const entries = service.listExperience({ includeInactive: arg === '--all' });
            if (entries.length === 0) {
              return { kind: 'success', text: '目前經驗庫尚無有效條目。' };
            }
            const lines = entries.map(
              (e) =>
                `- \`${e.entryId}\` [${e.domain}] (${e.status}): ${e.summary}`,
            );
            return {
              kind: 'success',
              text: `### 跨任務經驗庫條目（共 ${entries.length} 筆）\n${lines.join('\n')}`,
            };
          }

          default:
            return {
              kind: 'error',
              text: `未知的子指令：\`${sub}\`。支援子指令：\`inspect | status | cancel | rollback | listExperience\``,
            };
        }
      } catch (err) {
        return {
          kind: 'error',
          text: `執行 /harness ${sub} 失敗：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

/**
 * Cordis 插件主入口
 * @param {any} ctx
 * @param {Record<string, any>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  // 插件模式的預設根目錄是 $DSH_HOME/recursive-harness；CLI 另外傳入 baseDir
  const baseDir =
    typeof rawConfig.baseDir === 'string' && rawConfig.baseDir.trim()
      ? rawConfig.baseDir
      : defaultPluginBaseDir();
  const config = normalizeConfig(rawConfig, baseDir);
  ensureHarnessDir(config.harnessDir);

  // dsh 0.2 的 agent/created 事件帶 { agent, source, signal }；測試替身可能直接傳 agent
  const agentOf = (payload) => (payload && payload.agent && payload.agent.ctx ? payload.agent : payload);
  const sessionIdOf = (agent) =>
    String(agent?.session?.id ?? agent?.sessionId ?? agent?.session?.header?.id ?? 'unknown');

  let activeHarness = loadHarnessFromDir(config.harnessDir, {
    lockedSurfaces: config.lockedSurfaces,
  });

  // 1. 掛載至全域或目前 Context（供單一 Session 之 headless 探針直接生效）
  let disposeGlobalHarness = applyHarnessToContext(ctx, activeHarness, {
    sectionOrder: config.sectionOrder,
  });

  const refreshGlobalHarness = (newHarness) => {
    activeHarness = newHarness;
    if (typeof disposeGlobalHarness === 'function') {
      disposeGlobalHarness();
    }
    disposeGlobalHarness = applyHarnessToContext(ctx, activeHarness, {
      sectionOrder: config.sectionOrder,
    });
  };

  // 2. 當新 Agent (Session) 建立時，自動將最新採用之 Harness 掛載至該 Agent 專屬之 agent.ctx
  // 確保既已在執行中之舊 Session 不被中途覆寫，而新 Session 自動獲得演進後之版本
  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', (payload) => {
      const agent = agentOf(payload);
      if (!agent?.ctx) return;
      const latest = loadHarnessFromDir(config.harnessDir, {
        lockedSurfaces: config.lockedSurfaces,
      });
      applyHarnessToContext(agent.ctx, latest, {
        sectionOrder: config.sectionOrder,
      });
    });
  }

  // 3. 若為 apply-only 模式（探針子行程專用），到此結束！不註冊任何演進觸發或控制介面
  if (config.mode === 'apply-only') {
    return {
      mode: 'apply-only',
      activeHarness,
      dispose: () => {
        if (typeof disposeGlobalHarness === 'function') disposeGlobalHarness();
      },
    };
  }

  // 4. Full 模式：初始化狀態儲存、經驗庫、探針執行器與協調服務
  const store = new HarnessStateStore({
    storageDir: config.storageDir,
    activeHarnessDir: config.harnessDir,
  });
  store.saveHarnessSnapshot(activeHarness, {
    setActive: true,
    reason: 'plugin-init',
  });
  store.recoverInterruptedRuns({ markOrphansCancelled: true });

  const experienceLibrary = new ExperienceLibrary(config.experienceDir);
  const reflector = new Reflector(experienceLibrary);
  const probeRunner = new ProbeRunner({
    maxConcurrency: config.maxConcurrency,
    maxWallTimeMs: config.maxWallTimeMs,
    timeWindowPolicy: config.timeWindowPolicy,
    lockedSurfaces: config.lockedSurfaces,
    protectedPatterns: config.protectedPatterns,
    preApprovedTools: config.preApprovedTools,
    dshCliEntry: config.dshCliEntry,
  });

  const coordinator = new RecursiveHarnessCoordinator({
    probeRunner,
    store,
    experienceLibrary,
    reflector,
    maxTokensPerIteration: config.maxTokensPerIteration,
    maxWallTimeMs: config.maxWallTimeMs,
    lockedSurfaces: config.lockedSurfaces,
    protectedPatterns: config.protectedPatterns,
  });

  const service = new RecursiveHarnessService({
    config,
    store,
    experienceLibrary,
    probeRunner,
    coordinator,
    onActiveHarnessChanged: refreshGlobalHarness,
  });

  // 暴露 ctx.recursiveHarness 服務（相容於真實 Cordis 4 ctx.provide(name, value) 與測試 mock）
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide('recursiveHarness', service);
    } catch {
      try {
        ctx.recursiveHarness = service;
      } catch {
        // ignore
      }
    }
  } else {
    ctx.recursiveHarness = service;
  }

  // 註冊 /harness 指令
  const commandDef = createHarnessCommand(service);
  const commandsSvc =
    typeof ctx.get === 'function' ? ctx.get('commands') ?? ctx.commands : ctx.commands;
  if (commandsSvc && typeof commandsSvc.register === 'function') {
    commandsSvc.register(commandDef);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (scoped) => {
      const scopedCommands =
        typeof scoped.get === 'function' ? scoped.get('commands') : scoped.commands;
      scopedCommands?.register?.(commandDef);
    });
  }

  // 5. 事件收集與 Sidecar 持久化（依 sessionId 關聯）+ 選配之執行期停滯偵測
  const stagnationDetector = config.enableRuntimeStagnation
    ? new RuntimeStagnationDetector({
        threshold: config.stagnationThreshold,
        sectionOrder: config.sectionOrder + 35,
      })
    : null;

  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', (payload) => {
      const agent = agentOf(payload);
      store.saveSessionSidecar(sessionIdOf(agent), {
        harnessVersionId: activeHarness.versionId,
        createdAt: new Date().toISOString(),
      });
    });

    // dsh 0.2 沒有 agent/turn/end 事件；回合結束是 session/event 裡的 turn/end
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return;
      const sessionId = String(session?.id ?? session?.header?.id ?? 'unknown');
      store.saveSessionSidecar(sessionId, {
        harnessVersionId: activeHarness.versionId,
        lastTurnReason: event?.data?.reason?.kind ?? event?.data?.reason ?? 'completed',
        lastTurnAt: new Date().toISOString(),
      });
    });

    // tools/post-execute 是 waterfall：(exec, result, next) => PostToolDecision
    // 停滯偵測只在 enableRuntimeStagnation 時把提醒附在 additionalContexts，永不改寫工具結果
    ctx.on('tools/post-execute', async (exec, result, next) => {
      if (typeof result === 'function' && next === undefined) {
        // 舊式替身：(exec, next)
        next = result;
        result = exec?.result;
      }
      const downstream = typeof next === 'function' ? await next() : { kind: 'accept' };
      if (!stagnationDetector) return downstream;

      const isError = result?.isError === true || Boolean(exec?.error);
      const outputText = Array.isArray(result?.content)
        ? result.content
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('\n')
        : typeof result?.output === 'string'
          ? result.output
          : JSON.stringify(result?.value ?? result ?? '');

      let observation;
      try {
        observation = stagnationDetector.observeToolExecution({
          agent: exec?.agent,
          toolName: exec?.name || 'unknown',
          input: exec?.arguments || {},
          outputText,
          isError,
        });
      } catch {
        return downstream;
      }
      if (!observation?.stagnant || !downstream || typeof downstream !== 'object') return downstream;

      const notice = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: String(observation.additionalContext) }],
        source: {
          kind: 'recursive-harness-stagnation',
          form: 'notice',
          summary: `${exec?.name || 'tool'}: stagnation level ${observation.level ?? '?'}`.slice(0, 120),
        },
      };
      const prev = Array.isArray(downstream.additionalContexts) ? downstream.additionalContexts : [];
      return { ...downstream, additionalContexts: [...prev, notice] };
    });
  }

  return {
    mode: 'full',
    service,
    activeHarness,
    dispose: () => {
      if (typeof disposeGlobalHarness === 'function') disposeGlobalHarness();
    },
  };
}

export default {
  name,
  inject,
  apply,
  RecursiveHarnessService,
};
