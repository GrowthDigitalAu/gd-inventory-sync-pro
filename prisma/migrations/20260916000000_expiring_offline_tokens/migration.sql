-- Nullable columns preserve existing sessions while Shopify cycles their tokens.
ALTER TABLE "Session"
ADD COLUMN "refreshToken" TEXT,
ADD COLUMN "refreshTokenExpires" TIMESTAMP(3);
