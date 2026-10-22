# dsh-plugin-recursive-harness · 遞迴 Harness

[English](README.md) · [简体中文](README.zh-CN.md) · 繁體中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件。模型權重完全不動，只演進 agent 的 **harness**，照 Google Research **Harness²**（[arXiv:2610.14224](https://arxiv.org/abs/2610.14224)）的雙層遞迴：

- **任務層：Propose → Probe → Compose。** 模型提出兩個候選 harness（*general* 強化推理與工具紀律；*domain* 加入記憶、護欄與一個技能）。每個候選在隔離的 headless dsh 裡、用任務工作區的複本跑一次。先看客觀檢查，再看行為指標（工具錯誤、步數、token），最後才是選配的模型裁判。互補的勝出者會合併後再驗證一次；合併變差就退回最好的單一候選。
- **跨任務層：Reflector → 經驗庫。** 成功與失敗的教訓寫成純文字 Markdown 條目，之後的提案依嚴格時間序引用。

會被演進的：四段系統提示（`systemprompt`、`guardrails`、`tool_guidance`、`longTermMemory`）與候選技能（`SKILL.md` 加小腳本）。永遠不動的：你的 `AGENTS.md`、`.dsh/`、`.git/`，以及 `lockedSurfaces` 列出的路徑。

**狀態：實驗性。** 在 dsh 0.2.0-rc.2 上整條流程可跑，[`docs/evaluation-report.md`](docs/evaluation-report.md) 的評測是用真實模型在 12 題合成任務上跑出來的。要用在自己的任務前，先讀報告裡的限制。

## 你會看到什麼

1. 裝好插件後，每個新 Session 都帶著目前啟用的 harness 版本（四段各出現一次在系統提示裡；`/harness inspect` 顯示版本與掛載的技能）。
2. `/harness start gen-dev-01`（內建任務）或 `/harness start ./my-task.mjs` 在背景啟動一輪演進：參考執行、提案、探針、比較、合併。`/harness status <runId>` 看進度，`/harness cancel <runId>` 停止並砍掉子行程。
3. 候選在客觀檢查上贏過基準、而且贏的幅度大於基準自己的變異時，才會成為啟用版本。**新 Session** 會拿到它；執行中的 Session 不會被中途改掉。`/harness rollback [versionId]` 回退。
4. `/harness listExperience` 列出 reflector 留下的經驗。

命令列有同一組指令：`npx dsh-recursive-harness inspect | start | status | cancel | rollback | listExperience`（狀態預設在 `./.dsh-harness`；`--config` 吃一個 JSON，欄位和插件設定一樣）。

## 需求

- dsh 0.2.x。在 dsh 0.2.0-rc.2（Windows 11、Node.js 24.21）的 web profile 上測過；探針用 dsh 內建的 headless profile。
- Node.js 22.19 以上的 22 系列，或 24 以上（和 dsh 相同）。
- 一個**提案器端點**：任何 OpenAI 相容的 chat completions 伺服器（vLLM、SGLang、llama.cpp、Ollama 或雲端 API）。沒設定之前，提案器是固定模板，不會有任何文字離開你的電腦。
- 探針用 `probe.templateProfile`（預設 `web`）那個 profile 的模型，或你在 `probe.provider`／`probe.model` 指定的模型。每次探針都是一次完整的 agent 執行，請估好預算。

## 安裝

```bash
dsh plugin --profile web add dsh-plugin-recursive-harness
```

用 npx 的話：`npx @deepseek-ai/dsh plugin --profile web add dsh-plugin-recursive-harness`。之後重開 `dsh web`。啟動時插件會印 `[recursive-harness] ready: …`。

**更新：** `dsh plugin --profile web update dsh-plugin-recursive-harness` 後重開。dsh 用 pnpm 裝插件，剛發布的版本要滿一天才會被選到；想馬上更新就寫明版本（`add dsh-plugin-recursive-harness@0.1.0`）。

**移除：** `dsh plugin --profile web remove dsh-plugin-recursive-harness`，刪掉 profile `cordis.patch.yml` 裡的 `recursive-harness` 段落（如果有加），不想保留 harness 版本與經驗庫的話再刪 `~/.dsh/recursive-harness/`。

## 設定

設定放在 profile 的 `cordis.patch.yml`（web profile：`~/.dsh/profiles/web/cordis.patch.yml`）。`id: recursive-harness` 的段落會取代插件的整份 `config`；沒寫到的鍵用 [`cordis.patch.yml`](cordis.patch.yml) 裡的預設值。

```yaml
- id: recursive-harness
  config:
    proposer:
      engine: llm
      endpoint: http://127.0.0.1:8000/v1/chat/completions
      model: my-model
      apiKeyEnv: ""            # 放金鑰的環境變數，端點需要時才填
      allowEgress: false       # 要送到非本機端點前必須改成 true
      allowHttpHosts: []       # 允許用明文 http 連的非本機主機
      judge: true              # 第三層模型裁判；永遠不推翻客觀檢查
      jsonMode: false          # 送 response_format json_object（vLLM、OpenAI）
      extraBody: {}            # 例如 { chat_template_kwargs: { enable_thinking: false } }
    probe:
      templateProfile: web     # 探針繼承這個 profile 的模型清單與憑證
      provider: ""             # 覆蓋探針模型（llm-pi-ai 裡的 provider id）
      model: ""
      blockedTools: []         # 需要這些工具的任務不自動探針
    lockedSurfaces: []         # 候選永遠不能碰的額外路徑
    protectedPatterns: []      # 命中就拒絕候選的正規表達式（例如 "\\bPROD-DB\\b"）
    maxConcurrency: 2          # 同時跑的探針子行程數
    maxTokensPerIteration: 120000
    probeTimeoutMs: 600000
```

### 自己的任務

任務檔是一個 ES module，export 一個任務（或 `tasks` 陣列）。插件把 `workspaceFiles` 寫進空工作區，用 `prompt` 跑 agent，再把最後輸出交給 `objectiveCheck`：

```js
// my-task.mjs
export default {
  taskId: 'orders-report',
  split: 'dev',
  domain: 'general',
  prompt: '讀取 orders.csv，輸出 { total, byRegion } 的 JSON，byRegion 依名稱排序。',
  workspaceFiles: { 'orders.csv': 'region,amount\nEast,10\nWest,5\nEast,2\n' },
  expected: { total: 17, byRegion: { East: 12, West: 5 } },
  objectiveCheck(record, task) {
    const data = JSON.parse(record.finalOutput.match(/\{[\s\S]*\}/)[0]);
    const ok = data.total === task.expected.total;
    return { passed: ok, score: ok ? 1 : 0, details: ok ? [] : [`total 應為 ${task.expected.total}，實得 ${data.total}`] };
  },
};
```

提案器看不到 `expected`；`details` 裡的數字送到提案器前會先遮掉。請留一組提案器沒看過的保留任務，才能分辨真的進步和過擬合。

## 東西放在哪

`$DSH_HOME/recursive-harness/`（預設 `~/.dsh/recursive-harness/`）：

- `active/` 掛載中的 harness：`systemprompt.md`、`guardrails.md`、`tool_guidance.md`、`LongTermMEMORY.md`、`skills/<name>/SKILL.md`（加 `scripts/`）。可以手動改，下一個 Session 就掛改過的版本。
- `state/` `manifest.json`、`checkpoints/<runId>.json`、`harnesses/<versionId>/` 快照、`sessions/` sidecar、`events.jsonl`。
- `experience/` `INDEX.md` 與每筆一個資料夾（`EXPERIENCE.md`、來源的 harness 快照）。

每次探針在 `<tmp>/dshp-*/` 裡跑，有自己的 `DSH_HOME`（profile、從範本 profile 複製的憑證、候選 harness）和工作區，跑完即刪。行程被強殺留下的目錄會在下次啟動時清掉。

## 什麼會離開你的電腦

- 送到提案器端點：任務 prompt、目前的 harness 文字、參考執行的摘要（工具名、參數節錄、錯誤訊息、遮掉金鑰與內網 IP 的最後輸出節錄）、相關經驗條目。只在 `proposer.engine` 是 `llm` 時。
- 探針：和一般 dsh Session 一樣，agent 的模型會收到什麼就是什麼，走範本 profile 的模型設定。
- 其他沒有。沒有遙測；插件不會連 GitHub 或 npm。

## 評測

真實模型的評測（設定、逐題數字、限制）在 [`docs/evaluation-report.md`](docs/evaluation-report.md)。報告裡的兩個閘門：

- **G1**：同樣的探針預算下，單步 Propose → Probe → Compose 在保留任務集上是否贏過 best-of-k，而且贏的幅度大於基準自己的變異？
- **G2**：跨任務經驗庫對保留任務有沒有幫助（leave-one-out）？

單元測試（`npm test`）裡有一個用模擬執行器的管線演練；那些數字不是結果，也不會寫進報告。

## 已知限制

- 一輪演進要花 5 到 6 次完整的 agent 執行，加上一到兩次提案器呼叫。預算（`maxTokensPerIteration`、`maxWallTimeMs`、`probeTimeoutMs`）只會把它停下來，不會讓它變便宜。
- 探針只繼承範本 profile 的 `cordis.patch.yml`；啟動 dsh 時用 `--patch` 加的模型設定，子行程看不到。
- Windows：子行程用 `taskkill /T` 砍；在慢的模型呼叫中途取消，可能要幾秒才會消失。
- 執行期停滯偵測（`enableRuntimeStagnation`）是選配，預設關。

## 開發

```bash
npm test                    # 單元測試，含用假 dsh 可執行檔的探針子行程測試
npm run eval                # 模擬執行器的管線演練（不是結果）
node eval/run-real-eval.mjs --config my-config.json   # 真實模型評測，可續跑
```

意見與問題回報：[GitHub issues](https://github.com/Bear0117/dsh-plugin-recursive-harness/issues)。MIT 授權。
