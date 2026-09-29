# Private household access

## One-time production setup

The GitHub → Cloudflare pipeline applies `0006_household_access.sql` before publishing the Worker. This is additive: members, completions, rewards/ledger, meals, lists, events, encrypted Google credentials, member mappings, privacy settings and sync tokens are retained. Existing operator unlocks and in-progress Google authorization starts must be restarted. **The site becomes private immediately, including before initial credential setup.** There is no unauthenticated setup endpoint and no default password.

1. On your computer, open a terminal in the updated repository. Run `pnpm install --frozen-lockfile` if needed, then **`pnpm auth:credential`**.
2. Save a strong, unique credential in your password manager: preferably 24+ random characters or several randomly chosen words. The helper accepts 20–128 characters, asks twice with hidden input, and prints only a salted verifier. It does not write files, contact production, or print your credential. Do not put credentials in command arguments, source, chat, or GitHub.
3. In Cloudflare, open **Workers & Pages → family-dashboard → Settings → Variables and Secrets → Add**, select **Secret**, name it **`HOUSEHOLD_BOOTSTRAP_VERIFIER`**, and paste the entire single-line verifier. Save/apply the secret to the running Worker. This is a runtime Worker secret, not a frontend variable or a build-only variable. The verifier has `$` separators: copy it directly into the dashboard instead of interpolating it in a shell command.
4. Confirm the existing **`REWARDS_OPERATOR_PIN`** Worker secret is configured (at least 8 characters). It remains a separate credential. Keep the existing Google secrets unchanged.
5. Open `https://family-dashboard.jjayson400.workers.dev` on your computer. Enter the original household credential (not the verifier), select **Trust this device** if this is your own computer, optionally name it, and select **Enter dashboard**. The first successful login atomically establishes the D1 credential; later logins cannot overwrite it using the bootstrap secret.
6. Once login works, remove **`HOUSEHOLD_BOOTSTRAP_VERIFIER`** from Cloudflare's Worker secrets. The D1 verifier is now authoritative. Removing the bootstrap secret does not sign out devices or prevent future logins.
7. On the iPad, open the HTTPS URL in Safari and use **Share → Add to Home Screen**. Open the installed app, enter the same credential, select **Trust this device**, and name it **Kitchen dashboard**. Safari and installed PWAs may have separate cookie storage: authorize the installed app itself if prompted. Ordinary reopening does not require login while its cookie remains valid.

If an already-open old app shows an access error instead of the new welcome screen, accept its app-update prompt and reload. No manual production deploy or table editing is needed. If setup is missing or mistyped, login fails closed; correct the runtime secret and try again. Repeated attempts may require waiting 15 minutes. Keep the original credential in your password manager: there is no password-reset email service. If you forget it but retain a trusted browser, use the operator PIN to change it. Losing both the credential and all trusted browsers requires owner-controlled administrative recovery; changing the bootstrap secret cannot take over a configured household.

## Local development

Run migrations as usual, run `pnpm auth:credential` with a **different development-only credential**, and put its verifier in ignored `.dev.vars`:

```dotenv
HOUSEHOLD_BOOTSTRAP_VERIFIER="paste-the-generated-verifier-here"
REWARDS_OPERATOR_PIN="your-development-only-operator-credential"
```

Then run `pnpm dev`. The native rate-limit binding is declared in Wrangler. HTTP cookie relaxation is limited to Worker requests on localhost/loopback for development; every deployed HTTPS session uses Secure cookies. Vite's LAN proxy is for development-only data/credentials. Use the deployed HTTPS PWA for realistic iPad trust/storage testing. Never enter a production credential over a plain-HTTP LAN development server.

## Three separate boundaries

- **Household access** allows a browser to view and change ordinary household data. Every private API is guarded in the Worker, including Google status/refresh, imported projections, and Rewards.
- **Member identity** selects who a chore or reward belongs to. It is not authentication; there are no child accounts.
- **Operator PIN** unlocks privileged Rewards and security actions. Viewing/revoking devices and changing the credential require both a household cookie and the existing short-lived operator token. Operator tokens are now bound to the household session that unlocked them; another browser cannot reuse one. Expiration, PIN rotation and throttling remain in place.

The header gear opens **Household privacy** on every viewport. **Lock this device** requires deliberate confirmation, revokes its session on the server, clears the cookie and discards the in-memory household state/operator access. An operator can revoke individual browsers or change the household credential. A credential change invalidates **all sessions, including the current device**, and pending Google connect flows, atomically through a credential-version change. Sign in again using the new credential.

## Credential and session storage

Credentials use native Workers Web Crypto **PBKDF2-HMAC-SHA-256, 100,000 iterations**, a fresh cryptographically random 32-byte salt and 32-byte derived key. The versioned verifier string is the only credential representation stored in D1. Comparison covers the full fixed-length derived output. This Workers-compatible KDF is paired with a strong-credential policy and strict online throttling; it is not an excuse to choose a predictable phrase. Tests also run the KDF in actual workerd, rather than only Node.

Sessions use random 32-byte bearer tokens. Only SHA-256 token digests are stored in `household_sessions`, with a unique lookup index and household scope. Rows also contain an ID, friendly name, trusted flag, creation/expiry timestamps, optional revocation timestamp and credential version. No browser fingerprint is collected. Device names are user-provided labels, not proof of device identity. We omit last-used tracking to avoid recurring writes.

