-- Ensure polluted legacy rows have explicit entitlements.cold_email=false.
UPDATE "waitlist_signups"
SET "metadata" = jsonb_set(
  jsonb_set(
    jsonb_set(
      COALESCE("metadata", '{}'::jsonb)
      || jsonb_build_object(
        'entitlements',
        COALESCE(COALESCE("metadata", '{}'::jsonb) -> 'entitlements', '{}'::jsonb)
      ),
      '{entitlements,cold_email}',
      'false'::jsonb,
      true
    ),
    '{coldEmailPaid}',
    'false'::jsonb,
    true
  ),
  '{coldEmailUnlimited}',
  'false'::jsonb,
  true
)
WHERE COALESCE("metadata" ->> 'coldEmailLastPaymentSource', '') = 'success_redirect_reconcile';

--> statement-breakpoint

-- Ensure legitimate historical paid rows have explicit entitlements.cold_email=true.
UPDATE "waitlist_signups"
SET "metadata" = jsonb_set(
  COALESCE("metadata", '{}'::jsonb)
  || jsonb_build_object(
    'entitlements',
    COALESCE(COALESCE("metadata", '{}'::jsonb) -> 'entitlements', '{}'::jsonb)
  ),
  '{entitlements,cold_email}',
  'true'::jsonb,
  true
)
WHERE COALESCE(("metadata" ->> 'coldEmailPaid')::boolean, false) = true
  AND COALESCE("metadata" ->> 'coldEmailLastPaymentSource', '') <> 'success_redirect_reconcile';
