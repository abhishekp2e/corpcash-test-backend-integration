import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:root@localhost:5432/postgres";

export const pool = new Pool({
  connectionString: DATABASE_URL,
});

export async function checkDb() {
  const result = await pool.query("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1;
}
