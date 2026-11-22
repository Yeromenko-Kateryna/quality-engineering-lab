import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { csp, origin, responseStatuses } from '../security/scope.mjs';
import { validateAudit, validateZap } from '../security/evidence.mjs';
import { aggregate, createReceipts, decide, summarize } from './evidence.mjs';

const timestamp = '2026-01-01T00:00:00.000Z';
const namespace = 'a'.repeat(32);
const sha = 'b'.repeat(40);
const lock = 'c'.repeat(64);
const versions = { node: 'v24.15.0', playwright: '1.58.2', axe: '4.11.1' };
const completed = (code = 0) => ({ state: 'completed', code, finishedAt: timestamp });
const states = { catalogue: '/', search: '/search', matching: '/search?q=notebook', empty: '/search?q=compass', invalid: '/search?q=' };
const checks = ['http_response_received', 'status_is_200', 'content_type_is_json', 'body_is_valid_json',
  'items_is_array', 'contains_field_notebook', 'contains_desk_notebook'];

function fixture(t, profile = 'main') {
  const parent = realpathSync(tmpdir());
  const bundle = mkdtempSync(join(parent, 'qel-contract-'));
  t.after(() => {
    const name = relative(parent, realpathSync(bundle));
    assert.match(name, /^qel-contract-[^/\\]+$/);
    rmSync(bundle, { recursive: true });
  });
  const put = (stage, path, value) => {
    const file = join(bundle, 'native', stage, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const context = {
    namespace, profile, execution: 'github-hosted', runId: '187', attempt: 2, repository: 'qel/test', job: 'quality',
    testedSha: sha, eventSha: 'd'.repeat(40), prHeadSha: profile === 'pr' ? 'e'.repeat(40) : null,
    workingTree: 'clean', sourceSha256: 'f'.repeat(64), lockSha256: lock, startedAt: timestamp,
    environment: { platform: 'linux', arch: 'x64', node: 'v24.15.0' },
  };
  const execution = Object.fromEntries(['setup', 'performance', 'accessibility', 'security', 'cleanup'].map(stage => [stage, completed()]));
  const k6 = {
    root_group: { checks: Object.fromEntries(checks.map(name => [name, { name, passes: 10, fails: 0 }])) },
    metrics: { http_reqs: { count: 10 }, iterations: { count: 10 }, vus_max: { max: 1 },
      search_smoke_notebook_requests: { count: 10 }, search_smoke_empty_items: { count: 0 },
      http_req_failed: { passes: 0, fails: 10, thresholds: { 'rate==0': false } },
      checks: { passes: 70, fails: 0, thresholds: { 'rate==1': false } },
    },
  };
  const k6Result = { project: `qel2-${namespace}`, scenario: 'search_smoke', policy: 'PERF-G01', query: 'notebook', outcome: 'PASS', k6ExitCode: 0,
    summary: { requests: 10, iterations: 10, checksPassed: 70, checksFailed: 0, httpResponsesMissing: 0, httpFailures: 0, emptyItems: 0,
      thresholds: { 'checks rate==1': true, 'http_req_failed rate==0': true } } };
  put('performance', 'summary.json', k6);
  put('performance', 'result.json', k6Result);
  put('performance', 'invocation.json', { project: k6Result.project, target: origin + '/api/search?q=notebook' });
  put('performance', 'version.txt', 'k6 v2.3.0 (synthetic fixture)');
  put('performance', 'readiness.json', { Status: 'healthy' });
  put('performance', 'k6.log', 'Synthetic completed run');
  const browser = '145.0.7632.6';
  const a11yProject = `qel3-${namespace}-baseline`;
  put('accessibility', 'versions.json', versions);
  const playwright = { errors: [], stats: { expected: 6, unexpected: 0, skipped: 0, flaky: 0 },
    suites: [{ specs: [...Object.keys(states), 'keyboard search'].map(title => ({ title, tests: [{ results: [{ status: 'passed' }] }] })) }] };
  put('accessibility', 'baseline/playwright.json', playwright);
  put('accessibility', 'baseline/result.json', {
    run: `qel3-${namespace}`, revision: sha, profile: 'baseline', project: a11yProject, nativeExit: 0,
    sut: { health: 'healthy', owner: a11yProject }, network: 'synthetic network', image: 'synthetic image',
  });
  put('accessibility', 'execution.txt', 'Synthetic execution');
  put('accessibility', 'baseline/playwright.log', 'Synthetic six passed');
  for (const [name, path] of Object.entries(states)) {
    const url = origin + path;
    put('accessibility', `baseline/state-${name}.json`, { url, status: name === 'invalid' ? 400 : 200, csp, browser, node: versions.node,
      ...(name === 'search' && { input: '- searchbox "Search catalogue"' }) });
    put('accessibility', `baseline/axe-${name}.json`, {
      testEngine: { name: 'axe-core', version: versions.axe }, url,
      passes: [{ id: 'document-title' }], violations: [], incomplete: [], inapplicable: [],
    });
  }
  const visible = { focusVisible: true, outlineWidth: 1, outlineStyle: 'solid' };
  put('accessibility', 'baseline/keyboard.json', {
    url: origin + '/search?q=notebook', status: 200, afterNavigation: { element: 'BODY' }, nextTab: visible,
    stops: [['A', 'Catalogue'], ['A', 'Search'], ['INPUT', ''], ['BUTTON', 'Search']]
      .map(([element, text]) => ({ element, text, id: 'search-term', ...visible })),
  });
  const cspReport = { policy: 'SEC-G01', csp, outcome: 'PASS',
    observations: Object.entries(responseStatuses).map(([route, status]) => ({
      url: origin + route, status, contentType: route.startsWith('/api/') || route === '/health' ? 'application/json' : 'text/html',
      policies: [csp], xContentTypeOptions: ['nosniff'], bodySha256: '1'.repeat(64), passed: true,
    })) };
  const cspInvocation = { nativeExit: 0, sut: { health: 'healthy', project: `qel4-${namespace}-baseline` }, networkId: 'synthetic network' };
  put('security', 'baseline/http-csp.json', cspReport);
  put('security', 'baseline/http-invocation.json', cspInvocation);
  put('security', 'baseline/csp-result.json', { outcome: 'PASS', nativeExit: 0, observations: cspReport.observations });
  put('security', 'versions.json', { node: versions.node, npm: '11.12.1' });
  put('security', 'execution.txt', 'Synthetic execution');
  put('security', 'scope-tests.txt', 'Synthetic guard test results');
  const audit = { auditReportVersion: 2, metadata: { vulnerabilities: { total: 0 }, dependencies: { total: 10 } }, vulnerabilities: {} };
  const auditInvocation = { nativeExit: 0, utc: timestamp, lockSha256: lock,
    command: ['docker', '--network', 'bridge', 'npm', 'audit', '--package-lock-only', '--registry=https://registry.npmjs.org/'] };
  put('security', 'npm-audit.json', audit);
  put('security', 'npm-audit-invocation.json', auditInvocation);
  put('security', 'npm-audit-result.json', validateAudit(audit, 0));
  const guard = ['/', '/search'].map(path => JSON.stringify({ path, method: 'GET', forwarded: true, status: 200, reason: 'response' })).join('\n');
  const zap = { '@version': '2.17.0', site: [{ '@name': origin, alerts: [] }] };
  const zapLog = warnings => `Spider complete\nPassive scanning complete\nFAIL-NEW: 0 FAIL-INPROG: 0 WARN-NEW: ${warnings} WARN-INPROG: 0\n` +
    'QEL_ZAP_OBSERVATION ' + JSON.stringify({ version: '2.17.0', passiveRemaining: 0,
      scope: [String.raw`^http://sut:3000/(?:search(?:\?q=(?:notebook|compass)?)?)?$`], urls: [origin + '/', origin + '/search'] });
  function saveZap(code, warnings) {
    put('security', 'baseline/zap-process.json', { Status: 'exited', ExitCode: code, OOMKilled: false });
    put('security', 'baseline/zap.json', zap);
    put('security', 'baseline/zap.log', zapLog(warnings));
    put('security', 'baseline/zap-result.json', validateZap(zap, code, zapLog(warnings), guard));
  }
  if (profile === 'main') {
    put('security', 'baseline/gateway.jsonl', guard);
    for (const name of ['reachable-before', 'direct-blocked', 'reachable-after']) {
      const connected = name !== 'direct-blocked';
      put('security', `baseline/${name}.json`, { destination: '172.26.0.2', connected, ...(!connected && { code: 'ENETUNREACH' }) });
    }
    saveZap(0, 0);
  }
  function receipts() { return createReceipts(context, execution, bundle); }
  function summary(input = receipts()) { return summarize(context, execution, bundle, input); }
  return { context, bundle, put, execution, receipts, summary, k6, k6Result, playwright, cspReport, cspInvocation, zap, saveZap, audit, auditInvocation };
}

for (const [name, content] of [['missing', null], ['empty', ''], ['malformed JSON', '{']]) {
  test(`${name} required report is TOOL_ERROR`, t => {
    const f = fixture(t);
    if (content === null) rmSync(join(f.bundle, 'native/performance/summary.json'));
    else f.put('performance', 'summary.json', content);
    assert.equal(f.summary().required.search_smoke, 'TOOL_ERROR');
  });
}

for (const [name, edit] of [
  ['unsupported schema', r => { r[0].schemaVersion = 2; }],
  ['duplicate receipt', r => { r.push(structuredClone(r[0])); }],
  ['wrong tested SHA', r => { r[0].provenance = { ...r[0].provenance, testedSha: '0'.repeat(40) }; }],
  ['wrong run ID', r => { r[0].provenance = { ...r[0].provenance, runId: '188' }; }],
  ['wrong attempt', r => { r[0].provenance = { ...r[0].provenance, attempt: 3 }; }],
  ['missing required scenario', r => { r.shift(); }],
  ['unapproved substitution', r => { r[0].scenario = 'search-replacement'; }],
]) {
  test(`${name} blocks the aggregate`, t => {
    const f = fixture(t);
    const receipts = f.receipts();
    edit(receipts);
    assert.equal(f.summary(receipts).outcome, 'TOOL_ERROR');
  });
}

test('inconsistent k6 metrics and partial tool output cannot pass', t => {
  const f = fixture(t);
  f.k6.metrics.iterations.count = 5;
  f.put('performance', 'summary.json', f.k6);
  assert.equal(f.summary().required.search_smoke, 'TOOL_ERROR');
  f.execution.performance = { state: 'error', diagnostic: 'Synthetic tool crash after partial report' };
  assert.equal(f.summary().required.search_smoke, 'TOOL_ERROR');
});

test('execution timeout cannot reuse a seemingly complete report', t => {
  const f = fixture(t);
  f.execution.performance = { state: 'timeout', diagnostic: 'Synthetic timeout', code: null };
  assert.equal(f.summary().required.search_smoke, 'TOOL_ERROR');
});

test('observed policy FAIL wins over tool errors', t => {
  const f = fixture(t);
  f.cspReport.observations[0].policies = [];
  f.cspReport.observations[0].passed = false;
  f.cspReport.outcome = 'FAIL';
  f.cspInvocation.nativeExit = 1;
  f.put('security', 'baseline/http-csp.json', f.cspReport);
  f.put('security', 'baseline/http-invocation.json', f.cspInvocation);
  f.put('security', 'baseline/csp-result.json', { outcome: 'FAIL', nativeExit: 1, observations: f.cspReport.observations });
  f.execution.security.code = 1;
  f.execution.performance.state = 'error';
  assert.equal(f.summary().required['csp-baseline'], 'FAIL');
  assert.equal(f.summary().outcome, 'FAIL');
});

test('completed actionable ZAP finding remains INCONCLUSIVE', t => {
  const f = fixture(t);
  f.zap.site[0].alerts.push({ pluginid: '12345', name: 'Synthetic finding', riskdesc: 'High (Medium)',
    confidence: '2', riskcode: '3', instances: [{ uri: origin + '/' }] });
  f.saveZap(2, 1);
  f.execution.security.code = 1;
  assert.equal(f.summary().required['zap-baseline'], 'INCONCLUSIVE');
  assert.equal(f.summary().outcome, 'INCONCLUSIVE');
});

test('completed npm audit with advisories is distinct from an unavailable service', t => {
  const f = fixture(t);
  f.audit.vulnerabilities.synthetic = { name: 'synthetic', severity: 'high', via: [{ source: 1 }] };
  f.audit.metadata.vulnerabilities.total = 1;
  f.auditInvocation.nativeExit = 1;
  f.put('security', 'npm-audit-invocation.json', f.auditInvocation);
  f.put('security', 'npm-audit.json', f.audit);
  f.put('security', 'npm-audit-result.json', validateAudit(f.audit, 1));
  f.execution.security.code = 1;
  assert.equal(f.summary().required['npm-audit'], 'INCONCLUSIVE');
  f.put('security', 'npm-audit.json', { error: { code: 'EAI_AGAIN' } });
  assert.equal(f.summary().required['npm-audit'], 'TOOL_ERROR');
});

test('explicit required NOT_RUN is distinct from missing evidence', t => {
  const f = fixture(t);
  f.execution.performance = { state: 'not_run', diagnostic: 'Synthetic deliberate skip' };
  assert.equal(f.summary().required.search_smoke, 'NOT_RUN');
  assert.equal(f.summary().outcome, 'NOT_RUN');
});

test('optional completed diagnostic with samples is INCONCLUSIVE and never required', t => {
  const f = fixture(t);
  f.execution.diagnostic = completed();
  f.put('performance', 'latency-diagnostic.json', { samplesMs: [11, 22, 33], reason: 'Synthetic samples, no qualified environment' });
  assert.equal(f.summary().optional['latency-comparison'], 'INCONCLUSIVE');
  assert.equal(f.summary().outcome, 'PASS');
});

test('mandatory publication requires actual action success and matching artifact outputs', t => {
  const f = fixture(t);
  const preliminary = f.summary();
  const good = { outcome: 'success', id: '42', url: 'https://github.com/qel/test/actions/runs/187/artifacts/42' };
  assert.equal(decide(preliminary, good).outcome, 'PASS');
  assert.equal(decide(preliminary, { ...good, outcome: 'failure' }).outcome, 'TOOL_ERROR');
  assert.equal(decide(preliminary, { ...good, url: '' }).outcome, 'TOOL_ERROR');
  assert.equal(decide(preliminary, { ...good, url: good.url.replace('/187/', '/999/') }).outcome, 'TOOL_ERROR');
  assert.equal(decide({ ...preliminary, context: { ...preliminary.context, execution: 'local' } }, good).publication.outcome, 'NOT_RUN');
});

test('changing a native report after building receipts is detected', t => {
  const f = fixture(t);
  const previous = f.receipts();
  f.k6.root_group.checks.contains_field_notebook.fails = 3;
  f.put('performance', 'summary.json', f.k6);
  assert.equal(f.summary(previous).required.search_smoke, 'TOOL_ERROR');
});

test('native response and accessibility observations must agree with passing wrapper results', t => {
  const f = fixture(t);
  f.put('security', 'baseline/csp-result.json', { outcome: 'FAIL' });
  f.put('accessibility', 'baseline/state-search.json', { url: origin + '/search', status: 200, csp,
    browser: '145.0.7632.6', node: versions.node, input: '- searchbox' });
  f.k6Result.summary.requests = 6;
  f.put('performance', 'result.json', f.k6Result);
  const result = f.summary();
  assert.equal(result.required['csp-baseline'], 'TOOL_ERROR');
  assert.equal(result.required['axe-baseline'], 'TOOL_ERROR');
  assert.equal(result.required.search_smoke, 'TOOL_ERROR');
});

test('PR and main manifests differ only in mandatory ZAP, and preserve actual tested versus PR head SHA', t => {
  const pr = fixture(t, 'pr');
  const main = fixture(t);
  assert.deepEqual(Object.keys(main.summary().required).filter(id => !Object.hasOwn(pr.summary().required, id)), ['zap-baseline']);
  assert.equal(pr.summary().optional['zap-baseline'], 'NOT_RUN');
  assert.equal(pr.summary().outcome, 'PASS');
  assert.equal(main.summary().outcome, 'PASS');
  assert.equal(pr.receipts()[0].provenance.testedSha, sha);
  assert.notEqual(pr.receipts()[0].provenance.prHeadSha, sha);
  assert.equal(pr.receipts()[0].provenance.eventSha, 'd'.repeat(40));
});

test('aggregation precedence is explicit, including unresolved and skipped cases', () => {
  assert.equal(aggregate(['PASS', 'NOT_RUN', 'INCONCLUSIVE', 'TOOL_ERROR', 'FAIL']), 'FAIL');
  assert.equal(aggregate(['PASS', 'NOT_RUN', 'INCONCLUSIVE', 'TOOL_ERROR']), 'TOOL_ERROR');
  assert.equal(aggregate(['PASS', 'NOT_RUN', 'INCONCLUSIVE']), 'INCONCLUSIVE');
  assert.equal(aggregate(['PASS', 'NOT_RUN']), 'NOT_RUN');
  assert.equal(aggregate(['PASS', 'PASS']), 'PASS');
});
