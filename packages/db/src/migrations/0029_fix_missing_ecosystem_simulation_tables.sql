CREATE TABLE IF NOT EXISTS "ecosystem_limits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "limit_name" text NOT NULL,
  "limit_type" text NOT NULL,
  "current_value" real DEFAULT 0 NOT NULL,
  "threshold_value" real NOT NULL,
  "hard_ceiling" real,
  "action" text DEFAULT 'warn' NOT NULL,
  "description" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "ecosystem_limits_name_idx" ON "ecosystem_limits" USING btree ("limit_name");
CREATE INDEX IF NOT EXISTS "ecosystem_limits_type_idx" ON "ecosystem_limits" USING btree ("limit_type");

CREATE TABLE IF NOT EXISTS "ecosystem_metrics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "company_count" integer DEFAULT 0 NOT NULL,
  "agent_count" integer DEFAULT 0 NOT NULL,
  "goal_count" integer DEFAULT 0 NOT NULL,
  "active_goal_count" integer DEFAULT 0 NOT NULL,
  "task_backlog" integer DEFAULT 0 NOT NULL,
  "agent_utilization" real DEFAULT 0 NOT NULL,
  "goal_growth_rate" real DEFAULT 0 NOT NULL,
  "revenue_growth_rate" real DEFAULT 0 NOT NULL,
  "system_load" real DEFAULT 0 NOT NULL,
  "stability_score" real DEFAULT 100 NOT NULL,
  "expansion_pressure" real DEFAULT 0 NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ecosystem_metrics_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "ecosystem_metrics"
      ADD CONSTRAINT "ecosystem_metrics_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ecosystem_metrics_company_idx" ON "ecosystem_metrics" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "ecosystem_metrics_snapshot_idx" ON "ecosystem_metrics" USING btree ("snapshot_at");
CREATE INDEX IF NOT EXISTS "ecosystem_metrics_stability_idx" ON "ecosystem_metrics" USING btree ("company_id", "stability_score");

CREATE TABLE IF NOT EXISTS "stability_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid,
  "event_type" text NOT NULL,
  "severity" text DEFAULT 'warning' NOT NULL,
  "stability_score" real,
  "trigger" text NOT NULL,
  "action" text NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stability_events_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "stability_events"
      ADD CONSTRAINT "stability_events_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "stability_events_company_idx" ON "stability_events" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "stability_events_type_idx" ON "stability_events" USING btree ("event_type");
CREATE INDEX IF NOT EXISTS "stability_events_severity_idx" ON "stability_events" USING btree ("severity");
CREATE INDEX IF NOT EXISTS "stability_events_created_idx" ON "stability_events" USING btree ("created_at");

CREATE TABLE IF NOT EXISTS "simulation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "run_type" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "scenario_type" text NOT NULL,
  "strategy_name" text,
  "parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "total_universes" integer DEFAULT 1 NOT NULL,
  "completed_universes" integer DEFAULT 0 NOT NULL,
  "result_score" real,
  "selected_strategy" text,
  "summary" jsonb,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'simulation_runs_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "simulation_runs"
      ADD CONSTRAINT "simulation_runs_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "simulation_runs_company_idx" ON "simulation_runs" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "simulation_runs_status_idx" ON "simulation_runs" USING btree ("status");
CREATE INDEX IF NOT EXISTS "simulation_runs_type_idx" ON "simulation_runs" USING btree ("run_type");
CREATE INDEX IF NOT EXISTS "simulation_runs_scenario_idx" ON "simulation_runs" USING btree ("scenario_type");

CREATE TABLE IF NOT EXISTS "simulation_scenarios" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "name" text NOT NULL,
  "scenario_type" text NOT NULL,
  "description" text,
  "variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "evaluation_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "simulated_days" integer DEFAULT 90 NOT NULL,
  "default_universes" integer DEFAULT 100 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'simulation_scenarios_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "simulation_scenarios"
      ADD CONSTRAINT "simulation_scenarios_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "simulation_scenarios_company_idx" ON "simulation_scenarios" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "simulation_scenarios_type_idx" ON "simulation_scenarios" USING btree ("scenario_type");

CREATE TABLE IF NOT EXISTS "simulation_universes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "universe_index" integer NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metrics" jsonb DEFAULT '{"revenue":0,"cost":0,"profit":0,"taskCompletion":0,"goalSuccessRate":0,"agentEfficiency":0,"customerGrowth":0,"failureRate":0}'::jsonb,
  "simulated_days" integer DEFAULT 0 NOT NULL,
  "result_score" real,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'simulation_universes_run_id_simulation_runs_id_fk'
  ) THEN
    ALTER TABLE "simulation_universes"
      ADD CONSTRAINT "simulation_universes_run_id_simulation_runs_id_fk"
      FOREIGN KEY ("run_id") REFERENCES "public"."simulation_runs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "simulation_universes_run_idx" ON "simulation_universes" USING btree ("run_id");
CREATE INDEX IF NOT EXISTS "simulation_universes_status_idx" ON "simulation_universes" USING btree ("status");
CREATE INDEX IF NOT EXISTS "simulation_universes_score_idx" ON "simulation_universes" USING btree ("result_score");

CREATE TABLE IF NOT EXISTS "strategy_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "strategy_name" text NOT NULL,
  "mean_profit" real DEFAULT 0 NOT NULL,
  "median_profit" real DEFAULT 0 NOT NULL,
  "variance" real DEFAULT 0 NOT NULL,
  "standard_deviation" real DEFAULT 0 NOT NULL,
  "success_rate" real DEFAULT 0 NOT NULL,
  "failure_rate" real DEFAULT 0 NOT NULL,
  "mean_revenue" real DEFAULT 0 NOT NULL,
  "mean_cost" real DEFAULT 0 NOT NULL,
  "risk_score" real DEFAULT 0 NOT NULL,
  "confidence_level" real DEFAULT 0 NOT NULL,
  "sample_size" real DEFAULT 0 NOT NULL,
  "selected" text DEFAULT 'false' NOT NULL,
  "detailed_stats" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'strategy_outcomes_run_id_simulation_runs_id_fk'
  ) THEN
    ALTER TABLE "strategy_outcomes"
      ADD CONSTRAINT "strategy_outcomes_run_id_simulation_runs_id_fk"
      FOREIGN KEY ("run_id") REFERENCES "public"."simulation_runs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "strategy_outcomes_run_idx" ON "strategy_outcomes" USING btree ("run_id");
CREATE INDEX IF NOT EXISTS "strategy_outcomes_strategy_idx" ON "strategy_outcomes" USING btree ("strategy_name");
CREATE INDEX IF NOT EXISTS "strategy_outcomes_success_idx" ON "strategy_outcomes" USING btree ("success_rate");
