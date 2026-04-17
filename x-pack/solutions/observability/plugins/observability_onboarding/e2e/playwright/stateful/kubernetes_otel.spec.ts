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

  /**
   * Diagnostic capture (temporary, for the k8s-otel-ensemble-diag branch).
   * Records onboardingId, every /has-data poll, console/page errors, and
   * timing milestones, then writes a single JSON artifact in `finally` so we
   * get it even on test timeout. Delete this block once the ensemble
   * failure mode is identified.
   */
  const diagStartedAt = Date.now();
  const diagPath = path.join(__dirname, '..', process.env.ARTIFACTS_FOLDER, 'has_data_probes.json');
  let capturedOnboardingId: string | undefined;
  let blurDispatchedAt: number | undefined;
  let assertionResolvedAt: number | undefined;
  let assertionError: string | undefined;
  const probes: Array<{ tMs: number; url: string; status: number; body: string }> = [];
  const flowResponses: Array<{ tMs: number; status: number; body: string }> = [];
  const consoleMessages: Array<{ tMs: number; type: string; text: string }> = [];
  const pageErrors: Array<{ tMs: number; message: string }> = [];

  page.on('response', async (response) => {
    const url = response.url();
    const now = Date.now() - diagStartedAt;
    if (
      url.includes('/internal/observability_onboarding/kubernetes/flow') &&
      response.request().method() === 'POST'
    ) {
      let text = '';
      try {
        text = await response.text();
        const parsed = JSON.parse(text);
        if (typeof parsed?.onboardingId === 'string') {
          capturedOnboardingId = parsed.onboardingId;
        }
      } catch {
        text = text || '<read-failed>';
      }
      flowResponses.push({ tMs: now, status: response.status(), body: text });
      return;
    }
    if (url.includes('/has-data')) {
      let text = '';
      try {
        text = await response.text();
      } catch {
        text = '<read-failed>';
      }
      probes.push({ tMs: now, url, status: response.status(), body: text });
    }
  });

  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      consoleMessages.push({
        tMs: Date.now() - diagStartedAt,
        type,
        text: msg.text(),
      });
    }
  });

  page.on('pageerror', (err) => {
    pageErrors.push({
      tMs: Date.now() - diagStartedAt,
      message: err.message,
    });
  });

  const writeDiag = () => {
    try {
      fs.writeFileSync(
        diagPath,
        JSON.stringify(
          {
            onboardingId: capturedOnboardingId,
            diagStartedAt,
            blurDispatchedAt,
            blurDelayMs: blurDispatchedAt !== undefined ? blurDispatchedAt - diagStartedAt : null,
            assertionResolvedAt,
            assertionError,
            probeCount: probes.length,
            probes,
            flowResponses,
            consoleMessages,
            pageErrors,
          },
          null,
          2
        )
      );
    } catch {
      // best effort — don't mask the original test failure
    }
  };

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

    let codeSnippet: string;

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
    blurDispatchedAt = Date.now();
    await page.evaluate('window.dispatchEvent(new Event("blur"))');

    /**
     * Wait for the data received indicator to appear.
     * The flow now uses DataIngestStatus which polls for data
     * after the blur event and shows "We are monitoring your cluster"
     * once both logs and metrics have arrived.
     */
    try {
      await otelKubernetesFlowPage.assertDataReceivedIndicator();
      assertionResolvedAt = Date.now();
    } catch (err) {
      assertionError = err instanceof Error ? err.message : String(err);
      throw err;
    }

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
    writeDiag();
  }
});
