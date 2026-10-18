#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { BASELINE_NAME, SCHEMA_QUERY, ensureBaseline } from './migration-plan.mts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = join(projectRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function options(argv) {
  let target;
  let checkOnly = false;
  const extra = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--local' || arg === '--remote') {
      if (target) throw new Error('Choose exactly one of --local or --remote.');
      target = arg;
    } else if (arg === '--check') {
      checkOnly = true;
    } else if (['--persist-to', '--env-file', '--profile'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      extra.push(arg, value);
    } else {
      throw new Error(`Unsupported migration argument: ${arg}`);
    }
  }
  if (!target) throw new Error('Choose --local or --remote explicitly.');
  if (target === '--remote' && extra.includes('--persist-to')) {
    throw new Error('--persist-to is only supported with --local.');
  }
  return { target, checkOnly, extra };
}

async function main() {
  const { target, checkOnly, extra } = options(process.argv.slice(2));
  const run = (args, capture = false) => {
    const result = spawnSync(process.execPath, [wrangler, ...args, target, ...extra], {
      cwd: projectRoot,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Wrangler failed (${result.status ?? result.signal}). ${capture ? result.stderr.trim() : ''}`);
    }
    return result.stdout;
  };

  // Derive the expected schema from the same SQL used for new installations.
  const reference = new DatabaseSync(':memory:');
  let expected;
  try {
    reference.exec(readFileSync(join(projectRoot, 'migrations', BASELINE_NAME), 'utf8'));
    expected = reference.prepare(SCHEMA_QUERY).all();
  } finally {
    reference.close();
  }
  const adapter = {
    async query(sql) {
      const output = JSON.parse(run(['d1', 'execute', 'DB', '--command', sql, '--json'], true));
      if (!Array.isArray(output) || output.length !== 1 || output[0].success !== true || !Array.isArray(output[0].results)) {
        throw new Error('Unexpected D1 query response; migration stopped.');
      }
      return output[0].results;
    },
  };
  const state = await ensureBaseline(adapter, expected, { checkOnly });
  console.log(`Database baseline: ${state}${checkOnly ? ' (read-only check)' : ''}.`);
  if (!checkOnly) {
    run(['d1', 'migrations', 'apply', 'DB']);
    // Wrangler can exit successfully after an interactive cancellation.
    if (await ensureBaseline(adapter, expected, { checkOnly: true }) !== 'current') {
      throw new Error('The database baseline was not applied; deployment must not continue.');
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(`Migration stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
