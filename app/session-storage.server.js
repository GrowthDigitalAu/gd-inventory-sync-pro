import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

export class ExpiringOfflineSessionStorage extends PrismaSessionStorage {
  rowToSession(row) {
    const session = super.rowToSession(row);

    // The SDK otherwise considers permanent offline sessions active forever.
    // Expire only the loaded copy so authenticate.admin exchanges it using the
    // merchant's ID token, then persists the new token pair through the adapter.
    // Keep the stored session intact if that exchange fails.
    if (!session.isOnline && !session.expires) {
      session.expires = new Date(0);
    }

    return session;
  }
}
