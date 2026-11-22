import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { requireValid } from './adapters.mjs';
import { cleanupProject, localSutTag, projectResources } from './docker-cleanup.mjs';
import { createReceipts, decide, hash, parseJson, readArtifact, scenarioFiles, summarize, validateContext } from './evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const logs = join(root, 'logs');
const k6Image = 'ghcr.io/grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8';
const stages = ['performance', 'accessibility', 'security'];
const read = file => parseJson(readFileSync(file));
const write = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

function invoke(command, args, { timeout = 60_000, file, env = process.env } = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout, env,
    maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const execution = {
    command: [command, ...args], startedAt, finishedAt: new Date().toISOString(),
    state: result.error?.code === 'ETIMEDOUT' ? 'timeout' : result.error || result.signal ? 'error' : 'completed',
    code: result.status, diagnostic: result.error?.message ?? result.signal ?? null,
  };
  if (file) {
    // Child logs can include arbitrary PR text. Keep them out of workflow command parsing.
    appendFileSync(file, JSON.stringify(execution) + '\n' + (result.stdout ?? '') + (result.stderr ?? '') + '\n');
  }
  return { ...execution, stdout: result.stdout?.trim() ?? '' };
}

function checked(command, args, options) {
  const result = invoke(command, args, options);
  requireValid(result.state === 'completed' && result.code === 0,
    `${command} ${args[0]} failed (${result.state}, exit ${result.code}): ${result.diagnostic ?? 'see execution log'}`);
  return result.stdout;
}

function sourceIdentity() {
  const names = checked('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  return {
    testedSha: checked('git', ['rev-parse', 'HEAD']),
    workingTree: checked('git', ['status', '--porcelain=v1']) ? 'dirty' : 'clean',
    sourceSha256: hash([...new Set(names)].sort().map(name => {
      const file = join(root, name);
      const info = lstatOrMissing(file);
      if (!info) return JSON.stringify([name, null]);
      return JSON.stringify([name, info.isSymbolicLink() ? hash(readlinkSync(file)) : hash(readFileSync(file))]);
    }).join('\n')),
    lockSha256: hash(readFileSync(join(root, 'sut/package-lock.json'))),
  };
}

