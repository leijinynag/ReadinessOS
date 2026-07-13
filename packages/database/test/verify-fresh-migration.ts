import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error('DATABASE_URL is required to verify Prisma migrations.');

const sourceUrl = new URL(databaseUrl);
const sourceDatabaseName = sourceUrl.pathname.slice(1);
const freshDatabaseName = `${sourceDatabaseName}_migration_verify`;
const historyDatabaseName = `${sourceDatabaseName}_migration_history_verify`;
for (const name of [freshDatabaseName, historyDatabaseName]) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error('Database name contains invalid characters.');
}

const adminUrl = new URL(databaseUrl);
adminUrl.pathname = '/postgres';
adminUrl.search = '';
const adminClient = new Client({ connectionString: adminUrl.toString() });

async function main() {
  await adminClient.connect();
  try {
    await verifyFreshMigration();
    await verifyHistoricalDuplicateUpgrade();
  } finally {
    await dropDatabase(freshDatabaseName);
    await dropDatabase(historyDatabaseName);
    await adminClient.end();
  }
}

async function verifyFreshMigration() {
  const url = await recreateDatabase(freshDatabaseName);
  await execFileAsync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    [
      '--dir',
      'packages/database',
      'exec',
      'prisma',
      'migrate',
      'deploy',
      '--schema',
      'prisma/schema.prisma',
    ],
    { cwd: workspaceRoot, env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url } },
  );
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ exists: string | null }>(
      "SELECT to_regclass('public.organizations') AS exists",
    );
    if (result.rows[0]?.exists !== 'organizations') {
      throw new Error('Prisma migration did not create the organizations table.');
    }
  } finally {
    await client.end();
  }
}

async function verifyHistoricalDuplicateUpgrade() {
  const url = await recreateDatabase(historyDatabaseName);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const migration of [
      '20260711094208_init',
      '20260712131528_add_runtime_event_store',
      '20260712145500_add_run_create_idempotency',
      '20260713170000_add_run_schedule_leases',
    ]) {
      await applySql(client, `packages/database/prisma/migrations/${migration}/migration.sql`);
    }
    await client.query(`
      INSERT INTO organizations (id, slug, name, updated_at)
      VALUES ('00000000-0000-0000-0000-000000000001', 'migration-fixture', 'Migration Fixture', NOW());
      INSERT INTO users (id, email, updated_at)
      VALUES ('00000000-0000-0000-0000-000000000002', 'migration@example.com', NOW());
      INSERT INTO scenarios (id, organization_id, key, name, description, updated_at)
      VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'fixture', 'Fixture', 'Fixture', NOW());
      INSERT INTO scenario_versions (id, scenario_id, version, config)
      VALUES ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', 1, '{}');
      INSERT INTO simulation_runs (id, organization_id, scenario_version_id, seed, created_by, updated_at)
      VALUES ('00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000004', 1, '00000000-0000-0000-0000-000000000002', NOW());
      INSERT INTO run_participants (id, run_id, key, display_name, controller, updated_at)
      VALUES ('00000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000005', 'agent', 'Agent', 'agent', NOW());
      INSERT INTO agent_traces (id, run_id, run_participant_id, session_id, stream_index, event_type, payload, recorded_at)
      VALUES
        ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000006', 'session-1', 7, 'first', '{}', '2026-07-13T00:00:00Z'),
        ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000006', 'session-1', 7, 'duplicate', '{}', '2026-07-13T00:00:00Z');
    `);
    await applySql(
      client,
      'packages/database/prisma/migrations/20260713193000_harden_w3_runtime/migration.sql',
    );
    const result = await client.query<{ id: string; trace_identity: string }>(
      'SELECT id, trace_identity FROM agent_traces ORDER BY recorded_at, id',
    );
    const canonical =
      '00000000-0000-0000-0000-000000000005:00000000-0000-0000-0000-000000000006:session-1:7';
    const [canonicalRow, duplicateRow] = result.rows;
    if (
      result.rows.length !== 2 ||
      !canonicalRow ||
      !duplicateRow ||
      canonicalRow.trace_identity !== canonical
    ) {
      throw new Error('Hardening migration did not preserve the canonical legacy identity.');
    }
    if (duplicateRow.trace_identity !== `${canonical}:legacy:${duplicateRow.id}`) {
      throw new Error('Hardening migration did not disambiguate the duplicate legacy identity.');
    }
    if (new Set(result.rows.map((row) => row.trace_identity)).size !== result.rows.length) {
      throw new Error('Hardening migration left duplicate trace identities.');
    }
  } finally {
    await client.end();
  }
}

async function applySql(client: Client, relativePath: string) {
  await client.query(await readFile(`${workspaceRoot}/${relativePath}`, 'utf8'));
}

async function recreateDatabase(name: string): Promise<string> {
  await dropDatabase(name);
  await adminClient.query(`CREATE DATABASE "${name}"`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function dropDatabase(name: string) {
  await adminClient.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [name],
  );
  await adminClient.query(`DROP DATABASE IF EXISTS "${name}"`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
