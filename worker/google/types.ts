export interface GoogleSecrets {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_TOKEN_ENCRYPTION_KEY?: string;
  GOOGLE_ADMIN_KEY?: string;
  GOOGLE_APP_ORIGIN?: string;
}
export type GoogleEnv = Env & GoogleSecrets;
export type PrivacyMode = 'busy' | 'title' | 'full';
export interface Connection {
  household_id: string;
  id: string;
  account_id: string | null;
  account_email: string | null;
  refresh_ciphertext: string;
  refresh_iv: string;
  encryption_version: number;
  scopes: string;
}
export interface StoredCalendar {
  google_id: string;
  source_id: string;
  name: string;
  color: string;
  is_primary: number;
  enabled: number;
  privacy_mode: PrivacyMode;
  member_id: string | null;
  projection_version: number;
  sync_token: string | null;
  window_start: string | null;
  window_end: string | null;
  sync_time_zone: string | null;
  full_synced_at: string | null;
  last_synced_at: string | null;
}
export interface GoogleEvent {
  id: string;
  status?: string;
  eventType?: string;
  workingLocationProperties?: { type?: string } | null;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
}
