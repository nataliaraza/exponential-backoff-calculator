import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeBackoff,
  createBackoff,
  fullJitter,
  equalJitter,
  decorrelatedJitter,
} from '../src/core.js';

// --- Deterministic, no-jitter behaviour ------------------------------------

describe('computeBackoff (deterministic)', () => {
  it('returns baseDelay on attempt 1', () => {
    assert.equal(computeBackoff({ baseDelay: 100, maxDelay: 10_000, attempt: 1 }), 100);
  });

  it('doubles on each subsequent attempt', () => {
    assert.equal(computeBackoff({ baseDelay: 100, maxDelay: 10_000, attempt: 2 }), 200);
    assert.equal(computeBackoff({ baseDelay: 100, maxDelay: 10_000, attempt: 3 }), 400);
    assert.equal(computeBackoff({ baseDelay: 100, maxDelay: 10_000, attempt: 4 }), 800);
  });

  it('honours attempt 0 as half the base delay', () => {
    assert.equal(computeBackoff({ baseDelay: 100, maxDelay: 10_000, attempt: 0 }), 50);
  });

  it('clamps to maxDelay when the exponential exceeds it', () => {
    // 100 * 2^7 = 12800, capped to 5000
    assert.equal(computeBackoff({ baseDelay: 100, maxDelay: 5000, attempt: 8 }), 5000);
  });

  it('clamps exactly at the boundary where raw equals maxDelay', () => {
    // 100 * 2^6 = 6400 == maxDelay
    assert.equal(computeBackoff({ baseDelay: 100, maxDelay: 6400, attempt: 7 }), 6400);
  });

  it('handles large exponents without integer overflow', () => {
    // attempt 40 -> exponent 39, far beyond the 30-bit safe shift window.
    // The result must be capped by maxDelay, not corrupted by bit overflow.
    assert.equal(computeBackoff({ baseDelay: 1, maxDelay: 1000, attempt: 40 }), 1000);
  });

  it('returns 0 when baseDelay is 0, regardless of attempt', () => {
    assert.equal(computeBackoff({ baseDelay: 0, maxDelay: 10_000, attempt: 5 }), 0);
  });

  it('returns 0 when maxDelay is 0, even if baseDelay is positive', () => {
    assert.equal(computeBackoff({ baseDelay: 100, maxDelay: 0, attempt: 3 }), 0);
  });
});

// --- Jitter ----------------------------------------------------------------
//
// Jitter functions are inherently random, so we assert on *bounds*, not exact
// values. We sample repeatedly to keep variance low enough to be meaningful
// while staying deterministic in the sense that the assertions are mathematical
// invariants, not timing-dependent.

describe('fullJitter', () => {
  it('returns a value in [0, delay)', () => {
    for (let i = 0; i < 100; i++) {
      const v = fullJitter(1000, 5);
      assert.ok(v >= 0, `expected >= 0, got ${v}`);
      assert.ok(v < 1000, `expected < 1000, got ${v}`);
    }
  });

  it('returns 0 for non-positive or non-finite input', () => {
    assert.equal(fullJitter(0, 1), 0);
    assert.equal(fullJitter(-1, 1), 0);
    assert.equal(fullJitter(NaN, 1), 0);
    assert.equal(fullJitter(Infinity, 1), 0);
  });
});

describe('equalJitter', () => {
  it('returns a value in [delay/2, delay]', () => {
    for (let i = 0; i < 100; i++) {
      const v = equalJitter(1000, 5);
      assert.ok(v >= 500, `expected >= 500, got ${v}`);
      assert.ok(v <= 1000, `expected <= 1000, got ${v}`);
    }
  });

  it('returns 0 for non-positive or non-finite input', () => {
    assert.equal(equalJitter(0, 1), 0);
    assert.equal(equalJitter(-1, 1), 0);
    assert.equal(equalJitter(NaN, 1), 0);
    assert.equal(equalJitter(Infinity, 1), 0);
  });
});

describe('decorrelatedJitter', () => {
  it('returns a value in [delay/3, delay)', () => {
    for (let i = 0; i < 100; i++) {
      const v = decorrelatedJitter(999, 5);
      assert.ok(v >= 333, `expected >= 333, got ${v}`);
      assert.ok(v < 999, `expected < 999, got ${v}`);
    }
  });

  it('returns 0 for non-positive or non-finite input', () => {
    assert.equal(decorrelatedJitter(0, 1), 0);
    assert.equal(decorrelatedJitter(-1, 1), 0);
    assert.equal(decorrelatedJitter(NaN, 1), 0);
    assert.equal(decorrelatedJitter(Infinity, 1), 0);
  });
});

// --- computeBackoff with jitter wired in ------------------------------------

