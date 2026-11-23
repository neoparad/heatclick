import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SplitName } from './dataset-builder';

type History = ReadonlyMap<string, SplitName>;

function readHistory(path: string, scope: string): History {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  const doc = JSON.parse(raw);
  if (doc?.version !== 1 || doc.scope !== scope || !Array.isArray(doc.entries) || !doc.entries.length) {
    throw new Error('Invalid or incompatible split manifest');
  }
  const entries = new Map<string, SplitName>();
  for (const pair of doc.entries) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(pair[0]) || entries.has(pair[0]) ||
        !['train', 'select_tune', 'final_eval'].includes(pair[1])) {
      throw new Error('Invalid split manifest assignment');
    }
    entries.set(pair[0], pair[1]);
  }
  return entries;
}

function publish(path: string, scope: string, entries: History): void {
  const staging = path + '.' + randomUUID() + '.tmp';
  const fd = openSync(staging, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, scope, entries: [...entries] }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(staging, path);
  } catch (error) {
    unlinkSync(staging);
    throw error;
  }
}

/** On a writer crash the lock stays closed; remove it only after confirming the writer has stopped. */
export function withSplitManifest<T>(
  path: string,
  scope: string,
  build: (prior: History) => { readonly result: T; readonly assignments: History },
): T {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('An absolute split manifest path is required');
  const lock = path + '.lock';
  const fd = openSync(lock, 'wx', 0o600);
  try {
    const prior = readHistory(path, scope);
    const { result, assignments } = build(prior);
    const merged = new Map(prior);
    for (const [key, split] of assignments) {
      if (prior.has(key) && prior.get(key) !== split) throw new Error('Conflicting split manifest assignment');
      merged.set(key, split);
    }
    if (merged.size !== prior.size) publish(path, scope, merged);
    return result;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
