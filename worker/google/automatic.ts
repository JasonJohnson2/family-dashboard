import { ApiError } from '../database';
import { sync } from './calendar';
import type { GoogleEnv } from './types';

// Calendar-page stale refresh and the household sync button share the admin sync service.
export async function automaticSync(env: GoogleEnv, manual = false) {
  try {
    const results = await sync(env, undefined, manual ? 'manual' : 'stale');
    return { outcome: 'complete' as const, synced: results.length };
  } catch (error) {
    // Busy is normal across devices. Do not serialize/log exception details.
    return {
      outcome:
        error instanceof ApiError && error.code === 'google_busy'
          ? ('busy' as const)
          : error instanceof ApiError && error.code === 'google_cooldown'
            ? ('cooldown' as const)
            : ('unavailable' as const),
      synced: 0,
    };
  }
}
