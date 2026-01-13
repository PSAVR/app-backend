import pkg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "require"
    ? { rejectUnauthorized: false }
    : false,
});

export async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}