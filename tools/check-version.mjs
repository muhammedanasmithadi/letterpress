import { readFileSync } from 'node:fs';
import { $ } from 'bun';

const ROOT = new URL('..', import.meta.url).pathname;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const pkg = readJson(ROOT + 'package.json');
const jsr = readJson(ROOT + 'jsr.json');

const problems = [];

if (!SEMVER.test(pkg.version)) {
  problems.push(`package.json version "${pkg.version}" is not valid semver`);
}
if (!SEMVER.test(jsr.version)) {
  problems.push(`jsr.json version "${jsr.version}" is not valid semver`);
}
if (pkg.version !== jsr.version) {
  problems.push(`version mismatch: package.json has ${pkg.version}, jsr.json has ${jsr.version}`);
}

// Check that a git tag exists for this version (optional, warns only)
const tag = `v${pkg.version}`;
try {
  const tags = await $`git tag -l ${tag}`.text();
  if (!tags.trim()) {
    console.warn(`warning: no git tag ${tag} yet (create with: git tag ${tag} && git push --tags)`);
  }
} catch {
  // git not available in this context; skip
}

if (problems.length > 0) {
  console.error('version check failed:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`version check ok: ${pkg.version} (package.json == jsr.json)`);
