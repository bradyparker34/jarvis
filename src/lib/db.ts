import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..");

// Numerics come back as strings by default so large values survive the trip.
// Everything here fits in a double comfortably, and callers want numbers.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
    }
    pool = new pg.Pool({ connectionString, max: 8 });
  }
  return pool;
}

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await db().query(text, params);
  return result.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await q<T>(text, params);
  return rows[0];
}

/** Run work inside a transaction, rolling back on any throw. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Apply every migration in order, tracking what has run.
 *
 * 003_vectors.sql needs pgvector. If the extension is missing the system still
 * works on keyword search alone, so that one failure is reported and skipped
 * rather than aborting the whole run.
 */
export async function migrate(): Promise<{ applied: string[]; skipped: string[] }> {
  await q(`CREATE TABLE IF NOT EXISTS schema_migrations (
             name text PRIMARY KEY,
             applied_at timestamptz NOT NULL DEFAULT now())`);

  const dir = join(repoRoot, "db", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set((await q<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(dir, file), "utf8");
    try {
      await tx(async (client) => {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      });
      applied.push(file);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (file.includes("vectors") && /vector/i.test(message)) {
        skipped.push(`${file} (pgvector not installed — semantic search off, keyword search fine)`);
        continue;
      }
      throw new Error(`migration ${file} failed: ${message}`);
    }
  }

  // Seeds are data, not schema, but nothing works without the spaces. They are
  // written to be idempotent, so they run on every migrate and stay current.
  const seedDir = join(repoRoot, "db", "seed");
  for (const file of (await readdir(seedDir)).filter((f) => f.endsWith(".sql")).sort()) {
    await q(await readFile(join(seedDir, file), "utf8"));
  }

  return { applied, skipped };
}

export async function hasVectors(): Promise<boolean> {
  const row = await one<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ok`,
  );
  return Boolean(row?.ok);
}

export async function close(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
