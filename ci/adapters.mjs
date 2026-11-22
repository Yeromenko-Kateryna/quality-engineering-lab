import { isDeepStrictEqual } from 'node:util';
import { validateAudit, validateCsp, validateZap } from '../security/evidence.mjs';

const origin = 'http://sut:3000';
const axeStates = {
  catalogue: '/', search: '/search', matching: '/search?q=notebook',
  empty: '/search?q=compass', invalid: '/search?q=',
};
const keyboard = 'keyboard search';
const k6Checks = [
  'http_response_received', 'status_is_200', 'content_type_is_json', 'body_is_valid_json',
  'items_is_array', 'contains_field_notebook', 'contains_desk_notebook',
];

export function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}

const count = value => Number.isInteger(value) && value >= 0;

function k6(files, context, result) {
  const invocation = files.json('invocation.json');
  requireValid(result.project === `qel2-${context.namespace}` && invocation.project === result.project &&
    invocation.target === origin + '/api/search?q=notebook' && result.query === 'notebook' &&
    result.scenario === 'search_smoke' && result.policy === 'PERF-G01' &&
    files.json('readiness.json').Status === 'healthy', 'Unexpected k6 invocation or readiness');
  const version = files.text('version.txt');
  requireValid(/^k6 v2\.3\.0\b/.test(version), 'Unexpected k6 version');
  const native = files.json('summary.json');
  const m = native.metrics;
  const checks = native.root_group?.checks;
  const requests = m?.http_reqs?.count;
  requireValid(count(requests) && requests > 0 && m.iterations?.count === requests &&
    m.search_smoke_notebook_requests?.count === requests && m.vus_max?.max === 1 &&
    count(m.search_smoke_empty_items?.count) && m.search_smoke_empty_items.count <= requests &&
    Object.keys(checks ?? {}).length === k6Checks.length, 'Inconsistent k6 request or check counts');
  let passes = 0;
  let failures = 0;
  for (const name of k6Checks) {
    const check = checks[name];
    requireValid(check?.name === name && count(check.passes) && count(check.fails) &&
      check.passes + check.fails === requests, `Invalid k6 check count for ${name}`);
    passes += check.passes;
    failures += check.fails;
  }
  const http = m.http_req_failed;
  requireValid(checks.http_response_received.fails === 0, 'k6 did not receive every HTTP response');
  requireValid(count(http?.passes) && count(http?.fails) && http.passes + http.fails === requests &&
    http.passes === checks.status_is_200.fails && http.thresholds?.['rate==0'] === (http.passes > 0) &&
    m.checks?.passes === passes && m.checks?.fails === failures &&
    m.checks.thresholds?.['rate==1'] === (failures > 0), 'Inconsistent k6 threshold evidence');
  const outcome = failures ? 'FAIL' : 'PASS';
  requireValid(result.k6ExitCode === (failures ? 99 : 0) && result.outcome === outcome, 'Inconsistent k6 native exit or decision');
  requireValid(isDeepStrictEqual(result.summary, {
    requests, iterations: requests, checksPassed: passes, checksFailed: failures, httpResponsesMissing: 0,
    httpFailures: http.passes, emptyItems: m.search_smoke_empty_items.count,
    thresholds: { 'checks rate==1': failures === 0, 'http_req_failed rate==0': http.passes === 0 },
  }), 'k6 wrapper summary contradicts native evidence');
  files.text('k6.log');
  return { outcome, tools: { k6: version.trim() }, details: { query: 'notebook', vus: 1, durationSeconds: 10, requests, passes, failures } };
}

