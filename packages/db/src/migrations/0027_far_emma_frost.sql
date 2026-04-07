CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"head_agent_id" uuid,
	"parent_department_id" uuid,
	"capabilities" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expansion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approval_level" text NOT NULL,
	"requested_role" text,
	"requested_capabilities" text,
	"reason" text NOT NULL,
	"gap_analysis" jsonb,
	"design_spec" jsonb,
	"result_agent_id" uuid,
	"result_department_id" uuid,
	"requested_by" uuid,
	"approved_by" uuid,
	"rejection_reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expansion_requests" ADD CONSTRAINT "expansion_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "departments_company_idx" ON "departments" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "departments_company_name_idx" ON "departments" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "expansion_requests_company_idx" ON "expansion_requests" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "expansion_requests_company_status_idx" ON "expansion_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "expansion_requests_company_type_idx" ON "expansion_requests" USING btree ("company_id","request_type");