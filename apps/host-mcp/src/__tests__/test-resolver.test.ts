// The test-only DNS resolver (D-B11).
//
// WHY THIS FILE EXISTS. The resolver had no test, and it was broken: Node calls a custom
// `lookup` with `{ all: true }` and expects an ARRAY of `{address, family}` back, but it
// answered with a bare string. Every request through the test build died as
// `Invalid IP address: undefined` — which is why AC3/AC4 could not be written against it,
// and why the e2e never reached the stub at all. Reproduced in isolation before fixing:
// a `node:https` request with a string-answering lookup fails that way every time.

import { describe, expect, it } from 'vitest';

import { resolverFromEnv } from '../main.test-hooks.js';

type Cb = (err: Error | null, address: unknown, family?: number) => void;
const lookupOf = (spec: string) => resolverFromEnv(spec) as unknown as (h: string, o: unknown, cb: Cb) => void;

describe('resolverFromEnv', () => {
  it('answers Node’s ACTUAL contract: `all: true` wants an array of {address, family}', async () => {
    const answer = await new Promise<unknown>((resolve) => {
      lookupOf('stub.snug.test=127.0.0.1')('stub.snug.test', { all: true }, (_e, address) => resolve(address));
    });
    // The exact shape `node:https` reads. A bare string here is what produced
    // `Invalid IP address: undefined` on every single request.
    expect(answer).toEqual([{ address: '127.0.0.1', family: 4 }]);
  });

  it('still answers the single-address form when Node does not ask for all', async () => {
    const answer = await new Promise<unknown>((resolve) => {
      lookupOf('stub.snug.test=127.0.0.1')('stub.snug.test', {}, (_e, address) => resolve(address));
    });
    expect(answer).toBe('127.0.0.1');
  });

  it('refuses a host it was never told about, rather than inventing one', async () => {
    const error = await new Promise<Error | null>((resolve) => {
      lookupOf('stub.snug.test=127.0.0.1')('elsewhere.example', { all: true }, (e) => resolve(e));
    });
    expect(error).toBeInstanceOf(Error);
  });

  it('is absent unless the env var says otherwise — the release must never carry one', () => {
    expect(resolverFromEnv(undefined)).toBeUndefined();
    expect(resolverFromEnv('')).toBeUndefined();
  });
});
