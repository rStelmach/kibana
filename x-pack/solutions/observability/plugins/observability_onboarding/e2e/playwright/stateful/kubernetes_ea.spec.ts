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
import { assertDiscoverHasData, assertStreamHasData } from '../lib/validation_helpers';
import { createKubernetesOnboardingDiagnostics } from '../lib/kubernetes_onboarding_diagnostics';

test.beforeEach(async ({ page, onboardingHomePage }) => {
  await page.goto(`${process.env.KIBANA_BASE_URL}/app/observabilityOnboarding`);
  await onboardingHomePage.maybeClickIntroducingAIAgentModalContinueBtn();
});

test('Kubernetes EA', async ({
  page,
  onboardingHomePage,
  kubernetesEAFlowPage,
  kubernetesOverviewDashboardPage,
  wiredStreamsSelector,
}) => {
  assertEnv(process.env.ARTIFACTS_FOLDER, 'ARTIFACTS_FOLDER is not defined.');

  const isLogsEssentialsMode = process.env.LOGS_ESSENTIALS_MODE === 'true';
  const useWiredStreams = process.env.USE_WIRED_STREAMS === 'true';
  const fileName = 'code_snippet_kubernetes.sh';
  const outputPath = path.join(__dirname, '..', process.env.ARTIFACTS_FOLDER, fileName);
  const hasDataProbeStartedAt = Date.now();
  const hasDataProbePath = path.join(
    __dirname,
    '..',
    process.env.ARTIFACTS_FOLDER,
    'kubernetes_ea_has_data_probes.json'
  );
  const uniqueHasDataProbePath = path.join(
    __dirname,
    '..',
    process.env.ARTIFACTS_FOLDER,
    `kubernetes_ea_has_data_probes-${hasDataProbeStartedAt}-${process.pid}.json`
  );
  const readinessDiagnosticsPath = path.join(
    __dirname,
    '..',
    process.env.ARTIFACTS_FOLDER,
    'kubernetes_ea_readiness_diagnostics.json'
  );
  const uniqueReadinessDiagnosticsPath = path.join(
    __dirname,
    '..',
    process.env.ARTIFACTS_FOLDER,
    `kubernetes_ea_readiness_diagnostics-${hasDataProbeStartedAt}-${process.pid}.json`
  );
  const diagnostics = createKubernetesOnboardingDiagnostics({
    page,
    testName: 'Kubernetes EA',
    flow: 'kubernetes_ea',
  });

  try {
    await onboardingHomePage.selectKubernetesUseCase();
    await onboardingHomePage.selectKubernetesQuickstart();

    if (useWiredStreams) {
      await wiredStreamsSelector.selectWiredStreamsMode();
    }

    await kubernetesEAFlowPage.assertVisibilityCodeBlock();
    await kubernetesEAFlowPage.copyToClipboard();

    const clipboardData = (await page.evaluate('navigator.clipboard.readText()')) as string;
    diagnostics.recordInstallCommand(clipboardData);
    await diagnostics.recordReadinessSnapshot('install_command_copied');
    /**
     * The page waits for the browser window to loose
     * focus as a signal to start checking for incoming data
     */
    await page.evaluate('window.dispatchEvent(new Event("blur"))');
    await diagnostics.recordReadinessSnapshot('blur_dispatched');

    /**
     * Ensemble story watches for the code snippet file
     * to be created and then executes it
     */
    fs.writeFileSync(outputPath, clipboardData);
    await diagnostics.recordReadinessSnapshot('code_snippet_written');

    /**
     * Wired streams only reroutes logs (to logs.ecs); metrics are unaffected.
     * So for wired streams we validate log delivery via Discover and the Streams
     * page, and intentionally skip the Kubernetes Overview dashboard check.
     * Dashboard validation is already covered by the non-wired test variants.
     *
     * The logs essentials sub-case skips the data indicator and navigates to
     * Discover directly because the K8s EA has-data API relies on
     * fields.onboarding_id, which is unreliable when metrics are disabled in
     * the logs essentials tier.
     */
    if (useWiredStreams && !isLogsEssentialsMode) {
      await kubernetesEAFlowPage.assertReceivedDataIndicatorKubernetes();
      await diagnostics.recordReadinessSnapshot('data_received_indicator_visible');
      await page.waitForTimeout(2 * 60000);
      await kubernetesEAFlowPage.clickExploreLogsCTA();
      await assertDiscoverHasData(page, { assertHitCount: true });
      await assertStreamHasData(page, 'logs.ecs');
    } else if (useWiredStreams && isLogsEssentialsMode) {
      await page.waitForTimeout(5 * 60000);
      await page.goto(`${process.env.KIBANA_BASE_URL}/app/discover`);
      await assertDiscoverHasData(page, { assertHitCount: true });
      await assertStreamHasData(page, 'logs.ecs');
    } else if (!isLogsEssentialsMode) {
      await kubernetesEAFlowPage.assertReceivedDataIndicatorKubernetes();
      await diagnostics.recordReadinessSnapshot('data_received_indicator_visible');
      /**
       * There might be a case that dashboard still does not show
       * the data even though it was ingested already. This usually
       * happens during the test when navigation from the onboarding
       * flow to the dashboard happens almost immediately.
       * Having a timeout before going to the dashboard "solves"
       * the issue. 2 minutes is generous and should be more then enough
       * for the data to propagate everywhere.
       */
      await page.waitForTimeout(2 * 60000);
      await kubernetesEAFlowPage.clickKubernetesAgentCTA();
      await kubernetesOverviewDashboardPage.assertNodesPanelNotEmpty();
    } else {
      await page.waitForTimeout(5 * 60000);
      await page.goto(`${process.env.KIBANA_BASE_URL}/app/discover`);
      await assertDiscoverHasData(page);
    }
  } finally {
    try {
      await diagnostics.recordReadinessSnapshot('test_finally');

      const payload = JSON.stringify({ calls: diagnostics.hasDataTimeline }, null, 2);
      fs.writeFileSync(hasDataProbePath, payload);
      fs.writeFileSync(uniqueHasDataProbePath, payload);
      diagnostics.write([readinessDiagnosticsPath, uniqueReadinessDiagnosticsPath]);
    } catch {
      // best-effort only, do not mask the original test failure
    }
  }
});
