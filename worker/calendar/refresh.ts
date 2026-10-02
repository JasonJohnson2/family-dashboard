import { z } from 'zod';
import { ApiError } from '../database';
import { readJson } from '../http';
import { automaticSync } from '../google/automatic';
import { syncStatus } from '../google/status';
import { sync as icloudSync, status as icloudStatus } from '../icloud/service';
import { icloudDiagnostic, type SyncDiagnostic } from './diagnostics';
export async function refreshCalendars(request: Request, env: Env) {
  if (!['GET', 'POST'].includes(request.method))
    throw new ApiError(405, 'Use GET or POST for calendar refresh.');
  let manual = false;
  if (request.method === 'POST') {
    if (request.headers.get('Origin') !== new URL(request.url).origin)
      throw new ApiError(403, 'Use the dashboard origin.');
    const input = z
      .object({ manual: z.boolean().optional() })
      .strict()
      .safeParse(await readJson(request));
    if (!input.success) throw new ApiError(400, 'Send an empty object or a manual refresh flag.');
    manual = !!input.data.manual;
  }
  const safe = async (
    fn: () => Promise<{ outcome: string; synced: number; diagnostic?: SyncDiagnostic }>,
    provider: 'google' | 'icloud',
  ) => {
    try {
      return await fn();
    } catch (e) {
      return {
        outcome: e instanceof ApiError && e.code === 'icloud_busy' ? 'busy' : 'unavailable',
        synced: 0,
        ...(provider === 'icloud' && !(e instanceof ApiError && e.code === 'icloud_busy')
          ? {
              diagnostic: icloudDiagnostic(
                e,
                e instanceof ApiError &&
                  ['icloud_configuration', 'icloud_credentials'].includes(e.code)
                  ? 'credentials'
                  : undefined,
              ),
            }
          : {}),
      };
    }
  };
  // Keep providers independent: a failed Apple request never hides Google's safe data.
  const [google, icloud] =
    request.method === 'POST'
      ? await Promise.all([
          safe(() => automaticSync(env, manual), 'google'),
          safe(() => icloudSync(env, manual), 'icloud'),
        ])
      : [
          { outcome: 'complete', synced: 0 },
          { outcome: 'complete', synced: 0 },
        ];
  const [gs, is] = await Promise.all([syncStatus(env.DB), icloudStatus(env.DB)]);
  const providers = { google: { ...google, status: gs }, icloud: { ...icloud, status: is } };
  return Response.json(
    {
      synced: google.synced + icloud.synced,
      outcome: [google.outcome, icloud.outcome].includes('unavailable')
        ? 'unavailable'
        : [google.outcome, icloud.outcome].includes('busy')
          ? 'busy'
          : [google.outcome, icloud.outcome].includes('cooldown') &&
              !google.synced &&
              !icloud.synced
            ? 'cooldown'
            : 'complete',
      status: {
        enabledCalendars: gs.enabledCalendars + is.enabledCalendars,
        needsAttention: gs.needsAttention || is.needsAttention,
      },
      providers,
    },
    { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } },
  );
}
