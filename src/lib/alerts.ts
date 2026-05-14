// Alert rules: persistence + edge-triggered evaluation.
//
// Why this module exists
// ----------------------
// The "monitoring" half of finmarkets-monitor was previously passive —
// the user opened the page, eyeballed the dashboard, made a decision.
// Alerts turn it active: define a rule like "AAPL closes below $150" or
// "MSFT RSI crosses above 70" and the app will surface a toast + a
// browser notification the moment the condition newly becomes true.
//
// The "newly" is load-bearing. A rule that fires on every refresh while
// a stock is still under threshold would be useless noise; the
// edge-trigger semantics here mean "fire once on the transition into
// the firing zone, then go quiet until it transitions back out and
// re-enters." See `evaluateAlerts` for the state-machine details.
//
// Storage
// -------
// Two tables (migration v7):
//   - alerts        — rule definitions + last_state for edge detection
//   - alert_fires   — append-only log of every fire event
//
// Both persist via OPFS so rules survive reload. The `last_state` field
// on a rule is the linchpin of edge detection: 'above' / 'below' /
// 'inside' / 'outside' represent the side of the threshold the metric
// was on at the previous evaluation. A fire happens iff (prev_state,
// curr_state) is the pair the operator considers a transition (e.g.
// crosses_below: prev='above', curr='below').
//
// SQL parameter binding
// ---------------------
// Same patterns as data.svelte.ts and sqlIndicators.ts: prepared
// statements via `conn.prepare()`, bound positional parameters,
// `try { ... } finally { stmt.close() }`. Tickers are validated via
// the same TICKER_RE used elsewhere before they reach SQL — defence
// in depth.

import { getConn, ensureSchema } from './duckdb';

// ---------- types ----------

export type AlertMetric =
  | 'close'                       // last close price
  | 'rsi'                         // latest RSI(14)
  | 'macd_hist'                   // latest MACD histogram
  | 'distance_from_pcover_pct'    // (close - pcover) / pcover * 100; needs Position context
  | 'drawdown_pct';               // current drawdown from rolling 252-day high

export type AlertOperator =
  | 'crosses_above'
  | 'crosses_below'
  | 'enters_band'      // entered [threshold, threshold_band_high]
  | 'exits_band';      // left [threshold, threshold_band_high]

// Module-private — surfaced via the AlertRule.lastState field where it's
// already part of the public type. Not currently re-exported because
// no external consumer needs the bare alias.
type AlertState = 'above' | 'below' | 'inside' | 'outside';

export interface AlertRule {
  id: string;
  ticker: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  thresholdBandHigh: number | null;
  enabled: boolean;
  label: string | null;
  createdAt: Date;
  lastEvaluatedAt: Date | null;
  lastEvaluatedValue: number | null;
  lastState: AlertState | null;
}

export interface AlertFire {
  id: string;
  alertId: string;
  firedAt: Date;
  ticker: string;
  metric: AlertMetric;
  observedValue: number;
  threshold: number;
  message: string;
  acknowledged: boolean;
}

export interface EvaluationContext {
  ticker: string;
  /** Latest close price. Required (this is the foundation metric). */
  close: number;
  /** Latest RSI(14) — null when ticker has too few bars to compute. */
  rsi: number | null;
  /** Latest MACD histogram — null when ticker has too few bars. */
  macdHist: number | null;
  /** (close - pcover) / pcover * 100 — null when no Pcover (no tax tracking). */
  distanceFromPcoverPct: number | null;
  /** Current drawdown from rolling 252-day high, percent (negative). */
  drawdownPct: number | null;
}

// ---------- constants / validation ----------

/** Same shape as settings.svelte.ts TICKER_RE — defensive duplication
 *  to avoid pulling the reactive store into a pure-DB module. */
const TICKER_RE = /^[A-Z0-9]{1,10}$/;

/** Valid metric values, frozen for runtime validation of patches. */
const VALID_METRICS: ReadonlySet<AlertMetric> = new Set([
  'close',
  'rsi',
  'macd_hist',
  'distance_from_pcover_pct',
  'drawdown_pct',
]);

/** Valid operators, frozen for runtime validation of patches. */
const VALID_OPERATORS: ReadonlySet<AlertOperator> = new Set([
  'crosses_above',
  'crosses_below',
  'enters_band',
  'exits_band',
]);

