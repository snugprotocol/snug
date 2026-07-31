// routes/artifacts.ts — artifact serving. The CSP HTTP header is the AUTHORITATIVE
// delivery of the runner policy (ADR-0006 obligation): imported byte-exact from the
// runner, never retyped. Deep import of csp.js keeps the server free of the runner's
// React surface (the package index re-exports the React iframe wrapper).

import { RUNNER_CSP } from '@snugprotocol/runner/dist/csp.js';
import type { FastifyInstance } from 'fastify';

import type { ArtifactStore } from '../stores/artifacts.js';

export function registerArtifactRoutes(app: FastifyInstance, artifacts: ArtifactStore): void {
  app.get('/artifacts', async () => ({ artifacts: artifacts.list() }));

  app.get<{ Params: { id: string } }>('/artifacts/:id', async (request, reply) => {
    const artifact = artifacts.get(request.params.id);
    if (artifact === undefined) {
      return reply.status(404).send({ code: 'NOT_FOUND', message: 'no such artifact', retryable: false });
    }
    return reply
      .headers({
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': RUNNER_CSP,
        'x-content-type-options': 'nosniff',
      })
      .send(artifact.html);
  });
}
