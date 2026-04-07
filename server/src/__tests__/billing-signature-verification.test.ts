import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { __billingInternals } from "../routes/billing.js";

describe("billing webhook signature verification", () => {
  it("parses timestamped signature lists", () => {
    const parsed = __billingInternals.parseSignatureList(
      "t=1700000000,v1=abc,v1=def",
    );

    expect(parsed.timestamp).toBe("1700000000");
    expect(parsed.signatures).toEqual(["abc", "def"]);
  });

  it("validates Stripe signed payloads", () => {
    const secret = "whsec_test_secret";
    const body = JSON.stringify({ companyId: "cmp_1", amountCents: 1200 });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signed = `${timestamp}.${body}`;
    const signature = createHmac("sha256", secret).update(signed).digest("hex");

    const header = `t=${timestamp},v1=${signature}`;

    expect(__billingInternals.verifyStripeSignature(body, header, secret)).toBe(true);
    expect(__billingInternals.verifyStripeSignature(body, `t=${timestamp},v1=bad`, secret)).toBe(false);
  });

  it("rejects stale Stripe timestamps", () => {
    const secret = "whsec_test_secret";
    const body = JSON.stringify({ companyId: "cmp_1", amountCents: 1200 });
    const staleTimestamp = (Math.floor(Date.now() / 1000) - 3600).toString();
    const signed = `${staleTimestamp}.${body}`;
    const signature = createHmac("sha256", secret).update(signed).digest("hex");

    expect(
      __billingInternals.verifyStripeSignature(
        body,
        `t=${staleTimestamp},v1=${signature}`,
        secret,
      ),
    ).toBe(false);
  });

  it("validates Dodo raw-body signatures", () => {
    const secret = "dodo_secret_test";
    const body = JSON.stringify({ companyId: "cmp_1", provider: "dodo", amountCents: 4900 });
    const signature = createHmac("sha256", secret).update(body).digest("hex");

    expect(__billingInternals.verifyDodoSignature(body, signature, secret)).toBe(true);
    expect(__billingInternals.verifyDodoSignature(body, "bad-signature", secret)).toBe(false);
  });

  it("validates Svix-style Dodo signatures", () => {
    const rawSecret = Buffer.from("dodo_svix_secret_key", "utf8").toString("base64");
    const whsecSecret = `whsec_${rawSecret}`;
    const body = JSON.stringify({ companyId: "cmp_1", provider: "dodo", amountCents: 4900 });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signedPayload = `${timestamp}.${body}`;
    const signature = createHmac("sha256", Buffer.from(rawSecret, "base64"))
      .update(signedPayload)
      .digest("base64");
    const header = `v1,${signature}`;

    expect(
      __billingInternals.verifyDodoSignature(body, header, whsecSecret, timestamp),
    ).toBe(true);
  });

  it("validates Svix signatures that include webhook id", () => {
    const rawSecret = Buffer.from("dodo_svix_secret_key", "utf8").toString("base64");
    const whsecSecret = `whsec_${rawSecret}`;
    const body = JSON.stringify({ companyId: "cmp_1", provider: "dodo", amountCents: 4900 });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const webhookId = "msg_test_123";
    const svixPayload = `${webhookId}.${timestamp}.${body}`;
    const signature = createHmac("sha256", Buffer.from(rawSecret, "base64"))
      .update(svixPayload)
      .digest("base64");
    const header = `v1,${signature}`;

    expect(
      __billingInternals.verifyDodoSignature(body, header, whsecSecret, timestamp, webhookId),
    ).toBe(true);
    expect(
      __billingInternals.verifyDodoSignature(body, header, whsecSecret, timestamp, "msg_other"),
    ).toBe(false);
  });
});
