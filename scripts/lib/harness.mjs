import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// Load the root .env so the script targets the same Postgres as the npm scripts. A variable that
// is already set in the environment wins, and a missing file is fine.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {}

const adminUrl = new URL(
  process.env.DATABASE_URL_MIGRATE ?? 'postgresql://waitlist:waitlist@localhost:5432/waitlist',
);

export function urlFor(database, credentials) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  if (credentials) {
    url.username = credentials.user;
    url.password = credentials.password;
  }
  return url.toString();
}

export async function connect(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

async function withAdmin(fn) {
  const admin = await connect(urlFor('postgres'));
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

export function createDatabase(name) {
  return withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  });
}

export function dropDatabase(name) {
  return withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}

function run(command, env = {}) {
  const result = spawnSync(command, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

export function migrate(database, direction) {
  run(`npm run migrate:${direction} -w @waitlist/api --silent`, {
    DATABASE_URL_MIGRATE: urlFor(database),
  });
}

export function schemaDump(database) {
  // pg_dump 16.10+ prints a random \restrict token on every run; drop those lines so dumps compare.
  return run(
    `docker compose exec -T postgres pg_dump --schema-only --no-owner -U waitlist ${database}`,
  )
    .split('\n')
    .filter((line) => !/^\\(un)?restrict /.test(line))
    .join('\n');
}

export function createRunner() {
  const results = [];
  let clients = [];

  // Each case runs inside a savepoint on every open client, so one failing case cannot abort
  // the transaction the remaining cases share.
  async function t(name, fn) {
    for (const client of clients) await client.query('SAVEPOINT check_case');
    try {
      await fn();
      for (const client of clients) await client.query('RELEASE SAVEPOINT check_case');
      results.push({ name, ok: true });
      console.log(`  ok    ${name}`);
    } catch (err) {
      for (const client of clients) await client.query('ROLLBACK TO SAVEPOINT check_case');
      results.push({ name, ok: false });
      const detail = String(err.message).split('\n').join('\n        ');
      console.log(`  FAIL  ${name}\n        ${detail}`);
    }
  }

  return {
    t,
    results,
    useClients(list) {
      clients = list;
    },
  };
}

export async function insert(client, table, row) {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await client.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    Object.values(row),
  );
  return rows[0];
}

export async function expectFail(client, sqlState, action) {
  await client.query('SAVEPOINT expect_fail');
  try {
    await action();
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT expect_fail');
    if (err.code !== sqlState) {
      throw new Error(`expected SQLSTATE ${sqlState}, got ${err.code}: ${err.message}`);
    }
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT expect_fail');
  throw new Error(`expected SQLSTATE ${sqlState}, but the statement succeeded`);
}

let emailCounter = 0;
export function uniqueEmail() {
  emailCounter += 1;
  return `user${emailCounter}@example.com`;
}
