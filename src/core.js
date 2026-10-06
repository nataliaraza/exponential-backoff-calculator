/**
 * Core backoff calculation logic, separated from the public entry point so
 * it can be unit-tested in isolation and re-used by other callers if needed.
 * @module core
 */

/**
 * The shape of an optional jitter strategy.
 *
 * A jitter function receives the deterministic delay and the attempt number
 * and MUST return a non-negative number of milliseconds. Keeping this as a
 * plain function (rather than a set of named strategies) means callers can
 * compose their own without us shipping a taxonomy of jitter flavours.
 *
 * @typedef {(delay: number, attempt: number) => number} JitterFn
 */

/**
 * Full jitter: returns a uniform random value in [0, delay).
 *
 * This is the "full jitter" scheme described in the AWS architecture blog
 * (https://aws.amazon.com/blogs/architecture/). It spreads retries across the
 * whole available window, which is the best choice when many clients retry
 * against the same downstream at once — the exact scenario that causes
 * thundering herds.
 *
 * We guard against Math.random returning exactly 0 because that would yield
 * a zero delay on attempt 1 for a base of e.g. 100ms, which some callers may
 * not expect. A zero delay is not harmful, but pushing it to a hair above zero
 * keeps the contract "delay > 0 for attempt > 0" intact.
 *
 * @param {number} delay - The deterministic delay in ms (already clamped to maxDelay).
 * @param {number} _attempt - The attempt number, ignored by full jitter.
 * @returns {number} A jittered delay in [0, delay).
 */
export function fullJitter(delay, _attempt) {
  if (!Number.isFinite(delay) || delay <= 0) return 0;
  const r = Math.random();
  if (r === 0) return Number.MIN_VALUE;
  return r * delay;
}

/**
 * Equal jitter: returns base + uniform(0, (delay - base)/2).
 *
 * Equal jitter preserves a minimum spread while never exceeding the
 * deterministic delay. It trades a little randomness for tighter latency.
 *
 * @param {number} delay - The deterministic delay in ms.
 * @param {number} _attempt - The attempt number, ignored.
 * @returns {number} A jittered delay in [delay/2, delay].
 */
export function equalJitter(delay, _attempt) {
  if (!Number.isFinite(delay) || delay <= 0) return 0;
  const half = delay / 2;
  return half + Math.random() * half;
}

/**
 * Decorrelated jitter (a simplified form): returns uniform(min, delay*3),
 * but never more than the configured maximum.
 *
 * True decorrelated jitter tracks the *previous* delay across calls. That
 * requires state, which would make this function impure and hard to test
 * deterministically. We implement the stateless approximation that appears
 * in many client libraries: a window proportional to the current exponential
 * delay. This keeps the function pure and side-effect free.
 *
 * @param {number} delay - The deterministic delay in ms.
 * @param {number} _attempt - The attempt number, ignored.
 * @returns {number} A jittered delay in [delay/3, delay).
 */
export function decorrelatedJitter(delay, _attempt) {
  if (!Number.isFinite(delay) || delay <= 0) return 0;
  const lower = delay / 3;
  return lower + Math.random() * (delay - lower);
}

/**
 * Compute a deterministic exponential backoff delay.
 *
 * delay = min(maxDelay, baseDelay * 2^(attempt - 1))
 *
 * `attempt` is 1-indexed: the first retry is attempt 1 and yields `baseDelay`.
 * Attempt 0 is permitted and yields `baseDelay / 2`; this is convenient for
 * callers that want a pre-retry "soft" backoff, but callers should normally
 * start at 1.
 *
 * We use bit shifting for powers of two where it is safe (exponent in
 * [0, 30]) and Math.pow otherwise. Bit shifting is both faster and, more
 * importantly, returns an exact integer — so `2^10 * 1000` is `1024000`, not
 * `1024000.0000001`. Above exponent 30 we fall back to Math.pow, which is
 * fine because at those scales the caller has a maxDelay cap anyway.
 *
 * @param {object} opts
 * @param {number} opts.baseDelay  - Base delay in ms (attempt 1). Must be finite and >= 0.
 * @param {number} opts.maxDelay    - Hard upper bound in ms. Must be finite and >= 0.
 * @param {number} opts.attempt     - Attempt number, 1-indexed. Must be finite.
 * @param {JitterFn} [opts.jitter]  - Optional jitter transform applied after clamping.
 * @returns {number} Delay in milliseconds. Non-negative.
 */
export function computeBackoff({ baseDelay, maxDelay, attempt, jitter }) {
  if (!Number.isFinite(baseDelay) || baseDelay < 0) {
    throw new RangeError(`baseDelay must be a finite non-negative number, got ${baseDelay}`);
  }
  if (!Number.isFinite(maxDelay) || maxDelay < 0) {
    throw new RangeError(`maxDelay must be a finite non-negative number, got ${maxDelay}`);
  }
  if (!Number.isFinite(attempt)) {
    throw new RangeError(`attempt must be a finite number, got ${attempt}`);
  }
  // Fractional attempts are nonsensical for retry counting; reject rather than
  // silently rounding, which would hide caller bugs.
  if (!Number.isInteger(attempt)) {
    throw new RangeError(`attempt must be an integer, got ${attempt}`);
  }
  if (attempt < 0) {
    throw new RangeError(`attempt must be >= 0, got ${attempt}`);
  }

  if (baseDelay === 0 || maxDelay === 0) {
    // A zero base or zero max means "no delay ever". Short-circuit to avoid
    // multiplying zeros and to keep the jitter path consistent (jitter of 0 is 0).
    return 0;
  }

  const exponent = attempt - 1;
  // 1 << n is defined for n in [0, 30]; for n=31 it overflows to a negative
  // 32-bit int. We clamp to the safe range and use Math.pow above it.
  const factor = exponent <= 30 && exponent >= 0 ? (1 << exponent) : Math.pow(2, exponent);

  const raw = baseDelay * factor;
  const clamped = Math.min(raw, maxDelay);

  if (typeof jitter === 'function') {
    const jittered = jitter(clamped, attempt);
    if (!Number.isFinite(jittered) || jittered < 0) {
      // Jitter is caller-supplied; we validate defensively because a bad
      // jitter value can produce negative or NaN sleeps in downstream code.
      throw new RangeError(`jitter returned an invalid delay: ${jittered}`);
    }
    // Jitter may legitimately exceed the deterministic delay (e.g. decorrelated
    // jitter). We re-clamp to maxDelay so the cap is always honoured.
    return Math.min(jittered, maxDelay);
  }

  return clamped;
}

/**
 * Create a backoff calculator bound to fixed defaults.
 *
 * The returned function closes over `baseDelay`, `maxDelay`, and `jitter`,
 * so callers only pass `attempt` per call. This is the form most retry loops
 * want: configure once, call per attempt.
 *
 * @param {object} opts
 * @param {number} opts.baseDelay  - Base delay in ms.
 * @param {number} [opts.maxDelay=Infinity] - Upper bound in ms.
 * @param {JitterFn} [opts.jitter]          - Optional jitter transform.
 * @returns {(attempt: number) => number} A function that computes the delay for a given attempt.
 */
export function createBackoff({ baseDelay, maxDelay = Infinity, jitter } = {}) {
  if (baseDelay === undefined) {
    throw new TypeError('createBackoff requires a baseDelay option');
  }
  // We deliberately do NOT clone opts here; computeBackoff validates on each
  // call, which means misconfiguration surfaces at call time with the actual
  // values rather than at construction time with a stack trace pointing here.
  return (attempt) => computeBackoff({ baseDelay, maxDelay, attempt, jitter });
}
