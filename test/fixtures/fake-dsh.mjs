// A stand-in for @deepseek-ai/dsh/lib/bin.js used by the probe child-process test.
// It records how it was launched (args, env, cwd, the profile the plugin wrote) and prints an NDJSON run.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const home = process.env.DSH_HOME;
const profileDir = path.join(home, 'profiles', 'headless');
const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
const patches = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--patch') patches.push(fs.readFileSync(args[i + 1], 'utf8'));
const task = args[args.length - 1];
const linked = fs.existsSync(path.join(profileDir, 'node_modules', manifest.dsh.profile.bundles[2], 'package.json'));
const harnessDir = path.join(home, 'harness');
const harnessFiles = fs.existsSync(harnessDir) ? fs.readdirSync(harnessDir) : [];
const cwdFiles = fs.readdirSync(process.cwd());

const record = { args, cwd: process.cwd(), home, bundles: manifest.dsh.profile.bundles, linked, patches, harnessFiles, cwdFiles, telemetry: process.env.DSH_TELEMETRY_MODE };
if (process.env.FAKE_DSH_RECORD) fs.writeFileSync(process.env.FAKE_DSH_RECORD, JSON.stringify(record, null, 1));

if (process.env.FAKE_DSH_HANG === '1') {
  setInterval(() => {}, 1000); // never exits: the test must kill it
} else {
  const out = [
    { type: 'session', sessionId: 'fake-session', cwd: process.cwd() },
    { type: 'status', phase: 'turn_start', turn: 1 },
    { type: 'status', phase: 'step_start', turn: 1, step: 1 },
    { type: 'tool_call', callId: 'c1', tool: 'read', input: { file_path: cwdFiles[0] || 'none' } },
    { type: 'tool_result', callId: 'c1', status: 'completed', result: 'ok' },
    { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
    { type: 'final', text: JSON.stringify({ echo: task, harnessFiles }) },
  ];
  process.stdout.write(out.map((e) => JSON.stringify(e)).join('\n') + '\n');
  process.stderr.write('fake dsh: done\n');
}
