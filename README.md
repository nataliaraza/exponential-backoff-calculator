# exponential-backoff-calculator

Computes the delay (in milliseconds) for a given retry attempt using exponential backoff, with an optional jitter transform and a hard maximum delay cap.

## Usage

```js
import {
  computeBackoff,
  createBackoff,
  fullJitter,
  equalJitter,
  decorrelatedJitter,
} from 'exponential-backoff-calculator';

// One-off calculation: attempt 3 with base 100ms, capped at 5s -> 400ms.
const delay = computeBackoff({
  baseDelay: 100,
  maxDelay: 5000,
  attempt: 3,
});

// Create a bound calculator for a retry loop.
const backoff = createBackoff({
  baseDelay: 100,
  maxDelay: 5000,
  jitter: fullJitter,
});

for (let attempt = 1; attempt <= 5; attempt++) {
  const ms = backoff(attempt);
  console.log(`attempt ${attempt}: wait ${ms}ms`);
}
```

## Why

Retry storms are a real problem: when a downstream service blips, every client that was mid-request retries at almost the same instant, and the retry traffic often exceeds the original load. Exponential backoff spreads retries out, and jitter spreads them out *further* so clients don't synchronise on the same schedule.

This library does one thing: turn an attempt number into a delay. It does not sleep, it does not execute your retry callback, it does not track state. The trade-off is that you, the caller, own the loop — which means you can compose this with any cancellation, logging, or circuit-breaking you already have, rather than fitting your code into a retry framework's opinion of how those concerns should interleave.

## Exports

- `computeBackoff({ baseDelay, maxDelay, attempt, jitter })` → `number`
- `createBackoff({ baseDelay, maxDelay?, jitter? })` → `(attempt: number) => number`
- `fullJitter(delay, attempt)` → `number` (in `[0, delay)`)
- `equalJitter(delay, attempt)` → `number` (in `[delay/2, delay]`)
- `decorrelatedJitter(delay, attempt)` → `number` (in `[delay/3, delay)`)

`attempt` is 1-indexed: attempt 1 yields `baseDelay`. Attempt 0 is permitted and yields `baseDelay / 2`; treat it as a pre-retry soft delay if you want it.

## Edges you will hit

- **`maxDelay` caps the jittered output, not just the raw exponential.** A jitter function that overshoots is still clamped. If you need jitter to exceed the cap, raise the cap or write your own jitter that returns the cap minus a small epsilon.
- **Jitter values are validated.** A custom jitter that returns `NaN`, `Infinity`, or a negative number throws `RangeError`. Non-finite or negative `baseDelay`/`maxDelay` and non-integer or negative `attempt` also throw `RangeError`. This is strict by design: a bad delay silently becoming `NaN` in a `setTimeout` is a worse failure mode than an early throw.
- **Large exponents are safe.** `attempt` above ~30 would overflow a 32-bit shift, so the implementation falls back to `Math.pow` and relies on `maxDelay` to cap the result. Configure a `maxDelay`; without one, very high attempt numbers yield `Infinity`.
- **`decorrelatedJitter` here is the stateless approximation**, not the stateful decorrelated-jitter from the AWS blog. The stateful form requires carrying the previous delay across calls, which would make it impure and untestable without injecting a mutable store. The approximation uses a window proportional to the current exponential delay instead.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

