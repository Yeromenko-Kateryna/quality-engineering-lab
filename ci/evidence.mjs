import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { classify, nativeRecords, requireValid } from './adapters.mjs';

export const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
export const order = ['FAIL', 'TOOL_ERROR', 'INCONCLUSIVE', 'NOT_RUN', 'PASS'];
const states = ['catalogue', 'search', 'matching', 'empty', 'invalid'];
const axeFiles = states.flatMap(name => [`baseline/axe-${name}.json`, `baseline/state-${name}.json`]);
const accessibilityFiles = ['execution.txt', 'versions.json', 'baseline/result.json', 'baseline/playwright.json', 'baseline/playwright.log'];
const zapFiles = [
  'baseline/zap.json', 'baseline/zap.log', 'baseline/zap-process.json', 'baseline/zap-result.json',
  'baseline/gateway.jsonl', 'baseline/reachable-before.json', 'baseline/direct-blocked.json', 'baseline/reachable-after.json',
];
export const scenarioFiles = {
  search_smoke: ['result.json', 'invocation.json', 'summary.json', 'k6.log', 'readiness.json', 'version.txt'],
  'axe-baseline': [...accessibilityFiles, ...axeFiles],
  'keyboard-baseline': [...accessibilityFiles, 'baseline/state-search.json', 'baseline/keyboard.json'],
  'csp-baseline': ['execution.txt', 'scope-tests.txt', 'versions.json', 'baseline/http-invocation.json', 'baseline/http-csp.json', 'baseline/csp-result.json'],
  'zap-baseline': ['execution.txt', 'scope-tests.txt', 'baseline/zap-not-run.json', ...zapFiles],
  'npm-audit': ['execution.txt', 'versions.json', 'npm-audit-invocation.json', 'npm-audit.json', 'npm-audit.json.stderr', 'npm-audit-result.json'],
  'latency-comparison': ['latency-diagnostic.json'],
};
const sha = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const parseJson = bytes => JSON.parse(bytes.toString().replace(/^\uFEFF/, ''));

export function validateManifest() {
  requireValid(manifest.version === 1 && manifest.publicationPolicy === 'CI-G01', 'Unsupported manifest');
  const ids = new Set();
  for (const entry of manifest.scenarios) {
    requireValid(Object.hasOwn(scenarioFiles, entry.id) && !ids.has(entry.id) &&
      ['performance', 'accessibility', 'security'].includes(entry.stage) &&
      ['PERF-G01', 'PERF-G02', 'A11Y-G01', 'A11Y-G02', 'SEC-G01', 'DEP-G01'].includes(entry.policy) &&
      ['performance', 'accessibility', 'security', 'dependencies'].includes(entry.dimension) &&
      ['required', 'optional', 'absent'].includes(entry.pr) &&
      ['required', 'optional'].includes(entry.main), 'Invalid scenario assignment');
    ids.add(entry.id);
  }
  requireValid(ids.size === Object.keys(nativeRecords).length + 1 && manifest.scenarios.every(entry =>
    entry.id === 'latency-comparison' ? entry.pr === 'optional' && entry.main === 'optional' :
      entry.main === 'required' && entry.pr === (entry.id === 'zap-baseline' ? 'absent' : 'required')),
  'Manifest misses a required PR or main scenario');
}

export function validateContext(context) {
  requireValid(['pr', 'main'].includes(context.profile) && sha.test(context.testedSha) &&
    /^[a-f0-9]{32}$/.test(context.namespace) && sha256.test(context.sourceSha256) && sha256.test(context.lockSha256) &&
    ['clean', 'dirty'].includes(context.workingTree) && Number.isInteger(context.attempt) && context.attempt > 0 &&
    !Number.isNaN(Date.parse(context.startedAt)) && context.environment?.platform && context.environment?.arch &&
    context.environment?.node, 'Invalid execution provenance');
  if (context.execution === 'github-hosted') {
    requireValid(/^\d{1,20}$/.test(context.runId) && /^[\w.-]+\/[\w.-]+$/.test(context.repository) &&
      /^[a-z0-9_-]{1,40}$/.test(context.job) && sha.test(context.eventSha) && context.workingTree === 'clean' &&
      (context.profile === 'pr' ? sha.test(context.prHeadSha) : context.prHeadSha === null),
    'Invalid hosted execution provenance');
  } else {
    requireValid(context.execution === 'local' && context.runId === `local-${context.namespace}` && context.attempt === 1 &&
      context.eventSha === null && context.prHeadSha === null, 'Invalid local execution provenance');
  }
}

