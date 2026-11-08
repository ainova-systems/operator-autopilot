// Points npm's `next` dist-tag at a final release unless `next` holds a release candidate of a newer
// version. A release candidate is published to `next` and a final release to `latest`, so without
// this step `next` keeps offering the last release candidate after its final release ships.
//   node scripts/align-next.mjs <X.Y.Z>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = (version) => version.split('-')[0].split('.').map(Number);

// The version `next` moves to, or undefined when it stays. `current` is undefined when the tag is unset.
export function nextTarget(current, version) {
  if (current === version) return undefined;
  if (current === undefined) return version;
  const [held, released] = [base(current), base(version)];
  for (let i = 0; i < 3; i++) {
    if (held[i] !== released[i]) return held[i] > released[i] ? undefined : version;
  }
  return version;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] ?? '';
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`usage: node scripts/align-next.mjs <X.Y.Z> (got '${version}')`);
    process.exit(2);
  }
  const { name } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // A failed read throws before any tag moves: an unreadable tag must never look like an unset one.
  const tags = JSON.parse(execFileSync('npm', ['view', name, 'dist-tags', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  if (typeof tags !== 'object' || tags === null || typeof tags.latest !== 'string') {
    throw new Error(`npm view ${name} dist-tags did not answer with the package's dist-tags`);
  }
  const current = typeof tags.next === 'string' ? tags.next : undefined;
  const target = nextTarget(current, version);
  if (target === undefined) {
    console.log(current === version ? `next already points at ${version}` : `next stays at ${current}, a release candidate of a newer version`);
  } else {
    execFileSync('npm', ['dist-tag', 'add', `${name}@${target}`, 'next'], { stdio: 'inherit' });
    console.log(`next: ${current ?? '<unset>'} -> ${target}`);
  }
}
