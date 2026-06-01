/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Page, Response } from '@playwright/test';
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

interface HasDataResponseBody {
  hasData?: boolean;
  hasLogs?: boolean;
  hasMetrics?: boolean;
  hasPreExistingData?: boolean;
}

type DiagnosticEventValue = string | number | boolean | null | HasDataResponseBody;

interface DiagnosticEvent {
  '@timestamp': string;
  type: string;
  [key: string]: DiagnosticEventValue;
}

const appendDiagnosticEvent = (
  diagnosticEventsPath: string,
  event: Omit<DiagnosticEvent, '@timestamp'>
): void => {
  fs.appendFileSync(
    diagnosticEventsPath,
    `${JSON.stringify({ '@timestamp': new Date().toISOString(), ...event })}\n`
  );
};

const extractOnboardingIdFromInstallStackSnippet = (installStackSnippet: string): string | null => {
  return (
    installStackSnippet.match(/onboarding_id\.attributes\[0\]\.value=([^'\\\s]+)/)?.[1] ?? null
  );
};

const extractOnboardingIdFromHasDataUrl = (url: string): string | null => {
  return (
    url.match(/\/internal\/observability_onboarding\/kubernetes\/([^/]+)\/has-data/)?.[1] ?? null
  );
};

const readHasDataResponseBody = async (
  response: Response
): Promise<HasDataResponseBody | string> => {
  try {
    return (await response.json()) as HasDataResponseBody;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const registerHasDataProbeLogger = (page: Page, hasDataProbePath: string): (() => void) => {
  const responseListener = async (response: Response): Promise<void> => {
    const url = response.url();

    if (
      !url.includes('/internal/observability_onboarding/kubernetes/') ||
      !url.includes('/has-data')
    ) {
      return;
    }

    appendDiagnosticEvent(hasDataProbePath, {
      type: 'has_data_response',
      onboardingId: extractOnboardingIdFromHasDataUrl(url),
      status: response.status(),
      url,
      body: await readHasDataResponseBody(response),
    });
  };

  page.on('response', responseListener);

  return () => page.off('response', responseListener);
};

test('Otel Kubernetes', async ({
  page,
  onboardingHomePage,
  otelKubernetesFlowPage,
  wiredStreamsSelector,
}, testInfo) => {
  assertEnv(process.env.ARTIFACTS_FOLDER, 'ARTIFACTS_FOLDER is not defined.');

  const isLogsEssentialsMode = process.env.LOGS_ESSENTIALS_MODE === 'true';
  const useWiredStreams = process.env.USE_WIRED_STREAMS === 'true';
  const fileName = 'code_snippet_otel_kubernetes.sh';
  const outputPath = path.join(__dirname, '..', process.env.ARTIFACTS_FOLDER, fileName);
  const retryPrefix = `k8s_otel_retry_${testInfo.retry}`;
  const diagnosticEventsPath = path.join(
    __dirname,
    '..',
    process.env.ARTIFACTS_FOLDER,
    `${retryPrefix}_events.ndjson`
  );
  const hasDataProbePath = path.join(
    __dirname,
    '..',
    process.env.ARTIFACTS_FOLDER,
    `${retryPrefix}_has_data.ndjson`
  );
  const retrySnippetFileName = `code_snippet_otel_kubernetes.retry-${testInfo.retry}.sh`;
  const retrySnippetPath = path.join(
    __dirname,
    '..',
    process.env.ARTIFACTS_FOLDER,
    retrySnippetFileName
  );
  const metadataFileName = `code_snippet_otel_kubernetes.retry-${testInfo.retry}.metadata.json`;
  const metadataPath = path.join(__dirname, '..', process.env.ARTIFACTS_FOLDER, metadataFileName);
  const stopHasDataProbeLogger = registerHasDataProbeLogger(page, hasDataProbePath);

  appendDiagnosticEvent(diagnosticEventsPath, {
    type: 'test_started',
    retry: testInfo.retry,
    repeatEachIndex: testInfo.repeatEachIndex,
    workerIndex: testInfo.workerIndex,
    isLogsEssentialsMode,
    useWiredStreams,
  });

  await onboardingHomePage.selectKubernetesUseCase();
  await onboardingHomePage.selectOtelKubernetesQuickstart();

  await otelKubernetesFlowPage.copyHelmRepositorySnippetToClipboard();
  const helmRepoSnippet = (await page.evaluate('navigator.clipboard.readText()')) as string;

  if (useWiredStreams) {
    await wiredStreamsSelector.selectWiredStreamsMode();
  }

  await otelKubernetesFlowPage.copyInstallStackSnippetToClipboard();
  const installStackSnippet = (await page.evaluate('navigator.clipboard.readText()')) as string;
  const onboardingId = extractOnboardingIdFromInstallStackSnippet(installStackSnippet);

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
  fs.writeFileSync(retrySnippetPath, codeSnippet);
  fs.writeFileSync(outputPath, codeSnippet);
  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        retry: testInfo.retry,
        repeatEachIndex: testInfo.repeatEachIndex,
        workerIndex: testInfo.workerIndex,
        onboardingId,
        canonicalSnippetFileName: fileName,
        retrySnippetFileName,
        hasDataProbeFileName: path.basename(hasDataProbePath),
        diagnosticEventsFileName: path.basename(diagnosticEventsPath),
      },
      null,
      2
    )}\n`
  );
  appendDiagnosticEvent(diagnosticEventsPath, {
    type: 'snippet_written',
    retry: testInfo.retry,
    onboardingId,
    canonicalSnippetFileName: fileName,
    retrySnippetFileName,
    metadataFileName,
  });

  /**
   * The page waits for the browser window to lose
   * focus as a signal to start checking for incoming data
   */
  await page.evaluate('window.dispatchEvent(new Event("blur"))');
  appendDiagnosticEvent(diagnosticEventsPath, {
    type: 'data_detection_triggered',
    retry: testInfo.retry,
    onboardingId,
  });

  /**
   * Wait for the data received indicator to appear.
   * The flow now uses DataIngestStatus which polls for data
   * after the blur event and shows "We are monitoring your cluster"
   * once both logs and metrics have arrived.
   */
  try {
    await otelKubernetesFlowPage.assertDataReceivedIndicator();
    appendDiagnosticEvent(diagnosticEventsPath, {
      type: 'data_received_indicator_visible',
      retry: testInfo.retry,
      onboardingId,
    });
  } catch (error) {
    appendDiagnosticEvent(diagnosticEventsPath, {
      type: 'data_received_indicator_failed',
      retry: testInfo.retry,
      onboardingId,
      error: error instanceof Error ? error.message : String(error),
      pageUrl: page.url(),
    });
    throw error;
  } finally {
    stopHasDataProbeLogger();
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
});
