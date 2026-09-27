// Increases the patch number in src/version.js (1.0.4 -> 1.0.5). Run by .githooks/pre-commit.
import fs from 'node:fs';

const file = new URL('../src/version.js', import.meta.url);
const source = fs.readFileSync(file, 'utf8');
const match = source.match(/VERSION = '(\d+)\.(\d+)\.(\d+)'/);
if (!match) {
  console.error('bump-version: could not find VERSION in src/version.js');
  process.exit(1);
}

const [, major, minor, patch] = match;
const next = `${major}.${minor}.${Number(patch) + 1}`;
fs.writeFileSync(file, source.replace(match[0], `VERSION = '${next}'`));
console.log(`bump-version: ${match[1]}.${minor}.${patch} -> ${next}`);
