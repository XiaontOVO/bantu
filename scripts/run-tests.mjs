import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const testsDirectory = resolve(process.cwd(), 'dist/tests');
const entries = await readdir(testsDirectory, { withFileTypes: true });
const sourceTestsDirectory = resolve(process.cwd(), 'tests');
const sourceEntries = await readdir(sourceTestsDirectory, { withFileTypes: true });
const sourceTestNames = new Set(sourceEntries
  .filter((entry) => entry.isFile() && /\.test\.(?:ts|js|mjs)$/.test(entry.name))
  .map((entry) => entry.name.replace(/\.ts$/, '.js')));
const testFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  // tsc does not remove deleted outputs; do not execute tests whose source no longer exists.
  .filter((entry) => sourceTestNames.has(entry.name))
  .map((entry) => resolve(testsDirectory, entry.name))
  .sort();

if (testFiles.length === 0) {
  console.error(`No compiled test files found in ${testsDirectory}. Run "npm run build:test" first.`);
  process.exitCode = 1;
} else {
  // 单进程直接 import，避免在某些受限环境下 Node test runner 再 spawn 子进程。
  for (const file of testFiles) {
    await import(pathToFileURL(file).href);
  }
}
