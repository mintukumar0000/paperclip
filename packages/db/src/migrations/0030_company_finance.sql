CREATE TABLE IF NOT EXISTS "company_finance" (
  "company_id" uuid PRIMARY KEY NOT NULL,
  "revenue_cents" integer DEFAULT 0 NOT NULL,
  "credits_cents" integer DEFAULT 0 NOT NULL,
  "spent_cents" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_finance_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "company_finance"
      ADD CONSTRAINT "company_finance_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
