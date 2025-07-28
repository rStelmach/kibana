/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test as ess_auth, expect } from '@playwright/test';
import { STORAGE_STATE } from '../playwright.config';
import { isServerless } from '../lib/helpers';
import { waitForOneOf } from '../lib/helpers';
import { log } from '../lib/logger';
import { assertEnv } from '../lib/assert_env';

ess_auth('Authentication', async ({ page }) => {
  assertEnv(process.env.KIBANA_BASE_URL, 'KIBANA_BASE_URL is not defined.');
  assertEnv(process.env.KIBANA_USERNAME, 'KIBANA_USERNAME is not defined.');
  assertEnv(process.env.KIBANA_PASSWORD, 'KIBANA_PASSWORD is not defined.');

  await page.goto(process.env.KIBANA_BASE_URL);
  log.info('Detecting login flow...');

  if (isServerless) {
    const roleCombo = page.getByRole('combobox');
    const cloudContinue = page.getByRole('button', { name: /continue/i });

    // wait for either the old combobox or the new Cloud "Continue" button
    await Promise.any([
      roleCombo.waitFor({ state: 'visible', timeout: 10_000 }),
      cloudContinue.waitFor({ state: 'visible', timeout: 10_000 }),
    ]).catch(() => {});

    if (await cloudContinue.isVisible()) {
      await cloudContinue.click();
      // after clicking Continue we eventually land on the combo-box page
      await roleCombo.waitFor({ state: 'visible', timeout: 60_000 });
    }

    if (await roleCombo.isVisible()) {
      await roleCombo.fill('admin');
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Log in' }).click();
    } else if (!(await cloudContinue.isVisible())) {
      await page
        .getByRole('button', { name: 'Log in with Elasticsearch' })
        .click()
        .catch(() => {});
      if (
        await page
          .getByLabel('Username')
          .isVisible()
          .catch(() => false)
      ) {
        await page.getByLabel('Username').fill(process.env.KIBANA_USERNAME);
        await page.getByLabel('Password', { exact: true }).fill(process.env.KIBANA_PASSWORD);
        await page.getByRole('button', { name: 'Log in' }).click();
      }
    }
  } else {
    await page.getByRole('button', { name: 'Log in with Elasticsearch' }).click();
    await page.getByLabel('Username').fill(process.env.KIBANA_USERNAME);
    await page.getByLabel('Password', { exact: true }).fill(process.env.KIBANA_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
  }

  const [index] = await waitForOneOf([
    page.getByTestId('helpMenuButton'),
    page.getByText('Select your space'),
    page.getByTestId('loginErrorMessage'),
  ]);

  const spaceSelector = index === 1;
  const isAuthenticated = index === 0;

  if (isAuthenticated) {
    await page.context().storageState({ path: STORAGE_STATE });
  } else if (spaceSelector) {
    await page.getByRole('link', { name: 'Default' }).click();
    await expect(page.getByTestId('helpMenuButton')).toBeVisible();
    await page.context().storageState({ path: STORAGE_STATE });
  } else {
    log.error('Username or password is incorrect.');
    throw new Error('Authentication is failed.');
  }
});
