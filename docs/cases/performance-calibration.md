# Local performance calibration

Run on a host with the repository's Node, Docker and Compose prerequisites. Keep other performance workloads stopped until the batch completes. Run the controlled regressions first when reproducing the entire QEL-6 exercise.

```powershell
node --test performance/calibration.test.mjs
node performance/calibrate.mjs run
$runId = Read-Host 'Run ID printed above'
node performance/calibrate.mjs verify $runId
```

The calibration repeats the same workload on three sequential, fresh internal Compose projects using a single SUT image. Each uses digest-pinned k6 2.3.0, one runner CPU, 256 MiB of runner memory, a fixed search target, connection reuse, no redirects and a two-second request timeout. The setup phase warms the endpoint with five sequential requests paced at a minimum of one second each. The measured phase starts afterward and runs five constant VUs for 30 seconds with a one-second minimum iteration duration and up to three seconds of graceful completion for requests started in the window. Health checks and warm-up never enter the latency trend. In this closed workload, slower responses can reduce the achieved request rate.

`logs/qel6b-<run-id>/` contains the batch fingerprint, per-instance Docker commands and native exits, and the original k6 `summary.json` and `samples.ndjson` for every run. `decision.json` records artifact SHA-256 hashes, request rate over the 30-second admission window, errors and timeouts, and p50/p95 from successful measured requests only. `verify` checks summaries against the native points, confirms warm-up order, pacing and run identity, and checks that recorded artifact hashes still match.

The validator reports `TOOL_ERROR` for missing or contradictory mandatory evidence. Valid local evidence remains `INCONCLUSIVE` for PERF-G02 until the runner class and numerical policy are approved. The diagnostic screens flag fewer than 100 successful observations in a run, a p95 range larger than 25% of the run median, or a request-rate range larger than 10% of the run median. These screens prompt investigation. They provide no latency budget or confidence guarantee. Before/after Docker inventory can flag visible activity changes. It cannot measure all host contention.

## Observed baseline

**LOCAL-ONLY — NOT PUBLICLY RETRIEVABLE.** Batch `15e9becfef4e4b9aa215760ed37cfaad` used Docker Desktop with Linux engine 29.9.3, Compose 5.7.0 and the Linux amd64 k6 2.3.0 image. Each repetition had five successful warm-up requests and 150 successful measured requests at 5.00 requests/s. All three native exits were `0`, with zero failures or timeouts. The local `decision.json` records the native artifacts and hashes. [Evidence index](../../evidence/README.md#local-performance-calibration)

| Sample suffix | p50 | p95 |
| --- | ---: | ---: |
| `-1` | 1.404 ms | 2.870 ms |
| `-2` | 1.616 ms | 2.902 ms |
| `-3` | 1.597 ms | 3.091 ms |

The p95 range was 0.220 ms, or 7.6% of the median p95. About seven or eight observations per run occupy the upper 5%. The request rate was identical in these short runs, where latency remained well below the pacing interval. Docker had no unrelated running containers at the before/after checks. The host remains unqualified for a latency gate because these runs do not characterize day-to-day contention or stability. The comparison is `INCONCLUSIVE` and no numerical threshold proposal is justified. The optional delay sensitivity experiment is `NOT_RUN` because this batch was limited to baseline calibration on the unqualified host.

A numerical budget would need repeated measurements across sessions on a qualified runner with monitored contention and enough successful samples to characterize the tail. A later sensitivity comparison would need matched workload, source, dataset and runner conditions. Owner approval is required before any numerical policy can gate CI. [Workload](../../performance/search-calibration.js) · [Eligibility validator](../../performance/calibration-evidence.mjs)
