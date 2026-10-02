import { ApiError } from '../database';

export type SyncPhase = 'credentials' | 'calendar-query' | 'event-download' | 'database';
export interface SyncDiagnostic {
  code: string;
  message: string;
  phase?: SyncPhase;
  httpStatus?: number;
}

// Only application-owned descriptions are returned. Never serialize exception
// messages, CalDAV bodies, resource addresses, calendar names or credentials.
const descriptions: Record<string, string> = {
  icloud_authorization: 'iCloud sign-in was rejected. Update the app-specific password.',
  icloud_configuration: 'The calendar encryption key is missing or invalid.',
  icloud_credentials:
    'The saved credential could not be decrypted. Restore the encryption key or reconnect.',
  icloud_address: 'iCloud returned an unsupported calendar server or resource address.',
  icloud_response: 'iCloud returned a calendar response the dashboard could not read.',
  icloud_event: 'An iCloud event could not be safely imported.',
  icloud_limit: 'This iCloud sync exceeded the bounded request, response or event limit.',
  calendar_limit: 'The combined calendar sync reached its external request limit.',
  icloud_commit: 'The calendar database could not commit this sync. The batch was not saved.',
  icloud_timeout: 'iCloud took too long to respond. Retry synchronization after the cooldown.',
  icloud_network: 'The Worker could not reach iCloud. Retry synchronization after the cooldown.',
  icloud_unavailable:
    'iCloud synchronization could not complete. Check the sync step and HTTP status below.',
};

export function icloudDiagnostic(error: unknown, phase?: SyncPhase): SyncDiagnostic {
  const code =
    error instanceof ApiError && Object.hasOwn(descriptions, error.code)
      ? error.code
      : 'icloud_unavailable';
  const httpStatus =
    error instanceof ApiError &&
    'davStatus' in error &&
    typeof error.davStatus === 'number' &&
    error.davStatus >= 400 &&
    error.davStatus <= 599
      ? error.davStatus
      : undefined;
  return {
    code,
    message: descriptions[code],
    ...(phase ? { phase } : {}),
    ...(httpStatus ? { httpStatus } : {}),
  };
}
