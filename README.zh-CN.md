# dsh-plugin-recursive-harness · 递归 Harness

[English](README.md) · 简体中文 · [繁體中文](README.zh-TW.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件。模型权重完全不动，只演进 agent 的 **harness**，按 Google Research **Harness²**（[arXiv:2610.14224](https://arxiv.org/abs/2610.14224)）的双层递归：

- **任务层：Propose → Probe → Compose。** 模型提出两个候选 harness（*general* 强化推理与工具纪律；*domain* 加入记忆、护栏与一个技能）。每个候选在隔离的 headless dsh 里、用任务工作区的副本跑一次。先看客观检查，再看行为指标（工具错误、步数、token），最后才是可选的模型裁判。互补的胜出者会合并后再验证一次；合并变差就退回最好的单一候选。
- **跨任务层：Reflector → 经验库。** 成功与失败的教训写成纯文本 Markdown 条目，之后的提案按严格时间序引用。

会被演进的：四段系统提示（`systemprompt`、`guardrails`、`tool_guidance`、`longTermMemory`）与候选技能（`SKILL.md` 加小脚本）。永远不动的：你的 `AGENTS.md`、`.dsh/`、`.git/`，以及 `lockedSurfaces` 列出的路径。

**状态：实验性。** 在 dsh 0.2.0-rc.2 上整条流程可跑，[`docs/evaluation-report.md`](docs/evaluation-report.md) 的评测是用真实模型在 12 题合成任务上跑出来的。用在自己的任务前，先读报告里的限制。

## 你会看到什么

1. 装好插件后，每个新 Session 都带着当前启用的 harness 版本（四段各出现一次在系统提示里；`/harness inspect` 显示版本与挂载的技能）。
2. `/harness start gen-dev-01`（内置任务）或 `/harness start ./my-task.mjs` 在后台启动一轮演进：参考执行、提案、探针、比较、合并。`/harness status <runId>` 看进度，`/harness cancel <runId>` 停止并杀掉子进程。
3. 候选在客观检查上赢过基准、而且赢的幅度大于基准自己的方差时，才会成为启用版本。**新 Session** 会拿到它；运行中的 Session 不会被中途改掉。`/harness rollback [versionId]` 回退。
4. `/harness listExperience` 列出 reflector 留下的经验。

命令行有同一组命令：`npx dsh-recursive-harness inspect | start | status | cancel | rollback | listExperience`（状态默认在 `./.dsh-harness`；`--config` 接一个 JSON，字段和插件设置一样）。

## 需求

- dsh 0.2.x。在 dsh 0.2.0-rc.2（Windows 11、Node.js 24.21）的 web profile 上测过；探针用 dsh 内置的 headless profile。
- Node.js 22.19 以上的 22 系列，或 24 以上（和 dsh 相同）。
- 一个**提案器端点**：任何 OpenAI 兼容的 chat completions 服务器（vLLM、SGLang、llama.cpp、Ollama 或云端 API）。没设置之前，提案器是固定模板，不会有任何文字离开你的电脑。
- 探针用 `probe.templateProfile`（默认 `web`）那个 profile 的模型，或你在 `probe.provider`／`probe.model` 指定的模型。每次探针都是一次完整的 agent 运行，请估好预算。

## 安装

```bash
dsh plugin --profile web add dsh-plugin-recursive-harness
```

用 npx 的话：`npx @deepseek-ai/dsh plugin --profile web add dsh-plugin-recursive-harness`。之后重启 `dsh web`。启动时插件会打印 `[recursive-harness] ready: …`。

**更新：** `dsh plugin --profile web update dsh-plugin-recursive-harness` 后重启。dsh 用 pnpm 装插件，刚发布的版本要满一天才会被选到；想马上更新就写明版本（`add dsh-plugin-recursive-harness@0.1.0`）。

**移除：** `dsh plugin --profile web remove dsh-plugin-recursive-harness`，删掉 profile `cordis.patch.yml` 里的 `recursive-harness` 段落（如果有加），不想保留 harness 版本与经验库的话再删 `~/.dsh/recursive-harness/`。

## 设置

设置放在 profile 的 `cordis.patch.yml`（web profile：`~/.dsh/profiles/web/cordis.patch.yml`）。`id: recursive-harness` 的段落会替换插件的整份 `config`；没写到的键用 [`cordis.patch.yml`](cordis.patch.yml) 里的默认值。

```yaml
- id: recursive-harness
  config:
    proposer:
      engine: llm
      endpoint: http://127.0.0.1:8000/v1/chat/completions
      model: my-model
      apiKeyEnv: ""            # 放密钥的环境变量，端点需要时才填
      allowEgress: false       # 要送到非本机端点前必须改成 true
      allowHttpHosts: []       # 允许用明文 http 连的非本机主机
      judge: true              # 第三层模型裁判；永远不推翻客观检查
      jsonMode: false          # 发送 response_format json_object（vLLM、OpenAI）
      extraBody: {}            # 例如 { chat_template_kwargs: { enable_thinking: false } }
    probe:
      templateProfile: web     # 探针继承这个 profile 的模型列表与凭证
      provider: ""             # 覆盖探针模型（llm-pi-ai 里的 provider id）
      model: ""
      blockedTools: []         # 需要这些工具的任务不自动探针
    lockedSurfaces: []         # 候选永远不能碰的额外路径
    protectedPatterns: []      # 命中就拒绝候选的正则表达式（例如 "\\bPROD-DB\\b"）
    maxConcurrency: 2          # 同时跑的探针子进程数
    maxTokensPerIteration: 120000
    probeTimeoutMs: 600000
```

### 自己的任务

任务文件是一个 ES module，export 一个任务（或 `tasks` 数组）。插件把 `workspaceFiles` 写进空工作区，用 `prompt` 跑 agent，再把最后输出交给 `objectiveCheck`：

```js
// my-task.mjs
export default {
  taskId: 'orders-report',
  split: 'dev',
  domain: 'general',
  prompt: '读取 orders.csv，输出 { total, byRegion } 的 JSON，byRegion 按名称排序。',
  workspaceFiles: { 'orders.csv': 'region,amount\nEast,10\nWest,5\nEast,2\n' },
  expected: { total: 17, byRegion: { East: 12, West: 5 } },
  objectiveCheck(record, task) {
    const data = JSON.parse(record.finalOutput.match(/\{[\s\S]*\}/)[0]);
    const ok = data.total === task.expected.total;
    return { passed: ok, score: ok ? 1 : 0, details: ok ? [] : [`total 应为 ${task.expected.total}，实得 ${data.total}`] };
  },
};
```

提案器看不到 `expected`；`details` 里的数字送到提案器前会先遮掉。请留一组提案器没见过的保留任务，才能分辨真的进步和过拟合。

## 东西放在哪

`$DSH_HOME/recursive-harness/`（默认 `~/.dsh/recursive-harness/`）：

- `active/` 挂载中的 harness：`systemprompt.md`、`guardrails.md`、`tool_guidance.md`、`LongTermMEMORY.md`、`skills/<name>/SKILL.md`（加 `scripts/`）。可以手动改，下一个 Session 就挂改过的版本。
- `state/` `manifest.json`、`checkpoints/<runId>.json`、`harnesses/<versionId>/` 快照、`sessions/` sidecar、`events.jsonl`。
- `experience/` `INDEX.md` 与每条一个文件夹（`EXPERIENCE.md`、来源的 harness 快照）。

每次探针在 `<tmp>/dshp-*/` 里跑，有自己的 `DSH_HOME`（profile、从模板 profile 复制的凭证、候选 harness）和工作区，跑完即删。进程被强杀留下的目录会在下次启动时清掉。

## 什么会离开你的电脑

- 发到提案器端点：任务 prompt、当前的 harness 文字、参考执行的摘要（工具名、参数节选、错误信息、遮掉密钥与内网 IP 的最终输出节选）、相关经验条目。只在 `proposer.engine` 是 `llm` 时。
- 探针：和一般 dsh Session 一样，agent 的模型会收到什么就是什么，走模板 profile 的模型设置。
- 其他没有。没有遥测；插件不会连 GitHub 或 npm。

## 评测

真实模型的评测（设置、逐题数字、限制）在 [`docs/evaluation-report.md`](docs/evaluation-report.md)。报告里的两个门槛：

- **G1**：同样的探针预算下，单步 Propose → Probe → Compose 在保留任务集上是否赢过 best-of-k，而且赢的幅度大于基准自己的方差？
- **G2**：跨任务经验库对保留任务有没有帮助（leave-one-out）？

单元测试（`npm test`）里有一个用模拟执行器的管线演练；那些数字不是结果，也不会写进报告。

## 已知限制

- 一轮演进要花 5 到 6 次完整的 agent 运行，加上一到两次提案器调用。预算（`maxTokensPerIteration`、`maxWallTimeMs`、`probeTimeoutMs`）只会把它停下来，不会让它变便宜。
- 探针只继承模板 profile 的 `cordis.patch.yml`；启动 dsh 时用 `--patch` 加的模型设置，子进程看不到。
- Windows：子进程用 `taskkill /T` 杀；在慢的模型调用中途取消，可能要几秒才会消失。
- 运行期停滞检测（`enableRuntimeStagnation`）是可选项，默认关。

## 开发

```bash
npm test                    # 单元测试，含用假 dsh 可执行文件的探针子进程测试
npm run eval                # 模拟执行器的管线演练（不是结果）
node eval/run-real-eval.mjs --config my-config.json   # 真实模型评测，可续跑
```

意见与问题反馈：[GitHub issues](https://github.com/Bear0117/dsh-plugin-recursive-harness/issues)。MIT 许可。