// ---------- id generator ----------

/**
 * Short, collision-resistant id. Mirrors the pattern from
 * settings.svelte.ts::genId. We don't need cryptographic strength —
 * alerts are local to one browser profile and there are at most a
 * handful — so a UUID slice (or a base36 timestamp + random suffix
 * fallback) is plenty.
 */
function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 12);
  }
  return (
    Date.now().toString(36) +
    Math.floor(Math.random() * 0xffffff).toString(36)
  );
}

// ---------- coercion helpers ----------

/** DuckDB's TIMESTAMP comes back as either a Date, a number (ms), or a
 *  bigint (microseconds since epoch — depends on the binding/codepath).
 *  Normalize everything to a JS Date or null. */
function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'bigint') {
    // DuckDB-WASM hands back microseconds-since-epoch as a BigInt for
    // TIMESTAMP. Convert to ms for the Date constructor.
    return new Date(Number(v) / 1000);
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toBoolean(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return Number(v) !== 0;
  if (typeof v === 'string') return v === 'true' || v === '1' || v === 't';
  return Boolean(v);
}

function toAlertState(v: unknown): AlertState | null {
  if (v === 'above' || v === 'below' || v === 'inside' || v === 'outside') {
    return v;
  }
  return null;
}

/** Map a raw row from `alerts` to an AlertRule. */
function rowToRule(row: Record<string, unknown>): AlertRule {
  return {
    id: String(row.id),
    ticker: String(row.ticker),
    metric: String(row.metric) as AlertMetric,
    operator: String(row.operator) as AlertOperator,
    threshold: Number(row.threshold),
    thresholdBandHigh:
      row.threshold_band_high == null ? null : Number(row.threshold_band_high),
    enabled: toBoolean(row.enabled),
    label: row.label == null ? null : String(row.label),
    createdAt: toDate(row.created_at) ?? new Date(0),
    lastEvaluatedAt: toDate(row.last_evaluated_at),
    lastEvaluatedValue: toNumber(row.last_evaluated_value),
    lastState: toAlertState(row.last_state),
  };
}

/** Map a raw row from `alert_fires` to an AlertFire. */
function rowToFire(row: Record<string, unknown>): AlertFire {
  return {
    id: String(row.id),
    alertId: String(row.alert_id),
    firedAt: toDate(row.fired_at) ?? new Date(0),
    ticker: String(row.ticker),
    metric: String(row.metric) as AlertMetric,
    observedValue: Number(row.observed_value),
    threshold: Number(row.threshold),
    message: String(row.message),
    acknowledged: toBoolean(row.acknowledged),
  };
}

// ---------- CRUD: rules ----------

/** List every alert rule, newest first. */
export async function listAlerts(): Promise<AlertRule[]> {
  await ensureSchema();
  const conn = await getConn();
  const result = await conn.query(
    `SELECT id, ticker, metric, operator, threshold, threshold_band_high,
            enabled, label, created_at, last_evaluated_at,
            last_evaluated_value, last_state
       FROM alerts
       ORDER BY created_at DESC`,
  );
  return result.toArray().map((r) => rowToRule(r.toJSON() as Record<string, unknown>));
}

/** Read one rule by id. Returns null if not found. Module-private —
 *  used by `createAlert` to read back the inserted row. Exported as
 *  needed when a caller materialises (kept private to satisfy knip). */
async function getAlert(id: string): Promise<AlertRule | null> {
  await ensureSchema();
  const conn = await getConn();
  const stmt = await conn.prepare(
    `SELECT id, ticker, metric, operator, threshold, threshold_band_high,
            enabled, label, created_at, last_evaluated_at,
            last_evaluated_value, last_state
       FROM alerts
       WHERE id = ?
       LIMIT 1`,
  );
  try {
    const tbl = await stmt.query(id);
    const rows = tbl.toArray();
    if (rows.length === 0) return null;
    return rowToRule(rows[0].toJSON() as Record<string, unknown>);
  } finally {
    await stmt.close();
  }
}

/** Input shape for `createAlert` — the lifecycle fields are all set
 *  by the table defaults / evaluator, so the caller only provides the
 *  rule definition. */
export type CreateAlertInput = Omit<
  AlertRule,
  'id' | 'createdAt' | 'lastEvaluatedAt' | 'lastEvaluatedValue' | 'lastState'
>;

/** Validate a rule input. Throws on the FIRST problem found — the UI
 *  layer should validate per-field for friendly inline errors. This
 *  is the SQL-boundary defence-in-depth check. */
function validateRuleInput(input: CreateAlertInput): void {
  const ticker = input.ticker.trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) {
    throw new Error(
      `alerts: invalid ticker '${input.ticker}' (must be 1-10 alnum)`,
    );
  }
  if (!VALID_METRICS.has(input.metric)) {
    throw new Error(`alerts: invalid metric '${input.metric}'`);
  }
  if (!VALID_OPERATORS.has(input.operator)) {
    throw new Error(`alerts: invalid operator '${input.operator}'`);
  }
  if (!Number.isFinite(input.threshold)) {
    throw new Error(`alerts: threshold must be a finite number`);
  }
  // Band ops require thresholdBandHigh AND it must be > threshold so
  // the "inside" interval [threshold, thresholdBandHigh] is non-empty.
  // Without this guard, enters_band/exits_band would fire spuriously.
  if (input.operator === 'enters_band' || input.operator === 'exits_band') {
    if (input.thresholdBandHigh == null || !Number.isFinite(input.thresholdBandHigh)) {
      throw new Error(
        `alerts: operator '${input.operator}' requires a numeric thresholdBandHigh`,
      );
    }
    if (input.thresholdBandHigh <= input.threshold) {
      throw new Error(
        `alerts: thresholdBandHigh (${input.thresholdBandHigh}) must be > threshold (${input.threshold})`,
      );
    }
  }
}

