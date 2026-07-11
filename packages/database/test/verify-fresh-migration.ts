import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to verify Prisma migrations.');
}

const sourceUrl = new URL(databaseUrl);
const sourceDatabaseName = sourceUrl.pathname.slice(1);
const verificationDatabaseName = `${sourceDatabaseName}_migration_verify`;

if (!/^[a-zA-Z0-9_]+$/.test(verificationDatabaseName)) {
  throw new Error('DATABASE_URL database name must only contain letters, digits, and underscores.');
}

const adminUrl = new URL(databaseUrl);
adminUrl.pathname = '/postgres';
adminUrl.search = '';

const verificationUrl = new URL(databaseUrl);
verificationUrl.pathname = `/${verificationDatabaseName}`;

const adminClient = new Client({ connectionString: adminUrl.toString() });

async function main() {
  await adminClient.connect();

  try {
    // 每次都从一个全新的临时数据库验证，避免本地已有表掩盖 migration 缺失。
    await adminClient.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [verificationDatabaseName],
    );
    await adminClient.query(`DROP DATABASE IF EXISTS "${verificationDatabaseName}"`);
    await adminClient.query(`CREATE DATABASE "${verificationDatabaseName}"`);

    await execFileAsync(
      process.platform === 'win32' ? 'corepack.cmd' : 'corepack',
      [
        'pnpm',
        '--dir',
        'packages/database',
        'exec',
        'prisma',
        'migrate',
        'deploy',
        '--schema',
        'prisma/schema.prisma',
      ],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          DATABASE_URL: verificationUrl.toString(),
          DIRECT_URL: verificationUrl.toString(),
        },
      },
    );

    // `migrate deploy` 成功退出还不够；额外断言核心表确实由迁移创建。
    const verificationClient = new Client({ connectionString: verificationUrl.toString() });
    await verificationClient.connect();
    const result = await verificationClient.query<{ exists: string | null }>(
      "SELECT to_regclass('public.organizations') AS exists",
    );
    await verificationClient.end();

    if (result.rows[0]?.exists !== 'organizations') {
      throw new Error('Prisma migration did not create the organizations table.');
    }
  } finally {
    // 即使迁移失败也释放连接并删除临时库，保证下一次验证不受污染。
    await adminClient.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [verificationDatabaseName],
    );
    await adminClient.query(`DROP DATABASE IF EXISTS "${verificationDatabaseName}"`);
    await adminClient.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
