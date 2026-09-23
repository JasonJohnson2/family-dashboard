import { readJson } from './http';
import { googleRoute } from './google/routes';
import { mutationSchema } from '../src/data/contracts';
import {
  ApiError,
  HOUSEHOLD_ID,
  mutationStatements,
  readState,
  validateReferences,
} from './database';

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname.startsWith('/api/google/')) return googleRoute(request, env);
    try {
      if (url.pathname === '/api/household' && request.method === 'GET')
        return json(await readState(env.DB));
      if (url.pathname !== '/api/mutations') throw new ApiError(404, 'API endpoint not found.');
      if (request.method !== 'POST') throw new ApiError(405, 'Use POST to save changes.');
      const origin = request.headers.get('Origin');
      if (
        (origin && origin !== url.origin) ||
        request.headers.get('Sec-Fetch-Site') === 'cross-site'
      )
        throw new ApiError(403, 'Use the dashboard to make this change.');
      const parsed = mutationSchema.safeParse(await readJson(request));
      if (!parsed.success)
        throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Check your change.');
      const mutation = parsed.data;
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(mutation)),
      );
      const fingerprint = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      const receipt = await env.DB.prepare(
        'SELECT fingerprint FROM mutation_receipts WHERE household_id=? AND id=?',
      )
        .bind(HOUSEHOLD_ID, mutation.id)
        .first<{ fingerprint: string }>();
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new ApiError(
            409,
            'This save identifier has already been used.',
            'request_mismatch',
          );
        return json(await readState(env.DB));
      }
      const before = await readState(env.DB);
      if (before.household.revision !== mutation.revision)
        throw new ApiError(
          409,
          'Another device changed your household. Latest data has been loaded; review and try again.',
          'conflict',
        );
      validateReferences(before, mutation.operations);
      const results = await env.DB.batch(mutationStatements(env.DB, mutation, fingerprint));
      if (results.at(-1)?.meta.changes !== 1) {
        // A concurrent replay may have committed the same request while we were validating.
        const saved = await env.DB.prepare(
          'SELECT fingerprint FROM mutation_receipts WHERE household_id=? AND id=?',
        )
          .bind(HOUSEHOLD_ID, mutation.id)
          .first<{ fingerprint: string }>();
        if (saved?.fingerprint !== fingerprint)
          throw new ApiError(
            409,
            'Another device changed your household. Latest data has been loaded; review and try again.',
            'conflict',
          );
      }
      return json(await readState(env.DB));
    } catch (error) {
      if (error instanceof ApiError)
        return json({ error: error.message, code: error.code }, error.status);
      if (
        error instanceof Error &&
        /constraint failed|UNIQUE constraint|FOREIGN KEY constraint/i.test(error.message)
      )
        return json(
          {
            error:
              'This change conflicts with existing data. Check duplicate names/dates or records still assigned to family members.',
            code: 'constraint',
          },
          422,
        );
      console.error(
        JSON.stringify({
          event: 'household_api_error',
          path: url.pathname,
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
      return json(
        {
          error: 'Your household could not be saved or loaded. Please retry.',
          code: 'unavailable',
        },
        503,
      );
    }
  },
} satisfies ExportedHandler<Env>;
