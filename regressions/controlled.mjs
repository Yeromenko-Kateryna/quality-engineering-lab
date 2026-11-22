import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { requireValid } from '../ci/adapters.mjs';
import { hash, manifest } from '../ci/evidence.mjs';
import { validateCsp } from '../security/evidence.mjs';
import { checked, dockerVersions, fileHash, invoke, logs, readJson, references, root, sourceIdentity, utc, writeJson } from './local-evidence.mjs';

const profiles = ['baseline', 'injected', 'recovery'];
const states = ['catalogue', 'search', 'matching', 'empty', 'invalid'];
const expected = { baseline: 'PASS', injected: 'FAIL', recovery: 'PASS' };
const variants = {
  accessibility: { prefix: 'qel3', script: 'accessibility/Invoke-AccessibilityChecks.ps1', native: 'result.json',
    oracles: ['accessibility/tests/accessibility.spec.ts', 'accessibility/playwright.config.ts', 'accessibility/package-lock.json', 'accessibility/Dockerfile'],
    scenarios: ['axe-baseline', 'keyboard-baseline'], artifacts: ['result.json', 'playwright.json', 'playwright.log', 'keyboard.json',
      ...states.flatMap(state => [`state-${state}.json`, `axe-${state}.json`])] },
  security: { prefix: 'qel4', script: 'security/Invoke-SecurityChecks.ps1', native: 'http-invocation.json',
    oracles: ['security/scope.mjs', 'security/evidence.mjs'], scenarios: ['csp-baseline'],
    artifacts: ['http-invocation.json', 'http-csp.json', 'csp-result.json'] },
};

function accessibility(read, record, versions) {
  const native = read('playwright.json');
  const specs = native.suites?.flatMap(suite => suite.specs ?? []);
  const failed = states.filter(state => record.evidence?.statuses?.[state] === 'failed');
  const outcome = failed.length ? 'FAIL' : 'PASS';
  requireValid(native.errors?.length === 0 && specs?.length === 6 && native.stats?.expected === 6 - failed.length &&
    native.stats?.unexpected === failed.length && native.stats.skipped === 0 && native.stats.flaky === 0 &&
    record.nativeExit === (failed.length ? 1 : 0) && record.outcome === outcome, 'Invalid or contradictory Playwright execution');
  for (const name of [...states, 'keyboard search']) {
    const matching = specs.filter(spec => spec.title === name);
    const test = matching[0]?.tests?.[0];
    const result = test?.results?.[0];
    requireValid(matching.length === 1 && matching[0].tests.length === 1 && test.results.length === 1 &&
      result?.status === (failed.includes(name) ? 'failed' : 'passed'), `Incomplete terminal result for ${name}`);
  }
  const search = read('state-search.json');
  const named = /^\s*- searchbox "Search catalogue"\s*$/.test(search.input);
  requireValid(named || /^\s*- searchbox\s*$/.test(search.input), 'Unexpected accessible name evidence');
  const findings = [];
  for (const state of states) {
    const axe = read(`axe-${state}.json`);
    const response = read(`state-${state}.json`);
    requireValid(axe.url === response.url && response.node === versions.node && response.browser === search.browser &&
      response.status === (state === 'invalid' ? 400 : 200) && axe.testEngine?.version === versions.axe &&
      axe.passes?.length > 0 && Array.isArray(axe.violations), `Incomplete axe coverage for ${state}`);
    const blocking = axe.violations.filter(rule => ['serious', 'critical'].includes(rule.impact));
    const affected = !named && state !== 'catalogue';
    requireValid(isDeepStrictEqual(blocking.map(rule => rule.id), affected ? ['label'] : []) &&
      (!affected || blocking[0].nodes.some(node => node.target.includes('#search-term'))), `Unexpected blocking findings for ${state}`);
    if (affected) findings.push({ state, url: axe.url, rule: 'label', impact: blocking[0].impact, target: '#search-term' });
  }
  const keyboard = read('keyboard.json');
  const nameFailure = record.evidence?.failures?.some(failure =>
    failure.test === 'search' && failure.message.includes('A11Y: search input accessible name'));
  requireValid(versions.playwright && search.browser && keyboard.stops?.length === 4 && keyboard.nextTab?.focusVisible === true &&
    named === (outcome === 'PASS') && (named || (failed.length === 4 && nameFailure)),
  'Accessibility observation contradicts the native result');
  return { outcome, timestamp: native.stats.startTime, tools: { ...versions, chromium: search.browser, image: record.image },
    detail: { input: search.input, states, findings, keyboard: 'passed' } };
}

