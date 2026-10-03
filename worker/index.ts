import { executeCalendarSync } from './calendar/execution';
import { dayDifference } from '../src/lib/calendarDates';
import { dateSchema } from '../src/data/contracts';
import { authRoute, requireHousehold, sameOrigin } from './household-auth';
import { operatorRequired, validateRewards } from './rewards';
import { requireRewardOperator, rewardOperatorRoute } from './reward-operator';
import { readJson } from './http';
import { googleRoute } from './google/routes';
import { icloudRoute } from './icloud/routes';
import { refreshCalendars } from './calendar/refresh';
export { CalendarSync } from './calendar/executor';
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
    headers: {
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname.startsWith('/api/auth/')) return await authRoute(request, env);
      // Callback authenticates its one-use state/browser cookie and the initiating session.
      if (url.pathname === '/api/google/callback') return await googleRoute(request, env);
      await requireHousehold(request, env);
      if (request.method !== 'GET' && request.method !== 'HEAD') sameOrigin(request);
      env = { ...env, calendarHttpBudget: { remaining: 40 } };
      if (url.pathname.startsWith('/api/icloud/')) return await icloudRoute(request, env);
      if (url.pathname === '/api/calendar/refresh') return await refreshCalendars(request, env);
      if (url.pathname.startsWith('/api/google/')) return await googleRoute(request, env);
      if (url.pathname === '/api/calendar/events' && request.method === 'GET') {
        const from = dateSchema.safeParse(url.searchParams.get('from')),
          to = dateSchema.safeParse(url.searchParams.get('to'));
        if (!from.success || !to.success || from.data < '1900-01-01' || to.data > '2199-12-31')
          throw new ApiError(400, 'Use a valid calendar window.');
        if (dayDifference(from.data, to.data) < 0 || dayDifference(from.data, to.data) > 61)
          throw new ApiError(400, 'Choose a calendar window of at most 62 days.');
        return await executeCalendarSync(env, {
          kind: 'local-window',
          from: from.data,
          to: to.data,
        });
      }
      if (url.pathname === '/api/household' && request.method === 'GET')
        return json(await readState(env.DB));
      if (url.pathname !== '/api/mutations' && url.pathname !== '/api/rewards/operator')
        throw new ApiError(404, 'API endpoint not found.');
      if (request.method !== 'POST') throw new ApiError(405, 'Use POST to save changes.');
      const origin = request.headers.get('Origin');
      if (
        (origin && origin !== url.origin) ||
        request.headers.get('Sec-Fetch-Site') === 'cross-site'
      )
        throw new ApiError(403, 'Use the dashboard to make this change.');
      if (url.pathname === '/api/rewards/operator') return await rewardOperatorRoute(request, env);
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
      validateRewards(before, mutation.operations);
      if (mutation.operations.some((op) => operatorRequired(before, op)))
        await requireRewardOperator(request, env);
      const results = await env.DB.batch(mutationStatements(env.DB, mutation, fingerprint, before));
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
          // Do not log request bodies, tokens, or SQL exception details.
          category: 'unavailable',
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
