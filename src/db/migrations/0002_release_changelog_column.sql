ALTER TABLE "releases" ADD COLUMN "changelog" text;
UPDATE "releases" SET "changelog" = COALESCE(TRIM(BOTH FROM "user_facing"), '')
WHERE TRUE;
ALTER TABLE "releases" ALTER COLUMN "changelog" SET NOT NULL;
ALTER TABLE "releases" DROP COLUMN "user_facing";
ALTER TABLE "releases" DROP COLUMN "technical";
