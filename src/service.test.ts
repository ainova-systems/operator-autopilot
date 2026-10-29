import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installService, SERVICE_UNIT, serviceStatus, uninstallService, type CommandResult, type ServiceHost } from './service.ts';

const root = mkdtempSync(join(tmpdir(), 'operator-service-'));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;

interface FakeHost extends ServiceHost { calls: string[] }

function fakeHost(overrides: Partial<ServiceHost> = {}, answers: Record<string, CommandResult> = {}): FakeHost {
  const home = join(root, `home-${counter++}`);
  mkdirSync(home, { recursive: true });
  const calls: string[] = [];
  return {
    platform: 'linux',
    home,
    path: '/opt/bin:/usr/bin',
    user: 'me',
    calls,
    run: (command, args) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      return answers[line] ?? { code: 0, stdout: '', stderr: '' };
    },
    ...overrides,
  };
}

function manifestIn(dir: string): string {
  const file = join(dir, 'operator.yaml');
  writeFileSync(file, 'project: demo\n');
  return file;
}

const unitPath = (host: ServiceHost) => join(host.home, '.config', 'systemd', 'user', 'operator@.service');
const envPath = (host: ServiceHost, project: string) => join(host.home, '.config', 'operator', `${project}.env`);

test('install writes the unit and a private env file, then enables and starts the instance', () => {
  const host = fakeHost({}, { 'loginctl show-user me --property=Linger': { code: 0, stdout: 'Linger=yes\n', stderr: '' } });
  const manifest = manifestIn(host.home);
  const report = installService({ project: 'demo', manifest, start: true }, host);
  assert.deepEqual(report, { instance: 'operator@demo.service', unit: 'written', env: 'written', envPath: envPath(host, 'demo'), started: true, linger: true });
  assert.equal(readFileSync(unitPath(host), 'utf8'), SERVICE_UNIT);
  assert.equal(readFileSync(envPath(host, 'demo'), 'utf8'), `OPERATOR_MANIFEST=${manifest}\nPATH=/opt/bin:/usr/bin\n`);
  assert.equal(statSync(envPath(host, 'demo')).mode & 0o777, 0o600);
  assert.deepEqual(host.calls.filter((call) => call.startsWith('systemctl')), [
    'systemctl --user show-environment',
    'systemctl --user daemon-reload',
    'systemctl --user enable --now operator@demo.service',
  ]);
});

test('install keeps an existing env file, names a secrets file, and can enable without starting', () => {
  const host = fakeHost();
  const manifest = manifestIn(host.home);
  mkdirSync(join(host.home, '.config', 'operator'), { recursive: true });
  writeFileSync(envPath(host, 'demo'), 'OPERATOR_MANIFEST=/elsewhere.yaml\nEXTRA=kept\n');
  const secrets = join(host.home, 'secrets.env');
  writeFileSync(secrets, 'KEY=x\n');
  const first = installService({ project: 'demo', manifest, envFile: secrets, start: false }, host);
  assert.equal(first.env, 'kept');
  assert.equal(first.linger, false);
  assert.equal(readFileSync(envPath(host, 'demo'), 'utf8'), 'OPERATOR_MANIFEST=/elsewhere.yaml\nEXTRA=kept\n');
  assert.ok(host.calls.includes('systemctl --user enable operator@demo.service'));

  const other = fakeHost();
  installService({ project: 'other', manifest: manifestIn(other.home), envFile: secrets, start: true }, other);
  assert.match(readFileSync(envPath(other, 'other'), 'utf8'), new RegExp(`^OPERATOR_ENV_FILE=${secrets}$`, 'm'));
});

test('install reports an unchanged unit and replaces a drifted one', () => {
  const host = fakeHost();
  const manifest = manifestIn(host.home);
  installService({ project: 'demo', manifest, start: true }, host);
  assert.equal(installService({ project: 'demo', manifest, start: true }, host).unit, 'unchanged');
  writeFileSync(unitPath(host), '[Unit]\nDescription=old\n');
  assert.equal(installService({ project: 'demo', manifest, start: true }, host).unit, 'updated');
  assert.equal(readFileSync(unitPath(host), 'utf8'), SERVICE_UNIT);
});