On HTTPS the token is returned **only** in `__Host-household`, with `HttpOnly; Secure; SameSite=Lax; Path=/`, no Domain attribute, and a fixed Max-Age:

| Mode           | Lifetime |
| -------------- | -------- |
| Normal browser | 12 hours |
| Trusted device | 180 days |

There is no short inactivity timeout or silent session renewal. Expiry is enforced server-side. Browsers can clear cookies earlier, and private-browsing sessions are not reliable long-term storage. The application does not promise to override Safari storage policy. Expired/revoked rows are cleaned on successful login.

## API, cache and app lifecycle

Only static assets/the shell, `POST /api/auth/login`, and the independently validated Google callback are available without a household cookie. `/api/auth/session` verifies access without returning household data. Direct unauthenticated private API requests return 401 with a generic `auth_required` response. Unknown API routes also go through the guard. There is no header, query-string, member-ID or operator-PIN bypass.

The React household provider mounts only after verification. Unauthorized responses clear its state/queued writes and operator access. Visibility return, focus, reconnect and a visible-page 60-second check revalidate access. Hidden pages conceal their contents until access is rechecked. An expired/revoked device returns to the welcome screen; it does not keep a private offline snapshot. An unconfirmed edit may need to be entered again after signing in. A request already authorized/in flight at revocation can finish; revocation cannot retract data previously delivered to an authorized device.

Private JSON uses `no-store` (household/auth APIs also specify `private`); the service worker precaches only static assets and excludes `/api/` navigation fallback. There is no API runtime cache, local-storage household snapshot or persisted offline write queue. Logging omits request bodies, tokens, codes and SQL exception details. Worker request observability remains disabled. Static assets set no-referrer, anti-framing and a same-origin Content Security Policy; inline styles are allowed for the existing member-color design, but inline scripts and external scripts are not.

Same-origin/fetch-site checks plus JSON content types protect writes from cross-site requests. HttpOnly prevents script access to the household cookie, but an XSS on this origin could still issue authenticated requests; CSP and avoiding HTML injection remain important.

## Brute-force protection and D1 usage

`AUTH_RATE_LIMITER` uses Cloudflare's native rate-limit binding (namespace `1006`, reserved for this app): **5 login attempts per IP per 60 seconds per Cloudflare location**. There is no user/account identifier to safely rate-limit before login. Shared IPs can therefore briefly share the limit. Native counters are eventually consistent/local to a location, so an atomic D1 household bucket also permits at most **20 verification attempts per 15-minute window** across devices and locations. All attempts, including successful ones, count. Generic failures reveal no household/account lookup result.

The D1 bucket stops updating once full; blocked attempts change zero rows. Failed-login writes are bounded to about 1,920 bucket updates/day even under distributed guessing, rather than scaling with request volume. Native rejections never reach D1. Missing rate-limit binding fails closed. An attacker can consume the login allowance and temporarily delay legitimate new logins; existing trusted sessions remain usable. This is a deliberate tradeoff for a small private household, not complete denial-of-service protection.

Normal session validation and household reads **perform zero auth writes**. No last-seen updates, access audit rows, cookie rotation or balance rewrites occur on reads. Login, logout, revocation, credential changes and PIN unlocking write only their required rows. Authentication polling is read-only. Google freshness/write optimizations remain intact.

Cloudflare documents [native rate-limit locality and accuracy](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) and [Web Crypto support](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).

## Google compatibility

Google management requires household access **and** either the existing server-side admin bearer credential (administrative clients) or the existing session-bound operator token (browser operators). `GOOGLE_ADMIN_KEY` is never shipped to React; the updated operator-console guide uses the PIN unlock endpoint instead. Stale/manual refresh requires household access but no operator PIN, and keeps its existing cooldowns.

Connect binds each one-use OAuth state to the initiating household session. Callback does not blindly require a custom header or the household cookie: its existing OAuth HttpOnly SameSite=Lax cookie, random state, PKCE and expiry validation still apply, and the initiating session must remain valid/unrevoked with the current credential version. This permits Google's top-level return without weakening callback protections. Old in-flight flows without a session binding fail safely and must restart. Scopes, encryption, discovery, privacy, member mapping, working-location filtering and incremental synchronization are unchanged; existing connections do not need reconnecting.

## Validation and boundaries

Run `pnpm format:check`, `pnpm test`, `pnpm build`, `pnpm test:e2e` and `pnpm deploy:check`. Direct Worker tests exercise the unauthenticated route matrix, cookies, salted hashes, bootstrap protection, expiry/revocation, session-bound privilege checks, credential rotation, cross-site requests, rate limits, zero-write reads and migration preservation. Browser tests exercise both Chromium and WebKit, persistent cookies, PWA caching/offline startup, device revocation, logout, credential changes and responsive screenshots. Existing dashboard/Rewards/Google suites now authenticate through real test sessions; there is no production test bypass.

Someone who knows only the public workers.dev URL cannot obtain private household data through the API. This does not erase information that was publicly accessible before deployment or data already delivered to a trusted device. Anyone holding the household credential can authorize a new device; it is a shared household credential, not individual identity or parental controls. Retain a password-manager copy, revoke lost devices, and test Home Screen reopening on the physical iPad after setup. Automated WebKit is not a substitute for physical iOS storage testing.
