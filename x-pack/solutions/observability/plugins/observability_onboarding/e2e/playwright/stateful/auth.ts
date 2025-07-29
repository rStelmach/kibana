/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { test as ess_auth, expect } from '@playwright/test';
import { STORAGE_STATE } from '../playwright.config';
import { waitForOneOf } from '../lib/helpers';
import { log } from '../lib/logger';
import { assertEnv } from '../lib/assert_env';

const isLocalCluster = process.env.CLUSTER_ENVIRONMENT === 'local';

ess_auth('Authentication', async ({ page }) => {
  assertEnv(process.env.KIBANA_BASE_URL, 'KIBANA_BASE_URL is not defined.');
  assertEnv(process.env.KIBANA_USERNAME, 'KIBANA_USERNAME is not defined.');
  assertEnv(process.env.KIBANA_PASSWORD, 'KIBANA_PASSWORD is not defined.');

  await page.goto(process.env.KIBANA_BASE_URL);
  log.info('Detecting login flow...');

  const emailPlaceholder = page.getByPlaceholder(/email/i).first();

  let usedFlow: 'serverless' | 'stateful';

  if (await emailPlaceholder.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await loginServerless(page);
    usedFlow = 'serverless';
  } else {
    await loginStateful(page);
    usedFlow = 'stateful';
  }

  log.info(`Used ${usedFlow} login flow`);

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

async function loginStateful(page: import('@playwright/test').Page) {
  // First screen can be either direct form or the dual-button splash.
  if (!isLocalCluster) {
    const elasticBtn = page.getByRole('button', { name: /Log in with Elasticsearch/i });
    if (await elasticBtn.isVisible().catch(() => false)) {
      await elasticBtn.click();
    }
  }

  // Wait until the credential fields are actually rendered
  const usernameField = page
    .getByLabel('Username', { exact: true })
    .or(page.getByPlaceholder(/email/i))
    .first();
  const passwordField = page
    .getByLabel('Password', { exact: true })
    .or(page.getByPlaceholder(/password/i))
    .first();

  await usernameField.waitFor({ state: 'visible', timeout: 15_000 });
  await passwordField.waitFor({ state: 'visible', timeout: 15_000 });

  await usernameField.fill(process.env.KIBANA_USERNAME!);
  await passwordField.fill(process.env.KIBANA_PASSWORD!);
  await page.getByRole('button', { name: /log in/i }).click();
}

async function loginServerless(page: import('@playwright/test').Page) {
  const emailInput = page
    .getByPlaceholder(/email/i)
    .first()
    .or(page.locator('input[type="email"]'))
    .or(page.locator('form input').first());
  const passwordInput = page
    .getByPlaceholder(/password/i)
    .first()
    .or(page.locator('input[type="password"]'));
  const loginBtn = page.getByRole('button', { name: /log in/i });

  await emailInput.fill(process.env.KIBANA_USERNAME!);
  await emailInput.evaluate((el) => (el as HTMLElement).blur());

  await passwordInput.fill(process.env.KIBANA_PASSWORD!);
  await passwordInput.evaluate((el) => (el as HTMLElement).blur());

  await expect(loginBtn).toBeEnabled();
  await loginBtn.click();
}