test('a host without systemd fails before anything is written', () => {
  const mac = fakeHost({ platform: 'darwin' });
  assert.throws(() => installService({ project: 'demo', manifest: manifestIn(mac.home), start: true }, mac), (error: Error & { code?: string }) => error.code === 'SERVICE_UNSUPPORTED' && /darwin/.test(error.message));
  assert.equal(mac.calls.length, 0);

  const container = fakeHost({}, { 'systemctl --user show-environment': { code: 1, stdout: '', stderr: 'Failed to connect to bus' } });
  assert.throws(() => installService({ project: 'demo', manifest: manifestIn(container.home), start: true }, container), /no systemd user manager is reachable \(systemctl --user: Failed to connect to bus\)/);
  assert.throws(() => uninstallService('demo', container), /SERVICE_UNSUPPORTED|no systemd user manager/);
  assert.throws(() => serviceStatus('demo', container), /no systemd user manager/);
  for (const host of [mac, container]) {
    assert.equal(existsSync(unitPath(host)), false);
    assert.equal(existsSync(envPath(host, 'demo')), false);
  }
});

test('install refuses a bad project name, a missing manifest and a missing secrets file', () => {
  const host = fakeHost();
  const manifest = manifestIn(host.home);
  assert.throws(() => installService({ project: 'Bad Name', manifest, start: true }, host), /project name/);
  assert.throws(() => installService({ project: 'demo', manifest: join(host.home, 'none.yaml'), start: true }, host), /no manifest at/);
  assert.throws(() => installService({ project: 'demo', manifest, envFile: join(host.home, 'none.env'), start: true }, host), /no env file at/);
  assert.equal(host.calls.length, 0);
});

test('a failing systemctl step is reported with its output', () => {
  const host = fakeHost({}, { 'systemctl --user enable --now operator@demo.service': { code: 1, stdout: '', stderr: 'Unit not found' } });
  assert.throws(() => installService({ project: 'demo', manifest: manifestIn(host.home), start: true }, host), /systemctl --user enable --now operator@demo.service failed: Unit not found/);
});

test('uninstall disables the instance, keeps the env file, and removes the unit only when no other project uses it', () => {
  const host = fakeHost();
  const manifest = manifestIn(host.home);
  installService({ project: 'demo', manifest, start: true }, host);
  const wants = join(host.home, '.config', 'systemd', 'user', 'default.target.wants');
  mkdirSync(wants, { recursive: true });
  symlinkSync(unitPath(host), join(wants, 'operator@other.service'));

  const shared = uninstallService('demo', host);
  assert.deepEqual(shared, { instance: 'operator@demo.service', unitRemoved: false, envPath: envPath(host, 'demo') });
  assert.ok(host.calls.includes('systemctl --user disable --now operator@demo.service'));
  assert.ok(existsSync(unitPath(host)));

  rmSync(join(wants, 'operator@other.service'));
  assert.equal(uninstallService('demo', host).unitRemoved, true);
  assert.equal(existsSync(unitPath(host)), false);
  assert.ok(existsSync(envPath(host, 'demo')));
});

test('status reports what systemd says about the instance', () => {
  const host = fakeHost({}, {
    'systemctl --user is-enabled operator@demo.service': { code: 0, stdout: 'enabled\n', stderr: '' },
    'systemctl --user is-active operator@demo.service': { code: 3, stdout: 'inactive\n', stderr: '' },
  });
  installService({ project: 'demo', manifest: manifestIn(host.home), start: true }, host);
  assert.deepEqual(serviceStatus('demo', host), { instance: 'operator@demo.service', enabled: 'enabled', active: 'inactive', unit: true, env: true, linger: false });
});
