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

  // Captured /internal/observability_onboarding/kubernetes/{id}/has-data
  // responses as the polling UI sees them. On a Class B red the test stays
  // stuck on this endpoint for the full 400s window; this trail lets us
  // distinguish "endpoint always returned hasData=false" from "endpoint
  // started erroring" without needing cluster-side capture on the Kibana side.
  const hasDataProbeStartedAt = Date.now();
  const hasDataProbePath = path.join(
    __dirname,
    '..',
    process.env.ARTIFACTS_FOLDER,
    'kubernetes_ea_has_data_probes.json'
  );
  const hasDataCalls: Array<{
    tMs: number;
    status: number;
    requestUrl: string;
    hasData?: boolean;
    hasLogs?: boolean;
    hasMetrics?: boolean;
    hasPreExistingData?: boolean;
    errorBody?: string;
  }> = [];

  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (
      !/^\/internal\/observability_onboarding\/kubernetes\/[^/]+\/has-data$/.test(url.pathname)
    ) {
      return;
    }
    const status = response.status();
    const probe: (typeof hasDataCalls)[number] = {
      tMs: Date.now() - hasDataProbeStartedAt,
      status,
      requestUrl: response.url(),
    };
    if (status >= 400) {
      // Capture raw text for 4xx/5xx — response.json() on an error body often
      // throws and consumes the stream, leaving no trail.
      try {
        probe.errorBody = (await response.text()).slice(0, 1000);
      } catch {
        probe.errorBody = '<read-failed>';
      }
    } else {
      try {
        const json = (await response.json()) as {
          hasData?: boolean;
          hasLogs?: boolean;
          hasMetrics?: boolean;
          hasPreExistingData?: boolean;
        };
        probe.hasData = json?.hasData;
        probe.hasLogs = json?.hasLogs;
        probe.hasMetrics = json?.hasMetrics;
        probe.hasPreExistingData = json?.hasPreExistingData;
      } catch {
        // leave fields empty; status alone is a useful signal
      }
    }
    hasDataCalls.push(probe);
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
    /**
     * The page waits for the browser window to loose
     * focus as a signal to start checking for incoming data
     */
    await page.evaluate('window.dispatchEvent(new Event("blur"))');

    /**
     * Ensemble story watches for the code snippet file
     * to be created and then executes it
     */
    fs.writeFileSync(outputPath, clipboardData);

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
      fs.writeFileSync(hasDataProbePath, JSON.stringify({ calls: hasDataCalls }, null, 2));
    } catch {
      // best-effort — don't mask the original test failure
    }
  }
});
