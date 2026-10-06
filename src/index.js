/**
 * Public entry point for the exponential-backoff-calculator package.
 * Re-exports the core API so consumers can `import { ... } from 'exponential-backoff-calculator'`.
 * @module exponential-backoff-calculator
 */

export {
  computeBackoff,
  createBackoff,
  fullJitter,
  equalJitter,
  decorrelatedJitter,
} from './core.js';
