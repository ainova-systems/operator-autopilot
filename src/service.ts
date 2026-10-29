import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { OperatorError } from './errors.ts';

/**
 * One systemd user template serves every project: `operator@<project>.service` reads
 * ~/.config/operator/<project>.env, which names the manifest and the PATH jobs start with.
 * The runtime releases its leader lease on SIGTERM and running jobs are detached, so
 * KillMode=process lets a stop or restart leave them running.
 */
export const SERVICE_UNIT = `# Installed by \`operator service install\`. One instance per project:
# operator@<project>.service reads ~/.config/operator/<project>.env.
[Unit]
Description=Operator runtime for %i
After=network-online.target herdr.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/operator/%i.env
ExecStart=/usr/bin/env operator run
Restart=always
RestartSec=5
# The daemon releases its leader lease on SIGTERM; running jobs are detached and keep running.
KillMode=process
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;

export interface CommandResult { code: number; stdout: string; stderr: string }
export type RunCommand = (command: string, args: string[]) => CommandResult;

export interface ServiceHost {
  platform: NodeJS.Platform;
  home: string;
  path: string | undefined;
  user: string;
  run: RunCommand;
}

export function systemHost(): ServiceHost {
  return {
    platform: process.platform,
    home: homedir(),
    path: process.env['PATH'],
    user: process.env['USER'] ?? '',
    run: (command, args) => {
      const result = spawnSync(command, args, { encoding: 'utf8' });
      if (result.error) return { code: 127, stdout: '', stderr: result.error.message };
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

export interface ServicePaths { unit: string; env: string; instance: string }

export function servicePaths(home: string, project: string): ServicePaths {
  return {
    unit: join(home, '.config', 'systemd', 'user', 'operator@.service'),
    env: join(home, '.config', 'operator', `${project}.env`),
    instance: `operator@${project}.service`,
  };
}

function checkProject(project: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(project)) {
    throw new OperatorError('SERVICE_NAME', 'a project name is lower-case letters, digits, dashes and underscores');
  }
}

/** Fails before anything is written when the host has no systemd user manager to install into. */
function requireSystemd(host: ServiceHost): void {
  if (host.platform !== 'linux') {
    throw new OperatorError('SERVICE_UNSUPPORTED', `operator service needs systemd, which ${host.platform} does not have; run \`operator run\` under the host's own service manager`);
  }
  const probe = host.run('systemctl', ['--user', 'show-environment']);
  if (probe.code !== 0) {
    throw new OperatorError('SERVICE_UNSUPPORTED', `no systemd user manager is reachable (systemctl --user: ${(probe.stderr || probe.stdout).trim() || `exit ${probe.code}`}); run \`operator run\` under the host's own service manager`);
  }
}

function systemctl(host: ServiceHost, args: string[]): string {
  const result = host.run('systemctl', ['--user', ...args]);
  if (result.code !== 0) {
    throw new OperatorError('SERVICE_COMMAND', `systemctl --user ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function lingerEnabled(host: ServiceHost): boolean {
  if (!host.user) return false;
  const result = host.run('loginctl', ['show-user', host.user, '--property=Linger']);
  return result.code === 0 && result.stdout.trim() === 'Linger=yes';
}

export interface InstallOptions { project: string; manifest: string; envFile?: string; start: boolean }

export interface InstallReport {
  instance: string;
  unit: 'written' | 'updated' | 'unchanged';
  env: 'written' | 'kept';
  envPath: string;
  started: boolean;
  linger: boolean;
}

/**
 * Writes the template unit and the project's env file, then enables the instance. An existing env
 * file is kept as it is: it may hold keys the owner added, and rewriting it would lose them.
 */
export function installService(options: InstallOptions, host: ServiceHost = systemHost()): InstallReport {
  checkProject(options.project);
  const manifest = resolve(options.manifest);
  if (!existsSync(manifest)) throw new OperatorError('SERVICE_MANIFEST', `no manifest at ${manifest}`);
  const envFile = options.envFile === undefined ? undefined : resolve(options.envFile);
  if (envFile !== undefined && !existsSync(envFile)) throw new OperatorError('SERVICE_ENV_FILE', `no env file at ${envFile}`);
  requireSystemd(host);
  const paths = servicePaths(host.home, options.project);

  const current = existsSync(paths.unit) ? readFileSync(paths.unit, 'utf8') : undefined;
  const unit = current === undefined ? 'written' : current === SERVICE_UNIT ? 'unchanged' : 'updated';
  if (unit !== 'unchanged') {
    mkdirSync(join(paths.unit, '..'), { recursive: true });
    writeFileSync(paths.unit, SERVICE_UNIT);
  }

  let env: InstallReport['env'] = 'kept';
  if (!existsSync(paths.env)) {
    const lines = [`OPERATOR_MANIFEST=${manifest}`];
    if (envFile !== undefined) lines.push(`OPERATOR_ENV_FILE=${envFile}`);
    if (host.path) lines.push(`PATH=${host.path}`);
    mkdirSync(join(paths.env, '..'), { recursive: true });
    writeFileSync(paths.env, `${lines.join('\n')}\n`, { mode: 0o600 });
    chmodSync(paths.env, 0o600);
    env = 'written';
  }

  systemctl(host, ['daemon-reload']);
  systemctl(host, options.start ? ['enable', '--now', paths.instance] : ['enable', paths.instance]);
  return { instance: paths.instance, unit, env, envPath: paths.env, started: options.start, linger: lingerEnabled(host) };
}

export interface UninstallReport { instance: string; unitRemoved: boolean; envPath: string }

/**
 * Stops and disables the instance. The template unit goes only when no other project's instance is
 * still enabled (linked from default.target.wants, where WantedBy puts it), and the env file always
 * stays, because it is the owner's configuration.
 */
export function uninstallService(project: string, host: ServiceHost = systemHost()): UninstallReport {
  checkProject(project);
  requireSystemd(host);
  const paths = servicePaths(host.home, project);
  systemctl(host, ['disable', '--now', paths.instance]);
  const wants = join(host.home, '.config', 'systemd', 'user', 'default.target.wants');
  const stillEnabled = existsSync(wants) && readdirSync(wants).some((name) => name.startsWith('operator@') && name !== paths.instance);
  let unitRemoved = false;
  if (!stillEnabled && existsSync(paths.unit)) {
    rmSync(paths.unit);
    systemctl(host, ['daemon-reload']);
    unitRemoved = true;
  }
  return { instance: paths.instance, unitRemoved, envPath: paths.env };
}

export interface StatusReport { instance: string; enabled: string; active: string; unit: boolean; env: boolean; linger: boolean }

export function serviceStatus(project: string, host: ServiceHost = systemHost()): StatusReport {
  checkProject(project);
  requireSystemd(host);
  const paths = servicePaths(host.home, project);
  const query = (verb: string): string => host.run('systemctl', ['--user', verb, paths.instance]).stdout.trim() || 'unknown';
  return {
    instance: paths.instance,
    enabled: query('is-enabled'),
    active: query('is-active'),
    unit: existsSync(paths.unit),
    env: existsSync(paths.env),
    linger: lingerEnabled(host),
  };
}
