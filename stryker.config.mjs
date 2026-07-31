/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate: [
    'src/engine/commitment.ts',
    'src/engine/random.ts',
    'src/engine/settlement.ts',
    'src/engine/submission-signatures.ts',
  ],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.ts',
  },
  coverageAnalysis: 'perTest',
  disableTypeChecks: false,
  reporters: ['clear-text', 'progress', 'html'],
  thresholds: {
    high: 85,
    low: 70,
    break: 63,
  },
  timeoutMS: 10_000,
};