function security(read, record, versions) {
  const validated = validateCsp(read('http-csp.json'), record.nativeExit);
  requireValid(isDeepStrictEqual(validated, read('csp-result.json')), 'CSP verdict contradicts native evidence');
  const html = validated.observations.filter(row => row.contentType?.startsWith('text/html'));
  requireValid(html.length === 5 && html.some(row => row.status === 400) &&
    html.every(row => row.policies.length === (validated.outcome === 'FAIL' ? 0 : 1)) &&
    validated.observations.every(row => isDeepStrictEqual(row.xContentTypeOptions, ['nosniff'])),
  'Native HTTP evidence does not isolate the missing CSP');
  return { outcome: validated.outcome, timestamp: record.startedAt, tools: versions, detail: { html, responses: validated.observations } };
}

function indexCase(folder, dimension, run) {
  const variant = variants[dimension];
  const kind = `${variant.prefix}-${run.id}`;
  const base = `logs/${kind}`;
  const execution = run.executions[dimension];
  requireValid(execution?.command?.join(' ') === `pwsh -NoProfile -File ${variant.script} -LocalCaseRun ${run.id}` &&
    execution.exit === 0 && !execution.error, `${dimension} full runner did not verify the sequence (exit ${execution?.exit})`);
  const versions = readJson(root, `${base}/versions.json`);
  const images = readJson(folder, `${dimension}-image-layers.json`);
  const receipts = profiles.map(profile => {
    const read = name => readJson(root, `${base}/${profile}/${name}`);
    const record = read(variant.native);
    const container = record.sut;
    const network = record.network ?? record.networkId;
    const project = `${kind}-${profile}`;
    const layers = images[container?.image];
    requireValid(record.run === kind && record.project === project && record.profile === profile &&
      record.revision === run.source.testedSha && (container?.owner ?? container?.project) === project &&
      container?.health === 'healthy' && /^[a-f0-9]{64}$/.test(container.id) && /^[a-f0-9]{64}$/.test(network) &&
      layers?.length > 0, `Invalid ${dimension} ${profile} source, project or readiness provenance`);
    const observed = (dimension === 'accessibility' ? accessibility : security)(read, record, versions);
    requireValid(observed.outcome === expected[profile] && Date.parse(observed.timestamp) >= Date.parse(execution.startedAt) &&
      Date.parse(observed.timestamp) <= Date.parse(execution.finishedAt), `Unexpected ${dimension} ${profile} outcome or execution time`);
    return { profile, run: kind, project, container: container.id, network, image: container.image, layersSha256: hash(JSON.stringify(layers)),
      source: run.source, oracle: run.oracles[dimension], policy: variant.scenarios.map(id => manifest.scenarios.find(entry => entry.id === id).policy),
      configuration: { composeSha256: run.composeSha256, datasetSourceSha256: run.datasetSourceSha256, intendedState: profile },
      nativeExit: record.nativeExit, ...observed, artifacts: references(root, variant.artifacts.map(name => `${base}/${profile}/${name}`)) };
  });
  const [baseline, injected, recovery] = receipts;
  for (const key of ['container', 'network', 'project']) {
    requireValid(new Set(receipts.map(receipt => receipt[key])).size === profiles.length, `Reused ${dimension} ${key}`);
  }
  requireValid(Date.parse(baseline.timestamp) < Date.parse(injected.timestamp) && Date.parse(injected.timestamp) < Date.parse(recovery.timestamp) &&
    receipts.every(row => isDeepStrictEqual(row.tools, baseline.tools) && row.layersSha256 === baseline.layersSha256),
  `Different ${dimension} tool versions, SUT layers or profile order`);
  if (dimension === 'security') {
    const invariant = row => row.detail.responses.map(({ url, status, contentType, bodySha256 }) => ({ url, status, contentType, bodySha256 }));
    requireValid(receipts.every(row => isDeepStrictEqual(invariant(row), invariant(baseline))), 'HTTP status, media type or bodies changed across profiles');
  }
  const logs = references(root, [`${base}/execution.txt`, `${base}/versions.json`, `logs/qel6a-${run.id}/${dimension}-image-layers.json`,
    `logs/qel6a-${run.id}/${dimension}.log`]);
  return { dimension, outcome: 'PASS', execution, receipts, logs };
}

