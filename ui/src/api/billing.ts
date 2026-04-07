import { api } from "./client";

export interface BillingLineItem {
  name: string;
  amountCents: number;
  quantity?: number;
  currency?: string;
}

export interface CreateCheckoutSessionInput {
  provider: "stripe" | "dodo";
  lineItems: BillingLineItem[];
  successUrl?: string;
  cancelUrl?: string;
  currency?: string;
  mode?: "payment" | "subscription";
  goalId?: string;
  issueId?: string;
  payload?: Record<string, unknown>;
}

export interface CreateCheckoutSessionResponse {
  companyId?: string;
  provider: "stripe" | "dodo";
  sessionId: string;
  checkoutUrl: string | null;
  checkout_url?: string | null;
  raw: Record<string, unknown>;
}

export interface CreateHostedCheckoutInput extends CreateCheckoutSessionInput {
  companyId: string;
}

export interface PaymentSuccessWebhookInput {
  companyId: string;
  provider: "stripe" | "dodo";
  sessionId?: string;
  amountCents: number;
  currency?: string;
  eventId?: string;
  metadata?: Record<string, unknown>;
}

export interface DodoCheckoutInput {
  companyId?: string;
  productId?: string;
  successUrl?: string;
  cancelUrl?: string;
  goalId?: string;
  issueId?: string;
  payload?: Record<string, unknown>;
}

export interface BillingRevenueSnapshot {
  companyId: string;
  windowMinutes: number;
  revenueCents: number;
  conversions: number;
  traffic: number;
  conversionRate: number;
  sampleCount: number;
}

export interface BillingFinanceSnapshot {
  companyId: string;
  revenueCents: number;
  creditsCents: number;
  spentCents: number;
  updatedAt: string;
}

export const billingApi = {
  createCheckoutSession: (companyId: string, input: CreateCheckoutSessionInput) =>
    api.post<CreateCheckoutSessionResponse>(`/companies/${companyId}/billing/checkout`, input),

  createHostedCheckout: (input: CreateHostedCheckoutInput) =>
    api.post<CreateCheckoutSessionResponse>("/billing/create-checkout", input),

  reportPaymentSuccess: (input: PaymentSuccessWebhookInput) =>
    api.post<{
      accepted: boolean;
      companyId: string;
      amountCents: number;
      currency: string;
      finance?: { revenueCents: number; creditsCents: number; spentCents: number };
    }>(
      "/billing/webhooks/success",
      input,
    ),

  createDodoCheckout: (input: DodoCheckoutInput) =>
    api.post<CreateCheckoutSessionResponse>("/payments/dodo/checkout", input),

  reportDodoWebhookEvent: (payload: Record<string, unknown>) =>
    api.post<{ accepted: boolean; companyId: string; provider: "dodo"; amountCents: number }>(
      "/payments/dodo/webhook",
      payload,
    ),

  reportProviderWebhookEvent: (payload: Record<string, unknown>) =>
    api.post<{ accepted: boolean; companyId: string; provider: "dodo"; amountCents: number }>(
      "/billing/webhook",
      payload,
    ),

  revenueSnapshot: (companyId: string, windowMinutes = 30 * 24 * 60) =>
    api.get<BillingRevenueSnapshot>(
      `/companies/${companyId}/billing/revenue?windowMinutes=${encodeURIComponent(String(windowMinutes))}`,
    ),

  financeSnapshot: (companyId: string) =>
    api.get<BillingFinanceSnapshot>(`/companies/${companyId}/billing/finance`),
};
