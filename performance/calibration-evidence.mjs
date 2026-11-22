import { isDeepStrictEqual } from 'node:util';
import { requireValid } from '../ci/adapters.mjs';
import { parseJson } from '../ci/evidence.mjs';
import { k6Image, workload } from './calibration-profile.mjs';

const sha = /^[a-f0-9]{64}$/;
const image = /^sha256:[a-f0-9]{64}$/;
const phases = ['warmup', 'measurement'];
const compare = (a, b) => a - b;
const percentile = (values, p) => {
  const index = (values.length - 1) * p;
  const lower = Math.floor(index);
  return values[lower] + (values[Math.ceil(index)] - values[lower]) * (index - lower);
};

function verifyWorkload(actual, expected) {
  const field = Object.keys(expected).find(key => actual?.[key] !== expected[key]);
  requireValid(isDeepStrictEqual(actual, expected), `Calibration workload mismatch${field ? `: ${field}` : ''}`);
}

function points(raw, sample) {
  const metrics = { http_reqs: [], http_req_failed: [], qel_calibration_requests: [], qel_calibration_latency: [] };
  requireValid(typeof raw === 'string' && raw.trim(), 'Missing native sample stream');
  for (const line of raw.trim().split(/\r?\n/)) {
    const { type, metric, data } = parseJson(line);
    requireValid(['Metric', 'Point'].includes(type), 'Malformed native sample');
    if (type !== 'Point' || !Object.hasOwn(metrics, metric)) continue;
    requireValid(Number.isFinite(data?.value) && Number.isFinite(Date.parse(data.time)) &&
      data.tags?.sample === sample && phases.includes(data.tags.phase), 'Inconsistent native sample provenance');
    metrics[metric].push(data);
  }
  return metrics;
}

