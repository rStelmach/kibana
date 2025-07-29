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

  const usernameField = page.getByLabel('Username', { exact: true });
  const emailLabelField = page.getByLabel('Email', { exact: true });
  const emailPlaceholderField = page.getByPlaceholder('Email').first();

  let emailFilled = false;
  if (await usernameField.isVisible().catch(() => false)) {
    log.info('Filling "Username" labelled input');
    await usernameField.fill(process.env.KIBANA_USERNAME);
    await usernameField.evaluate((el) => (el as HTMLElement).blur());
    emailFilled = true;
  } else if (await emailLabelField.isVisible().catch(() => false)) {
    log.info('Filling "Email" labelled input');
    await emailLabelField.fill(process.env.KIBANA_USERNAME);
    await emailLabelField.evaluate((el) => (el as HTMLElement).blur());
    emailFilled = true;
  } else if (await emailPlaceholderField.isVisible().catch(() => false)) {
    log.info('Filling input with Email placeholder');
    await emailPlaceholderField.fill(process.env.KIBANA_USERNAME);
    await emailPlaceholderField.evaluate((el) => (el as HTMLElement).blur());
    emailFilled = true;
  }

  if (!emailFilled) {
    throw new Error('Email/Username field not found');
  }

  log.info('Email/Username filled, moving to Password');

  const passwordField = page.getByLabel('Password', { exact: true });
  await passwordField.fill(process.env.KIBANA_PASSWORD);
  await passwordField.evaluate((el) => (el as HTMLElement).blur());

  log.info('Password filled, waiting for Login button');

  // Wait for the login button to be enabled before clicking
  await expect(page.getByRole('button', { name: 'Log in' })).toBeEnabled();

  log.info('Login button enabled, clicking');
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
