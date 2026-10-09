// Scripted brain drivers, for tests of the registry, the runner and the chat route.
//
// A fake DRIVER, not a fake registry: the suites that use these run the real registry over
// them, so what they prove about selection, laziness and the wire is proven on the code
// that ships.

import type { Brain, BrainDriver, BrainReadiness, ChatRequest, StreamSink } from '../../brains/brain.js';
import { createBrainRegistry, type BrainRegistry, type BrainRegistryOptions } from '../../brains/registry.js';

/** A brain from the one method a test cares about. */
export function brainOf(stream: (request: ChatRequest, sink: StreamSink) => Promise<void> = async () => {}, stop: () => void = () => {}): Brain {
  const brain: Brain = {
    stream,
    async complete(request) {
      let body = '';
      await brain.stream(request, { write: (chunk) => (body += chunk) });
      return body;
    },
    stop,
  };
  return brain;
}

export type FakeDriver = BrainDriver & {
  /** What the next probe will answer. Settable, so a test can change the machine under the runner. */
  readiness: BrainReadiness;
  probes: number;
  created: number;
};

/** A driver that is ready, verified and accepts anything — until a test says otherwise. */
export function fakeDriver(id: string, over: Partial<BrainDriver> & { readiness?: BrainReadiness } = {}): FakeDriver {
  const { readiness = { state: 'ready' }, ...rest } = over;
  const driver: FakeDriver = {
    id,
    name: id.toUpperCase(),
    via: `your ${id}`,
    verified: true,
    streaming: true,
    readiness,
    probes: 0,
    created: 0,
    async probe(): Promise<BrainReadiness> {
      driver.probes += 1;
      return driver.readiness;
    },
    catalog: () => ({ efforts: [], models: [] }),
    acceptsModel: () => true,
    acceptsEffort: () => true,
    create(): Brain {
      driver.created += 1;
      return brainOf();
    },
    ...rest,
  };
  return driver;
}

/** A registry over these drivers whose first round has ALREADY landed — what a page sees after its first contact. */
export async function probed(drivers: readonly BrainDriver[], options: Omit<BrainRegistryOptions, 'drivers'> = {}): Promise<BrainRegistry> {
  const registry = createBrainRegistry({ drivers, ...options });
  await registry.probe();
  return registry;
}