/** Create a new alert rule. Returns the inserted rule (with id +
 *  default lifecycle fields populated). */
export async function createAlert(input: CreateAlertInput): Promise<AlertRule> {
  validateRuleInput(input);
  await ensureSchema();
  const conn = await getConn();
  const id = genId();
  const ticker = input.ticker.trim().toUpperCase();

  const stmt = await conn.prepare(
    `INSERT INTO alerts
       (id, ticker, metric, operator, threshold, threshold_band_high,
        enabled, label, created_at, last_evaluated_at,
        last_evaluated_value, last_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, NULL, NULL, NULL)`,
  );
  try {
    await stmt.query(
      id,
      ticker,
      input.metric,
      input.operator,
      input.threshold,
      input.thresholdBandHigh,
      input.enabled,
      input.label,
    );
  } finally {
    await stmt.close();
  }

  const rule = await getAlert(id);
  if (!rule) {
    // Defence-in-depth — should never happen since we just inserted.
    throw new Error(`alerts: createAlert insert succeeded but row not readable for id=${id}`);
  }
  return rule;
}

/** Patch an existing rule. Unknown fields are ignored. The lifecycle
 *  fields (lastEvaluatedAt etc.) are NOT user-editable and must not
 *  appear in `patch` — they're maintained by the evaluator.
 *
 *  Module-private — `setAlertEnabled` is the sole caller (the AlertsPanel
 *  v1 only supports enable-toggle + delete; full edit-in-place can re-
 *  export this when implemented).
 */
async function updateAlert(
  id: string,
  patch: Partial<AlertRule>,
): Promise<void> {
  await ensureSchema();
  const conn = await getConn();

  // Build the SET clause dynamically from whatever fields are present.
  // Whitelist the columns we'll touch so a malicious caller can't sneak
  // a SQL fragment in via patch keys.
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.ticker !== undefined) {
    const t = patch.ticker.trim().toUpperCase();
    if (!TICKER_RE.test(t)) throw new Error(`alerts: invalid ticker '${patch.ticker}'`);
    sets.push('ticker = ?');
    params.push(t);
  }
  if (patch.metric !== undefined) {
    if (!VALID_METRICS.has(patch.metric)) {
      throw new Error(`alerts: invalid metric '${patch.metric}'`);
    }
    sets.push('metric = ?');
    params.push(patch.metric);
  }
  if (patch.operator !== undefined) {
    if (!VALID_OPERATORS.has(patch.operator)) {
      throw new Error(`alerts: invalid operator '${patch.operator}'`);
    }
    sets.push('operator = ?');
    params.push(patch.operator);
  }
  if (patch.threshold !== undefined) {
    if (!Number.isFinite(patch.threshold)) throw new Error('alerts: threshold must be finite');
    sets.push('threshold = ?');
    params.push(patch.threshold);
  }
  if (patch.thresholdBandHigh !== undefined) {
    sets.push('threshold_band_high = ?');
    params.push(patch.thresholdBandHigh);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(patch.enabled);
  }
  if (patch.label !== undefined) {
    sets.push('label = ?');
    params.push(patch.label);
  }

  if (sets.length === 0) return; // nothing to do
  params.push(id);

  const sql = `UPDATE alerts SET ${sets.join(', ')} WHERE id = ?`;
  const stmt = await conn.prepare(sql);
  try {
    await stmt.query(...params);
  } finally {
    await stmt.close();
  }
}

