/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { test } from './fixtures/base_page';
import { assertEnv } from '../lib/assert_env';
import { OtelKubernetesOverviewDashboardPage } from './pom/pages/otel_kubernetes_overview_dashboard.page';
import { ApmServiceInventoryPage } from './pom/pages/apm_service_inventory.page';
import { assertDiscoverHasData, assertStreamHasData } from '../lib/validation_helpers';

/**
 * In case you need to run this test locally, you can use https://github.com/elastic/oblt-reference-stack
 * to spin up a local k8s cluster with the required resources.
 */

// Diagnostic: disable playwright's own retries for this spec so each Ensemble
// attempt is a single ~400s cycle instead of up to 3*400s. Combined with
// Ensemble step retry: max: 1, this makes the post-failure diag capture run
// after ~7 minutes instead of ~60. Remove once the Serverless flake is fixed.
test.describe.configure({ retries: 0 });

test.beforeEach(async ({ page, onboardingHomePage }) => {
  await page.goto(`${process.env.KIBANA_BASE_URL}/app/observabilityOnboarding`);
  await onboardingHomePage.maybeClickIntroducingAIAgentModalContinueBtn();
});

/**
 * These constants are used by Ensemble test
 * when creating the app container. They should
 * be kept in sync.
 */
const INSTRUMENTED_APP_CONTAINER_NAMESPACE = 'java';
const INSTRUMENTED_APP_NAME = 'java-app';

