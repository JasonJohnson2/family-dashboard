-- Additive recovery metadata. Existing credentials, projections and mappings remain intact.
ALTER TABLE google_connections ADD COLUMN requires_reconnect INTEGER NOT NULL DEFAULT 0 CHECK(requires_reconnect IN (0,1));
ALTER TABLE google_connections ADD COLUMN last_connection_error TEXT CHECK(last_connection_error IN ('authorization','configuration','unavailable'));
-- Snapshot the intended connection so a callback cannot replace a different/new connection.
ALTER TABLE google_oauth_states ADD COLUMN connection_id TEXT;
