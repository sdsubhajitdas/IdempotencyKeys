import { createSql, ensureSchema } from "../../src/db/client";
import type { SQL } from "bun";

export async function createTestSql(): Promise<SQL> {
  const sql = createSql();
  await ensureSchema(sql);
  return sql;
}

export function uniqueKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}