function playwright(files, context, record, scenario) {
  requireValid(record.run === `qel3-${context.namespace}` && record.profile === 'baseline' &&
    record.project === `${record.run}-baseline` && record.revision === context.testedSha &&
    record.sut?.health === 'healthy' && record.sut.owner === record.project &&
    typeof record.network === 'string' && typeof record.image === 'string',
  'Unexpected Playwright invocation, provenance or readiness');
  const versions = files.json('versions.json');
  requireValid(versions.playwright === '1.58.2' && versions.axe === '4.11.1' && typeof versions.node === 'string',
    'Invalid Playwright or axe versions');
  const report = files.json('baseline/playwright.json');
  requireValid(Array.isArray(report.errors) && report.errors.length === 0, 'Playwright reported a runner error');
  const specs = report.suites?.flatMap(suite => suite.specs ?? []);
  const names = [...Object.keys(axeStates), keyboard];
  requireValid(specs?.length === names.length, 'Incomplete Playwright execution');
  const results = {};
  for (const name of names) {
    const matching = specs.filter(spec => spec.title === name);
    const tests = matching[0]?.tests;
    const native = tests?.[0]?.results;
    requireValid(matching.length === 1 && tests?.length === 1 && native?.length === 1 &&
      ['passed', 'failed'].includes(native[0].status), `Missing terminal result for ${name}`);
    results[name] = native[0];
  }
  const failed = names.filter(name => results[name].status === 'failed');
  requireValid(report.stats?.expected === names.length - failed.length && report.stats?.unexpected === failed.length &&
    report.stats?.skipped === 0 && report.stats?.flaky === 0 &&
    record.nativeExit === (failed.length ? 1 : 0), 'Playwright stats and native exit contradict the tests');
  const selected = scenario === 'axe-baseline' ? Object.keys(axeStates) : [keyboard];
  for (const name of selected) {
    const result = results[name];
    if (result.status === 'failed') {
      requireValid(result.errors?.length > 0 && result.errors.every(error => error.message?.includes('A11Y:')),
        `Playwright execution failure in ${name}`);
    }
  }
  const details = { tests: selected.map(name => ({ name, status: results[name].status })) };
  if (scenario === 'axe-baseline') {
    const findings = [];
    for (const [name, path] of Object.entries(axeStates)) {
      const state = files.json(`baseline/state-${name}.json`);
      const axe = files.json(`baseline/axe-${name}.json`);
      requireValid(state.url === origin + path && state.status === (name === 'invalid' ? 400 : 200) &&
        state.csp?.includes("default-src 'none'") && typeof state.browser === 'string' &&
        state.node === versions.node && axe.url === state.url &&
        axe.testEngine?.name === 'axe-core' && axe.testEngine.version === versions.axe &&
        ['passes', 'violations', 'incomplete', 'inapplicable'].every(key => Array.isArray(axe[key])) &&
        axe.passes.length > 0, `Incomplete axe evidence for ${name}`);
      requireValid(versions.browser === undefined || versions.browser === state.browser, 'Contradictory Chromium versions');
      versions.browser = state.browser;
      if (name === 'search' && results[name].status === 'passed') {
        requireValid(/^\s*- searchbox "Search catalogue"\s*$/.test(state.input ?? ''),
          'Search accessible-name observation contradicts the passing test');
      }
      if (axe.violations.some(rule => ['critical', 'serious'].includes(rule.impact))) {
        requireValid(results[name].status === 'failed', `Unreported blocking axe violation on ${name}`);
      }
      findings.push(...axe.violations.map(rule => ({ path, id: rule.id, impact: rule.impact })));
    }
    details.findings = findings;
  } else if (!failed.includes(keyboard)) {
    const keys = files.json('baseline/keyboard.json');
    requireValid(keys.url === origin + '/search?q=notebook' && keys.status === 200 &&
      isDeepStrictEqual(keys.stops?.map(stop => [stop.element, stop.text]), [['A', 'Catalogue'], ['A', 'Search'], ['INPUT', ''], ['BUTTON', 'Search']]) &&
      keys.stops[2].id === 'search-term' && [...keys.stops, keys.nextTab].every(stop => stop.focusVisible === true &&
        stop.outlineStyle !== 'none' && stop.outlineWidth > 0) && keys.afterNavigation?.element,
    'Incomplete keyboard or focus observations');
  }
  if (scenario === 'keyboard-baseline') {
    const state = files.json('baseline/state-search.json');
    requireValid(state.url === origin + '/search' && state.node === versions.node &&
      typeof state.browser === 'string' && state.browser.length > 0, 'Missing Chromium version');
    versions.browser = state.browser;
  }
  files.text('baseline/playwright.log');
  return { outcome: selected.some(name => failed.includes(name)) ? 'FAIL' : 'PASS', tools: versions, details };
}

