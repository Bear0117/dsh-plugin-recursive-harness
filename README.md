# dsh-plugin-recursive-harness · Recursive Harness

English · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) that evolves the agent's **harness** while the model weights stay frozen, following the two-level recursion of Google Research's **Harness²** ([arXiv:2610.14224](https://arxiv.org/abs/2610.14224)):

- **Per task: Propose → Probe → Compose.** A model proposes two candidate harnesses (a *general* one that sharpens reasoning and tool discipline, and a *domain* one that adds memory, guardrails and a skill). Each candidate runs in an isolated headless dsh with a copy of the task workspace. Objective checks decide first, behavioral metrics (tool errors, steps, tokens) second, an optional model judge last. Complementary winners are merged and verified again; a worse merge falls back to the best single candidate.
- **Across tasks: Reflector → Experience Library.** What worked and what failed is written as plain Markdown entries that later proposals can draw on, in strict time order.

What gets evolved: four system prompt sections (`systemprompt`, `guardrails`, `tool_guidance`, `longTermMemory`) and candidate skills (`SKILL.md` plus small scripts). What never changes: your `AGENTS.md`, `.dsh/`, `.git/`, and anything you list in `lockedSurfaces`.

**Status: experimental.** It works end to end on dsh 0.2.0-rc.2, and the evaluation in [`docs/evaluation-report.md`](docs/evaluation-report.md) was run with a real model on a 12-task synthetic set. Read the report's limitations before expecting gains on your own tasks.

## What you see

1. Install the plugin. Every new Session now carries the active harness version (four sections once each in the system prompt; `/harness inspect` shows the version and the mounted skills).
2. `/harness start gen-dev-01` (a built-in task) or `/harness start ./my-task.mjs` starts an evolution run in the background: reference runs, proposals, probes, comparison, compose. `/harness status <runId>` follows it; `/harness cancel <runId>` stops it and kills the child processes.
3. When a candidate beats the baseline on the objective checks and by more than the baseline's own variance, it becomes the active version. **New Sessions** get it; running Sessions are never changed mid-flight. `/harness rollback [versionId]` goes back.
4. `/harness listExperience` lists what the reflector kept.

The same commands exist on the command line: `npx dsh-recursive-harness inspect | start | status | cancel | rollback | listExperience` (state under `./.dsh-harness` by default; `--config` takes a JSON file with the same keys as the plugin settings).

## Requirements

- dsh 0.2.x. Tested on dsh 0.2.0-rc.2 (Windows 11, Node.js 24.21) with the web profile; probes use the headless profile that ships with dsh.
- Node.js 22.19 or later in the 22 line, or 24 and later (the same as dsh).
- A **proposer endpoint**: any OpenAI-compatible chat completions server (vLLM, SGLang, llama.cpp, Ollama, or a hosted API). Until you configure one, the proposer is a fixed template and no text leaves your machine.
- Probes run with the model of the profile you name in `probe.templateProfile` (default `web`), or with `probe.provider` / `probe.model` if you set them. Each probe is a full agent run; budget accordingly.

## Install

```bash
dsh plugin --profile web add dsh-plugin-recursive-harness
```

Through npx: `npx @deepseek-ai/dsh plugin --profile web add dsh-plugin-recursive-harness`. Restart `dsh web`. The plugin prints `[recursive-harness] ready: …` on start.

**Update:** `dsh plugin --profile web update dsh-plugin-recursive-harness`, then restart. dsh installs plugins with pnpm, which picks a newly published version only once it is a day old; to update right away, name the version (`add dsh-plugin-recursive-harness@0.1.0`).

To remove: `dsh plugin --profile web remove dsh-plugin-recursive-harness`, delete the `recursive-harness` entry from your profile's `cordis.patch.yml` if you added one, and delete `~/.dsh/recursive-harness/` if you do not want to keep the harness versions and the experience library.

## Settings

Settings go in your profile's `cordis.patch.yml` (web profile: `~/.dsh/profiles/web/cordis.patch.yml`). An entry with `id: recursive-harness` replaces the plugin's whole `config`; keys you leave out keep the defaults in [`cordis.patch.yml`](cordis.patch.yml).

```yaml
- id: recursive-harness
  config:
    proposer:
      engine: llm
      endpoint: http://127.0.0.1:8000/v1/chat/completions
      model: my-model
      apiKeyEnv: ""            # env var with the key, if the endpoint needs one
      allowEgress: false       # true before anything goes to a non-loopback endpoint
      allowHttpHosts: []       # non-loopback hosts that may be reached over plain http
      judge: true              # model judge as the third tier; never overrides objective checks
      jsonMode: false          # send response_format json_object (vLLM, OpenAI)
      extraBody: {}            # e.g. { chat_template_kwargs: { enable_thinking: false } }
    probe:
      templateProfile: web     # probes inherit this profile's model rows and credentials
      provider: ""             # override the probe model (a provider id from llm-pi-ai)
      model: ""
      blockedTools: []         # tasks needing these tools are never probed
    lockedSurfaces: []         # extra paths a candidate may never touch
    protectedPatterns: []      # regexes that reject a candidate (e.g. "\\bPROD-DB\\b")
    maxConcurrency: 2          # parallel probe child processes
    maxTokensPerIteration: 120000
    probeTimeoutMs: 600000
```

### Your own tasks

A task file is an ES module that exports a task (or `tasks`, an array). The plugin writes `workspaceFiles` into an empty workspace, runs the agent with `prompt`, and hands the final output to `objectiveCheck`:

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

The proposer never sees `expected`; the numbers in `details` are masked before they reach it. Keep a held-out set of tasks the proposer has not seen to tell real improvements from overfitting.

## Where things live

`$DSH_HOME/recursive-harness/` (by default `~/.dsh/recursive-harness/`):

- `active/` the mounted harness: `systemprompt.md`, `guardrails.md`, `tool_guidance.md`, `LongTermMEMORY.md`, `skills/<name>/SKILL.md` (+ `scripts/`). You can edit these by hand; the next Session mounts the edited version.
- `state/` `manifest.json`, `checkpoints/<runId>.json`, `harnesses/<versionId>/` snapshots, `sessions/` sidecars, `events.jsonl`.
- `experience/` `INDEX.md` and one folder per entry (`EXPERIENCE.md`, the harness snapshot it came from).

Each probe runs in `<tmp>/dshp-*/` with its own `DSH_HOME` (profile, credentials copied from the template profile, the candidate harness) and workspace, deleted when the probe ends. Stale directories left by a killed process are swept at the next start.

## What leaves your machine

- To the proposer endpoint: the task prompt, the current harness text, summaries of the reference runs (tool names, argument excerpts, error messages, a final-output excerpt with keys and private IPs redacted), and relevant experience entries. Only when `proposer.engine` is `llm`.
- From the probes: whatever the agent's model receives in a normal dsh Session, through the model rows of the template profile.
- Nothing else. There is no telemetry; the plugin never calls GitHub or npm.

## Evaluation

See [`docs/evaluation-report.md`](docs/evaluation-report.md) for the real-model run (setup, per-task numbers, limitations). The two gates it reports:

- **G1**: with the same probe budget, does single-step Propose → Probe → Compose beat best-of-k on a held-out task set by more than the baseline's own variance?
- **G2**: does the cross-task experience library help on held-out tasks, measured by leave-one-out?

The unit tests (`npm test`) include a pipeline rehearsal with a mock executor; those numbers are not results and are never written into the report.

## Known limits

- One evolution run spends 5 to 6 full agent runs plus one or two proposer calls. Budgets (`maxTokensPerIteration`, `maxWallTimeMs`, `probeTimeoutMs`) stop a run; they do not make it cheap.
- Probes inherit the template profile's `cordis.patch.yml` only; model rows passed to dsh with `--patch` at launch are not seen by the child process.
- Windows: child processes are killed with `taskkill /T`; a probe that is cancelled during a slow model call may take a few seconds to go away.
- The runtime stagnation detector (`enableRuntimeStagnation`) is optional and off by default.

## Development

```bash
npm test                    # unit tests, including a probe child-process test with a fake dsh binary
npm run eval                # pipeline rehearsal with the mock executor (not a result)
node eval/run-real-eval.mjs --config my-config.json   # real-model evaluation, resumable
```

Feedback and bug reports: [GitHub issues](https://github.com/Bear0117/dsh-plugin-recursive-harness/issues). MIT license.
