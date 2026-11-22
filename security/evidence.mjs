import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { authorize, csp, matchesResponse, maxRequests, origin, responseStatuses, states } from './scope.mjs';

const load = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateCsp(report, exit) {
  requireEvidence(report.policy === 'SEC-G01' && report.csp === csp, 'Unexpected CSP policy evidence');
  requireEvidence(report.observations?.length === Object.keys(responseStatuses).length, 'Incomplete HTTP observations');
  const rows = new Map(report.observations.map(row => [row.url, row]));
  const matches = Object.keys(responseStatuses).map(route => {
    const row = rows.get(origin + route);
    requireEvidence(row && !row.error && Array.isArray(row.policies) && Array.isArray(row.xContentTypeOptions) &&
      (row.contentType === null || typeof row.contentType === 'string') &&
      Number.isInteger(row.status) && /^[a-f0-9]{64}$/.test(row.bodySha256), 'Missing HTTP response evidence');
    const passed = matchesResponse(route, row);
    requireEvidence(row.passed === passed, 'Header assertion is inconsistent with HTTP evidence');
    return passed;
  });
  const passed = matches.every(Boolean);
  const outcome = passed ? 'PASS' : 'FAIL';
  requireEvidence(exit === (passed ? 0 : 1) && report.outcome === outcome, 'CSP result does not match the native exit');
  return { outcome, nativeExit: exit, observations: report.observations };
}

export function validateAudit(report, exit) {
  requireEvidence(!report.error && report.auditReportVersion === 2 &&
    report.vulnerabilities && typeof report.vulnerabilities === 'object' && !Array.isArray(report.vulnerabilities),
  'npm did not return a completed audit report');
  const findings = Object.values(report.vulnerabilities);
  const totals = report.metadata?.vulnerabilities;
  requireEvidence(totals?.total === findings.length && report.metadata?.dependencies?.total > 0 &&
    findings.every(finding => typeof finding.name === 'string' && typeof finding.severity === 'string' &&
      Array.isArray(finding.via) && finding.via.length > 0), 'Invalid npm vulnerability evidence');
  requireEvidence(exit === (findings.length ? 1 : 0), 'Native npm exit does not match the audit evidence');
  return {
    execution: 'PASS',
    outcome: findings.length ? 'INCONCLUSIVE' : 'PASS',
    nativeExit: exit,
    totals,
    findings: findings.map(finding => ({
      package: finding.name, severity: finding.severity, range: finding.range,
      via: finding.via, fixAvailable: finding.fixAvailable,
      disposition: 'Unresolved pending owner review',
    })),
  };
}

export function validateZap(report, exit, log, guardLog) {
  requireEvidence([0, 1, 2].includes(exit), 'ZAP did not complete with a documented findings exit');
  requireEvidence(log.includes('Spider complete') && log.includes('Passive scanning complete') &&
    !log.includes('Exceeded passive scan timeout') && !log.includes('Failed to load context file'),
  'Missing spider, scope or passive completion evidence');
  const prefix = 'QEL_ZAP_OBSERVATION ';
  const lines = log.split(/\r?\n/).filter(line => line.startsWith(prefix));
  requireEvidence(lines.length === 1, 'Missing or duplicate ZAP runtime observations');
  const observed = JSON.parse(lines[0].slice(prefix.length));
  const expectedScope = String.raw`^http://sut:3000/(?:search(?:\?q=(?:notebook|compass)?)?)?$`;
  requireEvidence(observed.version === '2.17.0' && report['@version'] === observed.version &&
    observed.passiveRemaining === 0 && observed.scope?.length === 1 && observed.scope[0] === expectedScope &&
    Array.isArray(observed.urls) && observed.urls.length > 0, 'Incomplete ZAP version, scope, URL or queue evidence');
  // ZAP's URL tree includes the bare site root as well as the HTTP document.
  // Qualify that root only against the gateway's actual GET / observation.
  const examined = [...new Set(observed.urls.map(url => authorize(url === origin ? origin + '/' : url)))];
  const events = guardLog.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const forwarded = events.filter(event => event.forwarded);
  requireEvidence(forwarded.length > 0 && forwarded.length <= maxRequests &&
    forwarded.every(event => event.method === 'GET' && event.reason === 'response' &&
      states[authorize(origin + event.path)] === event.status) &&
    examined.every(route => forwarded.some(event => event.path === route)),
  'Gateway observations do not confirm approved, bounded ZAP requests');
  requireEvidence(Array.isArray(report.site) && report.site.length === 1 && report.site[0]['@name'] === origin &&
    Array.isArray(report.site[0].alerts), 'Invalid ZAP site or alert structure');
  const findings = report.site[0].alerts.map(alert => {
    requireEvidence(alert.pluginid && alert.name && alert.riskdesc && alert.confidence &&
      Array.isArray(alert.instances) && alert.instances.length > 0, 'Incomplete native ZAP alert');
    requireEvidence(alert.instances.every(instance => examined.includes(authorize(instance.uri))),
      'ZAP alert outside the observed authorized scope');
    const informational = String(alert.riskcode) === '0';
    return {
      rule: alert.pluginid, name: alert.name, risk: alert.riskdesc, confidence: alert.confidence,
      count: alert.count, instances: alert.instances,
      disposition: informational ? 'Informational finding' : 'Unresolved pending owner review',
      rationale: informational ? 'ZAP reports informational risk.' :
        'The passive alert is retained. No rule-specific risk disposition has been approved.',
    };
  });
  const counts = log.match(/FAIL-NEW: (\d+)\s+FAIL-INPROG: (\d+)\s+WARN-NEW: (\d+)\s+WARN-INPROG: (\d+)/);
  requireEvidence(counts && (Number(counts[1]) > 0 ? 1 : Number(counts[3]) > 0 ? 2 : 0) === exit &&
    (exit === 0 || findings.length > 0), 'ZAP exit does not match its findings summary');
  return {
    execution: 'PASS',
    outcome: findings.some(finding => finding.disposition.startsWith('Unresolved')) ? 'INCONCLUSIVE' : 'PASS',
    nativeExit: exit, version: observed.version, passiveRemaining: observed.passiveRemaining,
    examined: examined.map(route => origin + route),
    requestsForwarded: forwarded.length, denied: events.filter(event => !event.forwarded), findings,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , mode, path, code, logPath, guardPath] = process.argv;
  try {
    const report = load(path);
    const exit = Number(code);
    let result;
    if (mode === 'csp') result = validateCsp(report, exit);
    else if (mode === 'audit') result = validateAudit(report, exit);
    else if (mode === 'zap') result = validateZap(report, exit, readFileSync(logPath, 'utf8'), readFileSync(guardPath, 'utf8'));
    else throw new Error('Unknown evidence type');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ outcome: 'TOOL_ERROR', nativeExit: Number(code), diagnostic: error.message }));
    process.exitCode = 2;
  }
}
