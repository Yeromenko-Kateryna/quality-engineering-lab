import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { requireValid } from '../ci/adapters.mjs';
import { cleanupProject, localSutTag, projectResources } from '../ci/docker-cleanup.mjs';
import { hash, readArtifact } from '../ci/evidence.mjs';
import { dockerVersions, fileHash, invoke, logs, readJson, references, root, sourceIdentity, utc, writeJson } from '../regressions/local-evidence.mjs';
import { assessCalibration } from './calibration-evidence.mjs';
import { k6Image, workload } from './calibration-profile.mjs';

const repetitions = 3;
const safeSutEnv = { ...process.env, LAB_DELAY_MS: '0', LAB_A11Y_DEFECT: 'false', LAB_SECURITY_DEFECT: 'false' };
const runnerLimits = { NanoCpus: 1_000_000_000, Memory: 268_435_456, PidsLimit: 128 };
const limits = config => Object.fromEntries(['NanoCpus', 'Memory', 'PidsLimit', 'CpusetCpus', 'CpuShares', 'MemorySwap']
  .map(key => [key, config[key] ?? null]));

function driver(file) {
  function run(args, timeout = 60_000) {
    const result = invoke('docker', args, { timeout, env: safeSutEnv });
    const { stdout, stderr, ...execution } = result;
    appendFileSync(file, JSON.stringify(execution) + '\n' + stdout + '\n' + stderr + '\n');
    return result;
  }
  function docker(args, timeout) {
    const result = run(args, timeout);
    requireValid(result.exit === 0 && !result.error, `docker ${args[0]} exited ${result.exit}: ${result.error ?? 'see stage log'}`);
    return result.stdout;
  }
  return { run, docker };
}

function dockerJson(docker, args) {
  return JSON.parse(docker(args));
}

function verifyNewProject(project, docker) {
  const resources = projectResources(project, docker);
  requireValid(!resources.containers.length && !resources.networks.length && !localSutTag(project, docker), `Project ${project} is already in use`);
}

function inventory(docker) {
  return docker(['ps', '--no-trunc', '--format', '{{.ID}} {{.Image}}']).split(/\r?\n/).filter(Boolean).sort();
}

function executeSample(folder, batch, id) {
  const output = join(folder, id);
  mkdirSync(output);
  const { docker, run } = driver(join(output, 'docker.log'));
  const record = { id, source: batch.source, workload: batch.workload, workloadSha256: batch.workloadSha256,
    composeSha256: batch.composeSha256, runner: batch.runner, startedAt: utc(), cleanup: 'TOOL_ERROR' };
  let runner;
  let ownedProject = false;
  try {
    requireValid(!docker(['ps', '-q', '--filter', `ancestor=${k6Image}`]), 'Another pinned k6 workload is already running');
    record.unrelatedBefore = inventory(docker);
    ownedProject = true;
    docker(['compose', '-p', id, 'up', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '20', 'sut']);
    const sut = docker(['compose', '-p', id, 'ps', '-q', 'sut']);
    requireValid(/^[a-f0-9]{64}$/.test(sut), 'Expected one healthy SUT container');
    const identity = dockerJson(docker, ['inspect', '--format',
      '{"image":{{json .Image}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"health":{{json .State.Health.Status}}}', sut]);
    const host = dockerJson(docker, ['inspect', '--format', '{{json .HostConfig}}', sut]);
    const net = dockerJson(docker, ['network', 'inspect', '--format', '{{json .}}', `${id}_lab`]);
    requireValid(identity.image === batch.sut.image && identity.project === id && identity.health === 'healthy' &&
      net.Internal && net.Labels?.['com.docker.compose.project'] === id && net.Labels['com.docker.compose.network'] === 'lab' &&
      Object.keys(net.Containers ?? {}).length === 1 && net.Containers[sut] && !Object.keys(host.PortBindings ?? {}).length,
    'SUT identity, readiness or isolation mismatch');
    record.sut = { ...identity, datasetSha256: batch.sut.datasetSha256, container: sut };
    record.network = { id: net.Id, internal: net.Internal };

    runner = docker(['create', '--pull', 'never', '--name', `${id}-k6`, '--network', net.Id,
      '--label', `com.docker.compose.project=${id}`, '--label', `qel.calibration=${id}`, '--cpus', '1', '--memory', '256m', '--pids-limit', '128',
      ...(process.getuid ? ['--user', `${process.getuid()}:${process.getgid()}`] : []),
      '--mount', `type=bind,source=${join(root, 'performance')},target=/scripts,readonly`,
      '--mount', `type=bind,source=${output},target=/reports`,
      k6Image, 'run', '--quiet', '--no-color', '--no-usage-report', '--env', `QEL_SAMPLE_ID=${id}`,
      '--out', 'json=/reports/samples.ndjson', '/scripts/search-calibration.js']);
    requireValid(/^[a-f0-9]{64}$/.test(runner), 'Expected one task-owned k6 container');
    const runnerHost = dockerJson(docker, ['inspect', '--format', '{{json .HostConfig}}', runner]);
    const runnerImage = docker(['inspect', '--format', '{{.Image}}', runner]);
    requireValid(runnerHost.NetworkMode === net.Id && !Object.keys(runnerHost.PortBindings ?? {}).length &&
      runnerImage === batch.k6.imageId && Object.entries(runnerLimits).every(([name, value]) => runnerHost[name] === value),
    'Unexpected k6 isolation, image or resource limits');
    record.k6Container = runner;
    record.k6 = batch.k6;
    record.resources = { sut: limits(host), k6: limits(runnerHost) };
    batch.resources ??= record.resources;
    requireValid(isDeepStrictEqual(record.resources, batch.resources), 'Resource limits changed across baseline samples');

    const execution = run(['start', '--attach', runner], 65_000);
    const state = dockerJson(docker, ['inspect', '--format', '{{json .State}}', runner]);
    const others = docker(['ps', '-q', '--filter', `ancestor=${k6Image}`]);
    requireValid(!others && !execution.error && state.Status === 'exited', 'k6 execution was interrupted or another pinned k6 workload was detected');
    record.nativeExit = state.ExitCode;
    record.clientExit = execution.exit;
    record.oomKilled = state.OOMKilled;
  } finally {
    try {
      if (runner && /^[a-f0-9]{64}$/.test(runner)) {
        const labels = dockerJson(docker, ['inspect', '--format', '{{json .Config.Labels}}', runner]);
        requireValid(labels?.['qel.calibration'] === id && labels['com.docker.compose.project'] === id, 'Unable to verify k6 container ownership');
        docker(['rm', '-f', runner]);
      }
      if (ownedProject) cleanupProject({ project: id, stage: 'performance', checkout: [root, root.slice(0, -1)] }, docker);
      record.cleanup = 'PASS';
      record.unrelatedAfter = inventory(docker);
    } finally {
      record.finishedAt = utc();
      writeJson(join(output, 'record.json'), record);
    }
  }
  console.log(`${id}: native k6 exit ${record.nativeExit}, scoped cleanup ${record.cleanup}`);
}

