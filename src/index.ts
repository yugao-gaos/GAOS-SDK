/**
 * Browser-safe, product-neutral GAOS surface.
 *
 * Import product adapters, engines, sessions, benchmarks, evidence tooling,
 * and Node-only verifier utilities through their explicit package subpaths.
 */

export * from './protocol.js';
export * from './client.js';
export {
  runSession,
  type SessionEpisodeIdentity,
  type SessionObservationAdapter,
  type SessionPacing,
  type SessionPresentation,
  type SessionRunEvents,
  type SessionRunPolicy,
  type SessionRunResult,
} from './agent/session-runner.js';
