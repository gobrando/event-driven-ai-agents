import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function prepareDemoRepository(path) {
  const root = resolve(path);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const marker = `${root}/.event-agent-demo`;
  if ((await readdir(root)).length) {
    if (await readFile(marker, 'utf8').catch(() => '') !== 'synthetic-only\n') throw new Error('REFUSE_NON_DEMO_DIRECTORY');
  } else {
    await mkdir(`${root}/src`);
    await mkdir(`${root}/test`);
    await writeFile(marker, 'synthetic-only\n');
    await writeFile(`${root}/package.json`, '{"name":"synthetic-addition-fixture","private":true,"type":"module"}\n');
    await writeFile(`${root}/src/answer.mjs`, 'export function add(a, b) { return a - b; }\n');
    await writeFile(`${root}/test/answer.test.mjs`, "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/answer.mjs';\ntest('addition', () => assert.equal(add(2, 3), 5));\n");
    await exec('git', ['init', '-b', 'main', root]);
    await exec('git', ['-C', root, 'add', '--', '.event-agent-demo', 'package.json', 'src/answer.mjs', 'test/answer.test.mjs']);
    await exec('git', ['-C', root, '-c', 'user.name=Synthetic Demo', '-c', 'user.email=demo@example.invalid', 'commit', '-m', 'Create synthetic addition fixture']);
  }
  return { path: root, githubRepository: 'example/synthetic-addition', baseRef: 'main', baseBranch: 'main', checks: [[process.execPath, '--test', 'test/answer.test.mjs']], allowedPaths: ['src/', 'test/'] };
}
