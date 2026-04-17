import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const systemControls = pgTable(
  "system_controls",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id),
    trafficEnabled: boolean("traffic_enabled").notNull().default(true),
    redditEnabled: boolean("reddit_enabled").notNull().default(true),
    twitterEnabled: boolean("twitter_enabled").notNull().default(true),
    indieHackersEnabled: boolean("indie_hackers_enabled").notNull().default(true),
    hackerNewsEnabled: boolean("hacker_news_enabled").notNull().default(true),
    maxMultiplier: integer("max_multiplier").notNull().default(3),
    postFrequency: integer("post_frequency").notNull().default(1),
    subredditTargets: jsonb("subreddit_targets").$type<string[]>().notNull().default([]),
    pricingVariant: text("pricing_variant").notNull().default("entry_9"),
    paywallTriggerCount: integer("paywall_trigger_count").notNull().default(3),
    cycleMode: text("cycle_mode").notNull().default("launch"),
    autonomyLevel: text("autonomy_level").notNull().default("semi"),
    trafficChannels: jsonb("traffic_channels").$type<string[]>().notNull().default(["reddit", "twitter", "indie_hackers", "hacker_news"]),
    trafficMultiplier: integer("traffic_multiplier").notNull().default(1),
    trafficPostIntervalMs: integer("traffic_post_interval_ms").notNull().default(60_000),
    trafficMaxPostsPerCycle: integer("traffic_max_posts_per_cycle").notNull().default(8),
    trafficSubredditWhitelist: jsonb("traffic_subreddit_whitelist").$type<string[]>().notNull().default([]),
    trafficMode: text("traffic_mode").notNull().default("balanced"),
    decisionMode: text("decision_mode").notNull().default("approval_for_high_impact"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