function measure(sample, summary, raw) {
  requireValid(summary?.metrics && Number.isFinite(summary.state?.testRunDurationMs), 'Malformed native k6 summary');
  const durationMs = workload.durationSeconds * 1000;
  requireValid(summary.state.testRunDurationMs >= durationMs && summary.state.testRunDurationMs <= 50_000 &&
    summary.metrics.vus_max?.values?.max === workload.vus, 'Native k6 duration or VU count differs from the workload');
  const native = points(raw, sample);
  const attempts = phase => native.qel_calibration_requests.filter(point => point.tags.phase === phase);
  const warm = attempts('warmup');
  const measured = attempts('measurement');
  const warmErrors = warm.filter(point => point.tags.outcome !== 'success').length;
  requireValid(warm.length === workload.warmupRequests && measured.length > 0 &&
    measured.length <= workload.vus * Math.ceil(durationMs / workload.minIterationMs), 'Missing warm-up evidence or unsafe measurement request count');

  const tally = summary.metrics;
  const total = warm.length + measured.length;
  requireValid(tally.http_reqs?.values?.count === total && tally.qel_calibration_requests?.values?.count === total &&
    native.http_reqs.length === total && native.http_req_failed.length === total &&
    native.http_reqs.every(point => point.value === 1 && point.tags.url === workload.endpoint && point.tags.method === 'GET') &&
    native.http_req_failed.every(point => [0, 1].includes(point.value)) &&
    [...warm, ...measured].every(point => point.value === 1 && ['success', 'timeout', 'error'].includes(point.tags.outcome)),
  'Contradictory native request counts or wrong request endpoint');
  for (const [phase, phaseAttempts] of [['warmup', warm], ['measurement', measured]]) {
    requireValid(native.http_reqs.filter(point => point.tags.phase === phase).length === phaseAttempts.length &&
      native.http_req_failed.filter(point => point.tags.phase === phase).length === phaseAttempts.length,
    `Contradictory native request counts for ${phase}`);
  }

  const windowStart = Number(measured[0].tags.windowStart);
  const warmTimes = warm.map(point => Number(point.tags.sentAt)).sort(compare);
  requireValid(Number.isSafeInteger(windowStart) && windowStart > 0 && warmTimes.every((time, i) =>
    Number.isSafeInteger(time) && time > 0 && (i === 0 || time - warmTimes[i - 1] >= workload.warmupPacingMs - 1)) &&
    windowStart >= warmTimes.at(-1) + workload.warmupPacingMs - 1,
  'Warm-up timing evidence is missing or overlaps the measurement');
  const startsByVu = new Map();
  for (const { tags } of measured) {
    const sentAt = Number(tags.sentAt);
    requireValid(/^[1-9]\d*$/.test(tags.vu ?? '') && Number(tags.windowStart) === windowStart &&
      Number.isSafeInteger(sentAt) && sentAt >= windowStart && sentAt < windowStart + durationMs,
    'Measurement attempt outside the declared window');
    if (!startsByVu.has(tags.vu)) startsByVu.set(tags.vu, []);
    startsByVu.get(tags.vu).push(sentAt);
  }
  requireValid(startsByVu.size === workload.vus && [...startsByVu.values()].every(times =>
    times.sort(compare).every((time, index) => index === 0 || time - times[index - 1] >= workload.minIterationMs - 1)),
  'Native VU activity or pacing differs from the workload');

  const successful = measured.filter(point => point.tags.outcome === 'success').length;
  const timeouts = measured.filter(point => point.tags.outcome === 'timeout').length;
  const httpFailures = native.http_req_failed.filter(point => point.tags.phase === 'measurement' && point.value === 1).length;
  const samples = native.qel_calibration_latency.map(point => point.value).sort(compare);
  const trend = tally.qel_calibration_latency?.values;
  requireValid(successful === samples.length && timeouts <= httpFailures && httpFailures <= measured.length - successful &&
    samples.every(value => value >= 0) && native.qel_calibration_latency.every(point => point.tags.phase === 'measurement') &&
    (successful ? trend?.count === successful : !trend || trend.count === 0), 'Contradictory success, timeout or latency sample counts');
  const p50 = successful ? percentile(samples, 0.5) : null;
  const p95 = successful ? percentile(samples, 0.95) : null;
  requireValid(!successful || (Math.abs(trend.med - p50) < 1e-6 && Math.abs(trend['p(95)'] - p95) < 1e-6),
    'Native latency percentiles contradict successful samples');
  return { warmup: { requests: warm.length, errors: warmErrors, completed: true }, windowStart: new Date(windowStart).toISOString(),
    requests: measured.length, successful, errors: measured.length - successful, httpFailures, timeouts,
    ratePerSecond: measured.length / workload.durationSeconds, p50Ms: p50, p95Ms: p95, p95Observations: successful };
}