function readCases(folder, id) {
  const run = readJson(folder, 'run.json');
  requireValid(id === run.id && run.execution === 'local' && /^[a-f0-9]{40}$/.test(run.source?.testedSha) &&
    /^[a-f0-9]{64}$/.test(run.source.sourceSha256) && Object.keys(variants).every(dimension => {
      const paths = variants[dimension].oracles;
      const recorded = run.oracles[dimension];
      return isDeepStrictEqual(recorded?.map(file => file.path), paths) && recorded.every(file => /^[a-f0-9]{64}$/.test(file.sha256));
    }), 'Invalid controlled run identity');
  return { run, cases: Object.keys(variants).map(dimension => indexCase(folder, dimension, run)) };
}

function markdown(report) {
  return `# Controlled regression evidence\n\nLocal run ${report.run.id} tested ${report.run.source.testedSha} with a ${report.run.source.workingTree} worktree. [Provenance and SHA-256 receipts](evidence.json)\n` +
    report.cases.map(group => {
      const sections = group.dimension === 'accessibility' ?
        'The injected SUT removed the search input label. Playwright observed an unnamed searchbox and failed the accessible-name assertion. Axe reported `label` for `#search-term` on search, matching, empty and invalid states. The catalogue and keyboard checks passed. The fresh recovery restored `Search catalogue`. This covers the tested pages and keyboard path only.' :
        'The injected SUT omitted CSP on all five HTML states, including invalid input (HTTP 400). The independent HTTP checker failed. All eight responses retained `nosniff`, and status, content type and body SHA-256 matched across profiles. The fresh recovery restored the exact approved CSP. This covers the checked HTTP responses.';
      return `\n## ${group.dimension}\n\n${sections}\n\n` + group.receipts.map(row =>
        `- ${row.profile} **${row.outcome}**, native exit ${row.nativeExit}, project ${row.project}. [Native evidence](../../${row.artifacts[1].path})`).join('\n') +
        '\n\nThe profiles used fresh containers and internal networks, matching SUT layers, the same dataset, tool versions and unchanged oracle/policy.\n';
    }).join('');
}

function execute(id, folder) {
  mkdirSync(folder);
  const oracles = Object.fromEntries(Object.entries(variants).map(([key, variant]) =>
    [key, variant.oracles.map(path => ({ path, sha256: fileHash(path) }))]));
  const run = { id, execution: 'local', startedAt: utc(), source: sourceIdentity(),
    composeSha256: fileHash('docker-compose.yml'), datasetSourceSha256: fileHash('sut/src/app.ts'), oracles,
    tools: { ...dockerVersions(), powershell: checked('pwsh', ['--version']) }, executions: {} };
  for (const [dimension, variant] of Object.entries(variants)) {
    const result = invoke('pwsh', ['-NoProfile', '-File', variant.script, '-LocalCaseRun', id],
      { log: join(folder, `${dimension}.log`), timeout: 480_000 });
    const { command, startedAt, finishedAt, exit, error } = result;
    const execution = { command, startedAt, finishedAt, exit, error };
    run.executions[dimension] = execution;
    writeJson(join(folder, 'run.json'), run);
    requireValid(execution.exit === 0 && !execution.error && isDeepStrictEqual(run.source, sourceIdentity()),
      `${dimension} runner exited ${execution.exit} or source changed (see execution log)`);
    const images = new Set(profiles.map(profile => readJson(root, `logs/${variant.prefix}-${id}/${profile}/${variant.native}`).sut.image));
    const layers = Object.fromEntries([...images].map(image => {
      requireValid(/^sha256:[a-f0-9]{64}$/.test(image), 'Invalid SUT image identity');
      return [image, JSON.parse(checked('docker', ['image', 'inspect', '--format', '{{json .RootFS.Layers}}', image]))];
    }));
    writeJson(join(folder, `${dimension}-image-layers.json`), layers);
  }
  const report = readCases(folder, id);
  writeJson(join(folder, 'evidence.json'), report);
  writeFileSync(join(folder, 'case.md'), markdown(report));
}

try {
  const [command, existing] = process.argv.slice(2);
  requireValid(command === 'run' && !existing || command === 'verify' && /^[a-f0-9]{32}$/.test(existing ?? ''),
    'Use controlled.mjs run or controlled.mjs verify <run-id>');
  mkdirSync(logs, { recursive: true });
  const id = existing ?? randomUUID().replaceAll('-', '');
  const folder = join(logs, `qel6a-${id}`);
  console.log(`Evidence: ${folder}`);
  if (command === 'run') execute(id, folder);
  requireValid(isDeepStrictEqual(readCases(folder, id), readJson(folder, 'evidence.json')),
    'Controlled receipts or their artifact SHA-256 hashes do not match');
  console.log('PASS accessibility and security controlled regression evidence');
} catch (error) {
  console.error(`TOOL_ERROR ${error.message}`);
  process.exitCode = 2;
}