export const nativeRecords = {
  search_smoke: ['result.json', 'k6ExitCode'],
  'axe-baseline': ['baseline/result.json', 'nativeExit'],
  'keyboard-baseline': ['baseline/result.json', 'nativeExit'],
  'csp-baseline': ['baseline/http-invocation.json', 'nativeExit'],
  'zap-baseline': ['baseline/zap-process.json', 'ExitCode'],
  'npm-audit': ['npm-audit-invocation.json', 'nativeExit'],
};

export function classify(entry, files, context, execution) {
  let nativeExit = null;
  try {
    requireValid(execution?.state === 'completed', execution?.diagnostic ?? 'Required execution was not recorded');
    const [name, key] = nativeRecords[entry.id];
    const record = files.json(name);
    requireValid(count(record[key]), 'Actual native exit is missing');
    nativeExit = record[key];
    let decision;
    switch (entry.id) {
      case 'search_smoke':
        decision = k6(files, context, record);
        break;
      case 'axe-baseline':
      case 'keyboard-baseline':
        decision = playwright(files, context, record, entry.id);
        break;
      case 'csp-baseline': {
        requireValid(record.sut?.health === 'healthy' && record.sut.project === `qel4-${context.namespace}-baseline` &&
          record.networkId, 'CSP SUT readiness or ownership is missing');
        const validated = validateCsp(files.json('baseline/http-csp.json'), nativeExit);
        requireValid(isDeepStrictEqual(files.json('baseline/csp-result.json'), validated),
          'CSP wrapper decision contradicts native evidence');
        decision = { outcome: validated.outcome, tools: files.json('versions.json'), details: { responses: validated.observations.length } };
        break;
      }
      case 'zap-baseline': {
        requireValid(record.Status === 'exited' && record.OOMKilled === false, 'ZAP did not exit normally');
        const before = files.json('baseline/reachable-before.json');
        const blocked = files.json('baseline/direct-blocked.json');
        const after = files.json('baseline/reachable-after.json');
        requireValid(/^\d+\.\d+\.\d+\.\d+$/.test(before.destination) && before.destination === blocked.destination &&
          before.destination === after.destination && before.connected === true && after.connected === true &&
          blocked.connected === false && ['ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(blocked.code),
        'Contradictory ZAP network isolation controls');
        const validated = validateZap(files.json('baseline/zap.json'), nativeExit, files.text('baseline/zap.log'), files.text('baseline/gateway.jsonl'));
        requireValid(validated.examined.includes(origin + '/') && validated.examined.includes(origin + '/search'),
          'ZAP did not examine both required baseline pages');
        const triage = files.json('baseline/zap-result.json');
        requireValid(isDeepStrictEqual(triage, JSON.parse(JSON.stringify(validated))), 'ZAP disposition contradicts native evidence');
        decision = { outcome: validated.outcome, tools: { zap: validated.version }, details: {
          examined: validated.examined, requests: validated.requestsForwarded,
          findings: validated.findings.map(({ rule, risk, disposition }) => ({ rule, risk, disposition })),
        } };
        break;
      }
      case 'npm-audit': {
        requireValid(record.lockSha256?.toLowerCase() === context.lockSha256 && !Number.isNaN(Date.parse(record.utc)) &&
          record.command?.includes('npm') && record.command.includes('audit') && record.command.includes('--package-lock-only') &&
          record.command.includes('--registry=https://registry.npmjs.org/') &&
          record.command[record.command.indexOf('--network') + 1] === 'bridge', 'Unexpected npm audit lockfile or invocation');
        const validated = validateAudit(files.json('npm-audit.json'), nativeExit);
        requireValid(isDeepStrictEqual(files.json('npm-audit-result.json'), JSON.parse(JSON.stringify(validated))), 'npm disposition contradicts native evidence');
        decision = { outcome: validated.outcome, tools: files.json('versions.json'), details: { totals: validated.totals, auditedAt: record.utc } };
        break;
      }
      default: throw new Error('Unknown scenario adapter');
    }
    requireValid(Object.values(decision.tools).length > 0 &&
      Object.values(decision.tools).every(value => typeof value === 'string' && value.length > 0), 'Missing native tool versions');
    return { ...decision, nativeExit, validation: { valid: true, diagnostic: null } };
  } catch (error) {
    return { outcome: 'TOOL_ERROR', tools: {}, details: {}, nativeExit, validation: { valid: false, diagnostic: error.message } };
  }
}
