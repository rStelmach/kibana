/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expect, type Page, type Locator } from '@playwright/test';

export class HostDetailsPage {
  page: Page;

  private readonly cpuPercentageValue: Locator;

  constructor(page: Page) {
    this.page = page;

    this.cpuPercentageValue = this.page
      .getByTestId('infraAssetDetailsKPIcpuUsage')
      .locator('.echMetricText__value');
  }

  private async waitForTextMatch(locator: Locator, re: RegExp, timeoutMs = 180000) {
    const start = Date.now();
    let last = '';
    let delay = 1000;

    while (Date.now() - start < timeoutMs) {
      last = (await locator.textContent())?.trim() ?? '';
      if (re.test(last)) return last;
      await this.page.waitForTimeout(delay);
      if (delay < 10000) delay *= 2;
    }

    expect(last).toMatch(re);
  }

  public async assertCpuPercentageNotEmpty() {
    await expect(this.cpuPercentageValue).toBeVisible();
    await this.waitForTextMatch(this.cpuPercentageValue, /\d+%$/);
  }
}
