CREATE TABLE "agent_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"goal" text NOT NULL,
	"status" text DEFAULT 'planning' NOT NULL,
	"graph_json" jsonb DEFAULT '{}' NOT NULL,
	"episodic_json" jsonb DEFAULT '[]',
	"current_step" text,
	"steps_completed" integer DEFAULT 0 NOT NULL,
	"steps_total" integer DEFAULT 0 NOT NULL,
	"max_iterations" integer DEFAULT 25 NOT NULL,
	"iterations_used" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_plans" ADD CONSTRAINT "agent_plans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_plans" ADD CONSTRAINT "agent_plans_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_plans_company_idx" ON "agent_plans" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agent_plans_agent_idx" ON "agent_plans" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_plans_status_idx" ON "agent_plans" USING btree ("company_id","status");