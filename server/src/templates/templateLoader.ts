import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

const logger = pino({ name: "template-loader" });

export interface TemplateAgent {
  name: string;
  role: string;
  systemPrompt: string;
}

export interface TemplateGoal {
  title: string;
  level: string;
  description: string;
}

export interface TemplateProject {
  name: string;
  description: string;
}

export interface TemplateWorkflowStep {
  id: string;
  agent: string;
  description: string;
  dependsOn?: string[];
}

export interface TemplateWorkflow {
  name: string;
  description: string;
  steps: TemplateWorkflowStep[];
}

export interface CompanyTemplate {
  id: string;
  name: string;
  description: string;
  agents: TemplateAgent[];
  goals: TemplateGoal[];
  projects: TemplateProject[];
  workflows: TemplateWorkflow[];
}

const templateCache = new Map<string, CompanyTemplate>();

function getDefinitionsDir(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, "definitions");
}

/** Load all template definitions from the definitions directory */
export function loadTemplates(): CompanyTemplate[] {
  if (templateCache.size > 0) {
    return Array.from(templateCache.values());
  }

  const dir = getDefinitionsDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    logger.info({ dir }, "Template definitions directory not found; continuing with zero templates");
    return [];
  }

  for (const file of files) {
    try {
      const content = readFileSync(resolve(dir, file), "utf-8");
      const template: CompanyTemplate = JSON.parse(content);
      templateCache.set(template.id, template);
    } catch (err) {
      logger.error({ file, err }, "Failed to load template");
    }
  }

  logger.info({ count: templateCache.size }, "Templates loaded");
  return Array.from(templateCache.values());
}

/** Get a specific template by ID */
export function getTemplate(id: string): CompanyTemplate | undefined {
  if (templateCache.size === 0) loadTemplates();
  return templateCache.get(id);
}

/** List available template summaries */
export function listTemplateSummaries(): Array<{ id: string; name: string; description: string }> {
  const templates = loadTemplates();
  return templates.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
  }));
}
