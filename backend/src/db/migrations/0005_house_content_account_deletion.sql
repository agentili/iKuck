-- House-owned records must survive deletion of the account that last wrote them.
-- Personal rows are removed by the profile repository before deleting a user.
ALTER TABLE "houses" ALTER COLUMN "created_by_user_id" DROP NOT NULL;
ALTER TABLE "houses" DROP CONSTRAINT "houses_created_by_user_id_fkey";
ALTER TABLE "houses" ADD CONSTRAINT "houses_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id") ON DELETE SET NULL;

ALTER TABLE "sync_items" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "sync_items" DROP CONSTRAINT "sync_items_user_id_fkey";
ALTER TABLE "sync_items" ADD CONSTRAINT "sync_items_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "sync_items" ADD CONSTRAINT "sync_items_personal_owner_check"
  CHECK ("scope_type" = 'house' OR "user_id" IS NOT NULL);

ALTER TABLE "processed_sync_mutations" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "processed_sync_mutations" DROP CONSTRAINT "processed_sync_mutations_user_id_fkey";
ALTER TABLE "processed_sync_mutations" ADD CONSTRAINT "processed_sync_mutations_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "processed_sync_mutations" ADD CONSTRAINT "processed_sync_mutations_personal_owner_check"
  CHECK ("scope_type" = 'house' OR "user_id" IS NOT NULL);
