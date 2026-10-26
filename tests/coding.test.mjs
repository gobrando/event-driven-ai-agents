import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeCommand, runCodingJob } from '../src/agents/coding.mjs';

const wrong = 'export function add(a, b) { return a - b; }\n';
const correct = 'export function add(a, b) { return a + b; }\n';
const gitPath = '/usr/bin/git';
const event = {
  version: 1, id: 'synthetic-ticket-1', source: 'fixture', type: 'ticket.ready',
  repository: 'demo', occurredAt: '2026-10-26T12:00:00Z',
  data: { title: 'Correct synthetic addition', body: 'Expected add(2, 3) to return 5.' },
};

async function fixture(t, { badCheck = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'event-agent-coding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'src'), { recursive: true });
  await mkdir(path.join(source, 'test'));
  await writeFile(path.join(source, 'src/answer.mjs'), wrong);
  await writeFile(path.join(source, 'test/answer.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/answer.mjs';",
    `test('synthetic addition', () => assert.equal(add(2, 3), ${badCheck ? 999 : 5}));`,
    '',
  ].join('\n'));
  const git = async (args) => {
    const result = await executeCommand({ file: gitPath, args, cwd: source, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  await git(['init', '-b', 'main']);
  await git(['add', '--', 'src/answer.mjs', 'test/answer.test.mjs']);
  await git(['-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic baseline']);
  await git(['remote', 'add', 'origin', 'https://github.com/example/synthetic-demo.git']);
  const options = {
    workRoot: path.join(root, 'jobs'),
    repositories: { demo: {
      path: source, githubRepository: 'example/synthetic-demo', baseRef: 'HEAD', baseBranch: 'main',
      checks: [[process.execPath, '--test', 'test/answer.test.mjs']], allowedPaths: ['src/', 'test/'],
    } },
  };
  return { source, root, git, options };
}

test('mock creates a real isolated branch, fixes the fixture, passes real checks, and saves a patch', async (t) => {
  const { source, git, options } = await fixture(t);
  const commands = [];
  const result = await runCodingJob(event, { ...options, runCommand: command => { commands.push(command); return executeCommand(command); } });
  assert.equal(result.status, 'review-ready');
  assert.equal(result.modelSpendUsd, 0);
  assert.equal(result.checks[0].exitCode, 0);
  assert.deepEqual(result.changedFiles, ['src/answer.mjs']);
  assert.equal(await readFile(path.join(source, 'src/answer.mjs'), 'utf8'), wrong);
  assert.equal(await readFile(path.join(result.worktree, 'src/answer.mjs'), 'utf8'), correct);
  assert.match(await readFile(result.reviewPath, 'utf8'), /return a \+ b/);
  assert.equal(await git(['branch', '--show-current']), 'main');
  assert.match(await git(['branch', '--list', result.branch]), /codex\/ticket-/);
  assert.ok(commands.every(command => command.file !== 'codex' && command.file !== 'gh' && !command.args.includes('push')));
  const before = commands.length;
  const replayed = await runCodingJob(event, { ...options, runCommand: command => { commands.push(command); return executeCommand(command); } });
  assert.equal(replayed.jobId, result.jobId);
  assert.equal(replayed.patchSha256, result.patchSha256);
  assert.ok(commands.slice(before).every(command => !command.args.includes('worktree') && command.file !== process.execPath));
});

test('event-selected paths and commands cannot replace trusted configuration', async (t) => {
  const { options } = await fixture(t);
  await assert.rejects(runCodingJob({ ...event, repository: 'unconfigured' }, options), /Unknown configured repository/);
  await assert.rejects(runCodingJob({ ...event, data: { ...event.data, path: '/tmp/escape', command: 'touch /tmp/escape' } }, options), /INVALID_EVENT/);
  const result = await runCodingJob(event, options);
  assert.deepEqual(result.changedFiles, ['src/answer.mjs']);
  await assert.rejects(runCodingJob({ ...event, data: { ...event.data, body: 'Changed content under reused ID' } }, options), /reused/);
});

test('checks receive no inherited API, webhook, or GitHub secrets', async (t) => {
  const { options } = await fixture(t);
  let checked = false;
  await runCodingJob(event, {
    ...options,
    env: { HOME: '/private/home', GH_TOKEN: 'synthetic-gh-secret', OPENAI_API_KEY: 'synthetic-api-secret', WEBHOOK_SECRET: 'synthetic-hook-secret' },
    runCommand: command => {
      if (command.file === process.execPath) {
        checked = true;
        assert.equal(command.env.GH_TOKEN, undefined);
        assert.equal(command.env.OPENAI_API_KEY, undefined);
        assert.equal(command.env.WEBHOOK_SECRET, undefined);
        assert.notEqual(command.env.HOME, '/private/home');
      }
      return executeCommand(command);
    },
  });
  assert.equal(checked, true);
});

test('mock refuses arbitrary real repository content', async (t) => {
  const { options, source, git } = await fixture(t);
  await writeFile(path.join(source, 'src/answer.mjs'), 'export const production = true;\n');
  await git(['add', '--', 'src/answer.mjs']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Different fixture']);
  await assert.rejects(runCodingJob(event, options), /only supports the documented synthetic/);
});

test('a failing real check blocks publication and preserves diagnostics', async (t) => {
  const { options, root } = await fixture(t, { badCheck: true });
  const calls = [];
  await assert.rejects(runCodingJob(event, { ...options, publish: true, env: { ALLOW_GIT_WRITES: 'true' }, runCommand: command => {
    calls.push(command);
    return executeCommand(command);
  } }), /checks failed/);
  assert.ok(calls.every(command => command.file !== 'gh' && !command.args.includes('push')));
  const directories = (await import('node:fs/promises')).readdir;
  const [job] = await directories(path.join(root, 'jobs'));
  assert.equal(JSON.parse(await readFile(path.join(root, 'jobs', job, 'checks.json')))[0].exitCode, 1);
});

test('Codex cannot run without both explicit permission and an external spend enforcer', async (t) => {
  const { options } = await fixture(t);
  for (const extra of [{}, { env: { ALLOW_CODEX: 'true' } }, { codexBudgetEnforcer: () => assert.fail('Not permitted') }]) {
    await assert.rejects(runCodingJob(event, { ...options, mode: 'codex', ...extra, runCommand: () => assert.fail('Must not spawn') }), /cumulative \$1 budget enforcer/);
  }
});

test('externally enforced fake Codex receives stdin and records its JSONL thread ID', async (t) => {
  const { options } = await fixture(t);
  let enforced = false;
  let codexCommand;
  const result = await runCodingJob(event, {
    ...options, mode: 'codex', env: { ALLOW_CODEX: 'true', CODEX_API_KEY: 'never-pass-this-key' },
    codexBudgetEnforcer: async ({ maxUsd, jobId, run }) => {
      enforced = true;
      assert.equal(maxUsd, 1);
      assert.match(jobId, /^[a-f0-9]{24}$/);
      return run();
    },
    runCommand: async command => {
      if (command.file !== 'codex') return executeCommand(command);
      codexCommand = command;
      assert.equal(enforced, true);
      assert.equal(command.env.CODEX_API_KEY, undefined);
      assert.ok(command.args.includes('--sandbox') && command.args.includes('workspace-write'));
      assert.equal(command.args.at(-1), '-');
      assert.match(command.input, /untrusted task data/);
      assert.match(command.input, /Correct synthetic addition/);
      await writeFile(path.join(command.cwd, 'src/answer.mjs'), correct);
      return { code: 0, stdout: '{"type":"thread.started","thread_id":"synthetic-thread"}\n{"type":"turn.completed"}\n', stderr: '' };
    },
  });
  assert.equal(result.threadId, 'synthetic-thread');
  assert.equal(result.modelSpendUsd, null);
  assert.ok(codexCommand.timeoutMs <= 240_000);
});

test('runner changes outside allowedPaths fail before checks or publication', async (t) => {
  const { options } = await fixture(t);
  await assert.rejects(runCodingJob(event, {
    ...options, mode: 'codex', env: { ALLOW_CODEX: 'true' }, codexBudgetEnforcer: ({ run }) => run(),
    runCommand: async command => {
      if (command.file === 'codex') {
        await writeFile(path.join(command.cwd, 'escape.txt'), 'Synthetic unauthorized change');
        return { code: 0, stdout: '{"type":"thread.started","thread_id":"synthetic"}\n', stderr: '' };
      }
      if (command.file === process.execPath) assert.fail('Scope failure must precede checks');
      return executeCommand(command);
    },
  }), /outside configured allowedPaths/);
});

test('publication is explicit and rejects a different configured origin', async (t) => {
  const { options, git } = await fixture(t);
  await assert.rejects(runCodingJob(event, { ...options, publish: true, runCommand: () => assert.fail('No permission') }), /ALLOW_GIT_WRITES/);
  await git(['remote', 'set-url', '--push', 'origin', 'https://github.com/another/synthetic-demo.git']);
  await assert.rejects(runCodingJob(event, { ...options, publish: true, env: { ALLOW_GIT_WRITES: 'true' } }), /Origin does not exactly match/);
});

test('an interrupted registered worktree can recover its saved unadvanced branch', async (t) => {
  const { options } = await fixture(t);
  let interrupted = false;
  await assert.rejects(runCodingJob(event, { ...options, runCommand: async command => {
    const response = await executeCommand(command);
    if (!interrupted && command.args.includes('worktree') && command.args.includes('add')) {
      interrupted = true;
      const worktree = command.args[command.args.indexOf('-b') + 2];
      await rm(worktree, { recursive: true, force: true });
      return { code: 1, stdout: '', stderr: 'Synthetic interruption after branch registration' };
    }
    return response;
  } }), /Git operation failed/);
  assert.equal((await runCodingJob(event, options)).status, 'review-ready');
});

test('a closed draft or fork cannot be claimed as successful publication', async (t) => {
  const { options } = await fixture(t);
  await runCodingJob(event, options);
  for (const existing of [
    { isDraft: true, state: 'CLOSED', isCrossRepository: false },
    { isDraft: true, state: 'OPEN', isCrossRepository: true },
  ]) {
    await assert.rejects(runCodingJob(event, {
      ...options, publish: true, env: { ALLOW_GIT_WRITES: 'true' },
      runCommand: command => command.file === 'gh'
        ? Promise.resolve({ code: 0, stdout: JSON.stringify([{ url: 'https://github.com/example/synthetic-demo/pull/8', ...existing }]), stderr: '' })
        : executeCommand(command),
    }), /open draft from this repository/);
  }
});

test('publication uses a deterministic branch and recovers an uncertain draft creation', async (t) => {
  const { options } = await fixture(t);
  const calls = [];
  const url = 'https://github.com/example/synthetic-demo/pull/7';
  let created = false;
  const runCommand = async command => {
    calls.push(command);
    if (command.file === 'gh') {
      assert.equal(command.env.GH_TOKEN, 'synthetic-publication-token');
      if (command.args[1] === 'list') return { code: 0, stdout: JSON.stringify(created ? [{ url, isDraft: true, state: 'OPEN', isCrossRepository: false }] : []), stderr: '' };
      assert.equal(command.args[1], 'create');
      assert.ok(command.args.includes('--draft'));
      const body = await readFile(command.args[command.args.indexOf('--body-file') + 1], 'utf8');
      assert.match(body, /Validation:/);
      created = true;
      return { code: 1, stdout: '', stderr: 'Synthetic uncertain response after PR creation' };
    }
    if (command.args.includes('push')) {
      assert.ok(command.args.some(arg => arg.startsWith('HEAD:refs/heads/codex/ticket-')));
      assert.ok(!command.args.includes('--force'));
      return { code: 0, stdout: 'Synthetic push success\n', stderr: '' };
    }
    return executeCommand(command);
  };
  const publishing = { ...options, publish: true, env: { ALLOW_GIT_WRITES: 'true', GH_TOKEN: 'synthetic-publication-token' }, runCommand };
  await assert.rejects(runCodingJob(event, publishing), /uncertain publication/);
  const recovered = await runCodingJob(event, publishing);
  assert.equal(recovered.status, 'draft-pr');
  assert.equal(recovered.pullRequestUrl, url);
  assert.equal(calls.filter(command => command.args.includes('push')).length, 1);
  assert.equal(calls.filter(command => command.file === 'gh' && command.args[1] === 'create').length, 1);
  assert.ok(calls.filter(command => command.file === process.execPath).every(command => command.env.GH_TOKEN === undefined));
});

test('modified patch content after checks cannot be published from cached result', async (t) => {
  const { options } = await fixture(t);
  const result = await runCodingJob(event, options);
  await writeFile(path.join(result.worktree, 'src/answer.mjs'), `${correct}// unreviewed alteration\n`);
  await assert.rejects(runCodingJob(event, {
    ...options, publish: true, env: { ALLOW_GIT_WRITES: 'true' },
    runCommand: command => command.file === 'gh'
      ? Promise.resolve({ code: 0, stdout: '[]', stderr: '' }) : executeCommand(command),
  }), /Patch content changed/);
});

test('child processes obey timeout, output limit, and abort', async () => {
  const common = { file: process.execPath, cwd: tmpdir(), env: { PATH: '/usr/bin:/bin' } };
  await assert.rejects(executeCommand({ ...common, args: ['-e', 'setTimeout(() => {}, 10000)'], timeoutMs: 30 }), /timed out/);
  await assert.rejects(executeCommand({ ...common, args: ['-e', 'console.log("x".repeat(1000))'], maxOutputBytes: 32 }), /output limit/);
  const controller = new AbortController();
  const running = executeCommand({ ...common, args: ['-e', 'setTimeout(() => {}, 10000)'], signal: controller.signal });
  controller.abort();
  await assert.rejects(running, /aborted/);
});
