import { config as loadDotenv } from "dotenv";
import path from "node:path";

loadDotenv({ path: path.resolve(process.cwd(), ".env"), override: false });
loadDotenv({ path: path.resolve(process.cwd(), "..", ".env"), override: false });

function resolveApiBaseUrl(): string {
  const explicit = (process.env.PAPERCLIP_API_BASE_URL ?? "").trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const port = (process.env.PORT ?? "3100").trim();
  return `http://localhost:${port}/api`;
}

export async function sendOfferEmailsToRecentSignups(): Promise<void> {
  const apiBaseUrl = resolveApiBaseUrl();
  const automationSecret = (process.env.WAITLIST_AUTOMATION_SECRET ?? "").trim();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (automationSecret) {
    headers["x-waitlist-secret"] = automationSecret;
  }

  const response = await fetch(`${apiBaseUrl}/waitlist/offers/send`, {
    method: "POST",
    headers,
    body: "{}",
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${JSON.stringify(payload)}`);
  }

  console.log("waitlist offer dispatch report", payload);
}

sendOfferEmailsToRecentSignups().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("manual waitlist offer dispatch failed:", message);
  process.exitCode = 1;
});