function verify(folder, id) {
  const batch = readJson(folder, 'batch.json');
  requireValid(batch.id === id && batch.samples.length === repetitions, 'The three required baseline measurements were not executed');
  return assessCalibration(batch, sample => ({ record: readJson(folder, `${sample}/record.json`),
    summary: readJson(folder, `${sample}/summary.json`), raw: readArtifact(folder, `${sample}/samples.ndjson`).toString('utf8'),
    artifacts: references(folder, ['record.json', 'summary.json', 'samples.ndjson', 'docker.log'].map(name => `${sample}/${name}`)) }));
}

function execute(folder, id) {
  const lock = join(logs, 'qel6b.lock');
  const fd = openSync(lock, 'wx');
  try {
    mkdirSync(folder);
    const { docker } = driver(join(folder, 'setup.log'));
    const source = sourceIdentity();
    const ids = Array.from({ length: repetitions }, (_, index) => `qel6b-${id}-${index + 1}`);
    for (const project of ids) verifyNewProject(project, docker);
    docker(['pull', k6Image], 180_000);
    const version = docker(['run', '--rm', '--pull', 'never', '--network', 'none', k6Image, 'version']);
    requireValid(/^k6 v2\.3\.0\b/.test(version), 'Unexpected k6 version');
    const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', k6Image]);
    const tag = project => `${project}-sut:latest`;
    docker(['build', '--tag', tag(ids[0]), 'sut'], 180_000);
    const image = docker(['image', 'inspect', '--format', '{{.Id}}', tag(ids[0])]);
    for (const project of ids.slice(1)) docker(['image', 'tag', image, tag(project)]);
    const capacity = dockerJson(docker, ['info', '--format', '{"cpus":{{json .NCPU}},"memoryBytes":{{json .MemTotal}},"system":{{json .OperatingSystem}}}']);
    const batch = { id, startedAt: utc(), execution: 'local', source, workload,
      workloadSha256: hash(JSON.stringify(['performance/search-calibration.js', 'performance/calibration-profile.mjs'].map(fileHash))),
      composeSha256: fileHash('docker-compose.yml'),
      runner: { class: 'local-docker', ...dockerVersions(), capacity },
      k6: { image: k6Image, version, imageId }, sut: { image, datasetSha256: fileHash('sut/src/app.ts') }, samples: [] };
    writeJson(join(folder, 'batch.json'), batch);
    for (const project of ids) {
      executeSample(folder, batch, project);
      requireValid(isDeepStrictEqual(source, sourceIdentity()), 'Source changed during the calibration');
      batch.samples.push(project);
      writeJson(join(folder, 'batch.json'), batch);
    }
    writeJson(join(folder, 'decision.json'), verify(folder, id));
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

try {
  const [command, existing] = process.argv.slice(2);
  requireValid(command === 'run' && !existing || command === 'verify' && /^[a-f0-9]{32}$/.test(existing ?? ''),
    'Use calibrate.mjs run or calibrate.mjs verify <run-id>');
  mkdirSync(logs, { recursive: true });
  const id = existing ?? randomUUID().replaceAll('-', '');
  const folder = join(logs, `qel6b-${id}`);
  console.log(`Evidence: ${folder}`);
  if (command === 'run') execute(folder, id);
  const decision = verify(folder, id);
  requireValid(isDeepStrictEqual(decision, readJson(folder, 'decision.json')), 'Calibration decision or artifact SHA-256 hashes do not match');
  console.log(`${decision.outcome} ${decision.diagnostic ?? decision.reasons.map(reason => reason.code).join(', ')}`);
  process.exitCode = decision.outcome === 'TOOL_ERROR' ? 2 : 0;
} catch (error) {
  console.error(`TOOL_ERROR ${error.message}`);
  process.exitCode = 2;
}
