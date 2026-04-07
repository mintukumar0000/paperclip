ALTER TABLE "waitlist_signups" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "waitlist_signups" ADD COLUMN IF NOT EXISTS "monetization_sent" boolean DEFAULT false NOT NULL;
ALTER TABLE "waitlist_signups" ADD COLUMN IF NOT EXISTS "monetization_sent_at" timestamp with time zone;
