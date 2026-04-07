export {
  createDb,
  ensurePostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  type MigrationState,
  type MigrationHistoryReconcileResult,
  migratePostgresIfEmpty,
  type MigrationBootstrapResult,
  type Db,
} from "./client.js";
export {
  runDatabaseBackup,
  formatDatabaseBackupResult,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
} from "./backup-lib.js";
export * from "./schema/index.js";

// Re-export drizzle-orm operators so consumers use the same package instance.
// This prevents TypeScript "separate declarations of a private property" errors
// caused by pnpm resolving drizzle-orm to different physical paths.
export { eq, and, or, not, desc, asc, sql, inArray, isNull, isNotNull, gt, gte, lt, lte, ne, count, sum, avg, min, max, like, ilike, between, exists, notExists, type SQL, type InferSelectModel, type InferInsertModel } from "drizzle-orm";
