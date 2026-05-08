/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { globalSetupHook } from '@kbn/scout';

globalSetupHook('Setup environment for streams tests', async ({ apiServices, log }) => {
  // Discover tests in this suite assume Data view mode. In MKI QA the
  // `discover.isEsqlDefault` feature flag is enabled, which makes the
  // observability root profile boot Discover into ES|QL and hide the
  // data-view switcher. Mirrors PR #267910 in the Discover Scout suite.
  log.debug('[setup] turning off discover.isEsqlDefault');
  await apiServices.core.settings({
    'feature_flags.overrides': {
      'discover.isEsqlDefault': false,
    },
  });

  log.debug('[setup] Enabling streams...');
  await apiServices.streams.enable();
});
