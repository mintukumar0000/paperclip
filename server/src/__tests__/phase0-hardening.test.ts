import express from "express";
import { createHmac } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { billingRoutes } from "../routes/billing.js";
import { coldEmailRoutes } from "../routes/cold-email.js";
import { executionLoop } from "../core/executionLoop.js";

const originalEnv = {
  DODO_WEBHOOK_SECRET: process.env.DODO_WEBHOOK_SECRET,
  BILLING_WEBHOOK_DEBUG: process.env.BILLING_WEBHOOK_DEBUG,
  ACTIVE_COMPANY_ID: process.env.ACTIVE_COMPANY_ID,
};

afterEach(() => {
  process.env.DODO_WEBHOOK_SECRET = originalEnv.DODO_WEBHOOK_SECRET;
  process.env.BILLING_WEBHOOK_DEBUG = originalEnv.BILLING_WEBHOOK_DEBUG;
  process.env.ACTIVE_COMPANY_ID = originalEnv.ACTIVE_COMPANY_ID;
});

describe("Phase 0.1 webhook hardening", () => {
  it("rejects unsigned billing webhook even when debug flag is enabled", async () => {
    process.env.DODO_WEBHOOK_SECRET = "test_dodo_secret";
    process.env.BILLING_WEBHOOK_DEBUG = "true";

    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        },
      }),
    );
    app.use("/api", billingRoutes({} as any));

    const response = await request(app)
      .post("/api/billing/webhook")
      .send({ type: "subscription.active", data: { customer: { email: "audit@example.com" } } });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Invalid Dodo webhook signature" });
  });

  it("accepts a correctly signed non-success webhook event", async () => {
    process.env.DODO_WEBHOOK_SECRET = "test_dodo_secret";

    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        },
      }),
    );
    app.use("/api", billingRoutes({} as any));

    const payload = {
      type: "healthcheck",
      data: { customer: { email: "audit@example.com" } },
    };
    const rawBody = JSON.stringify(payload);
    const signature = createHmac("sha256", process.env.DODO_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    const response = await request(app)
      .post("/api/billing/webhook")
      .set("x-dodo-signature", signature)
      .set("content-type", "application/json")
      .send(rawBody);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: true, ignored: true, eventType: "healthcheck" });
  });
});

describe("Phase 0.2 and 0.3 success URL hardening", () => {
  it("does not grant paid access from success URL query parameters", async () => {
    const accessRows: Array<{ metadata: Record<string, unknown>; createdAt: Date }> = [];

    const coldEmailDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                then: (resolve: (rows: Array<{ metadata: Record<string, unknown>; createdAt: Date }>) => unknown) =>
                  Promise.resolve(resolve(accessRows)),
              }),
            }),
          }),
        }),
      }),
      insert: () => {
        throw new Error("success route must not insert records");
      },
      update: () => {
        throw new Error("success route must not update records");
      },
    } as any;

    const app = express();
    app.use("/api", coldEmailRoutes(coldEmailDb));

    const before = await request(app)
      .get("/api/cold-email/access")
      .query({ email: "phase0@example.com" });

    expect(before.status).toBe(200);
    expect(before.body.paid).toBe(false);

    const successPage = await request(app)
      .get("/api/cold-email/success")
      .query({ email: "phase0@example.com", status: "success", subscription_id: "fake_sub" });

    expect(successPage.status).toBe(200);
    expect(successPage.text).toContain("Payment received");

    const after = await request(app)
      .get("/api/cold-email/access")
      .query({ email: "phase0@example.com" });

    expect(after.status).toBe(200);
    expect(after.body.paid).toBe(false);
  });

  it("treats legacy coldEmailPaid flag without entitlement as unpaid", async () => {
    const accessRows: Array<{ metadata: Record<string, unknown>; createdAt: Date }> = [
      {
        metadata: { coldEmailPaid: true, coldEmailUnlimited: true },
        createdAt: new Date("2026-04-10T00:00:00.000Z"),
      },
    ];

    const coldEmailDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                then: (resolve: (rows: Array<{ metadata: Record<string, unknown>; createdAt: Date }>) => unknown) =>
                  Promise.resolve(resolve(accessRows)),
              }),
            }),
          }),
        }),
      }),
    } as any;

    const app = express();
    app.use("/api", coldEmailRoutes(coldEmailDb));

    const response = await request(app)
      .get("/api/cold-email/access")
      .query({ email: "legacy-flag@example.com" });

    expect(response.status).toBe(200);
    expect(response.body.paid).toBe(false);
    expect(response.body.plan).toBe("free");
  });
});

describe("Phase 0.4 active company scheduler behavior", () => {
  it("runs execution loop for every active company even when ACTIVE_COMPANY_ID is set", async () => {
    process.env.ACTIVE_COMPANY_ID = "company-scope-was-configured";

    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: "company-a" }, { id: "company-b" }]),
        }),
      }),
    } as any;

    const loop = executionLoop(fakeDb);
    const runCycleSpy = vi
      .spyOn(loop, "runCycle")
      .mockImplementation(async (companyId: string) => ({
        companyId,
        cycleStarted: "2026-01-01T00:00:00.000Z",
        cycleCompleted: "2026-01-01T00:00:01.000Z",
        goalsAnalyzed: 0,
        tasksDispatched: 0,
        agentsActivated: 0,
      }));

    const results = await loop.runAll();

    expect(runCycleSpy).toHaveBeenCalledTimes(2);
    expect(runCycleSpy).toHaveBeenNthCalledWith(1, "company-a");
    expect(runCycleSpy).toHaveBeenNthCalledWith(2, "company-b");
    expect(results.map((entry) => entry.companyId)).toEqual(["company-a", "company-b"]);
  });
});