test('Otel Kubernetes', async ({
  page,
  onboardingHomePage,
  otelKubernetesFlowPage,
  wiredStreamsSelector,
}) => {
  assertEnv(process.env.ARTIFACTS_FOLDER, 'ARTIFACTS_FOLDER is not defined.');

  const isLogsEssentialsMode = process.env.LOGS_ESSENTIALS_MODE === 'true';
  const useWiredStreams = process.env.USE_WIRED_STREAMS === 'true';
  const fileName = 'code_snippet_otel_kubernetes.sh';
  const outputPath = path.join(__dirname, '..', process.env.ARTIFACTS_FOLDER, fileName);

  // Temporary diagnostic: record every /has-data poll with a relative
  // timestamp so we can tell whether timeouts are a budget problem
  // (data arrives late) or a pipeline problem (data never arrives).
  // Remove once the root cause of Kubernetes OTel / Serverless flakes is confirmed.
  const diagStartedAt = Date.now();
  const diagPath = path.join(__dirname, '..', process.env.ARTIFACTS_FOLDER, 'has_data_probes.json');
  const probes: Array<{ tMs: number; status: number; body: string }> = [];
  page.on('response', async (response) => {
    if (!response.url().includes('/has-data')) return;
    let body = '';
    try {
      body = await response.text();
    } catch {
      body = '<read-failed>';
    }
    probes.push({
      tMs: Date.now() - diagStartedAt,
      status: response.status(),
      body,
    });
  });

  // Declared outside the try so the finally block can recover the onboarding_id
  // embedded in the snippet for the ES state dump.
  let codeSnippet: string | undefined;

  try {
    await onboardingHomePage.selectKubernetesUseCase();
    await onboardingHomePage.selectOtelKubernetesQuickstart();

    await otelKubernetesFlowPage.copyHelmRepositorySnippetToClipboard();
    const helmRepoSnippet = (await page.evaluate('navigator.clipboard.readText()')) as string;

    if (useWiredStreams) {
      await wiredStreamsSelector.selectWiredStreamsMode();
    }

    await otelKubernetesFlowPage.copyInstallStackSnippetToClipboard();
    const installStackSnippet = (await page.evaluate('navigator.clipboard.readText()')) as string;

    if (!isLogsEssentialsMode && !useWiredStreams) {
      /**
       * Getting the snippets and replacing placeholder
       * with the values used by Ensemble
       */
      await otelKubernetesFlowPage.switchInstrumentationInstructions('java');
      const annotateAllResourceSnippet = (
        await otelKubernetesFlowPage.getAnnotateAllResourceSnippet()
      )?.replace('my-namespace', INSTRUMENTED_APP_CONTAINER_NAMESPACE);
      const restartDeploymentSnippet = (await otelKubernetesFlowPage.getRestartDeploymentSnippet())
        ?.split('\n')[0]
        ?.replace('myapp', INSTRUMENTED_APP_NAME)
        ?.replace('my-namespace', INSTRUMENTED_APP_CONTAINER_NAMESPACE);
      /**
       * Adding timeout so Ensemble waits for the
       * pods to be created before instrumenting the app
       */
      const sleepSnippet = `sleep 120`;

      codeSnippet = `${helmRepoSnippet}\n${installStackSnippet}\n${sleepSnippet}\n${annotateAllResourceSnippet}\n${restartDeploymentSnippet}`;
    } else {
      codeSnippet = `${helmRepoSnippet}\n${installStackSnippet}`;
    }

    /**
     * Ensemble story watches for the code snippet file
     * to be created and then executes it
     */
    fs.writeFileSync(outputPath, codeSnippet);

    /**
     * The page waits for the browser window to lose
     * focus as a signal to start checking for incoming data
     */
    await page.evaluate('window.dispatchEvent(new Event("blur"))');

    /**
     * Wait for the data received indicator to appear.
     * The flow now uses DataIngestStatus which polls for data
     * after the blur event and shows "We are monitoring your cluster"
     * once both logs and metrics have arrived.
     */
    await otelKubernetesFlowPage.assertDataReceivedIndicator();

    /**
     * Additional buffer to ensure data has propagated
     * to dashboards and Discover before navigating.
     */
    await page.waitForTimeout(2 * 60000);

    /**
     * Wired streams only reroutes logs (to logs.otel); metrics and traces are
     * unaffected. So for wired streams we validate log delivery via Discover and
     * the Streams page, and intentionally skip the Cluster Overview dashboard
     * and APM Service Inventory checks. Dashboard/APM validation is already
     * covered by the non-wired test variants.
     *
     * Both "wired streams" and "wired streams + logs essentials" fall into this
     * single branch because the validation path is identical for both.
     */
    if (useWiredStreams) {
      await otelKubernetesFlowPage.clickExploreLogsCTA();
      await assertDiscoverHasData(page, { assertHitCount: true });
      await assertStreamHasData(page, 'logs.otel');
    } else if (!isLogsEssentialsMode) {
      const otelKubernetesOverviewDashboardPage = new OtelKubernetesOverviewDashboardPage(
        await otelKubernetesFlowPage.openClusterOverviewDashboardInNewTab()
      );

      await otelKubernetesOverviewDashboardPage.assertNodesPanelNotEmpty();

      const apmServiceInventoryPage = new ApmServiceInventoryPage(
        await otelKubernetesFlowPage.openServiceInventoryInNewTab()
      );

      const serviceTestId = 'serviceLink_opentelemetry/java/elastic';

      await apmServiceInventoryPage.page.getByTestId(serviceTestId).click();
      await apmServiceInventoryPage.assertTransactionExists();
    } else {
      await otelKubernetesFlowPage.clickExploreLogsCTA();
      await assertDiscoverHasData(page);
    }
  } finally {
    try {
      fs.writeFileSync(diagPath, JSON.stringify({ probes }, null, 2));
    } catch {
      // best-effort — don't mask the original test failure
    }

    // Best-effort ES state dump: queries ES via the Kibana Console proxy to
    // split "OTel pipeline never delivered" from "Kibana /has-data query wrong".
    // If counts are 0 at timeout, the pipeline is broken (managed OTLP -> ES).
    // If counts are non-zero, /has-data logic is failing to match the data.
    try {
      const onboardingIdMatch = (process.env.ONBOARDING_ID ?? '').match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
      );
      const snippetOnboardingId =
        typeof codeSnippet === 'string'
          ? codeSnippet.match(
              /onboarding_id\.attributes\[0\]\.value=([0-9a-f-]{36})/
            )?.[1]
          : undefined;
      const onboardingId = onboardingIdMatch?.[0] ?? snippetOnboardingId;

      const proxy = async (esPath: string, method: 'GET' | 'POST' = 'GET', body?: unknown) => {
        const qs = new URLSearchParams({ path: esPath, method });
        const resp = await page.request.post(
          `${process.env.KIBANA_BASE_URL}/api/console/proxy?${qs.toString()}`,
          {
            headers: { 'kbn-xsrf': 'true' },
            data: body,
            failOnStatusCode: false,
          }
        );
        let parsed: unknown;
        const text = await resp.text().catch(() => '<read-failed>');
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        return { status: resp.status(), body: parsed };
      };

      const indexPatterns = [
        'logs-*',
        'metrics-*',
        'logs.otel*',
        'metrics.otel*',
        'logs.ecs*',
        'metrics.ecs*',
      ];

      const onboardingIdQuery = onboardingId && {
        query: {
          bool: {
            should: [
              { term: { 'fields.onboarding_id': onboardingId } },
              { term: { 'resource.attributes.onboarding.id': onboardingId } },
              { term: { 'labels.onboarding_id': onboardingId } },
            ],
            minimum_should_match: 1,
          },
        },
      };

      const dump = {
        onboardingId,
        indices: await proxy('_cat/indices/logs-*,metrics-*,logs.otel*,metrics.otel*?format=json'),
        counts: Object.fromEntries(
          await Promise.all(
            indexPatterns.map(async (p) => [p, await proxy(`${p}/_count`, 'POST', { query: { match_all: {} } })])
          )
        ),
        countsByOnboardingId: onboardingIdQuery
          ? Object.fromEntries(
              await Promise.all(
                indexPatterns.map(async (p) => [p, await proxy(`${p}/_count`, 'POST', onboardingIdQuery)])
              )
            )
          : undefined,
        sampleLogDoc: await proxy('logs-*/_search?size=1', 'POST', { query: { match_all: {} } }),
        sampleMetricDoc: await proxy('metrics-*/_search?size=1', 'POST', { query: { match_all: {} } }),
      };

      const esDumpPath = path.join(__dirname, '..', process.env.ARTIFACTS_FOLDER, 'es_state.json');
      fs.writeFileSync(esDumpPath, JSON.stringify(dump, null, 2));
    } catch {
      // best-effort — don't mask the original test failure
    }
  }
});
