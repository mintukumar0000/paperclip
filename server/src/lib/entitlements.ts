type JsonRecord = Record<string, unknown>;

export const COLD_EMAIL_FEATURE_KEY = "cold_email";

export function normalizeFeatureKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  if (normalized === "cold_email_unlimited") {
    return COLD_EMAIL_FEATURE_KEY;
  }

  return normalized
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function asMetadata(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

export function readEntitlements(metadata: unknown): Record<string, boolean> {
  const bag = asMetadata(metadata);
  const raw = bag.entitlements;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = normalizeFeatureKey(key);
    if (!normalizedKey) continue;

    if (typeof value === "boolean") {
      result[normalizedKey] = value;
      continue;
    }
    if (typeof value === "string") {
      const lowered = value.trim().toLowerCase();
      result[normalizedKey] = lowered === "true" || lowered === "1" || lowered === "yes";
    }
  }

  return result;
}

export function hasEntitlement(metadata: unknown, featureKey: string): boolean {
  const normalizedKey = normalizeFeatureKey(featureKey);
  if (!normalizedKey) return false;
  const entitlements = readEntitlements(metadata);
  return entitlements[normalizedKey] === true;
}

export function setEntitlement(
  metadata: unknown,
  featureKey: string,
  value: boolean,
): JsonRecord {
  const normalizedKey = normalizeFeatureKey(featureKey);
  if (!normalizedKey) return asMetadata(metadata);

  const bag = asMetadata(metadata);
  const entitlements = readEntitlements(bag);
  entitlements[normalizedKey] = value;

  return {
    ...bag,
    entitlements,
  };
}