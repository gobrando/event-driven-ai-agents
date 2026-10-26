import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareDemoRepository } from './demo-repository.mjs';

export async function loadWorkerConfig(path, { stateRoot = '.state' } = {}) {
  if (path) return JSON.parse(await readFile(path, 'utf8'));
  const root = resolve(stateRoot);
  return {
    mode: 'mock', publish: false, workRoot: `${root}/work`,
    repositories: { demo: await prepareDemoRepository(`${root}/demo-repository`) },
  };
}

export function argument(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}
