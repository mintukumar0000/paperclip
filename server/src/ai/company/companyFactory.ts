// ---------------------------------------------------------------------------
// Company Factory — creates new company entities from business models
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { companyService } from "../../services/companies.js";
import { publishEvent } from "../../events/eventPublisher.js";
import type { BusinessModel } from "../ecosystem/businessDesigner.js";
import type { VenturePlan } from "../ecosystem/venturePlanner.js";
import pino from "pino";

const logger = pino({ name: "company-factory" });

export interface CompanyCreationRequest {
  businessModel: BusinessModel;
  venturePlan: VenturePlan;
  requestedBy?: string; // source company ID or agent ID
  approvalRequestId?: string;
}

export interface CompanyCreationResult {
  success: boolean;
  companyId?: string;
  companyName: string;
  budgetCents: number;
  agentCount: number;
  error?: string;
}

/**
 * Create a new company from a business model.
 *
 * Process:
 *   1. Create company record via companyService
 *   2. Publish creation event
 *   3. Return result (bootstrap happens separately)
 */
export async function createVentureCompany(
  db: Db,
  request: CompanyCreationRequest,
): Promise<CompanyCreationResult> {
  const { businessModel } = request;

  try {
    const svc = companyService(db);

    const company = await svc.create({
      name: businessModel.companyName,
      description: businessModel.description,
      status: "active",
      budgetMonthlyCents: businessModel.initialBudgetCents,
      spentMonthlyCents: 0,
    });

    await publishEvent("ai.ecosystem.company.created", {
      companyId: company.id,
      companyName: businessModel.companyName,
      product: businessModel.product,
      targetMarket: businessModel.targetMarket,
      revenueModel: businessModel.revenueModel,
      initialBudgetCents: businessModel.initialBudgetCents,
      agentRoles: businessModel.initialAgentRoles.map((a) => a.role),
      sourceOpportunity: businessModel.sourceOpportunity,
      requestedBy: request.requestedBy ?? null,
    });

    logger.info(
      { companyId: company.id, name: businessModel.companyName, budget: businessModel.initialBudgetCents },
      "Venture company created",
    );

    return {
      success: true,
      companyId: company.id,
      companyName: businessModel.companyName,
      budgetCents: businessModel.initialBudgetCents,
      agentCount: businessModel.initialAgentRoles.length,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, companyName: businessModel.companyName }, "Company creation failed");
    return {
      success: false,
      companyName: businessModel.companyName,
      budgetCents: businessModel.initialBudgetCents,
      agentCount: 0,
      error: message,
    };
  }
}