/** Delete a rule. Also deletes its fires (cascade-equivalent — DuckDB
 *  doesn't enforce the FK, so we do it ourselves to keep alert_fires
 *  free of orphaned rows). */
export async function deleteAlert(id: string): Promise<void> {
  await ensureSchema();
  const conn = await getConn();
  // Order: fires first, then rule. If the second statement failed mid-
  // way we'd leave the rule but with no fire history — ugly but the
  // app would still function. A transaction would be tidier; the
  // simpler shape is fine for the v1 scope here.
  const firesStmt = await conn.prepare(`DELETE FROM alert_fires WHERE alert_id = ?`);
  try {
    await firesStmt.query(id);
  } finally {
    await firesStmt.close();
  }
  const ruleStmt = await conn.prepare(`DELETE FROM alerts WHERE id = ?`);
  try {
    await ruleStmt.query(id);
  } finally {
    await ruleStmt.close();
  }
}

/** Toggle the `enabled` flag. Convenience over `updateAlert`. */
export async function setAlertEnabled(id: string, enabled: boolean): Promise<void> {
  await updateAlert(id, { enabled });
}

// ---------- Fires ----------

/** List fires, newest first. Optional filters by alertId or limit. */
export async function listFires(
  opts: { limit?: number; alertId?: string } = {},
): Promise<AlertFire[]> {
  await ensureSchema();
  const conn = await getConn();

  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.alertId !== undefined) {
    where.push('alert_id = ?');
    params.push(opts.alertId);
  }
  // Inline LIMIT — it's an integer we control, not user-supplied.
  // Default high enough that the UI's "Recent fires" section gets
  // plenty to filter through client-side.
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 100;
  const sql = `SELECT id, alert_id, fired_at, ticker, metric, observed_value,
                      threshold, message, acknowledged
                 FROM alert_fires
                 ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY fired_at DESC
                 LIMIT ${limit}`;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = await stmt.query(...params);
    return tbl
      .toArray()
      .map((r) => rowToFire(r.toJSON() as Record<string, unknown>));
  } finally {
    await stmt.close();
  }
}

/** Mark a fire as acknowledged (user has seen it / responded). */
export async function acknowledgeFire(id: string): Promise<void> {
  await ensureSchema();
  const conn = await getConn();
  const stmt = await conn.prepare(
    `UPDATE alert_fires SET acknowledged = TRUE WHERE id = ?`,
  );
  try {
    await stmt.query(id);
  } finally {
    await stmt.close();
  }
}

/** Delete every acknowledged fire. Useful "clean up old noise" affordance
 *  in the panel without nuking unread history. */
export async function clearAcknowledgedFires(): Promise<void> {
  await ensureSchema();
  const conn = await getConn();
  await conn.query(`DELETE FROM alert_fires WHERE acknowledged = TRUE`);
}

// ---------- Evaluation ----------

/**
 * Pick the metric value out of an EvaluationContext. Returns null
 * when the context didn't include the value (e.g. RSI on a brand-new
 * ticker with < 15 bars). A null value means "can't evaluate" — the
 * evaluator skips the rule for this tick rather than firing on a
 * fake-zero.
 */
function readMetricValue(ctx: EvaluationContext, metric: AlertMetric): number | null {
  switch (metric) {
    case 'close':
      return ctx.close;
    case 'rsi':
      return ctx.rsi;
    case 'macd_hist':
      return ctx.macdHist;
    case 'distance_from_pcover_pct':
      return ctx.distanceFromPcoverPct;
    case 'drawdown_pct':
      return ctx.drawdownPct;
  }
}

