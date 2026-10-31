CREATE TABLE "chef_chat_control" (
	"id" bigint PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "chef_chat_control_singleton" CHECK ("chef_chat_control"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "chef_chat_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token" uuid NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chef_chat_operations_state_check" CHECK ("chef_chat_operations"."state" in ('reserved', 'dispatched', 'settled', 'cancelled', 'quarantined'))
);
--> statement-breakpoint
CREATE INDEX "chef_chat_operations_user_time_idx" ON "chef_chat_operations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "chef_chat_operations_state_user_idx" ON "chef_chat_operations" USING btree ("state","user_id");