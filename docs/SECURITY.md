# Security Review

- **Secrets**: only from `process.env`. `TRADING_WALLET_SECRET` is parsed inside `execution/live.ts`,
  never logged, never returned; only the public key is exposed (truncated) on the readiness page.
- **Auth**: mutating endpoints use constant-time comparison of `x-admin-token`. Without
  `ADMIN_TOKEN` the readiness page and Settings page warn loudly. Run behind TLS + IP allow-list.
- **SQL injection**: all queries via Drizzle parameterised builders; the two raw fragments are
  constants with bound columns.
- **XSS**: React escaping; no `dangerouslySetInnerHTML`. Provider strings (names/symbols) are
  length-capped on ingest.
- **CSRF**: mutating routes require a custom header, which browsers do not send cross-origin.
- **Input validation**: mints validated against base58 regex; settings validated against
  min/max/type; confirmation phrases for SELL ALL and live enable; numeric coercion guarded.
- **Live activation**: requires env flag + admin token + typed phrase + readiness pass + configured
  key & wallet, and the executor re-checks env + DB + runtime flags on every order.
- **Idempotency**: unique index on `trades.idempotency_key`; open-position check; cooldown.
- **Dependencies**: `npm audit` reports advisories in transitive dev tooling; review before
  deploying publicly. No dependency handles keys.
- **Not done / out of scope**: multi-user auth, encrypted secret storage (use your platform's
  secret manager), rate limiting of the dashboard itself.
