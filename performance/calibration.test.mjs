import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessCalibration } from './calibration-evidence.mjs';
import { k6Image, workload } from './calibration-profile.mjs';

const id = 'a'.repeat(32);
const hash = char => char.repeat(64);
const start = Date.parse('2026-01-01T00:00:00Z');
const iso = time => new Date(time).toISOString();
const metric = values => ({ values });

function sample(batch, index, duration) {
  const sample = batch.samples[index];
  const first = start + index * 60_000;
  const record = { id: sample, source: batch.source, workload: { ...workload }, workloadSha256: batch.workloadSha256,
    composeSha256: batch.composeSha256, runner: batch.runner, resources: batch.resources, k6: batch.k6,
    sut: { ...batch.sut, project: sample, health: 'healthy', container: hash(String(index + 1)) },
    network: { internal: true, id: hash(String(index + 4)) }, k6Container: hash(String(index + 7)),
    startedAt: iso(first), finishedAt: iso(first + 36_000), cleanup: 'PASS', nativeExit: 0, clientExit: 0, oomKilled: false,
    unrelatedBefore: [], unrelatedAfter: [] };
  const warm = 5;
  const measured = 5;
  const windowStart = first + 5000;
  const point = (name, value, tags, time) => ({ type: 'Point', metric: name, data: { value, time: iso(time), tags: { sample, ...tags } } });
  const raw = [];
  for (let index = 0; index < warm + measured; index++) {
    const phase = index < warm ? 'warmup' : 'measurement';
    const sentAt = index < warm ? first + index * 1000 : windowStart;
    const tags = { phase, sentAt: String(sentAt), outcome: 'success',
      ...(phase === 'measurement' ? { vu: String(index - warm + 1), windowStart: String(windowStart) } : {}) };
    raw.push(point('qel_calibration_requests', 1, tags, sentAt + duration),
      point('http_reqs', 1, { phase, method: 'GET', url: workload.endpoint }, sentAt + duration),
      point('http_req_failed', 0, { phase }, sentAt + duration));
    if (phase === 'measurement') raw.push(point('qel_calibration_latency', duration, { phase }, sentAt + duration));
  }
  const summary = { state: { testRunDurationMs: 35_000 }, metrics: { vus_max: metric({ max: 5 }),
    http_reqs: metric({ count: warm + measured }), qel_calibration_requests: metric({ count: warm + measured }),
    qel_calibration_latency: metric({ count: measured, med: duration, 'p(95)': duration }) } };
  return { record, summary, raw: raw.map(row => JSON.stringify(row)).join('\n'), artifacts: [] };
}

function fixture(durations = [3, 3, 3]) {
  const batch = { id, execution: 'local', startedAt: iso(start), workload, workloadSha256: hash('b'), composeSha256: hash('c'),
    source: { testedSha: 'a'.repeat(40), sourceSha256: hash('d'), workingTree: 'dirty' },
    runner: { class: 'local-docker', docker: 'fixture', compose: 'fixture' },
    sut: { image: `sha256:${hash('e')}`, datasetSha256: hash('f') }, k6: { image: k6Image, version: 'k6 v2.3.0 fixture' },
    resources: { sut: {}, k6: {} }, samples: durations.map((_, i) => `qel6b-${id}-${i + 1}`) };
  const runs = Object.fromEntries(durations.map((value, index) => [batch.samples[index], sample(batch, index, value)]));
  return { batch, first: runs[batch.samples[0]], result: () => assessCalibration(batch, run => runs[run]) };
}

for (const [name, edit, diagnostic] of [
  ['missing summary', f => { delete f.first.summary; }, /Malformed native k6 summary/],
  ['malformed native report', f => { f.first.raw = '{'; }, /JSON/],
  ['different VUs', f => { f.first.record.workload.vus = 4; }, /workload mismatch: vus/],
  ['different duration', f => { f.first.record.workload.durationSeconds = 31; }, /workload mismatch: durationSeconds/],
  ['different endpoint', f => { f.first.record.workload.endpoint = 'http://sut:3000/api/search?q=compass'; }, /workload mismatch: endpoint/],
  ['different pacing', f => { f.first.record.workload.minIterationMs = 250; }, /workload mismatch: minIterationMs/],
  ['different SUT image', f => { f.first.record.sut.image = `sha256:${hash('0')}`; }, /image or dataset/],
  ['different dataset', f => { f.first.record.sut.datasetSha256 = hash('0'); }, /image or dataset/],
  ['missing warm-up', f => { f.first.raw = f.first.raw.split('\n').filter(line => !line.includes('"phase":"warmup"')).join('\n'); }, /Missing warm-up/],
  ['contradictory count', f => { f.first.summary.metrics.http_reqs.values.count = 9; }, /Contradictory native request counts/],
  ['inconsistent run provenance', f => { f.first.record.id = 'wrong'; }, /Inconsistent sample run provenance/],
  ['contradictory exit', f => { f.first.record.clientExit = 1; }, /contradictory native k6 exit/],
  ['different version', f => { f.first.record.k6 = { ...f.batch.k6, version: 'k6 v1.0.0' }; }, /tool version/],
  ['different workload identity', f => { f.first.record.workloadSha256 = hash('a'); }, /workload or Compose identity/],
]) {
  test(`${name} yields TOOL_ERROR`, () => {
    const f = fixture();
    edit(f);
    const actual = f.result();
    assert.equal(actual.outcome, 'TOOL_ERROR');
    assert.match(actual.diagnostic, diagnostic);
  });
}

test('valid but unstable synthetic measurements remain INCONCLUSIVE', () => {
  const result = fixture([2, 3, 8]).result();
  assert.equal(result.outcome, 'INCONCLUSIVE');
  assert.equal(result.samples.length, 3);
  assert.ok(result.reasons.some(reason => reason.code === 'P95_DISPERSION'));
});

test('stable synthetic measurements remain INCONCLUSIVE without an approved policy', () => {
  const result = fixture().result();
  assert.equal(result.outcome, 'INCONCLUSIVE');
  assert.equal(result.samples.length, 3);
  assert.ok(result.reasons.some(reason => reason.code === 'UNAPPROVED_POLICY'));
});
