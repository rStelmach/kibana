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

  // Diagnostic for the APM service inventory step. Written in finally so
  // we always have a trail, green or red. Populated by the response listener
  // and reload loop further below.
  const apmServiceName = `opentelemetry/java/elastic`;
  const apmProbePath = path.join(
    __dirname,
    '..',
    process.env.ARTIFACTS_FOLDER,
    'apm_service_probes.json'
  );
  // Captured /internal/apm/services responses as the inventory UI sees them.
  // Piggy-backing on the UI's own request avoids having to hand-construct the
  // route's ~8 required query params, and gives us ground-truth for which
  // {serviceName, agentName} pairs actually landed.
  const apmServiceCalls: Array<{
    tMs: number;
    status: number;
    requestUrl: string;
    services: Array<{ service: string; agent: string }>;
    errorBody?: string;
  }> = [];

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

      const serviceTestId = `serviceLink_${apmServiceName}`;

      // Open APM inventory in a new tab, but attach a response listener for
      // /internal/apm/services BEFORE the first navigation — otherwise we'd
      // race the initial inventory fetch. Inlines the two-step open so the
      // listener is in place before goto().
      const serviceInventoryHref = await page
        .getByTestId('observabilityOnboardingDataIngestStatusActionLink-services')
        .getAttribute('href');
      if (!serviceInventoryHref) {
        throw new Error('Service inventory URL not found');
      }

      const apmStartedAt = Date.now();
      const apmPage = await page.context().newPage();
      apmPage.on('response', async (response) => {
        if (!response.url().includes('/internal/apm/services')) return;
        // Filter out the sub-routes (e.g. /internal/apm/services/foo/...).
        // Only the top-level list endpoint is what the UI uses to populate rows.
        const requestUrl = response.url();
        const url = new URL(requestUrl);
        if (url.pathname !== '/internal/apm/services') return;
        const status = response.status();
        let services: Array<{ service: string; agent: string }> = [];
        let errorBody: string | undefined;
        if (status >= 400) {
          // Capture raw text for 4xx/5xx — response.json() on an error body
          // often throws and consumes the stream, leaving no trail.
          try {
            errorBody = await response.text();
          } catch {
            errorBody = '<read-failed>';
          }
        } else {
          try {
            const json = (await response.json()) as {
              items?: Array<{ serviceName?: string; agentName?: string }>;
            };
            const items = Array.isArray(json?.items) ? json.items : [];
            services = items.map((item) => ({
              service: item?.serviceName ?? '<missing>',
              agent: item?.agentName ?? '<missing>',
            }));
          } catch {
            // leave services empty; status alone is a useful signal
          }
        }
        apmServiceCalls.push({
          tMs: Date.now() - apmStartedAt,
          status,
          requestUrl,
          services,
          ...(errorBody !== undefined ? { errorBody } : {}),
        });
      });
      await apmPage.goto(serviceInventoryHref);
      const apmServiceInventoryPage = new ApmServiceInventoryPage(apmPage);

    const apmServiceName = 'opentelemetry/java/elastic';
    const apmProbePath = path.join(
      __dirname,
      '..',
      process.env.ARTIFACTS_FOLDER,
      'apm_service_probes.json'
    );
    const apmServiceCalls: Array<{
      tMs: number;
      status: number;
      requestUrl: string;
      services: Array<{ service: string; agent: string }>;
      errorBody?: string;
    }> = [];

    try {
      // Open the inventory in a new tab manually so the response listener is
      // attached before navigation — page.on('response') only catches future
      // events, and the inventory's mount-fetch fires immediately on goto.
      const serviceInventoryHref = await page
        .getByTestId('observabilityOnboardingDataIngestStatusActionLink-services')
        .getAttribute('href');
      if (!serviceInventoryHref) {
        throw new Error('Service inventory URL not found');
      }

      const apmStartedAt = Date.now();
      const apmPage = await page.context().newPage();
      apmPage.on('response', async (response) => {
        // Match only the top-level list endpoint, not /internal/apm/services/foo/...
        const url = new URL(response.url());
        if (url.pathname !== '/internal/apm/services') return;
        const status = response.status();
        let services: Array<{ service: string; agent: string }> = [];
        let errorBody: string | undefined;
        if (status >= 400) {
          try {
            errorBody = await response.text();
          } catch {
            errorBody = '<read-failed>';
          }
        } else {
          try {
            const json = (await response.json()) as {
              items?: Array<{ serviceName?: string; agentName?: string }>;
            };
            const items = Array.isArray(json?.items) ? json.items : [];
            services = items.map((item) => ({
              service: item?.serviceName ?? '<missing>',
              agent: item?.agentName ?? '<missing>',
            }));
          } catch {
            // leave services empty
          }
        }
        apmServiceCalls.push({
          tMs: Date.now() - apmStartedAt,
          status,
          requestUrl: response.url(),
          services,
          ...(errorBody !== undefined ? { errorBody } : {}),
        });
      });
      await apmPage.goto(serviceInventoryHref);
      const apmServiceInventoryPage = new ApmServiceInventoryPage(apmPage);

      const serviceTestId = `serviceLink_${apmServiceName}`;

      await apmServiceInventoryPage.waitForServiceRow(serviceTestId);
      await apmServiceInventoryPage.page.getByTestId(serviceTestId).click();
      await apmServiceInventoryPage.assertTransactionExists();
    } finally {
      try {
        fs.writeFileSync(
          apmProbePath,
          JSON.stringify({ serviceName: apmServiceName, calls: apmServiceCalls }, null, 2)
        );
      } catch {
        // best-effort - don't mask the original test failure
      }
    }
  } else {
    await otelKubernetesFlowPage.clickExploreLogsCTA();
    await assertDiscoverHasData(page);
  }
});