export function readArtifact(bundle, path) {
  // Callers supply fixed manifest paths only. Never follow an artifact symlink.
  let resolved = bundle;
  for (const part of path.split('/')) {
    requireValid(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part), 'Invalid artifact path');
    resolved = join(resolved, part);
    requireValid(!lstatSync(resolved).isSymbolicLink(), 'Artifact path contains a symlink');
  }
  const stats = lstatSync(resolved);
  requireValid(stats.isFile() && stats.size <= 16 * 1024 * 1024, 'Artifact is not a bounded regular file');
  return readFileSync(resolved);
}

function scenarioReceipt(context, entry, executions, bundle) {
  const mode = entry[context.profile];
  const execution = executions[entry.stage];
  const available = new Map();
  let measuredAt = null;
  const files = {
    text(name) {
      const bytes = available.get(name)?.bytes;
      requireValid(bytes?.length > 0, `Missing or empty mandatory artifact: ${name}`);
      return bytes.toString();
    },
    json(name) { return parseJson(this.text(name)); },
  };
  let decision;
  const skip = reason => ({
    outcome: 'NOT_RUN', nativeExit: null, tools: {}, details: {},
    validation: { valid: false, diagnostic: reason },
  });
  if (mode === 'absent') {
    decision = skip('Passive ZAP is intentionally absent from the PR manifest');
  } else if (mode === 'optional' && !executions.diagnostic) {
    decision = skip('No calibrated PERF-G02 policy or comparison was executed');
  } else if (mode === 'required' && execution?.state === 'not_run') {
    decision = skip(execution.diagnostic);
  } else {
    for (const name of scenarioFiles[entry.id]) {
      const path = `native/${entry.stage}/${name}`;
      try {
        const bytes = readArtifact(bundle, path);
        if (bytes.length) available.set(name, { bytes, reference: { path, sha256: hash(bytes), size: bytes.length } });
      } catch {
        // The adapter requires the applicable files. A missing file is never PASS.
      }
    }
    if (mode === 'optional') {
      const diagnostic = executions.diagnostic;
      measuredAt = diagnostic.finishedAt;
      try {
        const comparison = files.json('latency-diagnostic.json');
        requireValid(diagnostic.state === 'completed' && diagnostic.code === 0 &&
          Array.isArray(comparison.samplesMs) && comparison.samplesMs.length > 0 &&
          comparison.samplesMs.every(value => Number.isFinite(value) && value >= 0) &&
          typeof comparison.reason === 'string' && comparison.reason.length > 0,
        'No completed optional diagnostic evidence');
        decision = { outcome: 'INCONCLUSIVE', nativeExit: diagnostic.code, tools: {}, details: { samples: comparison.samplesMs.length },
          validation: { valid: true, diagnostic: comparison.reason } };
      } catch (error) {
        decision = { ...skip(error.message), outcome: 'TOOL_ERROR' };
      }
    } else {
      measuredAt = execution?.finishedAt ?? null;
      if (entry.id === 'zap-baseline' && execution?.state === 'completed' && available.has('baseline/zap-not-run.json')) {
        const skipped = files.json('baseline/zap-not-run.json');
        const cspDecision = scenarioReceipt(context, manifest.scenarios.find(item => item.id === 'csp-baseline'), executions, bundle);
        decision = skipped.reason === 'CSP baseline did not pass' && cspDecision.outcome !== 'PASS' &&
          !available.has('baseline/zap-process.json') ? skip(skipped.reason) :
          { ...skip('Contradictory ZAP skip evidence'), outcome: 'TOOL_ERROR' };
        measuredAt = null;
      } else {
        decision = classify(entry, files, context, execution);
      }
      if (decision.outcome === 'PASS') {
        const missing = scenarioFiles[entry.id].filter(name => !available.has(name) &&
          !['npm-audit.json.stderr', 'baseline/zap-not-run.json'].includes(name));
        if (missing.length) {
          decision.outcome = 'TOOL_ERROR';
          decision.validation = { valid: false, diagnostic: `Missing mandatory artifacts: ${missing.join(', ')}` };
        }
      }
    }
  }
  return {
    schemaVersion: 1, manifestVersion: manifest.version, scenario: entry.id, dimension: entry.dimension,
    policy: { id: entry.policy, version: 'v0.2' }, qualification: mode,
    provenance: context, measuredAt, ...decision, artifacts: [...available.values()].map(value => value.reference),
  };
}

