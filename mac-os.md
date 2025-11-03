### macOS support for Ensemble onboarding workflows

#### Problem
- Goal: Run the Observability Onboarding “Host (OTel)” workflow under Ensemble on macOS with the same stability as Linux.
- Issues observed:
  - OTel hostmetrics starts slower on macOS; CPU utilization (a rate metric) can show NaN for minutes.
  - Samples used by the snippet didn’t guarantee required semconv fields (e.g., `metrics.system.cpu.logical.count`, `system.load.*`) were enabled.
  - KPI queries could miss OTel datasets unless recognized correctly by Kibana.

### Scope
- Enable macOS in Ensemble by:
  - Making the OTel quickstart snippet emit the required semconv metrics deterministically and sooner.
  - Ensuring Kibana recognizes OTel hostmetrics datasets for Hosts KPIs.
  - Hardening E2E test waits to tolerate slow starts without flakiness.

### Changes (by area)

- Onboarding UI (OTel Host quickstart)
  - `x-pack/solutions/observability/plugins/observability_onboarding/public/application/quickstart_flows/otel_logs/build_install_command.ts`
    - Reduces `collection_interval` to 15s (when metrics onboarding is enabled) to speed up first CPU utilization value.
    - Writes a companion `otel.overlay.yml` enabling required semconv metrics:
      - `metrics.system.cpu.utilization`
      - `metrics.system.cpu.logical.count`
      - `system.load.1`, `system.load.5`, `system.load.15`
    - Includes both receiver keys for compatibility: `hostmetrics/system` and `hostmetrics`.
  - `x-pack/solutions/observability/plugins/observability_onboarding/public/application/quickstart_flows/otel_logs/index.tsx`
    - Start command now loads both configs and is hardened on macOS:
      - Linux: `sudo ./otelcol --config otel.yml --config otel.overlay.yml`
      - Mac: `xattr -dr com.apple.quarantine ./otelcol || true && chmod +x ./otelcol && ./otelcol --config otel.yml --config otel.overlay.yml`
  - `x-pack/solutions/observability/plugins/observability_onboarding/public/application/quickstart_flows/otel_logs/build_install_command.test.ts`
    - Updated unit tests to reflect the new command content (interval tweak + overlay).

- Backend dataset/schema recognition (Hosts KPIs)
  - `x-pack/solutions/observability/plugins/metrics_data_access/common/constants.ts`
    - Adds `HOST_METRICS_OTEL_DATASETS = ['hostmetricsreceiver.otel', 'otelcol.hostmetrics']`.
  - `x-pack/solutions/observability/plugins/metrics_data_access/common/index.ts`
    - Re-exports `HOST_METRICS_OTEL_DATASETS`.
  - `x-pack/solutions/observability/plugins/metrics_data_access/common/inventory_models/host/index.ts`
    - For semconv schema, uses `terms` on `data_stream.dataset` with `HOST_METRICS_OTEL_DATASETS`.
  - `x-pack/solutions/observability/plugins/infra/server/routes/metrics_sources/index.ts`
    - In `hasData` and `time_range_metadata`, uses `termsQuery(data_stream.dataset, ...HOST_METRICS_OTEL_DATASETS)` in OTel branches.

- E2E hardening
  - `x-pack/solutions/observability/plugins/observability_onboarding/e2e/playwright/stateful/host_otel.spec.ts`
    - Writes the combined snippet file for Ensemble to execute.
    - Adds a settle wait to accommodate macOS startup.
    - Selects “Mac” platform when `process.env.OS_NAME === 'darwin'`.
  - `x-pack/solutions/observability/plugins/observability_onboarding/e2e/playwright/stateful/pom/pages/hosts_overview.page.ts`
    - Uses a bounded polling helper with backoff to wait for KPI text like `\d+%$`.

### Why this fixes macOS NaN
- CPU utilization is a rate metric requiring two scrapes; reducing `collection_interval` to 15s yields a value within ~30–45s instead of ~2+ minutes.
- The overlay guarantees required semconv fields exist regardless of which sample the distro delivers.
- Kibana backend recognizes both known OTel hostmetrics dataset names and uses the semconv schema.
- The test’s bounded wait bridges remaining startup variance.
- macOS start hardening (quarantine removal + `chmod +x`) ensures the collector launches promptly.

### Validation checklist
- After running the snippet, verify recent documents contain:
  - `metrics.system.cpu.logical.count`
  - `metrics.system.cpu.utilization`
  - `system.load.1`, `system.load.5`, `system.load.15`

Example quick checks (Dev Tools):

```json
POST metrics-*/_search
{
  "size": 1,
  "sort": [{"@timestamp": "desc"}],
  "query": {"exists": {"field": "metrics.system.cpu.logical.count"}}
}
```

```json
POST metrics-*/_search
{
  "size": 1,
  "sort": [{"@timestamp": "desc"}],
  "query": {"exists": {"field": "metrics.system.cpu.utilization"}}
}
```

```json
POST metrics-*/_search
{
  "size": 1,
  "sort": [{"@timestamp": "desc"}],
  "query": {"exists": {"field": "system.load.1"}}
}
```

### Impact
- Faster first KPI values for macOS and Linux during onboarding.
- Minimal overhead: higher scrape frequency only in the quickstart snippet; not a production baseline.
- Other onboarding flows (logs-only, APM, Kubernetes, Firehose, auto-detect) remain unaffected.

### Rollback
- Revert the snippet generator and start command changes if necessary:
  - `build_install_command.ts` and `index.tsx`.
  - Revert unit test expectations in `build_install_command.test.ts`.

### Follow-ups
- If KPIs still display NaN after fields exist, re-check ESS deployment includes:
  - `HOST_METRICS_OTEL_DATASETS` usage in constants and routes.
  - `termsQuery` on `data_stream.dataset` for OTel branches.
- If a distro variant uses a different receiver instance name (e.g., `hostmetrics/host`), add it to the overlay.

### Issue context (summary)
- Ensemble intended to support macOS runs for the Host (OTel) onboarding workflow.
- OS info is passed via environment variables (`OS_NAME`, `OS_VERSION`, `OS_ARCH`); tests adapt platform selection accordingly.
- The core fix focuses on data readiness (overlay-enabled semconv metrics + faster scrapes), Kibana query recognition of OTel datasets, and macOS startup hardening.


