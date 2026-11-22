import { sleep } from 'k6';
import execution from 'k6/execution';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import { workload } from './calibration-profile.mjs';

const attempts = new Counter('qel_calibration_requests');
const latency = new Trend('qel_calibration_latency', true);

export const options = {
  scenarios: { measurement: { executor: workload.executor, vus: workload.vus,
    duration: `${workload.durationSeconds}s`, gracefulStop: `${workload.gracefulStopSeconds}s` } },
  minIterationDuration: `${workload.minIterationMs}ms`, setupTimeout: `${workload.setupTimeoutSeconds}s`,
  noConnectionReuse: !workload.reuseConnections, noVUConnectionReuse: !workload.reuseConnections,
  maxRedirects: workload.redirects, summaryTrendStats: ['min', 'med', 'p(95)', 'max', 'count'],
  tags: { sample: __ENV.QEL_SAMPLE_ID },
};

http.setResponseCallback(http.expectedStatuses(200));

function measure(phase, tags = {}) {
  const sentAt = Date.now();
  const response = http.get(workload.endpoint, {
    timeout: `${workload.requestTimeoutMs}ms`, redirects: workload.redirects, tags: { phase },
  });
  let valid = false;
  if (response.status === 200 && (response.headers['Content-Type'] ?? '').split(';')[0] === 'application/json') {
    try {
      const items = response.json('items');
      valid = Array.isArray(items) && items.map(item => item.id).join(',') === 'field-notebook,desk-notebook';
    } catch {
      // A malformed body is counted as a failed observation.
    }
  }
  const outcome = valid ? 'success' : response.error_code === 1050 || response.error_code === 1211 ? 'timeout' : 'error';
  attempts.add(1, { phase, outcome, sentAt: String(sentAt), ...tags });
  if (phase === 'measurement' && valid) latency.add(response.timings.duration, { phase });
  return sentAt;
}

export function setup() {
  for (let index = 0; index < workload.warmupRequests; index++) {
    const sentAt = measure('warmup');
    sleep(Math.max(0, workload.warmupPacingMs - (Date.now() - sentAt)) / 1000);
  }
}

export default function () {
  measure('measurement', { vu: String(execution.vu.idInTest), windowStart: String(execution.scenario.startTime) });
}

export function handleSummary(data) {
  return { '/reports/summary.json': JSON.stringify(data, null, 2) };
}
