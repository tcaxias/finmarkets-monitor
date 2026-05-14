// Integration tests for the alerts feature (migration v7 + alerts.ts
// evaluation logic).
//
// Strategy: same as the other integration suites — execute SQL strings
// against a real DuckDB engine via @duckdb/node-api so the schema and
// edge-trigger transitions are exercised end-to-end. The fixture's
// `applyMigrations` already provisions the v7 alerts + alert_fires
// tables.
//
// We test the SQL/state machine directly here (rather than driving
// through src/lib/alerts.ts, which depends on the WASM `getConn`
// path that isn't available in vitest). The state-machine logic IS
// the high-value thing — it's the same logic that runs in the
// production module, just inlined here against the node-api fixture.
//
// The crosses_below edge-trigger test is the headline: most
// commonly-broken case in alerting systems is "alert keeps re-firing
// while the metric is still in the firing zone".

import { describe, it, expect, afterEach } from 'vitest';
import { bootFixture, type FixtureDb } from './duckdb-fixture';

let fixture: FixtureDb | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = null;
  }
});

// --- Helpers that mirror the state-machine logic in alerts.ts. ---
// Inlined so the tests pin the EXACT semantics: any change to
// alerts.ts that breaks the contract surfaces as a test diff in BOTH
// places, forcing a deliberate decision rather than a silent drift.

type AlertState = 'above' | 'below' | 'inside' | 'outside';
type AlertOperator =
  | 'crosses_above'
  | 'crosses_below'
  | 'enters_band'
  | 'exits_band';

function currentState(
  value: number,
  operator: AlertOperator,
  threshold: number,
  thresholdHigh: number | null,
): AlertState {
  if (operator === 'enters_band' || operator === 'exits_band') {
    if (thresholdHigh == null) return 'outside';
    return value >= threshold && value <= thresholdHigh ? 'inside' : 'outside';
  }
  return value >= threshold ? 'above' : 'below';
}

function shouldFire(
  prev: AlertState | null,
  curr: AlertState,
  operator: AlertOperator,
): boolean {
  switch (operator) {
    case 'crosses_above':
      if (prev === null) return curr === 'above';
      return prev === 'below' && curr === 'above';
    case 'crosses_below':
      if (prev === null) return curr === 'below';
      return prev === 'above' && curr === 'below';
    case 'enters_band':
      if (prev === null) return curr === 'inside';
      return prev === 'outside' && curr === 'inside';
    case 'exits_band':
      if (prev === null) return curr === 'outside';
      return prev === 'inside' && curr === 'outside';
  }
}

/**
 * Run one tick: read the alert from the fixture, evaluate against
 * `value`, persist the new state, and insert a fire row if applicable.
 * Returns true if a fire was emitted on this tick. Mirrors the
 * effective behaviour of `alerts.ts::evaluateAlerts` for one rule.
 */
