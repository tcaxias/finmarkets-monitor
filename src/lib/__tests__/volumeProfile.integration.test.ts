// Integration tests for the volume profile query in
// `src/lib/queries.ts` (`getVolumeProfile`).
//
// Same extract-and-execute strategy as the other integration files:
// the SQL is duplicated inline (kept in sync with the production
// helper) and run against a real DuckDB engine via `bootFixture`.
// The bug class we protect against is "the SQL string is invalid"
// plus "the bucketing math doesn't pin to the textbook value when
// fed a deterministic input".
//
// What we exercise:
//   - 40 buckets cover the full close-price range; total volume sums
//     to the inserted total
//   - POC identification — when one price level is loaded with 10x
//     the volume of others, that bucket's index is the POC
//   - Empty-range case — no rows for the ticker → 0 buckets, 0 totals
//   - Single-price degenerate case — all closes equal → 0 buckets,
//     barsAnalyzed surfaces the bar count for UI disambiguation
//   - Edge clamp — close == hi falls in the topmost bucket (the
//     LEAST/GREATEST clamp), not in an out-of-range bucket index

import { describe, it, expect, afterEach } from 'vitest';
import {
  bootFixture,
  type FixtureDb,
} from './duckdb-fixture';

let fixture: FixtureDb | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = null;
  }
});

/**
 * Inline the volume-profile range-query SQL. Mirrors the first
 * statement in `getVolumeProfile`. Returns lo / hi / n for the
 * window — the test then computes bucketWidth and runs
 * `profileSql` below to get the per-bucket sums.
 */
function rangeSql(ticker: string): string {
  return `
    SELECT MIN(close) AS lo, MAX(close) AS hi, COUNT(*) AS n
    FROM ohlcv
    WHERE ticker = '${ticker}'
      AND volume IS NOT NULL
  `;
}

/**
 * Inline the volume-profile bucketing SQL. Mirrors the second
 * statement in `getVolumeProfile`. `lo` and `bucketWidth` are
 * computed by the caller (matching how the production helper
 * inlines them after the range query).
 */
function profileSql(
  ticker: string,
  lo: number,
  bucketWidth: number,
  bucketCount: number,
): string {
  return `
    WITH bucketed AS (
      SELECT
        LEAST(${bucketCount - 1}, GREATEST(0, FLOOR((close - ${lo}) / ${bucketWidth})))::INTEGER AS bucket_idx,
        volume
      FROM ohlcv
      WHERE ticker = '${ticker}'
        AND volume IS NOT NULL
    )
    SELECT
      bucket_idx,
      SUM(volume) AS total_volume,
      COUNT(*) AS bars_count
    FROM bucketed
    GROUP BY bucket_idx
    ORDER BY bucket_idx
  `;
}

/**
 * Insert explicit (close, volume) pairs for `ticker`. Open/high/low
 * are deterministically derived from the close (volume profile cares
 * only about close + volume). Used because we need pin-precise
 * control over the volume distribution to validate POC / total-
 * volume math.
 */
async function insertExplicitBars(
  fixture: FixtureDb,
  ticker: string,
  bars: { close: number; volume: number }[],
  startDate = '2024-01-01',
): Promise<void> {
  const startMs = new Date(startDate + 'T00:00:00Z').getTime();
  const dayMs = 86_400_000;
  const values = bars.map(({ close, volume }, i) => {
    const dt = new Date(startMs + i * dayMs).toISOString().slice(0, 10);
    const open = close - 0.05;
    const high = close + 0.2;
    const low = close - 0.2;
    return `('${ticker}', DATE '${dt}', ${open.toFixed(6)}, ${high.toFixed(6)}, ${low.toFixed(6)}, ${close.toFixed(6)}, ${volume})`;
  });
  if (values.length === 0) return;
  await fixture.query(
    `INSERT INTO ohlcv (ticker, dt, open, high, low, close, volume) VALUES ${values.join(', ')}`,
  );
}

