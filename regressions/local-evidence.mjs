import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireValid } from '../ci/adapters.mjs';
import { hash, parseJson, readArtifact } from '../ci/evidence.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const logs = join(root, 'logs');
export const utc = () => new Date().toISOString();
export const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

export function invoke(command, args, { log, timeout = 60_000, env = process.env } = {}) {
  const startedAt = utc();
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const execution = { command: [command, ...args], startedAt, finishedAt: utc(), exit: result.status,
    error: result.error?.message ?? result.signal ?? null };
  if (log) writeFileSync(log, JSON.stringify(execution) + '\n' + (result.stdout ?? '') + (result.stderr ?? ''));
  return { ...execution, stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '' };
}

export function checked(command, args, options) {
  const result = invoke(command, args, options);
  requireValid(result.exit === 0 && !result.error, `${command} ${args[0]} exited ${result.exit}: ${result.error ?? 'command failed'}`);
  return result.stdout;
}

export function sourceIdentity() {
  const names = checked('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const rows = [...new Set(names)].sort().map(name => {
    const path = join(root, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    return JSON.stringify([name, stat ? hash(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path)) : null]);
  });
  return { testedSha: checked('git', ['rev-parse', 'HEAD']),
    workingTree: checked('git', ['status', '--porcelain=v1']) ? 'dirty' : 'clean', sourceSha256: hash(rows.join('\n')) };
}

export const fileHash = path => hash(readFileSync(join(root, path)));
export const version = (command, args) => checked(command, args);
export const readJson = (folder, name) => parseJson(readArtifact(folder, name));
export const references = (folder, paths) => paths.map(path => ({ path, sha256: hash(readArtifact(folder, path)) }));

export function dockerVersions() {
  return { node: process.version, host: `${process.platform}/${process.arch}`,
    docker: version('docker', ['version', '--format', '{{.Client.Version}} / {{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}']),
    compose: version('docker', ['compose', 'version', '--short']) };
}
