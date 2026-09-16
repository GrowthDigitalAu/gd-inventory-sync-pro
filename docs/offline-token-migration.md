# Expiring offline token rollout

The app requests expiring offline access tokens using Shopify's
`expiringOfflineAccessTokens` flag. The Prisma adapter stores both refresh-token
fields alongside the existing access-token expiry. Shopify's SDK obtains a new
token for authenticated requests when the session is near expiry and supports
refreshing offline sessions through `unauthenticated.admin`.

Existing permanent sessions are treated as expired when loaded, without changing
their database records. On the next authenticated app visit, the SDK exchanges
the merchant's ID token and saves the replacement token pair. This avoids leaving
permanent sessions active indefinitely. No merchant reinstall is required.

## Deployment

Production uses Dokploy with automatic deployment on Git push. With the repository
Dockerfile, startup runs `npm run docker-start`, which runs `npm run setup`
(`prisma generate && prisma migrate deploy`) before starting the server. The
checked-in migration is therefore applied during deployment; a separate manual
production migration is unnecessary when using this startup command. Check the
Dokploy deployment logs for successful migration and application startup.

1. Back up the production database using the hosting provider's normal process.
2. Install the locked dependencies with `npm ci` and run `npx prisma generate`.
3. Run `npx prisma migrate deploy` against the production database **before**
   starting the updated application. The migration only adds two nullable columns.
4. Build and deploy the web application to its existing host. The Docker startup
   command already runs `npm run setup` before starting the server. A Shopify CLI
   configuration deploy alone does not deploy this server code or database change.
5. Open the app from Shopify admin on a test installation with an existing
   permanent session. Verify that imports, exports, and product browsing work.
6. Check migration status using metadata only (never log token values):

   ```sql
   SELECT
     COUNT(*) FILTER (WHERE "expires" IS NULL) AS permanent_sessions,
     COUNT(*) FILTER (
       WHERE "expires" IS NOT NULL AND "refreshToken" IS NOT NULL
         AND "refreshTokenExpires" IS NOT NULL
     ) AS expiring_sessions
   FROM "Session"
   WHERE "isOnline" = false;
   ```

7. Reopen the test installation after access-token expiry and verify that API
   calls still succeed and the stored expiry advances. If testing a background
   consumer, verify `unauthenticated.admin(shop)` refreshes an expired session too.

Inactive installations migrate on their next authenticated visit. This app's
current Admin API callers all use `authenticate.admin(request)`; it has no
scheduled Admin API workers. Production tokens have not been cycled by this code
change alone. Shopify's historical warning is not evidence of an immediate
post-deployment failure; monitor new deprecated-token calls and session metadata.

Do not restore permanent tokens after a successful exchange. If a merchant's
refresh credentials become unusable, have them reopen the app to authenticate.

## Local checks

```sh
npx prisma generate
npm test
npm run build
npm run typecheck
npm run lint
```

The tests exercise the real Shopify SDK and Prisma adapter with synthetic
credentials, an in-memory Prisma stub, and a mocked token endpoint. They cover
legacy-token exchange, failed-exchange recovery, valid-session reuse, and refresh
rotation. They do not replace the production database migration or a live
test-store check.

Reference: [Shopify's migration guide](https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens).
