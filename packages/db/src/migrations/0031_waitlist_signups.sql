CREATE TABLE IF NOT EXISTS "waitlist_signups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid,
  "email" text NOT NULL,
  "source" text,
  "variant_id" text,
  "page_version" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "waitlist_signups_email_unique" UNIQUE("email")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'waitlist_signups_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "waitlist_signups"
      ADD CONSTRAINT "waitlist_signups_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "waitlist_signups_company_id_idx" ON "waitlist_signups" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "waitlist_signups_created_at_idx" ON "waitlist_signups" USING btree ("created_at");
