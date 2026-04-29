import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = String(process.env.DATABASE_URL ?? "").trim();
    if (!connectionString) {
      throw new Error("DATABASE_URL is required");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

export async function safeQuery<T = Record<string, unknown>>(sql: string, params: unknown[], fallbackRows: T[]): Promise<T[]> {
  try {
    const result = await getPool().query(sql, params);
    return result.rows as T[];
  } catch {
    return fallbackRows;
  }
}
