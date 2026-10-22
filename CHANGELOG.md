# Changelog

## 0.1.0 (unreleased)

First public release.

- Mounts a versioned harness (system prompt, guardrails, tool guidance, long-term memory, skills) into every new dsh Session; content-addressed versions, snapshots and rollback.
- Propose → Probe → Compose per task: a model proposes General and Domain candidates, each candidate runs in an isolated headless dsh child process with a copy of the task workspace, and a three-tier comparator (objective checks, behavioral metrics, optional model judge) decides. Compose merges complementary winners and re-verifies; a worse merge falls back to the best single candidate.
- Cross-task experience library as plain Markdown files, with time-ordered snapshots, idempotent writes, retraction and deprecation.
- `/harness inspect | start | status | cancel | rollback | listExperience` in dsh, and a CLI with the same commands.
- Safety: locked surfaces (`AGENTS.md`, `.dsh`, `.git`, plus your own), privilege-escalation and prompt-injection patterns, your own `protectedPatterns`, blocked tools, path checks on skill names and scripts, and redaction of keys and private IPs before anything is written to the library. The proposer never sees a task's expected answer.
- Nothing leaves the machine until a proposer endpoint is configured; non-loopback endpoints need `allowEgress: true`, and plain http hosts must be listed in `allowHttpHosts`. Probe children inherit the model rows and credentials of the profile you name (`probe.templateProfile`).
- Optional runtime stagnation detector (`enableRuntimeStagnation`).
- Tested on dsh 0.2.0-rc.2 (Windows 11, Node 24.21).
