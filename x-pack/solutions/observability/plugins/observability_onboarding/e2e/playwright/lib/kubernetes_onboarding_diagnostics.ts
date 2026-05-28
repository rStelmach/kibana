/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import fs from 'node:fs';
import type { Page } from '@playwright/test';

const HAS_DATA_ROUTE_PATTERN =
  /^\/internal\/observability_onboarding\/kubernetes\/[^/]+\/has-data$/;
const FLOW_ROUTE = '/internal/observability_onboarding/kubernetes/flow';
const READINESS_DIAGNOSTICS_TEST_SUBJ = 'observabilityOnboardingKubernetesReadinessDiagnostics';
const ACTION_LINK_TEST_SUBJ_PREFIX = 'observabilityOnboardingDataIngestStatusActionLink-';

type ProbeValue = boolean | 'skipped';

interface KubernetesHasDataProbeBreakdown {
  classicLogs: ProbeValue;
  classicMetrics: ProbeValue;
  wiredLogs: ProbeValue;
  wiredMetrics: ProbeValue;
  wiredQueryUsed: boolean;
  hasPreExistingData: boolean;
  start?: string;
}

interface KubernetesHasDataResponse {
  hasData?: boolean;
  hasLogs?: boolean;
  hasMetrics?: boolean;
  hasPreExistingData?: boolean;
  probes?: KubernetesHasDataProbeBreakdown;
}

interface KubernetesFlowResponse {
  onboardingId?: string;
  apiKeyEncoded?: string;
  elasticsearchUrl?: string;
  managedOtlpServiceUrl?: string;
  elasticAgentVersionInfo?: {
    agentBaseVersion?: string;
  };
}

export interface KubernetesHasDataCall extends KubernetesHasDataResponse {
  tMs: number;
  status: number;
  requestUrl: string;
  startQueryParam?: string;
  errorBody?: string;
}

interface KubernetesFlowCall {
  tMs: number;
  status: number;
  requestUrl: string;
  onboardingId?: string;
  hasApiKeyEncoded?: boolean;
  elasticsearchUrlPresent?: boolean;
  managedOtlpServiceUrlPresent?: boolean;
  managedOtlpServiceUrlLength?: number;
  agentBaseVersion?: string;
  errorBody?: string;
}

interface ReadinessSnapshot {
  label: string;
  tMs: number;
  exists: boolean;
  attrs?: Record<string, string | null>;
  progressText?: string;
  actionLinks: Array<{
    testSubj: string | null;
    href: string | null;
    text: string;
  }>;
}

export interface InstallCommandDiagnostics {
  endpointVariable?: string;
  endpointValueLength?: number;
  endpointIsEmpty?: boolean;
  usesManagedOtlpEndpoint: boolean;
  valuesFileUrl?: string;
  usesManagedOtlpValues: boolean;
  usesLogsOnlyValues: boolean;
  usesWiredStreams: boolean;
  hasMetricsOnboardingProcessor: boolean;
  hasLogsOnboardingProcessor: boolean;
}

export interface KubernetesOnboardingDiagnosticsPayload {
  testName: string;
  flow: 'kubernetes_otel' | 'kubernetes_ea';
  env: {
    USE_WIRED_STREAMS?: string;
    LOGS_ESSENTIALS_MODE?: string;
  };
  flowResponses: KubernetesFlowCall[];
  hasDataTimeline: KubernetesHasDataCall[];
  readinessSnapshots: ReadinessSnapshot[];
  installCommand?: InstallCommandDiagnostics;
}

export const getInstallCommandDiagnostics = (
  installStackSnippet: string
): InstallCommandDiagnostics => {
  const endpointMatch = installStackSnippet.match(
    /--from-literal=(elastic_otlp_endpoint|elastic_endpoint)='([^']*)'/
  );
  const valuesFileMatch = installStackSnippet.match(/--values '([^']+)'/);
  const endpointVariable = endpointMatch?.[1];
  const endpointValue = endpointMatch?.[2];
  const valuesFileUrl = valuesFileMatch?.[1];

  return {
    usesManagedOtlpEndpoint: endpointVariable === 'elastic_otlp_endpoint',
    usesManagedOtlpValues: valuesFileUrl?.includes('/managed_otlp/') ?? false,
    usesLogsOnlyValues: valuesFileUrl?.endsWith('/logs-values.yaml') ?? false,
    usesWiredStreams: installStackSnippet.includes('resource\\/wired_streams'),
    hasMetricsOnboardingProcessor: installStackSnippet.includes('metrics\\/node\\/otel.processors'),
    hasLogsOnboardingProcessor: installStackSnippet.includes('logs\\/node.processors'),
    ...(endpointVariable ? { endpointVariable } : {}),
    ...(endpointValue !== undefined
      ? { endpointValueLength: endpointValue.length, endpointIsEmpty: endpointValue === '' }
      : {}),
    ...(valuesFileUrl ? { valuesFileUrl } : {}),
  };
};