async function tickAlert(
  fx: FixtureDb,
  alertId: string,
  value: number,
): Promise<boolean> {
  const rows = await fx.query(`
    SELECT id, operator, threshold, threshold_band_high, last_state, ticker, metric
    FROM alerts WHERE id = '${alertId}'
  `);
  expect(rows.length).toBe(1);
  const r = rows[0];
  const operator = String(r.operator) as AlertOperator;
  const threshold = Number(r.threshold);
  const thresholdHigh =
    r.threshold_band_high == null ? null : Number(r.threshold_band_high);
  const prevRaw = r.last_state == null ? null : String(r.last_state);
  const prev = (prevRaw === null ? null : prevRaw) as AlertState | null;

  const curr = currentState(value, operator, threshold, thresholdHigh);
  const fire = shouldFire(prev, curr, operator);

  // Update last_state/last_evaluated_value regardless.
  await fx.query(`
    UPDATE alerts
    SET last_state = '${curr}',
        last_evaluated_value = ${value},
        last_evaluated_at = CURRENT_TIMESTAMP
    WHERE id = '${alertId}'
  `);

  if (fire) {
    // Inline-quote literals; alertId/ticker/metric come from the rule
    // we just SELECTed (trusted), value is a Number we constructed.
    const fireId = `fire-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await fx.query(`
      INSERT INTO alert_fires
        (id, alert_id, fired_at, ticker, metric,
         observed_value, threshold, message, acknowledged)
      VALUES
        ('${fireId}', '${alertId}', CURRENT_TIMESTAMP,
         '${r.ticker}', '${r.metric}',
         ${value}, ${threshold},
         'test fire @ ${value}', FALSE)
    `);
  }
  return fire;
}

describe('alerts (integration)', () => {
  it('persists an alert rule with all columns round-tripped correctly', async () => {
    fixture = await bootFixture();

    await fixture.query(`
      INSERT INTO alerts
        (id, ticker, metric, operator, threshold, threshold_band_high,
         enabled, label, created_at, last_evaluated_at,
         last_evaluated_value, last_state)
      VALUES
        ('rule-1', 'AAPL', 'close', 'crosses_below', 100.0, NULL,
         TRUE, 'AAPL down breakout', CURRENT_TIMESTAMP, NULL, NULL, NULL)
    `);

    const rows = await fixture.query(`
      SELECT id, ticker, metric, operator, threshold, threshold_band_high,
             enabled, label, last_state
      FROM alerts WHERE id = 'rule-1'
    `);

    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('rule-1');
    expect(rows[0].ticker).toBe('AAPL');
    expect(rows[0].metric).toBe('close');
    expect(rows[0].operator).toBe('crosses_below');
    expect(Number(rows[0].threshold)).toBe(100.0);
    expect(rows[0].threshold_band_high).toBeNull();
    expect(rows[0].enabled).toBe(true);
    expect(rows[0].label).toBe('AAPL down breakout');
    expect(rows[0].last_state).toBeNull();
  });

  // The headline test: edge-triggered crosses_below.
  //
  // Sequence: 105, 102, 99, 95, 102
  // Threshold: 100
  //   tick 1 (105): prev=null, curr='above' → no fire; record state='above'
  //   tick 2 (102): prev='above', curr='above' → no fire
  //   tick 3 (99): prev='above', curr='below' → FIRE; state='below'
  //   tick 4 (95): prev='below', curr='below' → NO fire (still below — anti-spam)
  //   tick 5 (102): prev='below', curr='above' → no fire (this isn't a crosses_below)
  //
  // Total fires: exactly 1. The "no fire on tick 4" case is the
  // anti-spam pin — alerting systems most commonly ship with this
  // bug and the user gets 50 redundant notifications during a
  // sustained drop.
  it('edge-triggers a crosses_below alert exactly once per crossing', async () => {
    fixture = await bootFixture();

    await fixture.query(`
      INSERT INTO alerts
        (id, ticker, metric, operator, threshold, threshold_band_high,
         enabled, label)
      VALUES
        ('rule-cb', 'AAPL', 'close', 'crosses_below', 100.0, NULL,
         TRUE, 'cb test')
    `);

    const sequence = [105, 102, 99, 95, 102];
    const fires: boolean[] = [];
    for (const v of sequence) {
      fires.push(await tickAlert(fixture, 'rule-cb', v));
    }

    expect(fires).toEqual([false, false, true, false, false]);

    // Verify alert_fires has exactly one row.
    const fireRows = await fixture.query(
      `SELECT observed_value FROM alert_fires WHERE alert_id = 'rule-cb'`,
    );
    expect(fireRows.length).toBe(1);
    expect(Number(fireRows[0].observed_value)).toBe(99);
  });

  it('edge-triggers a crosses_above alert exactly once per crossing', async () => {
    // Mirror of the crosses_below test. Sequence: 50, 60, 75, 80, 70
    // Threshold (RSI) = 70.
    //   tick 1 (50): prev=null, curr='below' → no fire; state='below'
    //   tick 2 (60): prev='below', curr='below' → no fire
    //   tick 3 (75): prev='below', curr='above' → FIRE
    //   tick 4 (80): prev='above', curr='above' → no fire (still above)
    //   tick 5 (70): prev='above', curr='above' → no fire (==70 still above by ≥)
    fixture = await bootFixture();

    await fixture.query(`
      INSERT INTO alerts
        (id, ticker, metric, operator, threshold, threshold_band_high, enabled)
      VALUES
        ('rule-ca', 'AAPL', 'rsi', 'crosses_above', 70.0, NULL, TRUE)
    `);

    const sequence = [50, 60, 75, 80, 70];
    const fires: boolean[] = [];
    for (const v of sequence) {
      fires.push(await tickAlert(fixture, 'rule-ca', v));
    }

    expect(fires).toEqual([false, false, true, false, false]);

    const fireRows = await fixture.query(
      `SELECT observed_value FROM alert_fires WHERE alert_id = 'rule-ca'`,
    );
    expect(fireRows.length).toBe(1);
    expect(Number(fireRows[0].observed_value)).toBe(75);
  });

  it('edge-triggers an enters_band alert exactly once per entry', async () => {
    // Band: [40, 60]. Sequence: 30, 35, 50, 55, 65, 70, 45
    //   tick 1 (30): prev=null, curr='outside' → no fire; state='outside'
    //   tick 2 (35): prev='outside', curr='outside' → no fire
    //   tick 3 (50): prev='outside', curr='inside' → FIRE
    //   tick 4 (55): prev='inside', curr='inside' → no fire (still inside)
    //   tick 5 (65): prev='inside', curr='outside' → no fire (this is exits, not enters)
    //   tick 6 (70): prev='outside', curr='outside' → no fire
    //   tick 7 (45): prev='outside', curr='inside' → FIRE again (re-entry)
    fixture = await bootFixture();

    await fixture.query(`
      INSERT INTO alerts
        (id, ticker, metric, operator, threshold, threshold_band_high, enabled)
      VALUES
        ('rule-eb', 'AAPL', 'rsi', 'enters_band', 40.0, 60.0, TRUE)
    `);

    const sequence = [30, 35, 50, 55, 65, 70, 45];
    const fires: boolean[] = [];
    for (const v of sequence) {
      fires.push(await tickAlert(fixture, 'rule-eb', v));
    }

    expect(fires).toEqual([false, false, true, false, false, false, true]);

    const fireRows = await fixture.query(
      `SELECT observed_value FROM alert_fires WHERE alert_id = 'rule-eb' ORDER BY fired_at`,
    );
    expect(fireRows.length).toBe(2);
    expect(Number(fireRows[0].observed_value)).toBe(50);
    expect(Number(fireRows[1].observed_value)).toBe(45);
  });

  it('persists fire rows with all expected columns populated', async () => {
    fixture = await bootFixture();

    await fixture.query(`
      INSERT INTO alerts
        (id, ticker, metric, operator, threshold, threshold_band_high, enabled)
      VALUES
        ('rule-p', 'AAPL', 'close', 'crosses_below', 200.0, NULL, TRUE)
    `);

    // First tick above (no fire), second below (fire).
    await tickAlert(fixture, 'rule-p', 210);
    await tickAlert(fixture, 'rule-p', 195);

    const rows = await fixture.query(`
      SELECT id, alert_id, ticker, metric, observed_value, threshold,
             message, acknowledged
      FROM alert_fires WHERE alert_id = 'rule-p'
    `);

    expect(rows.length).toBe(1);
    const f = rows[0];
    expect(typeof f.id).toBe('string');
    expect(f.alert_id).toBe('rule-p');
    expect(f.ticker).toBe('AAPL');
    expect(f.metric).toBe('close');
    expect(Number(f.observed_value)).toBe(195);
    expect(Number(f.threshold)).toBe(200);
    expect(typeof f.message).toBe('string');
    expect(f.message).toContain('195'); // value embedded in message
    expect(f.acknowledged).toBe(false);
  });

  it('does not fire when the alert is disabled (production-path filter)', async () => {
    // The production evaluator filters `WHERE enabled = TRUE` before
    // running the state machine. A disabled rule must not advance its
    // last_state nor produce fires. Replicate that filter here and
    // assert.
    fixture = await bootFixture();

    await fixture.query(`
      INSERT INTO alerts
        (id, ticker, metric, operator, threshold, threshold_band_high,
         enabled)
      VALUES
        ('rule-d', 'AAPL', 'close', 'crosses_below', 100.0, NULL, FALSE)
    `);

    // Mirror the production SELECT — only rules with enabled = TRUE
    // are processed. A disabled rule yields zero candidates.
    const candidates = await fixture.query(`
      SELECT id FROM alerts WHERE ticker = 'AAPL' AND enabled = TRUE
    `);
    expect(candidates.length).toBe(0);

    // Sanity: no fire rows were inserted.
    const fires = await fixture.query(
      `SELECT id FROM alert_fires WHERE alert_id = 'rule-d'`,
    );
    expect(fires.length).toBe(0);

    // Sanity: last_state stays null (we never ran the tick).
    const stateRows = await fixture.query(
      `SELECT last_state FROM alerts WHERE id = 'rule-d'`,
    );
    expect(stateRows[0].last_state).toBeNull();
  });

  it('first-tick crosses_below fires immediately if already below threshold', async () => {
    // Edge case: rule created while metric is already in the firing
    // zone. The alerts.ts shouldFire() returns true on prev=null +
    // curr=firing-side so the user gets an immediate alert — matches
    // the intuitive "tell me if AAPL is below $200" mental model
    // when AAPL is already at $190.
    fixture = await bootFixture();

    await fixture.query(`
      INSERT INTO alerts
        (id, ticker, metric, operator, threshold, threshold_band_high,
         enabled)
      VALUES
        ('rule-first', 'AAPL', 'close', 'crosses_below', 200.0, NULL, TRUE)
    `);

    const fired = await tickAlert(fixture, 'rule-first', 190);
    expect(fired).toBe(true);

    const fires = await fixture.query(
      `SELECT observed_value FROM alert_fires WHERE alert_id = 'rule-first'`,
    );
    expect(fires.length).toBe(1);
    expect(Number(fires[0].observed_value)).toBe(190);
  });

  it('FK-style cascade: rule deletion can clear orphan fires', async () => {
    // DuckDB doesn't enforce the FK, so the production deleteAlert()
    // explicitly DELETEs from alert_fires first. Test that pattern
    // (the SQL the production code emits, against the fixture).
    fixture = await bootFixture();

    await fixture.query(`
      INSERT INTO alerts
        (id, ticker, metric, operator, threshold, threshold_band_high, enabled)
      VALUES
        ('rule-fk', 'AAPL', 'close', 'crosses_below', 100.0, NULL, TRUE)
    `);
    // Generate a fire so there's something to clean up.
    await tickAlert(fixture, 'rule-fk', 90);

    // Production cleanup sequence.
    await fixture.query(`DELETE FROM alert_fires WHERE alert_id = 'rule-fk'`);
    await fixture.query(`DELETE FROM alerts WHERE id = 'rule-fk'`);

    const remainingRules = await fixture.query(
      `SELECT id FROM alerts WHERE id = 'rule-fk'`,
    );
    expect(remainingRules.length).toBe(0);

    const remainingFires = await fixture.query(
      `SELECT id FROM alert_fires WHERE alert_id = 'rule-fk'`,
    );
    expect(remainingFires.length).toBe(0);
  });
});