export function createReceipts(context, executions, bundle) {
  validateManifest();
  validateContext(context);
  return manifest.scenarios.map(entry => scenarioReceipt(context, entry, executions, bundle));
}

export function summarize(context, executions, bundle, receipts) {
  const canonical = createReceipts(context, executions, bundle);
  const diagnostics = [];
  const seen = new Map();
  for (const receipt of receipts) {
    if (seen.has(receipt?.scenario)) diagnostics.push(`Duplicate receipt: ${receipt.scenario}`);
    else seen.set(receipt?.scenario, receipt);
  }
  const required = {};
  const optional = {};
  for (const expected of canonical) {
    const actual = seen.get(expected.scenario);
    const valid = isDeepStrictEqual(expected, actual);
    if (!valid) diagnostics.push(`Missing or inconsistent receipt: ${expected.scenario}`);
    const states = expected.qualification === 'required' ? required : optional;
    states[expected.scenario] = valid ? expected.outcome : 'TOOL_ERROR';
    seen.delete(expected.scenario);
  }
  for (const name of seen.keys()) diagnostics.push(`Unapproved scenario or receipt: ${name}`);
  if (executions.setup?.state !== 'completed' || executions.setup?.code !== 0) diagnostics.push('Configuration or contract tests failed');
  if (executions.cleanup?.state !== 'completed' || executions.cleanup?.code !== 0) diagnostics.push('Scoped Docker cleanup was not verified');
  for (const stage of ['performance', 'accessibility', 'security']) {
    const stageOutcomes = manifest.scenarios.filter(entry => entry.stage === stage && entry[context.profile] === 'required')
      .map(entry => required[entry.id]);
    const execution = executions[stage];
    if (execution?.state === 'completed' && stageOutcomes.every(outcome => ['PASS', 'FAIL', 'INCONCLUSIVE'].includes(outcome))) {
      const expectedExit = stageOutcomes.every(outcome => outcome === 'PASS') ? 0 : 1;
      if (execution.code !== expectedExit) diagnostics.push(`Wrapper exit contradicts validated scenarios: ${stage}`);
    }
  }
  const localValidation = diagnostics.length ? 'TOOL_ERROR' : 'PASS';
  return { manifestVersion: manifest.version, context, required, optional, diagnostics, localValidation,
    outcome: aggregate([...Object.values(required), localValidation]) };
}

export function aggregate(outcomes) {
  requireValid(outcomes.length > 0 && outcomes.every(outcome => order.includes(outcome)), 'Unknown or empty result states');
  return order.find(outcome => outcomes.includes(outcome));
}

export function decide(preliminary, upload) {
  const { context } = preliminary;
  let publication;
  if (context.execution === 'local') {
    publication = { outcome: 'NOT_RUN', diagnostic: 'Local validation has no hosted publication' };
  } else if (upload?.outcome === 'success' && /^[1-9]\d*$/.test(upload.id ?? '') &&
      upload.url === `https://github.com/${context.repository}/actions/runs/${context.runId}/artifacts/${upload.id}`) {
    publication = { outcome: 'PASS', id: upload.id, url: upload.url, independentlyRetrieved: false };
  } else {
    publication = { outcome: 'TOOL_ERROR', diagnostic: 'Mandatory artifact upload failed or has missing/inconsistent outputs' };
  }
  return { ...preliminary, publication, policy: manifest.publicationPolicy,
    outcome: aggregate([preliminary.outcome, publication.outcome]) };
}
