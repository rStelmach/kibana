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
import { log } from '../lib/logger';
import { OtelKubernetesOverviewDashboardPage } from './pom/pages/otel_kubernetes_overview_dashboard.page';
import { ApmServiceInventoryPage } from './pom/pages/apm_service_inventory.page';

/**
 * In case you need to run this test locally, you can use https://github.com/elastic/oblt-reference-stack
 * to spin up a local k8s cluster with the required resources.
 */

test.beforeEach(async ({ page }) => {
  await page.goto(`${process.env.KIBANA_BASE_URL}/app/observabilityOnboarding`);
});

/**
 * These constants are used by Ensemble test
 * when creating the app container. They should
 * be kept in sync.
 */
const INSTRUMENTED_APP_CONTAINER_NAMESPACE = 'java';
const INSTRUMENTED_APP_NAME = 'java-app';
const isServerless = process.env.CLUSTER_ENVIRONMENT === 'serverless';

test('Otel Kubernetes', async ({ page, onboardingHomePage, otelKubernetesFlowPage }) => {
  assertEnv(process.env.ARTIFACTS_FOLDER, 'ARTIFACTS_FOLDER is not defined.');

  const isLogsEssentialsMode = process.env.LOGS_ESSENTIALS_MODE === 'true';
  const fileName = 'code_snippet_otel_kubernetes.sh';
  const outputPath = path.join(__dirname, '..', process.env.ARTIFACTS_FOLDER, fileName);

  await onboardingHomePage.selectKubernetesUseCase();
  await onboardingHomePage.selectOtelKubernetesQuickstart();

  await otelKubernetesFlowPage.copyHelmRepositorySnippetToClipboard();
  const helmRepoSnippet = (await page.evaluate('navigator.clipboard.readText()')) as string;

  await otelKubernetesFlowPage.copyInstallStackSnippetToClipboard();
  const installStackSnippet = (await page.evaluate('navigator.clipboard.readText()')) as string;

  let codeSnippet: string;

  if (!isLogsEssentialsMode) {
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
   * There is no explicit data ingest indication
   * in the flow, so we need to rely on a timeout.
   * 5 minutes should be enough for the stack to be
   * created and to start pushing data.
   */
  await page.waitForTimeout(5 * 60000);

  if (!isLogsEssentialsMode) {
    const otelKubernetesOverviewDashboardPage = new OtelKubernetesOverviewDashboardPage(
      await otelKubernetesFlowPage.openClusterOverviewDashboardInNewTab()
    );

    await otelKubernetesOverviewDashboardPage.assertNodesPanelNotEmpty();

    const apmServiceInventoryPage = new ApmServiceInventoryPage(
      await otelKubernetesFlowPage.openServiceInventoryInNewTab()
    );
    // Note: Logger to get agent.name
    const debugLog = (msg: string) => {
      log.info(msg);
      console.log(msg);
      process.stdout.write(`${msg}\n`);
    };

    const serviceTestId = isServerless
      ? 'serviceLink_java'
      : 'serviceLink_opentelemetry/java/elastic';

    debugLog('DEBUG: Waiting for service links to appear on the page...');

    /**
     * Wait for at least one service link to appear (max 2 min)
     * This ensures we capture the actual rendered services
     */
    try {
      await apmServiceInventoryPage.page
        .locator('[data-test-subj^="serviceLink_"]')
        .first()
        .waitFor({ state: 'visible', timeout: 120000 });
      debugLog('DEBUG: At least one service link is now visible');
    } catch {
      debugLog('DEBUG: WARNING - No service links appeared after 2 minutes!');
    }

    // Give a bit more time for all services to render
    await apmServiceInventoryPage.page.waitForTimeout(3000);

    debugLog('DEBUG: Collecting all serviceLink_* test IDs from Service Inventory page...');
    const allServiceLinks = await apmServiceInventoryPage.page
      .locator('[data-test-subj^="serviceLink_"]')
      .all();
    const serviceLinksDebug: string[] = [];
    for (const link of allServiceLinks) {
      const testId = await link.getAttribute('data-test-subj');
      const text = await link.textContent();
      const debugLine = `  - ${testId} (service: ${text?.trim()})`;
      serviceLinksDebug.push(debugLine);
      debugLog(`Found service link: ${testId} | service name: ${text?.trim()}`);
    }
    debugLog(`DEBUG: Total service links found: ${serviceLinksDebug.length}`);
    debugLog(`DEBUG: isServerless=${isServerless}, expected testId=${serviceTestId}`);

    // Check if the expected service link exists
    const expectedServiceExists = serviceLinksDebug.some((line) =>
      line.includes(serviceTestId)
    );
    debugLog(`DEBUG: Expected service link (${serviceTestId}) exists: ${expectedServiceExists}`);

    // Also check for the alternative agentName format
    const alternativeTestId = isServerless
      ? 'serviceLink_opentelemetry/java/elastic'
      : 'serviceLink_java';
    const alternativeExists = serviceLinksDebug.some((line) =>
      line.includes(alternativeTestId)
    );
    debugLog(
      `DEBUG: Alternative service link (${alternativeTestId}) exists: ${alternativeExists}`
    );

    const debugContent =
      `Service Links Debug (isServerless: ${isServerless})\n` +
      `Expected testId: ${serviceTestId}\n` +
      `Expected service exists: ${expectedServiceExists}\n` +
      `Alternative testId: ${alternativeTestId}\n` +
      `Alternative service exists: ${alternativeExists}\n` +
      `Found ${serviceLinksDebug.length} service links:\n${serviceLinksDebug.join('\n')}\n`;

    const debugFilePath = path.join(
      __dirname,
      '..',
      process.env.ARTIFACTS_FOLDER,
      'service_links_debug.txt'
    );
    fs.writeFileSync(debugFilePath, debugContent);
    debugLog(`DEBUG: Saved service links debug to ${debugFilePath}`);

    debugLog('DEBUG: === FULL SERVICE LINKS DEBUG OUTPUT ===');
    debugLog(debugContent);
    debugLog('DEBUG: === END OF DEBUG OUTPUT ===');

    /**
     * FLEXIBLE AGENT NAME HANDLING:
     * The EDOT Java agent can report different agent.name values:
     * - 'opentelemetry/java/elastic' (current EDOT behavior with v1.6.0+)
     * - 'java' (legacy or native APM agent behavior)
     *
     * We try the OTel format first (most common now), then fall back to legacy.
     * This handles both serverless and stateful environments consistently.
     */
    const primaryTestId = 'serviceLink_opentelemetry/java/elastic';
    const fallbackTestId = 'serviceLink_java';

    const primaryCount = await apmServiceInventoryPage.page
      .getByTestId(primaryTestId)
      .count();
    const fallbackCount = await apmServiceInventoryPage.page
      .getByTestId(fallbackTestId)
      .count();

    debugLog(`DEBUG: Primary testId (${primaryTestId}) count: ${primaryCount}`);
    debugLog(`DEBUG: Fallback testId (${fallbackTestId}) count: ${fallbackCount}`);

    let finalTestId: string;
    if (primaryCount > 0) {
      finalTestId = primaryTestId;
      debugLog(`DEBUG: Using PRIMARY testId: ${finalTestId}`);
    } else if (fallbackCount > 0) {
      finalTestId = fallbackTestId;
      debugLog(`DEBUG: Using FALLBACK testId: ${finalTestId}`);
    } else {
      // Neither exists - use primary and let Playwright's click() wait/fail with clear error
      finalTestId = primaryTestId;
      debugLog(`DEBUG: WARNING - Neither testId found! Attempting primary: ${finalTestId}`);
    }

    await apmServiceInventoryPage.page.getByTestId(finalTestId).click();
    await apmServiceInventoryPage.assertTransactionExists();
  } else {
    const discoverValidation =
      await otelKubernetesFlowPage.clickExploreLogsAndGetDiscoverValidation();
    await discoverValidation.waitForDiscoverToLoad();
    await discoverValidation.assertHasAnyLogData();
  }
});
