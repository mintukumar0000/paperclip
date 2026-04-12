CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"email" text,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"external_event_id" text,
	"session_id" text,
	"source" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_events_company_created_idx" ON "payment_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_events_email_idx" ON "payment_events" USING btree ("email");--> statement-breakpoint
CREATE INDEX "payment_events_external_event_idx" ON "payment_events" USING btree ("external_event_id");