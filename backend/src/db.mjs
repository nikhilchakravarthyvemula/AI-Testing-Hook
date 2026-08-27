// Shared pg pool. Connection comes from DATABASE_URL, or the standard PG* env
// vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE) that psql also honors.
// On the VM this points at the cloud-sql-proxy: postgres://user@127.0.0.1:5432/db
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}
);

export async function query(text, params) {
  return pool.query(text, params);
}

// Run fn inside a transaction with a dedicated client.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
