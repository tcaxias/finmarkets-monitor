// The migration `up` functions are tightly coupled to a real DuckDB
// connection and aren't worth mocking — they'd just re-implement
// DuckDB's SQL parser. Instead we lock down the structural invariants
// that catch the easy mistakes:
//
// - SCHEMA_VERSION pin: forces "did you add a migration?" to be a
//   build-time question (bumping the schema requires updating this test).
// - Sequential ordering: catches typos in version numbers and
//   reordering errors that would silently re-run an applied migration.
// - Non-empty descriptions: cheap enforcement that the next person
//   reading `migrations: applying v3 — undefined` in the console isn't
//   left guessing what changed.
//
// Integration testing of the actual SQL happens via the dev server; the
// vitest runner doesn't load DuckDB-WASM (no worker, no OPFS).
import { describe, it, expect } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations';

describe('migrations', () => {
  it('SCHEMA_VERSION is a positive integer', () => {
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
  });

  // Pin the current schema version. Bumping the schema requires
  // updating this expectation, which makes "did you remember to add a
  // migration?" a build-time question.
  it('SCHEMA_VERSION is currently 4', () => {
    expect(SCHEMA_VERSION).toBe(4);
  });

  it('SCHEMA_VERSION matches the highest migration version', () => {
    const max = Math.max(...MIGRATIONS.map((m) => m.version));
    expect(SCHEMA_VERSION).toBe(max);
  });

  it('migrations have no version gaps and are sorted ascending', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(MIGRATIONS[0].version).toBe(1);
    for (let i = 1; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i].version).toBe(MIGRATIONS[i - 1].version + 1);
    }
  });

  it('every migration has a non-empty description', () => {
    for (const m of MIGRATIONS) {
      expect(m.description.length).toBeGreaterThan(5);
    }
  });

  it('every migration has an `up` function', () => {
    for (const m of MIGRATIONS) {
      expect(typeof m.up).toBe('function');
    }
  });
});
