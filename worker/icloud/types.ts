import type { CalendarPrivacyMode as PrivacyMode } from '../../src/types';
declare global {
  interface Env {
    ICLOUD_CREDENTIAL_ENCRYPTION_KEY?: string;
  }
}
export interface Connection {
  id: string;
  account: string;
  password_ciphertext: string;
  password_iv: string;
  encryption_version: number;
  principal_url: string;
  home_url: string;
  requires_attention: number;
}
export interface Calendar {
  url: string;
  source_id: string;
  name: string;
  color: string;
  enabled: number;
  privacy_mode: PrivacyMode;
  member_id: string | null;
  supports_sync: number;
  sync_token: string | null;
  window_start: string | null;
  window_end: string | null;
  sync_time_zone: string | null;
  full_synced_at: string | null;
  last_synced_at: string | null;
  last_attempt_at: string | null;
  last_sync_error: 'authorization' | 'configuration' | 'unavailable' | null;
}
export interface Resource {
  href: string;
  etag: string;
  event_ids: string;
}