/**
 * Compute the current state ('above'/'below' for single-threshold ops,
 * 'inside'/'outside' for band ops) given the metric value and the
 * rule's threshold(s).
 *
 * Single-threshold ops:
 *   value >= threshold → 'above'
 *   value <  threshold → 'below'
 *   (>= so a value exactly at the threshold is considered "above" —
 *    matches the "crosses_above when value crosses to >= threshold"
 *    intent that most users have when they say "alert me at $20".)
 *
 * Band ops:
 *   threshold <= value <= thresholdBandHigh → 'inside'
 *   else                                     → 'outside'
 */
function currentState(value: number, rule: AlertRule): AlertState {
  if (rule.operator === 'enters_band' || rule.operator === 'exits_band') {
    if (rule.thresholdBandHigh == null) {
      // Mis-configured rule — treated as 'outside' so it never fires.
      // validateRuleInput should have caught this at create time.
      return 'outside';
    }
    return value >= rule.threshold && value <= rule.thresholdBandHigh
      ? 'inside'
      : 'outside';
  }
  return value >= rule.threshold ? 'above' : 'below';
}

/**
 * Decide whether a state transition fires the alert.
 *
 * Edge-trigger semantics — a transition fires only when:
 *   crosses_above:  prev='below'  → curr='above'
 *   crosses_below:  prev='above'  → curr='below'
 *   enters_band:    prev='outside'→ curr='inside'
 *   exits_band:     prev='inside' → curr='outside'
 *
 * First-evaluation behaviour (`prev === null`): we DO fire if `curr`
 * matches the operator's "firing side" — otherwise a rule created
 * while the metric is already in the firing zone would never alert
 * the user. The trade-off is an immediate alert on rule creation if
 * the condition is already true, which is what most users intuitively
 * expect ("tell me when AAPL is below $200" should fire NOW if AAPL
 * is at $190 right now).
 */
function shouldFire(
  prev: AlertState | null,
  curr: AlertState,
  operator: AlertOperator,
): boolean {
  // STRICT EDGE SEMANTICS: never fire on the first evaluation.
  //
  // The first eval (prev === null) just initializes the rule's
  // last_state — firing is decoupled from that initialization. Without
  // this, a newly-created rule against a metric that's already in the
  // firing zone (e.g. "alert when AAPL closes below $200" while AAPL
  // is at $190) would fire IMMEDIATELY on the next refresh, which
  // feels like a false positive — the user just defined the rule;
  // nothing actually transitioned.
  //
  // Trade-off: a user who wants the "is currently true" semantics has
  // to wait one refresh cycle for the state to seed, then trigger an
  // actual edge to fire. Worth it — the alternative produces immediate
  // noise on every newly-armed rule and undermines confidence in the
  // alerting system.
  //
  // Cumulative-review Major #1 (this file).
  if (prev === null) return false;

  switch (operator) {
    case 'crosses_above':
      return prev === 'below' && curr === 'above';
    case 'crosses_below':
      return prev === 'above' && curr === 'below';
    case 'enters_band':
      return prev === 'outside' && curr === 'inside';
    case 'exits_band':
      return prev === 'inside' && curr === 'outside';
  }
}

/** Format a human-readable message for a fire event. */
function formatFireMessage(
  rule: AlertRule,
  value: number,
): string {
  // Short metric label for the message — keep it terse so toast/
  // notification lines stay one-line readable on small viewports.
  const metricLabel: Record<AlertMetric, string> = {
    close: 'close',
    rsi: 'RSI',
    macd_hist: 'MACD histogram',
    distance_from_pcover_pct: 'distance from Pcover',
    drawdown_pct: 'drawdown',
  };
  const opLabel: Record<AlertOperator, string> = {
    crosses_above: 'crossed above',
    crosses_below: 'crossed below',
    enters_band: 'entered band',
    exits_band: 'exited band',
  };
  const fmtVal = (n: number): string => {
    // Generous precision for prices, tighter for percentages — the
    // metric tells us which scale we're on. Errs on the side of
    // showing too many decimals (better than showing too few when
    // the user is comparing 70.0001 vs 70.0002 RSI).
    return Number.isInteger(n) ? n.toFixed(2) : n.toFixed(2);
  };
  const thresholdStr =
    rule.operator === 'enters_band' || rule.operator === 'exits_band'
      ? `[${fmtVal(rule.threshold)}, ${fmtVal(rule.thresholdBandHigh ?? 0)}]`
      : fmtVal(rule.threshold);
  const labelPrefix = rule.label ? `${rule.label}: ` : '';
  return `${labelPrefix}${rule.ticker} ${metricLabel[rule.metric]} ${opLabel[rule.operator]} ${thresholdStr} (now ${fmtVal(value)})`;
}

