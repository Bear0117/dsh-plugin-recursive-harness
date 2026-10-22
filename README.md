# dsh-plugin-recursive-harness · Recursive Harness

> **Work in progress. Not released yet.** The npm package and the plugin catalog entry will follow once the evaluation below has been run with a real model. Nothing here is a result yet.

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) that tries out the two-level recursive evolution of Google Research's **Harness²** ([arXiv:2610.14224](https://arxiv.org/abs/2610.14224)) with the model weights frozen: a per-task **Propose → Probe → Compose** loop evolves the agent's system prompt, guardrails, tool guidance, long-term memory and skills, and a cross-task **Reflector → Experience Library** keeps what worked and what failed.

## What is done

- The plugin loads in dsh 0.2.0-rc.2 and mounts a versioned harness (four system prompt sections plus candidate skills) into every new Session. Verified on Windows 11 with a headless run: the sections appear once each in the prompt sent to the model.
- `/harness inspect | status | cancel | rollback | listExperience`, a sidecar state store with checkpoints and snapshots, content-addressed harness versions, and the experience library as plain Markdown files.
- Security checks: locked surfaces (`AGENTS.md`, `.dsh/`, `.git/`, plus your own `lockedSurfaces`), privilege-escalation and prompt-injection patterns, your own `protectedPatterns`, and redaction of keys and private IPs before anything is written to the library.
- Unit tests for all of the above (`npm test`), including a pipeline rehearsal with a mock executor.

## What is not done

- **The probe child process** (an isolated headless dsh run per candidate) is being wired now.
- **The LLM proposer and judge.** The current proposer is a fixed template; it does not call a model.
- **The evaluation.** The G1 gate (same compute budget as best-of-k on a held-out task set) and the G2 gate (experience library, leave-one-out) have only been rehearsed with a mock executor. Those numbers are not reported anywhere on purpose.

## Install (for trying the mounting layer only)

```bash
dsh plugin --profile web add link:/path/to/dsh-plugin-recursive-harness
```

Settings go in your profile's `cordis.patch.yml` under row id `recursive-harness`; see [`cordis.patch.yml`](./cordis.patch.yml) for the defaults. State lives in `$DSH_HOME/recursive-harness/`.

---

## 繁體中文

> **開發中，尚未發布。** 真實模型的評測跑完以後才會發 npm 與上架插件目錄。這裡還沒有任何評測結果。

把 Google Research **Harness²**（arXiv:2610.14224）的雙層遞迴演進帶進 dsh：任務層 **Propose → Probe → Compose** 演進系統提示詞、護欄、工具指引、長期記憶與技能；跨任務層 **Reflector → 經驗庫** 保存成功策略與失敗教訓。模型權重完全不動。

**已完成**：插件可在 dsh 0.2.0-rc.2 載入，把版本化的 harness 掛進每個新 Session（Windows 11 headless 實測，四段各出現一次）；`/harness` 指令、sidecar 狀態與快照回退、純文字經驗庫、安全檢查（鎖定表面、權限提升與 Prompt Injection 樣式、自訂 `protectedPatterns`、寫入前遮罩金鑰與內網 IP）、單元測試。

**未完成**：真實的探針子行程（每個候選跑一次隔離的 headless dsh）正在接；LLM 提案器與裁判（目前是固定模板，不呼叫模型）；G1／G2 閘門的評測只用模擬執行器演練過，數字刻意不列出。