export function assessCalibration(batch, loadSample) {
  const samples = [];
  try {
    requireValid(/^[a-f0-9]{32}$/.test(batch.id) && batch.execution === 'local' && batch.source &&
      /^[a-f0-9]{40}$/.test(batch.source.testedSha) && sha.test(batch.source.sourceSha256) &&
      ['dirty', 'clean'].includes(batch.source.workingTree), 'Invalid calibration run provenance');
    verifyWorkload(batch.workload, workload);
    requireValid(sha.test(batch.workloadSha256) && sha.test(batch.composeSha256), 'Missing workload or Compose identity');
    requireValid(batch.k6?.image === k6Image && /^k6 v2\.3\.0\b/.test(batch.k6.version) &&
      batch.runner?.class === 'local-docker' && batch.runner.docker && batch.runner.compose && batch.resources?.sut && batch.resources.k6,
    'Unmatched k6 version, runner class or resource configuration');
    requireValid(image.test(batch.sut?.image) && sha.test(batch.sut?.datasetSha256), 'Missing SUT image or dataset identity');
    requireValid(Array.isArray(batch.samples), 'Missing calibration sample index');
    for (const [index, id] of batch.samples.entries()) {
      requireValid(id === `qel6b-${batch.id}-${index + 1}`, 'Inconsistent sample run provenance');
      const { record, summary, raw, artifacts } = loadSample(id);
      requireValid(record.id === id && isDeepStrictEqual(record.source, batch.source) &&
        Date.parse(record.startedAt) >= (Date.parse(samples.at(-1)?.finishedAt) || Date.parse(batch.startedAt)) &&
        Date.parse(record.finishedAt) > Date.parse(record.startedAt), 'Inconsistent sample run provenance or timing');
      verifyWorkload(record.workload, batch.workload);
      requireValid(record.workloadSha256 === batch.workloadSha256 && record.composeSha256 === batch.composeSha256,
        'Sample workload or Compose identity differs');
      requireValid(record.sut?.image === batch.sut.image && record.sut?.datasetSha256 === batch.sut.datasetSha256,
        'Sample SUT image or dataset identity differs');
      requireValid(isDeepStrictEqual(record.k6, batch.k6) && isDeepStrictEqual(record.runner, batch.runner) &&
        isDeepStrictEqual(record.resources, batch.resources), 'Sample tool version, runner or resource configuration differs');
      requireValid(record.sut.health === 'healthy' && record.sut.project === id && record.network?.internal === true &&
        [record.network.id, record.sut.container, record.k6Container].every(value => sha.test(value)) &&
        !samples.some(row => row.sut.container === record.sut.container || row.network.id === record.network.id || row.k6Container === record.k6Container),
      'SUT readiness, fresh instance identity or network isolation is unverified');
      requireValid(record.cleanup === 'PASS' && record.nativeExit === 0 && record.clientExit === 0 && !record.oomKilled,
        'Unverified cleanup or contradictory native k6 exit');
      const metrics = measure(id, summary, raw);
      samples.push({ ...record, metrics, artifacts });
    }
  } catch (error) {
    return { outcome: 'TOOL_ERROR', diagnostic: error.message, samples };
  }

  const reasons = [{ code: 'UNAPPROVED_POLICY', detail: 'No approved numerical PERF-G02 policy applies.' },
    { code: 'UNQUALIFIED_RUNNER', detail: 'Local Docker host lacks a qualified contention and stability envelope.' }];
  const p95s = samples.map(row => row.metrics.p95Ms).filter(value => value !== null).sort(compare);
  const rates = samples.map(row => row.metrics.ratePerSecond).sort(compare);
  const dispersion = values => values.length > 1 && percentile(values, 0.5) > 0 ?
    (values.at(-1) - values[0]) / percentile(values, 0.5) : null;
  const p95Spread = dispersion(p95s);
  const rateSpread = dispersion(rates);
  if (samples.length < 3 || samples.some(row => row.metrics.p95Observations < 100)) {
    reasons.push({ code: 'LIMITED_SAMPLE', detail: 'Fewer than three runs or fewer than 100 successful observations in a run.' });
  }
  if (p95Spread > 0.25) reasons.push({ code: 'P95_DISPERSION', detail: 'p95 range exceeds 25% of the run median.' });
  if (rateSpread > 0.10) reasons.push({ code: 'RATE_DISPERSION', detail: 'Achieved request-rate range exceeds 10% of the run median.' });
  if (samples.some(row => row.metrics.warmup.errors || row.metrics.errors)) {
    reasons.push({ code: 'REQUEST_ERRORS', detail: 'One or more warm-up or measurement requests failed.' });
  }
  if (samples.some(row => !recordedStableInventory(row))) {
    reasons.push({ code: 'OBSERVED_CONTENTION', detail: 'Unrelated running Docker inventory changed or was unverified.' });
  }
  return { outcome: 'INCONCLUSIVE', reasons, p95Spread, rateSpread, samples };
}

function recordedStableInventory(row) {
  return Array.isArray(row.unrelatedBefore) && isDeepStrictEqual(row.unrelatedBefore, row.unrelatedAfter);
}