/**
 * Evaluate every enabled alert for `ctx.ticker`. Returns the alerts
 * that just fired (transitioned into their firing zone this tick).
 *
 * Side effects:
 *   - Updates each alert's last_state / last_evaluated_value /
 *     last_evaluated_at regardless of whether it fired.
 *   - For each fire: inserts a row into alert_fires.
 *
 * The caller (data.svelte.ts after refresh) is responsible for
 * surfacing the returned fires as toasts / browser notifications.
 *
 * Why not also surface the toasts from here: this module is pure
 * data-layer; coupling it to the notifications layer would force
 * tests to mock a UI surface to exercise edge-trigger logic.
 */
export async function evaluateAlerts(
  ctx: EvaluationContext,
): Promise<AlertFire[]> {
  const ticker = ctx.ticker.trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) {
    // Defensive — shouldn't happen since callers go through validated
    // paths, but if it does, return empty rather than throw (alerts
    // are best-effort additive functionality; a malformed ticker
    // shouldn't break the refresh pipeline).
    console.warn(`alerts.evaluateAlerts: malformed ticker '${ctx.ticker}', skipping`);
    return [];
  }

  await ensureSchema();
  const conn = await getConn();

  // Fetch enabled rules for this ticker.
  const stmt = await conn.prepare(
    `SELECT id, ticker, metric, operator, threshold, threshold_band_high,
            enabled, label, created_at, last_evaluated_at,
            last_evaluated_value, last_state
       FROM alerts
       WHERE ticker = ? AND enabled = TRUE`,
  );
  let rules: AlertRule[];
  try {
    const tbl = await stmt.query(ticker);
    rules = tbl
      .toArray()
      .map((r) => rowToRule(r.toJSON() as Record<string, unknown>));
  } finally {
    await stmt.close();
  }

  if (rules.length === 0) return [];

  const fires: AlertFire[] = [];

  // Process each rule. Sequential rather than parallel — DuckDB-WASM
  // has a single connection and prepared statements aren't safe to
  // interleave across `await` points anyway.
  for (const rule of rules) {
    const value = readMetricValue(ctx, rule.metric);
    if (value === null || !Number.isFinite(value)) {
      // Metric not available for this ticker (e.g. RSI on a 5-bar
      // ticker). Don't update last_state — a null evaluation isn't a
      // state transition. Just skip the rule for this tick.
      continue;
    }

    const newState = currentState(value, rule);
    const fired = shouldFire(rule.lastState, newState, rule.operator);

    // Always update last_state / last_evaluated_value /
    // last_evaluated_at — the state machine needs the prior state
    // to detect the next transition.
    const updateStmt = await conn.prepare(
      `UPDATE alerts
         SET last_state = ?,
             last_evaluated_value = ?,
             last_evaluated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
    );
    try {
      await updateStmt.query(newState, value, rule.id);
    } finally {
      await updateStmt.close();
    }

    if (fired) {
      const fireId = genId();
      const message = formatFireMessage(rule, value);
      const insertStmt = await conn.prepare(
        `INSERT INTO alert_fires
           (id, alert_id, fired_at, ticker, metric,
            observed_value, threshold, message, acknowledged)
         VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, FALSE)`,
      );
      try {
        await insertStmt.query(
          fireId,
          rule.id,
          rule.ticker,
          rule.metric,
          value,
          rule.threshold,
          message,
        );
      } finally {
        await insertStmt.close();
      }
      // Construct the AlertFire to return without a follow-up SELECT —
      // we know the values we just inserted. firedAt is approximated as
      // `new Date()` rather than reading back the CURRENT_TIMESTAMP from
      // DuckDB; the DB row has the precise value, callers using the
      // returned object only need a "right now" timestamp for the toast.
      fires.push({
        id: fireId,
        alertId: rule.id,
        firedAt: new Date(),
        ticker: rule.ticker,
        metric: rule.metric,
        observedValue: value,
        threshold: rule.threshold,
        message,
        acknowledged: false,
      });
    }
  }

  return fires;
}
