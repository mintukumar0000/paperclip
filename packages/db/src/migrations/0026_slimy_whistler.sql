CREATE TABLE "ai_learning_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" text,
	"agent_id" uuid,
	"record_type" text NOT NULL,
	"category" text NOT NULL,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scores" jsonb,
	"recommended_change" text,
	"applied" boolean DEFAULT false NOT NULL,
	"applied_at" timestamp with time zone,
	"rolled_back" boolean DEFAULT false NOT NULL,
	"rolled_back_at" timestamp with time zone,
	"parent_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_learning_records" ADD CONSTRAINT "ai_learning_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_learning_company_type_idx" ON "ai_learning_records" USING btree ("company_id","record_type");--> statement-breakpoint
CREATE INDEX "ai_learning_company_category_idx" ON "ai_learning_records" USING btree ("company_id","category");--> statement-breakpoint
CREATE INDEX "ai_learning_goal_idx" ON "ai_learning_records" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "ai_learning_applied_idx" ON "ai_learning_records" USING btree ("company_id","applied");