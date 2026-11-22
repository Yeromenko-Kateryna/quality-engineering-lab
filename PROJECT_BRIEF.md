# Quality Engineering Lab — Project Brief

- **Status** — QEL-1 through QEL-6 accepted. QEL-7 portfolio close is under local review, with final hosted acceptance pending.
- **Architecture** — [Accepted technical contract v0.2](docs/architecture/QEL_ARCHITECTURE_IMPLEMENTATION_PLAN_v0.2.md)
- **Review** — Independent Architecture Delta Review, 2026-11-22, `ACCEPT`, `ARCHITECTURE_READY = YES` (design-level only).
- **Audience** — Junior QA Automation / Junior SDET reviewers in Germany/DACH and remote EU.

> The architecture file is the unchanged v0.2 artifact and retains its pre-review header (`PROPOSED — DELTA REVIEW REQUIRED`). The later independent delta review accepted all five mandatory changes. This brief records that later decision; it does not modify or supersede the technical contracts in v0.2.

## Mission

Build a reproducible non-functional quality engineering lab that detects performance, accessibility, and security regressions in a controlled web application through measurable checks, CI quality gates, and traceable reports.

## Portfolio differentiation

ReqGuard demonstrates system/integration QA (UI → API → PostgreSQL → CI) and deterministic AI-quality mechanics. QEL demonstrates non-functional quality engineering: performance, accessibility, and a narrow general security baseline. Reuse testing tools only as supporting infrastructure; do not recreate ReqGuard's broad UI/API/DB suites.

## MVP system under test

One small TypeScript/Fastify application, with immutable synthetic data, HTML Catalogue and Search pages, and read-only HTTP endpoints:

- `GET /health` — readiness without sensitive diagnostics.
- `GET /api/items` — deterministic catalogue data.
- `GET /api/search` — matching results, valid empty results, and explicit invalid-input feedback.

No database, authentication, public deployment, external application APIs, user data, or persistent shared services.

### Controlled regression switches

SUT-only, validated at startup and safe by default:

- `LAB_DELAY_MS` — delays observable `/api/search` response latency while keeping the response payload unchanged.
- `LAB_A11Y_DEFECT` — removes the accessible name of the designated search input.
- `LAB_SECURITY_DEFECT` — removes the applicable CSP response header from HTML pages.

These switches must **never** control test assertions, thresholds, or report interpretation. The k6, axe, and HTTP checks observe public HTTP and DOM behavior independently.

## Implemented quality dimensions

| Dimension | Verification | Claim boundary |
|---|---|---|
| Performance | Required functional k6 smoke and separate local baseline calibration | No approved numerical latency threshold or production-capacity claim |
| Accessibility | Playwright + axe-core and selected keyboard/focus tests | Automated checks do not prove WCAG conformance |
| Security | CSP assertions, scoped passive ZAP Baseline, npm audit | No pentest/certification or arbitrary public scans |
| CI/evidence | Compose lifecycle, GitHub Actions, five-state outcomes, validated receipts | Code/config alone is not execution evidence |

## Critical constraints

1. Security/load runners target only the allowed controlled SUT origin (`http://sut:3000`) in the approved internal Docker network. Validate target boundaries before scanning. No external targets, host networking, or active scans in MVP.
2. Each local/CI profile owns its Compose project and disposable outputs. Cleanup must not affect unowned/shared resources.
3. Performance comparison uses fixed workload inputs and qualified environment; numerical latency gates require prior calibration and policy approval. No invented thresholds.
4. Required checks distinguish `PASS`, `FAIL`, `TOOL_ERROR`, `INCONCLUSIVE`, and `NOT_RUN`; no absent or corrupt mandatory report can become `PASS`.
5. Required evidence binds actual commit, run identity, environment, scenario, gate policy, outcome, and native report. No invented CI results or metrics.
6. Secrets, personal data, paid external services, public deployment, pushes, PR creation, and destructive shared-resource actions require appropriate owner authorization; read-only repository access does not authorize external writes.

## Delivery gates

- **QEL-0 — ACCEPTED:** design v0.2 accepted by independent delta review on 2026-11-22 (5/5 changes, zero mandatory architecture blockers).
- **QEL-0.5 — LOCAL SETUP:** user created `Yeromenko-Kateryna/quality-engineering-lab` and cloned it locally; initial README and `.gitignore` exist.
- **QEL-1 — ACCEPTED:** runnable SUT, safe configuration switches, internal Compose network and scoped cleanup.
- **QEL-2 through QEL-4 — ACCEPTED:** k6 smoke, accessibility and keyboard checks, CSP checks, scoped passive ZAP and npm audit. The QEL-4 revision added the `nosniff` response hook after triage of rule `10021`.
- **QEL-5 — ACCEPTED:** hosted CI-G01, native evidence and receipts, with the QEL-5R shared-image teardown correction.
- **QEL-6 — ACCEPTED:** local controlled regressions and performance eligibility. PERF-G02 remains optional and the local qualification decision is `INCONCLUSIVE`.
- **QEL-7 — PORTFOLIO CLOSE:** documentation and local verification, followed by separate Coordinator acceptance at the published documentation revision.

## Portfolio definition of done

QEL can be called portfolio-ready only after an independently reproducible SUT and quality checks, approved measurable gates, actual revision-bound CI and native reports, at least one real baseline → injected FAIL → recovery PASS case, documented triage, and honest limitations. Portfolio readiness does not mean production release.

The [Portfolio DoD](docs/portfolio-dod.md) records evidence and remaining conditions for each criterion.

## Stop conditions and authority

The owner approves external publication/remote mutation, privileged access, destructive shared changes, and costs. The architect owns material changes to SUT, security/performance/evidence boundaries. The coordinator owns current gate and scope. Codex may implement, test, repair, and report only within an approved local task. Stop and escalate rather than silently alter accepted architecture or permissions.

## Current evidence status

Hosted run `45060111440`, attempt `1`, verified CI-G01 at `a18f6d6517235f5a89e8717f11ceb94165e51913`. Artifact `14769122504` was independently retrieved on 2026-11-22. The [evidence index](evidence/README.md) records native archive availability, the local regression and calibration runs, and their claim boundaries. Final hosted verification of the QEL-7 documentation revision is `NOT_RUN`.
