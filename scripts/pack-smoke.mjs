// Packs the package, installs the tarball into an empty directory with no workspace around it,
// and runs the installed CLI: --version, --help, and an offline validate of the demo fixture.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'operator-pack-'));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work], root));
  const tarball = join(work, packed[0].filename);
  const files = packed[0].files.map((file) => file.path);
  const unexpected = files.filter((path) => !/^(dist\/|README\.md$|LICENSE$|package\.json$)/.test(path) || path.includes('.test.') || path.includes('test-support'));
  if (unexpected.length > 0) throw new Error(`the tarball carries files it should not: ${unexpected.join(', ')}`);
  const app = join(work, 'app');
  run('mkdir', ['-p', app]);
  writeFileSync(join(app, 'package.json'), '{"name":"pack-smoke","private":true}');
  run('npm', ['install', '--no-audit', '--no-fund', tarball], app);
  const bin = join(app, 'node_modules', '.bin', 'operator');
  const version = run(bin, ['--version'], app).trim();
  run(bin, ['--help'], app);
  const validated = run(bin, ['validate', '--offline', '--manifest', join(root, 'fixtures', 'demo', 'orchestrator.yaml')], app);
  console.log(`pack smoke ok: ${packed[0].filename} (${files.length} files), operator ${version}`);
  console.log(validated.trim().split('\n').at(-1));
} finally {
  rmSync(work, { recursive: true, force: true });
}
