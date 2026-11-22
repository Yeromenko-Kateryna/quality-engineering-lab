export const workload = Object.freeze({
  id: 'qel6-calibration-v1', endpoint: 'http://sut:3000/api/search?q=notebook',
  executor: 'constant-vus', vus: 5, durationSeconds: 30, minIterationMs: 1000,
  warmupRequests: 5, warmupPacingMs: 1000, setupTimeoutSeconds: 16,
  requestTimeoutMs: 2000, gracefulStopSeconds: 3, redirects: 0, reuseConnections: true,
});

export const k6Image = 'ghcr.io/grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8';
