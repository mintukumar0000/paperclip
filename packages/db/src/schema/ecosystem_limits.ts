import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Ecosystem limits — configurable thresholds that control system growth.
 * The Stability Controller uses these to decide when to freeze expansions.
 * Global scope (not company-scoped) since they govern the whole ecosystem.
 */
export const ecosystemLimits = pgTable(
  "ecosystem_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    limitName: text("limit_name").notNull(),
    limitType: text("limit_type").notNull(), // growth | resource | economic | safety
    currentValue: real("current_value").notNull().default(0),
    thresholdValue: real("threshold_value").notNull(),
    hardCeiling: real("hard_ceiling"), // absolute max — never exceed
    action: text("action").notNull().default("warn"), // warn | throttle | freeze | block
    description: text("description"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    nameIdx: index("ecosystem_limits_name_idx").on(table.limitName),
    typeIdx: index("ecosystem_limits_type_idx").on(table.limitType),
  }),
);
