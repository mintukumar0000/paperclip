-- One-time cleanup: revoke fake entitlements created by legacy success redirect reconcile path.
UPDATE "waitlist_signups"
SET "metadata" = jsonb_set(
  jsonb_set(
    jsonb_set(
      COALESCE("metadata", '{}'::jsonb),
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

-- Backfill entitlements for legitimate historical paid users.
UPDATE "waitlist_signups"
SET "metadata" = jsonb_set(
  COALESCE("metadata", '{}'::jsonb),
  '{entitlements,cold_email}',
  'true'::jsonb,
  true
)
WHERE COALESCE(("metadata" ->> 'coldEmailPaid')::boolean, false) = true
  AND COALESCE("metadata" ->> 'coldEmailLastPaymentSource', '') <> 'success_redirect_reconcile';
