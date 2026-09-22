import { ApiError } from '../database';
import { sync } from './calendar';
import type { GoogleEnv } from './types';

// Both cron and the public, staleness-gated refresh use the exact manual sync service.
export async function automaticSync(env: GoogleEnv) {
  try {
    const results = await sync(env, undefined, true);
    return { outcome: 'complete' as const, synced: results.length };
  } catch (error) {
    // Busy is normal across devices. Do not serialize/log exception details.
    return {
      outcome:
        error instanceof ApiError && error.code === 'google_busy'
          ? ('busy' as const)
          : ('unavailable' as const),
      synced: 0,
    };
  }
}
