import { SQL } from "bun";

const DEFAULT_URL = "postgres://idempotency:idempotency@localhost:5432/idempotency";

// Bun's SQL client defaults to a 10-connection pool, sized for typical
// request-per-connection web traffic. This repo's own load harness fires
// bursts of 50+ concurrent requests at a single process on purpose (see
// tests/phase4-postgres.test.ts, harness/compare.ts) — a pool that small
// would queue most of a burst behind the other 40, and PostgresTransactional's
// staleness check (see src/strategies/postgres-transactional.ts) can't
// tell "genuinely abandoned" apart from "just queued a while" on wall-clock
// time alone. Sized generously here so the demo's own concurrency doesn't
// manufacture that ambiguity.
const DEFAULT_MAX_CONNECTIONS = 30;

export function createSql(databaseUrl: string = process.env.DATABASE_URL ?? DEFAULT_URL): SQL {
  return new SQL(databaseUrl, { max: DEFAULT_MAX_CONNECTIONS });
}

export async function ensureSchema(sql: SQL): Promise<void> {
  const schemaPath = new URL("./schema.sql", import.meta.url).pathname;
  try {
    await sql.file(schemaPath);
  } catch (err) {
    // Two concurrent `CREATE TABLE IF NOT EXISTS` calls can still race on
    // Postgres's internal pg_type catalog insert, even though the table
    // itself is guarded — a well-known Postgres gotcha, not a bug in the
    // guard. By the time this happens the table exists, so retrying once
    // is a correct no-op rather than a real failure.
    if (err instanceof Error && err.message.includes("pg_type_typname_nsp_index")) {
      await sql.file(schemaPath);
      return;
    }
    throw err;
  }
}
