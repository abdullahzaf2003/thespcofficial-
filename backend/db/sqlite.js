import sqlite3 from 'sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Thin promise wrapper over node-sqlite3.
 *
 * This is the only module that knows we are on SQLite. Everything above it
 * talks in terms of `run` / `all` / `get` / `transaction`, so swapping in a
 * Postgres driver later is a matter of reimplementing this file (see
 * adapters/README notes in AGENTS-level docs).
 */

// The data directory is gitignored, so a fresh clone has to create it.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new sqlite3.Database(config.dbPath, (error) => {
  if (error) {
    console.error('[db] connection failed:', error.message);
    process.exit(1);
  }
});

db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA foreign_keys = ON');
db.run('PRAGMA busy_timeout = 5000');

export const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });

export const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
  });

export const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row)));
  });

// node-sqlite3 multiplexes statements over one handle, so two overlapping
// `BEGIN IMMEDIATE` blocks would interleave. A single-process mutex keeps
// transactions serialised; a real pool (Postgres) would not need this.
let txChain = Promise.resolve();

export function transaction(work) {
  const result = txChain.then(async () => {
    await run('BEGIN IMMEDIATE');
    try {
      const value = await work();
      await run('COMMIT');
      return value;
    } catch (error) {
      await run('ROLLBACK').catch(() => {});
      throw error;
    }
  });

  // Keep the chain alive even when a caller's transaction rejects.
  txChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function isUniqueViolation(error) {
  return Boolean(error) && String(error.message || '').includes('UNIQUE constraint failed');
}

export default db;