describe('getVolumeProfile (integration)', () => {
  it('produces buckets covering the full price range with the expected total volume', async () => {
    fixture = await bootFixture();
    // 30 bars with closes 100..129 (linear), each carrying 1_000_000
    // volume. Total = 30M; range = [100, 129]; bucketWidth =
    // (129 - 100) / 40 = 0.725.
    const bars: { close: number; volume: number }[] = [];
    for (let i = 0; i < 30; i++) {
      bars.push({ close: 100 + i, volume: 1_000_000 });
    }
    await insertExplicitBars(fixture, 'AAPL', bars);

    const rangeRows = await fixture.query(rangeSql('AAPL'));
    expect(rangeRows.length).toBe(1);
    const lo = Number(rangeRows[0].lo);
    const hi = Number(rangeRows[0].hi);
    expect(lo).toBeCloseTo(100, 6);
    expect(hi).toBeCloseTo(129, 6);
    expect(Number(rangeRows[0].n)).toBe(30);

    const bucketCount = 40;
    const bucketWidth = (hi - lo) / bucketCount;
    const profileRows = await fixture.query(
      profileSql('AAPL', lo, bucketWidth, bucketCount),
    );

    // 30 distinct closes spread across 40 buckets — at most 30 buckets
    // are populated (some buckets will be empty in the gaps because
    // closes are integer-spaced and bucketWidth ≈ 0.725).
    expect(profileRows.length).toBeGreaterThan(0);
    expect(profileRows.length).toBeLessThanOrEqual(30);

    // Total volume across all buckets must equal the inserted total.
    const totalVol = profileRows.reduce(
      (acc, r) => acc + Number(r.total_volume),
      0,
    );
    expect(totalVol).toBe(30_000_000);

    // Total bars across all buckets must equal the inserted bar count.
    const totalBars = profileRows.reduce(
      (acc, r) => acc + Number(r.bars_count),
      0,
    );
    expect(totalBars).toBe(30);

    // Every bucket index must be in [0, bucketCount-1] — the
    // LEAST/GREATEST clamp guarantees this even for the close == hi
    // edge case where FLOOR would otherwise emit `bucketCount`.
    for (const r of profileRows) {
      const idx = Number(r.bucket_idx);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThanOrEqual(bucketCount - 1);
    }
  });

  it('identifies the Point of Control correctly', async () => {
    fixture = await bootFixture();
    // 40 bars with closes 100..139, each carrying 1M volume EXCEPT
    // the bar at close=120 which carries 50M. With 40 buckets across
    // a 39-wide range (bucketWidth = 39/40 = 0.975), close=120 falls
    // in bucket index FLOOR((120 - 100) / 0.975) = FLOOR(20.51) = 20.
    //
    // The POC must be bucket 20 (the loaded one), and its total
    // volume must be at least 50M (the loaded volume). A bucket-
    // boundary near 120 could group a neighbour into the same
    // bucket, bumping the total slightly higher — we assert >= 50M
    // and that it's strictly greater than every other bucket.
    const bars: { close: number; volume: number }[] = [];
    for (let i = 0; i < 40; i++) {
      const close = 100 + i;
      const volume = close === 120 ? 50_000_000 : 1_000_000;
      bars.push({ close, volume });
    }
    await insertExplicitBars(fixture, 'POC', bars);

    const rangeRows = await fixture.query(rangeSql('POC'));
    const lo = Number(rangeRows[0].lo);
    const hi = Number(rangeRows[0].hi);
    const bucketCount = 40;
    const bucketWidth = (hi - lo) / bucketCount;

    const profileRows = await fixture.query(
      profileSql('POC', lo, bucketWidth, bucketCount),
    );

    // Find the max-volume bucket — that's the POC.
    let pocIdx = -1;
    let pocVol = -1;
    for (const r of profileRows) {
      const idx = Number(r.bucket_idx);
      const vol = Number(r.total_volume);
      if (vol > pocVol) {
        pocVol = vol;
        pocIdx = idx;
      }
    }

    // Bucket containing close=120 should be the POC.
    const expectedPocIdx = Math.floor((120 - lo) / bucketWidth);
    expect(pocIdx).toBe(expectedPocIdx);
    expect(pocVol).toBeGreaterThanOrEqual(50_000_000);

    // POC must be strictly the largest — no ties.
    let secondLargest = -1;
    for (const r of profileRows) {
      const vol = Number(r.total_volume);
      if (Number(r.bucket_idx) === pocIdx) continue;
      if (vol > secondLargest) secondLargest = vol;
    }
    expect(pocVol).toBeGreaterThan(secondLargest);
  });

  it('handles empty range gracefully (no rows for ticker)', async () => {
    fixture = await bootFixture();
    // No data inserted for SPY. The range query returns one row
    // with NULL lo/hi and n=0; the production helper short-circuits
    // here and returns an empty profile without running the bucketing
    // query. We assert the range row's shape directly — that's the
    // surface the production code branches on.
    const rangeRows = await fixture.query(rangeSql('SPY'));
    expect(rangeRows.length).toBe(1);
    expect(Number(rangeRows[0].n)).toBe(0);
    // lo/hi are NULL for an empty aggregate. The production helper
    // checks n === 0 first so the NULL never reaches the divide.
    expect(rangeRows[0].lo).toBeNull();
    expect(rangeRows[0].hi).toBeNull();
  });

  it('handles the single-price degenerate case (all closes equal)', async () => {
    fixture = await bootFixture();
    // 10 bars all at close=100. hi - lo = 0, so bucketWidth would be
    // zero — meaningful bucketing is impossible. The production
    // helper short-circuits when lo === hi and returns an empty
    // profile, but with `barsAnalyzed = n` so the UI can distinguish
    // "single price" from "no data". We assert the range query gives
    // us the inputs that trigger that branch.
    const bars: { close: number; volume: number }[] = [];
    for (let i = 0; i < 10; i++) {
      bars.push({ close: 100, volume: 1_000_000 });
    }
    await insertExplicitBars(fixture, 'FLAT', bars);

    const rangeRows = await fixture.query(rangeSql('FLAT'));
    expect(rangeRows.length).toBe(1);
    expect(Number(rangeRows[0].lo)).toBe(100);
    expect(Number(rangeRows[0].hi)).toBe(100);
    expect(Number(rangeRows[0].n)).toBe(10);
    // The production helper does NOT run profileSql in this case;
    // running it here would divide by zero. Documented behaviour:
    // single-price → empty buckets, barsAnalyzed = 10.
  });

  it('excludes bars with NULL volume from both range and bucketing', async () => {
    fixture = await bootFixture();
    // Mix bars with and without volume. The NULL-volume bar at
    // close=200 should NOT widen the price range — otherwise the
    // bucketing would have a huge dead zone between 109 and 199.
    const bars: { close: number; volume: number }[] = [];
    for (let i = 0; i < 10; i++) {
      bars.push({ close: 100 + i, volume: 1_000_000 });
    }
    await insertExplicitBars(fixture, 'NULLV', bars);
    // Insert one bar with explicit NULL volume at an extreme price.
    // Manual SQL because insertExplicitBars writes a non-null volume.
    await fixture.query(`
      INSERT INTO ohlcv (ticker, dt, open, high, low, close, volume)
      VALUES ('NULLV', DATE '2024-02-01', 199.95, 200.20, 199.80, 200.00, NULL)
    `);

    const rangeRows = await fixture.query(rangeSql('NULLV'));
    // Range should still be [100, 109] — the NULL-volume bar is
    // excluded by `volume IS NOT NULL` in the WHERE clause. n=10,
    // not 11.
    expect(Number(rangeRows[0].lo)).toBe(100);
    expect(Number(rangeRows[0].hi)).toBe(109);
    expect(Number(rangeRows[0].n)).toBe(10);
  });

  it('clamps the close == hi edge case into the topmost bucket', async () => {
    fixture = await bootFixture();
    // Closes 100..120. Without the LEAST clamp, FLOOR((120 - 100) /
    // ((120 - 100) / 40)) would be FLOOR(40) = 40 — out of range
    // (max valid index is 39). The clamp pulls it back to 39.
    const bars: { close: number; volume: number }[] = [];
    for (let i = 0; i <= 20; i++) {
      bars.push({ close: 100 + i, volume: 1_000_000 });
    }
    await insertExplicitBars(fixture, 'EDGE', bars);

    const rangeRows = await fixture.query(rangeSql('EDGE'));
    const lo = Number(rangeRows[0].lo);
    const hi = Number(rangeRows[0].hi);
    expect(lo).toBe(100);
    expect(hi).toBe(120);
    const bucketCount = 40;
    const bucketWidth = (hi - lo) / bucketCount;

    const profileRows = await fixture.query(
      profileSql('EDGE', lo, bucketWidth, bucketCount),
    );

    // Max bucket index must never exceed bucketCount - 1.
    const maxIdx = Math.max(...profileRows.map((r) => Number(r.bucket_idx)));
    expect(maxIdx).toBe(bucketCount - 1);

    // And total bars/volume preserved (no rows dropped by the clamp).
    const totalBars = profileRows.reduce(
      (acc, r) => acc + Number(r.bars_count),
      0,
    );
    expect(totalBars).toBe(21);
  });
});
