import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const root = '/opt/postiz';
const appRoot = `${root}/app`;
const envPath = `${appRoot}/.env`;
const publicUrl = 'https://post.truegrit.dev';

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const quoteLiteral = (value) => `'${value.replaceAll("'", "''")}'`;

const runPostgres = (sql) => {
  const result = spawnSync(
    'sudo',
    ['-u', 'postgres', 'psql', '--set', 'ON_ERROR_STOP=1', '--file=-'],
    { encoding: 'utf8', input: sql }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || 'PostgreSQL configuration failed.');
  }
};

const readEnvValue = (contents, key) => {
  const match = contents.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!match) return undefined;
  const value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

const setEnvValue = (contents, key, value) => {
  const line = `${key}=${JSON.stringify(value)}`;
  const expression = new RegExp(`^${key}=.*$`, 'm');
  if (expression.test(contents)) return contents.replace(expression, line);
  return `${contents.replace(/\s*$/, '')}\n${line}\n`;
};

await mkdir(`${root}/config/rednote/v2.10.1`, {
  mode: 0o700,
  recursive: true,
});
await mkdir(`${root}/uploads`, { mode: 0o750, recursive: true });
await mkdir(`${root}/temporal`, { mode: 0o750, recursive: true });

let env = await readFile(envPath, 'utf8');
const localDatabaseUrl = new URL(
  readEnvValue(env, 'DATABASE_URL') ||
    'postgresql://postiz-local@localhost:5432/postiz-db-local'
);
const databaseUser = decodeURIComponent(localDatabaseUrl.username);
const databaseName = localDatabaseUrl.pathname.slice(1);
const passwordPath = `${root}/.database-password`;
let databasePassword;
try {
  databasePassword = (await readFile(passwordPath, 'utf8')).trim();
} catch {
  databasePassword = randomBytes(32).toString('hex');
  await writeFile(passwordPath, `${databasePassword}\n`, { mode: 0o600 });
}

runPostgres(`
DO $postiz$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_roles
    WHERE rolname = ${quoteLiteral(databaseUser)}
  ) THEN
    CREATE ROLE ${quoteIdentifier(databaseUser)} LOGIN;
  END IF;
END
$postiz$;
ALTER ROLE ${quoteIdentifier(databaseUser)} WITH LOGIN PASSWORD ${quoteLiteral(
  databasePassword
)};
`);

const databaseExists = spawnSync(
  'sudo',
  [
    '-u',
    'postgres',
    'psql',
    '--tuples-only',
    '--no-align',
    '--command',
    `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(databaseName)}`,
  ],
  { encoding: 'utf8' }
);
if (databaseExists.status !== 0) {
  throw new Error(databaseExists.stderr || 'Could not inspect PostgreSQL.');
}
if (databaseExists.stdout.trim() !== '1') {
  runPostgres(
    `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(
      databaseUser
    )};\n`
  );
}

const remoteDatabaseUrl = new URL('postgresql://127.0.0.1:5432');
remoteDatabaseUrl.username = databaseUser;
remoteDatabaseUrl.password = databasePassword;
remoteDatabaseUrl.pathname = `/${databaseName}`;

const updates = {
  MAIN_URL: publicUrl,
  FRONTEND_URL: publicUrl,
  NEXT_PUBLIC_BACKEND_URL: `${publicUrl}/api`,
  BACKEND_INTERNAL_URL: 'http://127.0.0.1:3003',
  PORT: '3003',
  DATABASE_URL: remoteDatabaseUrl.toString(),
  REDIS_URL: 'redis://127.0.0.1:6379',
  TEMPORAL_ADDRESS: '127.0.0.1:7233',
  STORAGE_PROVIDER: 'local',
  POSTIZ_CONFIG_DIR: `${root}/config`,
  UPLOAD_DIRECTORY: `${root}/uploads`,
  NEXT_PUBLIC_UPLOAD_DIRECTORY: '/uploads',
  XHS_MCP_INSTALL_DIR: `${root}/config/rednote/v2.10.1`,
  XHS_COOKIES_PATH: `${root}/config/rednote/cookies.json`,
  NOT_SECURED: 'false',
};

for (const [key, value] of Object.entries(updates)) {
  env = setEnvValue(env, key, value);
}
if (!readEnvValue(env, 'JWT_SECRET')) {
  env = setEnvValue(env, 'JWT_SECRET', randomBytes(48).toString('base64url'));
}

await writeFile(envPath, env, { mode: 0o600 });
await chmod(envPath, 0o600);
console.log('Native Postiz environment and PostgreSQL are configured.');
