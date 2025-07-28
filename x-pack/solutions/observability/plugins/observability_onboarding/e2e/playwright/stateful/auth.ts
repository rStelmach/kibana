/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test as ess_auth, expect, type Page } from '@playwright/test';
import { STORAGE_STATE } from '../playwright.config';
import { isServerless } from '../lib/helpers';
import { waitForOneOf } from '../lib/helpers';
import { log } from '../lib/logger';
import { assertEnv } from '../lib/assert_env';

const isLocalCluster = process.env.CLUSTER_ENVIRONMENT === 'local';

ess_auth('Authentication', async ({ page }) => {
  assertEnv(process.env.KIBANA_BASE_URL, 'KIBANA_BASE_URL is not defined.');
  assertEnv(process.env.KIBANA_USERNAME, 'KIBANA_USERNAME is not defined.');
  assertEnv(process.env.KIBANA_PASSWORD, 'KIBANA_PASSWORD is not defined.');

  await page.goto(process.env.KIBANA_BASE_URL!);
  log.info('Detecting login flow...');

  if (isServerless) {
    await handleServerlessLogin(page);
  } else {
    await handleStatefulLogin(page);
  }

  // Wait for Kibana UI or space selector or error
  const [idx] = await waitForOneOf([
    page.getByTestId('helpMenuButton'),
    page.getByText('Select your space'),
    page.getByTestId('loginErrorMessage'),
  ]);

  if (idx === 0) {
    // landed in Kibana
    await page.context().storageState({ path: STORAGE_STATE });
  } else if (idx === 1) {
    // space selector shown – pick Default
    await page.getByRole('link', { name: 'Default' }).click();
    await expect(page.getByTestId('helpMenuButton')).toBeVisible();
    await page.context().storageState({ path: STORAGE_STATE });
  } else {
    throw new Error('Authentication failed');
  }
});

async function handleServerlessLogin(page: Page) {
  // Cloud login shows Email/Password + SSO. Use SSO.
  const ssoBtn = page.getByRole('button', { name: 'SSO' });
  if (await ssoBtn.isVisible().catch(() => false)) {
    await ssoBtn.click();
  }

  // On the mock IdP page select admin role
  const roleCombo = page.getByRole('combobox');
  await roleCombo.waitFor({ state: 'visible', timeout: 60_000 });
  await roleCombo.fill('admin');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Log in' }).click();
}

async function handleStatefulLogin(page: Page) {
  if (!isLocalCluster) {
    await page.getByRole('button', { name: 'Log in with Elasticsearch' }).click();
  }
  await page.getByLabel('Username').fill(process.env.KIBANA_USERNAME!);
  await page.getByLabel('Password', { exact: true }).fill(process.env.KIBANA_PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
}