function lstatOrMissing(path) {
  try { return lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function identify(localProfile) {
  if (localProfile) {
    requireValid(['pr', 'main'].includes(localProfile), 'Use local pr or local main');
    const namespace = randomUUID().replaceAll('-', '');
    return { namespace, profile: localProfile, execution: 'local', runId: `local-${namespace}`,
      attempt: 1, eventSha: null, prHeadSha: null };
  }
  const { GITHUB_ACTIONS, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_SHA, GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT, GITHUB_JOB, GITHUB_REPOSITORY, GITHUB_REF } = process.env;
  const profile = GITHUB_EVENT_NAME === 'pull_request' ? 'pr' : GITHUB_EVENT_NAME === 'push' && GITHUB_REF === 'refs/heads/main' ? 'main' : null;
  requireValid(GITHUB_ACTIONS === 'true' && profile && /^\d{1,20}$/.test(GITHUB_RUN_ID ?? '') &&
    /^[1-9]\d{0,8}$/.test(GITHUB_RUN_ATTEMPT ?? '') && /^[a-z0-9_-]{1,40}$/.test(GITHUB_JOB ?? ''),
  'Missing or unsupported GitHub run context');
  const namespace = hash(JSON.stringify([GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_JOB, profile])).slice(0, 32);
  return { namespace, profile, execution: 'github-hosted', runId: GITHUB_RUN_ID, attempt: Number(GITHUB_RUN_ATTEMPT),
    eventSha: GITHUB_SHA, prHeadSha: profile === 'pr' ? read(GITHUB_EVENT_PATH).pull_request?.head?.sha : null,
    repository: GITHUB_REPOSITORY, job: GITHUB_JOB };
}

function layout(identity) {
  const dir = join(logs, `qel5-${identity.namespace}`);
  return { dir, bundle: join(dir, 'bundle'), context: join(dir, 'bundle/context.json'),
    executions: join(dir, 'bundle/executions.json'), owned: join(dir, 'owned.json') };
}

function projectIds(namespace) {
  return { performance: `qel2-${namespace}`, accessibility: `qel3-${namespace}-baseline`, security: `qel4-${namespace}-baseline` };
}

function dockerList(args, file) {
  return checked('docker', args, { file }).split(/\r?\n/).filter(Boolean);
}

function portabilityEnv() {
  return { ...process.env, ...Object.fromEntries(['LAB_DELAY_MS', 'LAB_A11Y_DEFECT', 'LAB_SECURITY_DEFECT'].map((name, i) =>
    [name, i === 0 ? '0' : 'false'])) };
}

function stageFile(bundle, stage, name) {
  return join(bundle, 'native', stage, name);
}

function executePerformance(project, bundle, file) {
  const options = { file, timeout: 180_000, env: portabilityEnv() };
  checked('docker', ['pull', k6Image], options);
  const k6Version = checked('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', k6Image, 'version'], options);
  writeFileSync(stageFile(bundle, 'performance', 'version.txt'), k6Version + '\n');
  checked('docker', ['compose', '-p', project, 'build', 'sut'], options);
  checked('docker', ['compose', '-p', project, 'up', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '20', 'sut'], options);
  const sut = checked('docker', ['compose', '-p', project, 'ps', '-q', 'sut'], options);
  requireValid(/^[a-f0-9]{12,64}$/.test(sut), 'Expected one lab SUT');
  const health = JSON.parse(checked('docker', ['inspect', '--format', '{{json .State.Health}}', sut], options));
  requireValid(health.Status === 'healthy', 'SUT did not reach healthy readiness');
  write(stageFile(bundle, 'performance', 'readiness.json'), health);
  return invoke('pwsh', ['-NoProfile', '-File', 'performance/Invoke-SearchSmoke.ps1', '-Project', project, '-Query', 'notebook'], options);
}

function stageSources(context, stage, project) {
  if (stage === 'performance') {
    const candidates = existsSync(join(logs, project)) ? readdirSync(join(logs, project)).filter(name => /^notebook-[a-f0-9]{32}$/.test(name)) : [];
    requireValid(candidates.length <= 1, 'Ambiguous k6 result directories');
    return candidates.length ? `${project}/${candidates[0]}` : null;
  }
  return `${stage === 'accessibility' ? 'qel3' : 'qel4'}-${context.namespace}`;
}

function collect(context, paths, stage, project) {
  const source = stageSources(context, stage, project);
  if (!source) return;
  const names = stage === 'performance' ? scenarioFiles.search_smoke.filter(name => !['readiness.json', 'version.txt'].includes(name)) :
    stage === 'accessibility' ? [...new Set([...scenarioFiles['axe-baseline'], ...scenarioFiles['keyboard-baseline']])] :
      [...new Set([...scenarioFiles['csp-baseline'], ...scenarioFiles['npm-audit'],
        ...(context.profile === 'main' ? scenarioFiles['zap-baseline'] : []), 'baseline/zap-error.json', 'baseline/zap-not-run.json'])];
  for (const name of names) {
    let bytes;
    try { bytes = readArtifact(logs, `${source}/${name}`); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const dest = stageFile(paths.bundle, stage, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  }
}

function execute(identity) {
  mkdirSync(logs, { recursive: true });
  requireValid(!lstatSync(logs).isSymbolicLink(), 'Output root must not be a symlink');
  const paths = layout(identity);
  mkdirSync(paths.dir);
  mkdirSync(paths.bundle);
  if (identity.execution === 'github-hosted') appendFileSync(process.env.GITHUB_OUTPUT, `bundle=${paths.bundle}\nnamespace=${identity.namespace}\n`);

  const setupLog = join(paths.bundle, 'setup.log');
  const context = { ...identity, ...sourceIdentity(), startedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.version } };
  validateContext(context);
  write(paths.context, context);
  const executions = {};
  const projects = projectIds(context.namespace);
  try {
    for (const [key, command, args] of [
      ['powershell', 'pwsh', ['--version']],
      ['docker', 'docker', ['version', '--format', '{{.Client.Version}} / {{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}']],
      ['compose', 'docker', ['compose', 'version', '--short']],
    ]) {
      context.environment[key] = checked(command, args, { file: setupLog });
    }
    write(paths.context, context);
    checked('docker', ['compose', 'config', '--quiet'], { file: setupLog, env: portabilityEnv() });
    executions.setup = invoke(process.execPath, ['--test', 'ci/contracts.test.mjs'], { file: setupLog });
  } catch (error) {
    executions.setup = { state: 'error', diagnostic: error.message, code: null };
  }
  delete executions.setup.stdout;
  write(paths.executions, executions);
  const owned = [];
  for (const stage of stages) {
    const project = projects[stage];
    const dir = join(paths.bundle, 'native', stage);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'stage.log');
    if (executions.setup.state !== 'completed' || executions.setup.code !== 0) {
      executions[stage] = { state: 'not_run', diagnostic: 'Configuration or contract test prerequisite failed' };
    } else {
      try {
        const docker = args => checked('docker', args, { file });
        requireValid(Object.values(projectResources(project, docker)).every(ids => ids.length === 0) && !localSutTag(project, docker), `Compose project is already in use: ${project}`);
        const expectedOutput = join(logs, stage === 'performance' ? project :
          `${stage === 'accessibility' ? 'qel3' : 'qel4'}-${context.namespace}`);
        requireValid(!lstatOrMissing(expectedOutput), 'Native output directory is already in use');
        owned.push(stage);
        write(paths.owned, owned);
        executions[stage] = stage === 'performance' ? executePerformance(project, paths.bundle, file) :
          invoke('pwsh', ['-NoProfile', '-File', stage === 'accessibility' ? 'accessibility/Invoke-AccessibilityChecks.ps1' : 'security/Invoke-SecurityChecks.ps1',
            '-CiRun', context.namespace, ...(stage === 'security' ? ['-CiProfile', context.profile] : [])],
          { file, timeout: 360_000, env: portabilityEnv() });
      } catch (error) {
        executions[stage] = { state: 'error', diagnostic: error.message, code: null };
      }
      delete executions[stage].stdout;
      write(paths.executions, executions);
      try { if (owned.includes(stage)) collect(context, paths, stage, project); }
      catch (error) { executions[stage] = { ...executions[stage], state: 'error', diagnostic: error.message }; }
    }
    console.log(`${stage}: ${executions[stage].state}; wrapper exit ${executions[stage].code ?? 'unavailable'}`);
    write(paths.executions, executions);
  }
  console.log(`Evidence: ${paths.bundle}`);
}

function cleanup(context, paths) {
  const file = join(paths.bundle, 'cleanup.log');
  const owned = existsSync(paths.owned) ? read(paths.owned) : [];
  requireValid(Array.isArray(owned) && owned.every(stage => stages.includes(stage)) && new Set(owned).size === owned.length, 'Invalid cleanup ownership record');
  for (const stage of owned) {
    const project = projectIds(context.namespace)[stage];
    const docker = args => checked('docker', args, { file, env: portabilityEnv() });
    const tag = cleanupProject({ project, stage, checkout: [root.slice(0, -1), root] }, docker);
    appendFileSync(file, `${project}: containers and networks removed; local SUT tag ${tag ? `retained (${tag})` : 'absent'}\n`);
    if (stage === 'accessibility') {
      const tag = `qel3-${context.namespace}-browser`;
      if (dockerList(['image', 'ls', '-q', '--filter', `reference=${tag}`], file).length) {
        const labels = dockerJson(['image', 'inspect', '--format', '{{json .Config.Labels}}', tag], file);
        requireValid(labels?.['qel.run'] === `qel3-${context.namespace}`, 'Unowned browser image tag');
        checked('docker', ['image', 'rm', tag], { file });
      }
    }
  }
}

function dockerJson(args, file) {
  return JSON.parse(checked('docker', args, { file }));
}

function loadContext(identity, paths) {
  const context = read(paths.context);
  validateContext(context);
  requireValid(Object.entries(identity).every(([key, value]) => context[key] === value), 'Run provenance changed');
  return context;
}

function prepare(identity) {
  const paths = layout(identity);
  const context = loadContext(identity, paths);
  const executions = existsSync(paths.executions) ? read(paths.executions) : {};
  try {
    cleanup(context, paths);
    executions.cleanup = { state: 'completed', code: 0, finishedAt: new Date().toISOString() };
  } catch (error) {
    executions.cleanup = { state: 'error', code: null, diagnostic: error.message, finishedAt: new Date().toISOString() };
  }
  if (!Object.entries(sourceIdentity()).every(([key, value]) => context[key] === value)) {
    executions.setup = { state: 'error', diagnostic: 'The tested source changed during execution' };
  }
  write(paths.executions, executions);
  const receipts = createReceipts(context, executions, paths.bundle);
  const receiptDir = join(paths.bundle, 'receipts');
  mkdirSync(receiptDir);
  for (const receipt of receipts) write(join(receiptDir, `${receipt.scenario}.json`), receipt);
  const preliminary = summarize(context, executions, paths.bundle, receipts);
  write(join(paths.bundle, 'preliminary.json'), preliminary);
  console.log(JSON.stringify(preliminary, null, 2));
  return preliminary;
}

function finish(identity) {
  const paths = layout(identity);
  const context = loadContext(identity, paths);
  requireValid(Object.entries(sourceIdentity()).every(([key, value]) => context[key] === value), 'The tested source changed before the final decision');
  const executions = read(paths.executions);
  const receiptDir = join(paths.bundle, 'receipts');
  const receipts = readdirSync(receiptDir).map(name => parseJson(readArtifact(paths.bundle, `receipts/${name}`)));
  const preliminary = summarize(context, executions, paths.bundle, receipts);
  requireValid(isDeepStrictEqual(preliminary, read(join(paths.bundle, 'preliminary.json'))), 'Published preliminary evidence changed before gate evaluation');
  const decision = decide(preliminary, {
    outcome: process.env.QEL_UPLOAD_OUTCOME, id: process.env.QEL_ARTIFACT_ID, url: process.env.QEL_ARTIFACT_URL,
  });
  write(join(paths.dir, 'final.json'), decision);
  console.log(JSON.stringify(decision, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const publication = decision.publication;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CI-G01 — ${decision.outcome}\n\nTested revision \`${context.testedSha}\`\n\n` +
      (publication.url ? `Artifact ${publication.id} · ${publication.url}\n\n` : `Publication ${publication.outcome}\n\n`) +
      Object.entries(decision.required).map(([id, state]) => `- ${id} · ${state}\n`).join(''));
  }
  return decision;
}

try {
  const [, , command, profile] = process.argv;
  if (command === 'local') {
    const identity = identify(profile);
    requireValid(identity.execution === 'local', 'Supply local pr or local main');
    execute(identity);
    const preliminary = prepare(identity);
    finish(identity);
    process.exitCode = preliminary.outcome === 'PASS' ? 0 : 1;
  } else {
    const identity = identify();
    if (command === 'run') execute(identity);
    else if (command === 'prepare') prepare(identity);
    else if (command === 'decide') process.exitCode = finish(identity).outcome === 'PASS' ? 0 : 1;
    else throw new Error('Use local pr or local main, or the hosted workflow entry points');
  }
} catch (error) {
  console.error(`CI-G01 TOOL_ERROR: ${error.message}`);
  process.exitCode = 1;
}
