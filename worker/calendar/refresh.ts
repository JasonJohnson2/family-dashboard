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
  // A late status read must not discard another provider's committed sync.
  const status = async (
    read: () => Promise<{ enabledCalendars: number; needsAttention: boolean }>,
  ) => {
    try {
      return { status: await read() };
    } catch {
      return {
        status: { enabledCalendars: 0, needsAttention: true },
        diagnostic: {
          code: 'calendar_status',
          message: 'Calendar connection status could not be loaded. Retry shortly.',
          phase: 'database' as const,
        },
      };
    }
  };
  const [gs, is] = await Promise.all([
    status(() => syncStatus(env.DB)),
    status(() => icloudStatus(env.DB)),
  ]);
  const providers = { google: { ...google, ...gs }, icloud: { ...icloud, ...is } };
  return Response.json(
    {
      synced: google.synced + icloud.synced,
      outcome:
        gs.diagnostic || is.diagnostic || [google.outcome, icloud.outcome].includes('unavailable')
          ? 'unavailable'
          : [google.outcome, icloud.outcome].includes('busy')
            ? 'busy'
            : [google.outcome, icloud.outcome].includes('cooldown') &&
                !google.synced &&
                !icloud.synced
              ? 'cooldown'
              : 'complete',
      status: {
        enabledCalendars: gs.status.enabledCalendars + is.status.enabledCalendars,
        needsAttention: gs.status.needsAttention || is.status.needsAttention,
      },
      providers,
    },
    { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } },
  );
}
