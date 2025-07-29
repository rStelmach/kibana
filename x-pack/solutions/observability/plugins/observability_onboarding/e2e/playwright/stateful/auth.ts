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
  log.info(`...waiting for login page elements to appear.`);

  const elasticsearchBtn = page.getByRole('button', { name: 'Log in with Elasticsearch' });
  if (!isLocalCluster && (await elasticsearchBtn.isVisible().catch(() => false))) {
    await elasticsearchBtn.click();
  }

  const usernameField = page.getByLabel('Username');
  const emailField = page.getByLabel('Email');

  if (await usernameField.isVisible().catch(() => false)) {
    await usernameField.fill(process.env.KIBANA_USERNAME);
  } else if (await emailField.isVisible().catch(() => false)) {
    await emailField.fill(process.env.KIBANA_USERNAME);
  }

  await page.getByLabel('Password', { exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(process.env.KIBANA_PASSWORD);

  // Wait a moment for the form to validate and enable the button
  await page.waitForTimeout(1000);

  // Wait for the login button to be enabled before clicking
  await page.getByRole('button', { name: 'Log in' }).waitFor({ state: 'visible' });
  await expect(page.getByRole('button', { name: 'Log in' })).toBeEnabled();

  await page.getByRole('button', { name: 'Log in' }).click();

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