export const createKubernetesOnboardingDiagnostics = ({
  page,
  testName,
  flow,
}: {
  page: Page;
  testName: string;
  flow: KubernetesOnboardingDiagnosticsPayload['flow'];
}) => {
  const startedAt = Date.now();
  const flowResponses: KubernetesFlowCall[] = [];
  const hasDataTimeline: KubernetesHasDataCall[] = [];
  const readinessSnapshots: ReadinessSnapshot[] = [];
  let installCommand: InstallCommandDiagnostics | undefined;

  page.on('response', async (response) => {
    const url = new URL(response.url());
    const status = response.status();
    const tMs = Date.now() - startedAt;

    if (url.pathname === FLOW_ROUTE) {
      const flowResponse: KubernetesFlowCall = {
        tMs,
        status,
        requestUrl: response.url(),
      };

      if (status >= 400) {
        try {
          flowResponse.errorBody = (await response.text()).slice(0, 1000);
        } catch {
          flowResponse.errorBody = '<read-failed>';
        }
      } else {
        try {
          const json = (await response.json()) as KubernetesFlowResponse;
          flowResponse.hasApiKeyEncoded = Boolean(json.apiKeyEncoded);
          if (json.onboardingId !== undefined) {
            flowResponse.onboardingId = json.onboardingId;
          }
          if (json.elasticsearchUrl !== undefined) {
            flowResponse.elasticsearchUrlPresent = Boolean(json.elasticsearchUrl);
          }
          if (json.managedOtlpServiceUrl !== undefined) {
            flowResponse.managedOtlpServiceUrlPresent = Boolean(json.managedOtlpServiceUrl);
            flowResponse.managedOtlpServiceUrlLength = json.managedOtlpServiceUrl.length;
          }
          if (json.elasticAgentVersionInfo?.agentBaseVersion !== undefined) {
            flowResponse.agentBaseVersion = json.elasticAgentVersionInfo.agentBaseVersion;
          }
        } catch {
          flowResponse.errorBody = '<json-read-failed>';
        }
      }

      flowResponses.push(flowResponse);
      return;
    }

    if (!HAS_DATA_ROUTE_PATTERN.test(url.pathname)) {
      return;
    }

    const startQueryParam = url.searchParams.get('start');
    const hasDataCall: KubernetesHasDataCall = {
      tMs,
      status,
      requestUrl: response.url(),
    };
    if (startQueryParam !== null) {
      hasDataCall.startQueryParam = startQueryParam;
    }

    if (status >= 400) {
      try {
        hasDataCall.errorBody = (await response.text()).slice(0, 1000);
      } catch {
        hasDataCall.errorBody = '<read-failed>';
      }
    } else {
      try {
        const json = (await response.json()) as KubernetesHasDataResponse;
        hasDataCall.hasData = json.hasData;
        hasDataCall.hasLogs = json.hasLogs;
        hasDataCall.hasMetrics = json.hasMetrics;
        hasDataCall.hasPreExistingData = json.hasPreExistingData;
        hasDataCall.probes = json.probes;
      } catch {
        hasDataCall.errorBody = '<json-read-failed>';
      }
    }

    hasDataTimeline.push(hasDataCall);
  });

  const recordInstallCommand = (installStackSnippet: string) => {
    installCommand = getInstallCommandDiagnostics(installStackSnippet);
  };

  const recordReadinessSnapshot = async (label: string) => {
    try {
      const diagnosticsLocator = page.getByTestId(READINESS_DIAGNOSTICS_TEST_SUBJ);
      const progressLocator = page.getByTestId(
        'observabilityOnboardingKubernetesPanelDataProgressIndicator'
      );
      const exists = (await diagnosticsLocator.count()) > 0;
      const attrs = exists
        ? await diagnosticsLocator.first().evaluate((element) => ({
            hasData: element.getAttribute('data-has-data'),
            hasLogs: element.getAttribute('data-has-logs'),
            hasMetrics: element.getAttribute('data-has-metrics'),
            hasPreExistingData: element.getAttribute('data-has-pre-existing-data'),
            isReady: element.getAttribute('data-is-ready'),
            needsLogs: element.getAttribute('data-needs-logs'),
            needsMetrics: element.getAttribute('data-needs-metrics'),
            respectPreExistingData: element.getAttribute('data-respect-pre-existing-data'),
            status: element.getAttribute('data-status'),
            actionLinkRequirements: element.getAttribute('data-action-link-requirements'),
            filteredActionLinkRequirements: element.getAttribute(
              'data-filtered-action-link-requirements'
            ),
          }))
        : undefined;
      const actionLinks = await page
        .locator(`[data-test-subj^="${ACTION_LINK_TEST_SUBJ_PREFIX}"]`)
        .evaluateAll((links) =>
          links.map((link) => ({
            testSubj: link.getAttribute('data-test-subj'),
            href: link.getAttribute('href'),
            text: link.textContent?.trim() ?? '',
          }))
        );
      const progressText =
        (await progressLocator.count()) > 0
          ? (await progressLocator.first().textContent())?.trim()
          : undefined;

      readinessSnapshots.push({
        label,
        tMs: Date.now() - startedAt,
        exists,
        actionLinks,
        ...(attrs ? { attrs } : {}),
        ...(progressText ? { progressText } : {}),
      });
    } catch (error) {
      readinessSnapshots.push({
        label,
        tMs: Date.now() - startedAt,
        exists: false,
        actionLinks: [],
        attrs: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  const buildPayload = (): KubernetesOnboardingDiagnosticsPayload => ({
    testName,
    flow,
    env: {
      ...(process.env.USE_WIRED_STREAMS !== undefined
        ? { USE_WIRED_STREAMS: process.env.USE_WIRED_STREAMS }
        : {}),
      ...(process.env.LOGS_ESSENTIALS_MODE !== undefined
        ? { LOGS_ESSENTIALS_MODE: process.env.LOGS_ESSENTIALS_MODE }
        : {}),
    },
    flowResponses,
    hasDataTimeline,
    readinessSnapshots,
    ...(installCommand ? { installCommand } : {}),
  });

  const write = (paths: string[]) => {
    const payload = JSON.stringify(buildPayload(), null, 2);
    paths.forEach((artifactPath) => {
      fs.writeFileSync(artifactPath, payload);
    });
  };

  return {
    hasDataTimeline,
    flowResponses,
    recordInstallCommand,
    recordReadinessSnapshot,
    write,
  };
};
