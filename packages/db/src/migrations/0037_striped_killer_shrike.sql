CREATE TABLE "system_controls" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"traffic_enabled" boolean DEFAULT true NOT NULL,
	"reddit_enabled" boolean DEFAULT true NOT NULL,
	"twitter_enabled" boolean DEFAULT true NOT NULL,
	"indie_hackers_enabled" boolean DEFAULT true NOT NULL,
	"hacker_news_enabled" boolean DEFAULT true NOT NULL,
	"max_multiplier" integer DEFAULT 3 NOT NULL,
	"post_frequency" integer DEFAULT 1 NOT NULL,
	"subreddit_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pricing_variant" text DEFAULT 'entry_9' NOT NULL,
	"paywall_trigger_count" integer DEFAULT 3 NOT NULL,
	"cycle_mode" text DEFAULT 'launch' NOT NULL,
	"autonomy_level" text DEFAULT 'semi' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"action_type" text NOT NULL,
	"action_key" text NOT NULL,
	"reason" text NOT NULL,
	"metric_name" text,
	"metric_value" real,
	"threshold_value" real,
	"action_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"override_note" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejected_by" text,
	"rejected_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "system_controls" ADD CONSTRAINT "system_controls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_decisions" ADD CONSTRAINT "system_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "system_decisions_company_created_idx" ON "system_decisions" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "system_decisions_company_status_idx" ON "system_decisions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "system_decisions_company_action_idx" ON "system_decisions" USING btree ("company_id","action_key");