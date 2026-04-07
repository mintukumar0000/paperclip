CREATE TABLE "ai_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"pattern" text NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_outcome" text,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"source" text,
	"embedding" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_strategy_state" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"current_strategy" text DEFAULT '' NOT NULL,
	"beliefs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hypotheses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active_experiments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_metrics_snapshot" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_skills" ADD CONSTRAINT "ai_skills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_strategy_state" ADD CONSTRAINT "ai_strategy_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_skills_company_category_idx" ON "ai_skills" USING btree ("company_id","category");--> statement-breakpoint
CREATE INDEX "ai_skills_confidence_idx" ON "ai_skills" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX "ai_skills_company_source_idx" ON "ai_skills" USING btree ("company_id","source");