describe('computeBackoff (with jitter)', () => {
  it('applies jitter to the clamped delay', () => {
    // Fixed jitter so the assertion is exact and deterministic.
    const fixed = (delay, attempt) => delay + attempt;
    // attempt 3, base 100 -> raw 400, no cap -> jittered 400 + 3 = 403
    assert.equal(
      computeBackoff({ baseDelay: 100, maxDelay: 10_000, attempt: 3, jitter: fixed }),
      403,
    );
  });

  it('re-clamps jittered output to maxDelay', () => {
    // A jitter that overshoots; the cap must still hold.
    const overshoot = (delay) => delay * 10;
    // attempt 3, base 100 -> raw 400 -> jittered 4000 -> capped 1000
    assert.equal(
      computeBackoff({ baseDelay: 100, maxDelay: 1000, attempt: 3, jitter: overshoot }),
      1000,
    );
  });

  it('rejects jitter that returns a negative value', () => {
    const bad = () => -5;
    assert.throws(
      () => computeBackoff({ baseDelay: 100, maxDelay: 10_000, attempt: 1, jitter: bad }),
      { name: 'RangeError' },
    );
  });

  it('rejects jitter that returns NaN', () => {
    const bad = () => NaN;
    assert.throws(
      () => computeBackoff({ baseDelay: 100, maxDelay: 10_000, attempt: 1, jitter: bad }),
      { name: 'RangeError' },
    );
  });

  it('does not call jitter when baseDelay is 0', () => {
    let called = false;
    const spy = () => { called = true; return 0; };
    const result = computeBackoff({ baseDelay: 0, maxDelay: 10_000, attempt: 3, jitter: spy });
    assert.equal(result, 0);
    assert.equal(called, false);
  });
});

// --- Input validation -------------------------------------------------------

describe('computeBackoff (validation)', () => {
  it('rejects non-finite baseDelay', () => {
    assert.throws(
      () => computeBackoff({ baseDelay: Infinity, maxDelay: 10, attempt: 1 }),
      { name: 'RangeError' },
    );
    assert.throws(
      () => computeBackoff({ baseDelay: NaN, maxDelay: 10, attempt: 1 }),
      { name: 'RangeError' },
    );
  });

  it('rejects negative baseDelay', () => {
    assert.throws(
      () => computeBackoff({ baseDelay: -1, maxDelay: 10, attempt: 1 }),
      { name: 'RangeError' },
    );
  });

  it('rejects negative maxDelay', () => {
    assert.throws(
      () => computeBackoff({ baseDelay: 100, maxDelay: -1, attempt: 1 }),
      { name: 'RangeError' },
    );
  });

  it('rejects non-integer attempt', () => {
    assert.throws(
      () => computeBackoff({ baseDelay: 100, maxDelay: 10_000, attempt: 1.5 }),
      { name: 'RangeError' },
    );
  });

  it('rejects negative attempt', () => {
    assert.throws(
      () => computeBackoff({ baseDelay: 100, maxDelay: 10_000, attempt: -1 }),
      { name: 'RangeError' },
    );
  });

  it('rejects non-finite attempt', () => {
    assert.throws(
      () => computeBackoff({ baseDelay: 100, maxDelay: 10_000, attempt: Infinity }),
      { name: 'RangeError' },
    );
  });
});

// --- createBackoff factory --------------------------------------------------

describe('createBackoff', () => {
  it('returns a function bound to the configured defaults', () => {
    const backoff = createBackoff({ baseDelay: 100, maxDelay: 10_000 });
    assert.equal(backoff(1), 100);
    assert.equal(backoff(2), 200);
    assert.equal(backoff(5), 1600);
  });

  it('defaults maxDelay to Infinity when omitted', () => {
    const backoff = createBackoff({ baseDelay: 1, maxDelay: Number.MAX_SAFE_INTEGER });
    // attempt 20 -> 2^19 = 524288, no cap
    assert.equal(backoff(20), 524_288);
  });

  it('threads jitter through from configuration', () => {
    const fixed = (delay, attempt) => delay + attempt;
    const backoff = createBackoff({ baseDelay: 100, maxDelay: 10_000, jitter: fixed });
    // attempt 3 -> raw 400 -> jittered 403
    assert.equal(backoff(3), 403);
  });

  it('throws if baseDelay is omitted entirely', () => {
    assert.throws(
      () => createBackoff({}),
      { name: 'TypeError' },
    );
  });

  it('validates per-call: bad attempt still throws', () => {
    const backoff = createBackoff({ baseDelay: 100, maxDelay: 10_000 });
    assert.throws(
      () => backoff(-1),
      { name: 'RangeError' },
    );
  });
});
