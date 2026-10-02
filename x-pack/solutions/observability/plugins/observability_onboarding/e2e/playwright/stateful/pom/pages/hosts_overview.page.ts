/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page, type Locator, type Response } from '@playwright/test';

export class HostsOverviewPage {
  page: Page;

  private readonly cpuPercentageValue: Locator;

  constructor(page: Page) {
    this.page = page;

    this.cpuPercentageValue = this.page
      .getByTestId('infraAssetDetailsKPIcpuUsage')
      .locator('.echMetricText__value');
  }

  public async assertCpuPercentageNotEmpty() {
    await expect(this.cpuPercentageValue).toBeVisible();
    expect(await this.cpuPercentageValue.textContent()).toMatch(/\d+%$/);
  }

  public async assertHostCpuNotEmpty(hostname: string) {
    const hostRow = this.page
      .locator('[data-test-subj="hostsView-tableRow"]')
      .filter({ hasText: hostname });

    await expect(hostRow).toBeVisible();

    const cpuCell = hostRow.locator('[data-test-subj="hostsView-tableRow-cpuUsage"]');
    await expect(cpuCell).toBeVisible();

    // Get the first child element which contains the actual value (not the separator)
    const cpuValue = cpuCell.locator('> div').first();
    const cpuText = await cpuValue.textContent();
    await this.writeCpuDiagnostics(cpuText);
    expect(cpuText).toMatch(/\d+(\.\d+)?%$/);
  }

  // TEMPORARY diagnostics for the OTel Host "CPU usage N/A" nightly failure. Do not merge.
  private async writeCpuDiagnostics(cpuText: string | null) {
    const output: Record<string, unknown> = { cpuText, capturedAt: new Date().toISOString() };
    const origin = new URL(this.page.url()).origin;

    const esRequest = async (method: string, esPath: string, body?: unknown) => {
      try {
        const response = await this.page.request.post(
          `${origin}/api/console/proxy?path=${encodeURIComponent(esPath)}&method=${method}`,
          { headers: { 'kbn-xsrf': 'true' }, data: body }
        );
        return { status: response.status(), body: await response.json().catch(() => null) };
      } catch (error) {
        return { error: String(error) };
      }
    };

    const recent = { range: { '@timestamp': { gte: 'now-30m' } } };
    const statesFor = (field: string) => ({
      filter: { exists: { field } },
      aggs: {
        state: { terms: { field: 'state', missing: '__missing__', size: 20 } },
        index: { terms: { field: '_index', size: 10 } },
        host: { terms: { field: 'host.name', missing: '__missing__', size: 10 } },
        first: { min: { field: '@timestamp' } },
        last: { max: { field: '@timestamp' } },
      },
    });

    output.fieldCaps = await esRequest(
      'GET',
      'metrics-*/_field_caps?ignore_unavailable=true&fields=*cpu.utilization*,*memory.utilization*,*cpu.load_average.1m*,state,attributes.state,host.name'
    );
    output.aggregations = await esRequest('POST', 'metrics-*/_search?ignore_unavailable=true', {
      size: 0,
      query: recent,
      aggs: {
        cpuPrefixed: statesFor('metrics.system.cpu.utilization'),
        cpuUnprefixed: statesFor('system.cpu.utilization'),
        memory: statesFor('system.memory.utilization'),
        load: statesFor('metrics.system.cpu.load_average.1m'),
        indices: { terms: { field: '_index', size: 30 } },
      },
    });
    output.cpuSampleDocs = await esRequest('POST', 'metrics-*/_search?ignore_unavailable=true', {
      size: 3,
      sort: [{ '@timestamp': 'desc' }],
      query: {
        bool: {
          filter: [recent],
          should: [
            { exists: { field: 'metrics.system.cpu.utilization' } },
            { exists: { field: 'system.cpu.utilization' } },
          ],
          minimum_should_match: 1,
        },
      },
    });
    output.memorySampleDoc = await esRequest('POST', 'metrics-*/_search?ignore_unavailable=true', {
      size: 1,
      sort: [{ '@timestamp': 'desc' }],
      query: { bool: { filter: [recent, { exists: { field: 'system.memory.utilization' } }] } },
    });

    try {
      const responses: unknown[] = [];
      const onResponse = async (response: Response) => {
        if (!/\/api\/metrics\/infra/.test(response.url())) return;
        responses.push({
          url: response.url(),
          status: response.status(),
          requestBody: response.request().postData(),
          body: (await response.text().catch(() => '')).slice(0, 20000),
        });
      };
      this.page.on('response', onResponse);
      await this.page.reload();
      await this.page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
      this.page.off('response', onResponse);
      output.hostsApiResponses = responses;
    } catch (error) {
      output.hostsApiResponses = { error: String(error) };
    }

    const outputPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      process.env.ARTIFACTS_FOLDER ?? '.playwright',
      'cpu_diagnostics.json'
    );
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    // eslint-disable-next-line no-console
    console.log(`CPU diagnostics written to ${outputPath}`);
  }
}
