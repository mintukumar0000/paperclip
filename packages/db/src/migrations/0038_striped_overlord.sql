CREATE TABLE "cycle_state" (
	"company_id" uuid NOT NULL,
	"loop_key" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"stage" text,
	"current_action" text,
	"decision_id" uuid,
	"last_error" text,
	"last_run_started_at" timestamp with time zone,
	"last_run_completed_at" timestamp with time zone,
	"last_run_duration_ms" integer,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cycle_state_pk" PRIMARY KEY("company_id","loop_key")
);
--> statement-breakpoint
ALTER TABLE "system_controls" ADD COLUMN "traffic_channels" jsonb DEFAULT '["reddit","twitter","indie_hackers","hacker_news"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "system_controls" ADD COLUMN "traffic_multiplier" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "system_controls" ADD COLUMN "traffic_post_interval_ms" integer DEFAULT 60000 NOT NULL;--> statement-breakpoint
ALTER TABLE "system_controls" ADD COLUMN "traffic_max_posts_per_cycle" integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "system_controls" ADD COLUMN "traffic_subreddit_whitelist" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "system_controls" ADD COLUMN "traffic_mode" text DEFAULT 'balanced' NOT NULL;--> statement-breakpoint
ALTER TABLE "system_controls" ADD COLUMN "decision_mode" text DEFAULT 'approval_for_high_impact' NOT NULL;--> statement-breakpoint
ALTER TABLE "cycle_state" ADD CONSTRAINT "cycle_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cycle_state_company_status_idx" ON "cycle_state" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "cycle_state_company_updated_idx" ON "cycle_state" USING btree ("company_id","updated_at");