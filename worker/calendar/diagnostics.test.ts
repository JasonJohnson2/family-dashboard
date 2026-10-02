import { expect, it } from 'vitest';
import { ApiError } from '../database';
import { DavError } from '../icloud/dav';
import { icloudDiagnostic } from './diagnostics';

it('reports a safe sync phase and DAV HTTP status without provider response text', () => {
  expect(icloudDiagnostic(new DavError(403), 'calendar-query')).toEqual({
    code: 'icloud_unavailable',
    message:
      'iCloud synchronization could not complete. Check the sync step and HTTP status below.',
    phase: 'calendar-query',
    httpStatus: 403,
  });
});

it('never returns arbitrary exception messages, provider bodies or unknown error codes', () => {
  const privateText = 'private-title private-account fixture-app-password';
  for (const error of [
    new Error(privateText),
    new ApiError(502, privateText, privateText),
    new ApiError(502, privateText, 'icloud_response'),
  ]) {
    expect(JSON.stringify(icloudDiagnostic(error, 'event-download'))).not.toContain(privateText);
  }
});

it('distinguishes bad encryption, event parsing, database and bounded-request failures', () => {
  for (const code of ['icloud_credentials', 'icloud_event', 'icloud_commit', 'calendar_limit']) {
    expect(icloudDiagnostic(new ApiError(503, 'discarded', code)).code).toBe(code);
  }
});
