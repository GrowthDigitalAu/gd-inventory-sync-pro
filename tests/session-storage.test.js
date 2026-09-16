/* eslint-env node */
import "@shopify/shopify-app-react-router/adapters/node";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { shopifyApp, ApiVersion, AppDistribution } from "@shopify/shopify-app-react-router/server";
import { abstractFetch, setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
import { ExpiringOfflineSessionStorage } from "../app/session-storage.server.js";

function fixture(overrides = {}) {
  let row = {
    id: "offline_example.myshopify.com",
    shop: "example.myshopify.com",
    state: "",
    isOnline: false,
    accessToken: "test-access-token",
    scope: "read_products",
    expires: null,
    refreshToken: null,
    refreshTokenExpires: null,
    ...overrides,
  };
  const storage = new ExpiringOfflineSessionStorage({
    session: {
      count: async () => 1,
      findUnique: async () => row,
      findMany: async () => [row],
      upsert: async ({ update }) => { row = update; },
    },
  });
  return { storage, stored: () => row };
}

test("legacy offline sessions require exchange without deleting stored credentials", async () => {
  const { storage, stored } = fixture();
  const session = await storage.loadSession("offline_example.myshopify.com");
  assert.equal(session.isActive(), false);
  assert.equal(stored().expires, null);
  assert.equal(stored().accessToken, "test-access-token");
  const [listed] = await storage.findSessionsByShop(session.shop);
  assert.equal(listed.isActive(), false);
});

test("expiring sessions preserve expiry and round-trip rotated refresh credentials", async () => {
  const expires = new Date(Date.now() + 3_600_000);
  const refreshTokenExpires = new Date(Date.now() + 86_400_000);
  const { storage, stored } = fixture({ expires, refreshToken: "test-refresh", refreshTokenExpires });
  const session = await storage.loadSession("offline_example.myshopify.com");
  assert.equal(session.isActive(), true);
  assert.deepEqual(session.expires, expires);
  assert.deepEqual(session.refreshTokenExpires, refreshTokenExpires);
  session.accessToken = "rotated-access";
  session.refreshToken = "rotated-refresh";
  await storage.storeSession(session);
  const reloaded = await storage.loadSession(session.id);
  assert.equal(reloaded.accessToken, "rotated-access");
  assert.equal(reloaded.refreshToken, "rotated-refresh");
  assert.deepEqual(stored().refreshTokenExpires, refreshTokenExpires);
});

test("online sessions are not forced to migrate", async () => {
  const expires = new Date(Date.now() + 3_600_000);
  const { storage } = fixture({ isOnline: true, expires });
  const session = await storage.loadSession("online-test");
  assert.deepEqual(session.expires, expires);
});

function testApp(storage) {
  return shopifyApp({
    apiKey: "test-api-key",
    apiSecretKey: "test-secret",
    appUrl: "https://app.example.com",
    apiVersion: ApiVersion.October25,
    distribution: AppDistribution.AppStore,
    scopes: ["read_products"],
    sessionStorage: storage,
    future: { expiringOfflineAccessTokens: true },
    logger: { level: 0 },
  });
}

function authenticatedRequest() {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: "https://example.myshopify.com/admin",
    dest: "https://example.myshopify.com",
    aud: "test-api-key", sub: "1", exp: now + 60, nbf: now - 1,
    iat: now, jti: "test-jti", sid: "test-sid",
  })}`;
  const signature = createHmac("sha256", "test-secret").update(unsigned).digest("base64url");
  return new Request("https://app.example.com/app", {
    headers: { Authorization: `Bearer ${unsigned}.${signature}` },
  });
}

function mockTokenEndpoint(t, status = 200) {
  const originalFetch = abstractFetch;
  const requests = [];
  setAbstractFetchFunc(async (url, options) => {
    assert.equal(url, "https://example.myshopify.com/admin/oauth/access_token");
    requests.push(JSON.parse(options.body));
    return Response.json(status === 200 ? {
      access_token: "new-access", scope: "read_products", expires_in: 3600,
      refresh_token: "new-refresh", refresh_token_expires_in: 7776000,
    } : { error: "invalid_subject_token" }, { status });
  });
  t.after(() => setAbstractFetchFunc(originalFetch));
  return requests;
}

test("SDK exchanges a permanent session and persists expiring credentials on app open", async (t) => {
  const { storage, stored } = fixture();
  const requests = mockTokenEndpoint(t);
  const app = testApp(storage);
  const { session } = await app.authenticate.admin(authenticatedRequest());
  assert.equal(requests.length, 1);
  assert.equal(requests[0].expiring, "1");
  assert.equal(session.accessToken, "new-access");
  assert.equal(stored().refreshToken, "new-refresh");
  assert.ok(stored().expires > new Date());
  assert.ok(stored().refreshTokenExpires > stored().expires);
  await app.authenticate.admin(authenticatedRequest());
  assert.equal(requests.length, 1, "a valid expiring session is reused");
});

test("failed exchange preserves the permanent session for a later retry", async (t) => {
  const { storage, stored } = fixture();
  mockTokenEndpoint(t, 400);
  await assert.rejects(testApp(storage).authenticate.admin(authenticatedRequest()),
    (error) => error instanceof Response);
  assert.equal(stored().accessToken, "test-access-token");
  assert.equal(stored().expires, null);
});

test("SDK refreshes expired offline credentials and stores the rotated pair", async (t) => {
  const { storage, stored } = fixture({
    expires: new Date(Date.now() - 1000),
    refreshToken: "previous-refresh",
    refreshTokenExpires: new Date(Date.now() + 86_400_000),
  });
  const requests = mockTokenEndpoint(t);
  await testApp(storage).unauthenticated.admin("example.myshopify.com");
  assert.equal(requests[0].grant_type, "refresh_token");
  assert.equal(requests[0].refresh_token, "previous-refresh");
  assert.equal(stored().accessToken, "new-access");
  assert.equal(stored().refreshToken, "new-refresh");
  assert.ok(stored().expires > new Date());
});
