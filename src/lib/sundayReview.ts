// Sunday weekly-review markdown generator.
//
// Produces a pre-filled version of the canonical AAPL weekly-review template
// (`~/docs/finmarkets/aapl-weekly-review.md`). Computable fields — those
// derivable from market data alone — are auto-filled. Judgment fields (the
// tradeability gate, S/R levels, the decision section, calendar items, and
// the cognitive-integrity checks) are left as `______` placeholders so the
// human reviewer knows exactly what they still need to think about.
//
// Design constraints:
//   - Pure function. No DOM, no fetch, no Svelte runes. The component layer
//     owns reactivity and data loading; this file just transforms inputs to
//     a markdown string.
//   - Section ordering and headers MUST mirror the canonical template.
//     Tests assert on header text, so renames cascade.
//   - Auto-filled checkboxes use `[x]`; left-blank checkboxes use `[ ]`.
//
// "Why pre-fill at all": the template takes ~15 minutes to fill manually, and
// most of that time is mechanical lookup (price, MA values, RSI bucket).
// Pre-filling those fields lets the reviewer spend their 15 minutes on the
// judgment work that actually requires a human (decision, S/R reading,
// cognitive checks).

import type { WitnessSummary } from './witnesses';
import type { Candle, MaPoint } from './queries';
import type { RsiPoint, MacdPoint } from './indicators';
import type { Thresholds } from './math';
import { daysUntil } from './math';
import { detectRsiDivergence, type ClosePoint } from './indicators';

export interface ReviewInputs {
  ticker: string;
  reviewDate: Date; // when the review is being generated
  thresholds: Thresholds;
  taxDueDate: string | null; // ISO date or null
  candles: Candle[];
  sma20: MaPoint[];
  sma200: MaPoint[];
  volume: { time: number; value: number; color: string }[];
  rsi: RsiPoint[];
  macd: MacdPoint[];
  witnesses: WitnessSummary;
}

// How many bars back to compare against for "this week" change. 6 because
// the latest bar plus 5 trading days back ≈ a week's worth of price action.
const WEEK_LOOKBACK = 6;

// MA slope lookback in bars. Same value as `witnesses.ts` — keeps the
// "slope" verdict between the witness panel and the review consistent.
const MA_SLOPE_LOOKBACK = 5;

// Slope epsilon: anything within ±$0.01 over the lookback window is
// considered "flat". Matches the witness module's threshold so a witness
// that says "20-MA slope: up" lines up with what the review reports.
const SLOPE_EPSILON = 0.01;

// Volume comparison: this week (last 5 sessions) vs trailing 50-day avg.
const RECENT_VOLUME_WINDOW = 5;
const VOLUME_AVG_WINDOW = 50;

// Margin around the 50-day avg before we call this week "heavier" or
// "lighter". 10% gives some breathing room around natural week-to-week
// variance — a tighter threshold flips on noise.
const VOLUME_MARGIN_PCT = 0.10;

// Volume color codes from queries.ts — referenced here to count volume
// types for the heaviest-day classification.
const COLOR_GREEN = '#26a69a';

// MACD histogram expansion threshold. Below this absolute change between
// consecutive bars we call the histogram "flat" rather than expanding or
// contracting. Matches the spirit of the witness module.
const HISTOGRAM_FLAT_EPSILON = 0.001;

/**
 * Generate the pre-filled weekly-review markdown.
 *
 * The output mirrors the section ordering of the canonical template. Each
 * section is built by a focused helper so the structure is easy to audit
 * against the source doc.
 */
export function generateSundayReview(inputs: ReviewInputs): string {
  const sections: string[] = [];

  sections.push(banner(inputs));
  sections.push(redFlagWarning(inputs));
  sections.push(preflight());
  sections.push(reviewDateLine(inputs));
  sections.push(section1Tradeability());
  sections.push(section2TimePressure(inputs));
  sections.push(section3PriceSnapshot(inputs));
  sections.push(section4TrendMa(inputs));
  sections.push(section5SupportResistance());
  sections.push(section6Volume(inputs));
  sections.push(section7Indicators(inputs));
  sections.push(section8Witnesses(inputs));
  sections.push(section9Decision());
  sections.push(section10Calendar());
  sections.push(cognitiveIntegrity());
  sections.push(redFlagTriggers(inputs));
  sections.push(autoFillSummary(inputs));

  // Filter empty sections (e.g. red-flag warning when no flags fire) and
  // join with blank lines between blocks for readable markdown.
  return sections.filter((s) => s.length > 0).join('\n\n');
}

// ---------- banner & warnings ----------

function banner(inputs: ReviewInputs): string {
  const iso = isoDate(inputs.reviewDate);
  const ts = isoTimestamp(inputs.reviewDate);
  return [
    `# ${inputs.ticker} Weekly Review — Auto-Generated ${iso}`,
    ``,
    `This document was auto-generated from market data fetched on ${ts}.`,
    `Computed fields are pre-filled. Judgment fields (in \`______\` form) are for you to complete.`,
    `This is NOT a substitute for personal judgment. Read every section.`,
  ].join('\n');
}

/**
 * Top-of-document warning when a red-flag threshold has fired. Surfaced at
 * the top so a reviewer reading top-to-bottom can't miss it. The detail of
 * which flags fired lives in section "Red-flag triggers" later.
 */
function redFlagWarning(inputs: ReviewInputs): string {
  const flags = activeRedFlags(inputs);
  if (flags.length === 0) return '';
  return [
    `> ⚠️ **WARNING — red-flag triggers active:**`,
    ...flags.map((f) => `> - ${f}`),
    `>`,
    `> Re-read the relevant phase of \`aapl-monitoring-guide.md\` and act within the next valid trading window. Do not wait for Sunday.`,
  ].join('\n');
}

// ---------- pre-flight & date line ----------

function preflight(): string {
  // Pre-flight numbers are private to the user (vest price, share count,
  // exact tax bill). We deliberately don't auto-fill them even though we
  // have the thresholds — the review is a printable artifact and these
  // shouldn't end up in screenshots/exports.
  return [
    `---`,
    ``,
    `## Pre-flight (private numbers — fill in once, update if vest changes)`,
    ``,
    `- Vest-date FMV per share (\`Pv\`): $______`,
    `- Tax rate (\`T\`): ~0.45`,
    `- Total shares held (\`N\`): ______`,
    `- Tax bill (\`Tax = N × Pv × T\`): $______`,
    `- Tax due date (\`Ddue\`): ______ (typically Apr 15 next year)`,
    `- Tax-coverage price (\`Pcover = Pv × T\`): $______`,
    `- Tax-coverage + 20% buffer (\`Pcover+20% = Pv × T × 1.2\`): $______`,
    `- Personal upside target (\`Ptarget\`): $______`,
  ].join('\n');
}

function reviewDateLine(inputs: ReviewInputs): string {
  return [
    `---`,
    ``,
    `## Weekly Review — Date: ${isoDate(inputs.reviewDate)}`,
  ].join('\n');
}

// ---------- section 1: tradeability ----------

function section1Tradeability(): string {
  // All judgment — leave every checkbox blank.
  return [
    `### 1. Tradeability gate (30 seconds — do this FIRST)`,
    ``,
    `If you can't trade this week, the analysis below is theoretical. Check before`,
    `investing 15 minutes:`,
    ``,
    `- [ ] Currently inside issuer trading blackout window? If yes → skip to section 10 (calendar items only).`,
    `- [ ] Earnings within next 30 days? Date: ______ (note: blackout starts ~2 weeks before)`,
    `- [ ] Any 10b5-1 plan currently active? [ ] yes  [ ] no`,
    `- [ ] Any insider designation that requires pre-clearance? [ ] yes  [ ] no`,
  ].join('\n');
}

// ---------- section 2: time-pressure ----------

function section2TimePressure(inputs: ReviewInputs): string {
  const days = inputs.taxDueDate ? daysUntil(inputs.taxDueDate) : NaN;
  const daysStr = Number.isFinite(days) ? `${days}` : '______';

  // Auto-check the right bucket based on the day count. Buckets are
  // inclusive on the upper bound (per the template's "<30 days" / "30-90"
  // /"90-180" / ">180" wording).
  const hasDays = Number.isFinite(days);
  const b180Plus = hasDays && days > 180;
  const b90To180 = hasDays && days > 90 && days <= 180;
  const b30To90 = hasDays && days > 30 && days <= 90;
  const bUnder30 = hasDays && days <= 30;

  return [
    `---`,
    ``,
    `### 2. Time-pressure check (10 seconds)`,
    ``,
    `- Days until tax due: ${daysStr}`,
    `- Bucket: ${cb(b180Plus)} >180 days   ${cb(b90To180)} 90–180 days   ${cb(b30To90)} 30–90 days   ${cb(bUnder30)} <30 days`,
    ``,
    `> **Rule:** As days decrease, your tolerance for ambiguity decreases. Below 90 days,`,
    `> "wait and see" stops being a valid posture.`,
  ].join('\n');
}

// ---------- section 3: price snapshot ----------

function section3PriceSnapshot(inputs: ReviewInputs): string {
  const latest = lastOrNull(inputs.candles);
  const closeStr = latest ? fmtUsd(latest.close) : '$______';

  // Week change: latest close vs the close from `WEEK_LOOKBACK` bars back.
  // If we don't have that much history, leave it blank rather than print
  // a misleading partial-week number.
  let weekChangeStr = '______';
  if (latest && inputs.candles.length >= WEEK_LOOKBACK) {
    const ref = inputs.candles[inputs.candles.length - WEEK_LOOKBACK].close;
    if (ref > 0) {
      const pct = ((latest.close - ref) / ref) * 100;
      weekChangeStr = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}`;
    }
  }

  const distPcoverStr = latest
    ? fmtSignedUsd(latest.close - inputs.thresholds.pcover)
    : '$______';
  const distPcover20Str = latest
    ? fmtSignedUsd(latest.close - inputs.thresholds.pcoverPlus20)
    : '$______';

  // Status flag auto-checks. We can't auto-check the Ptarget flag because
  // Ptarget isn't in the threshold inputs — leave it blank.
  const close = latest?.close ?? null;
  const above20 = close !== null && close >= inputs.thresholds.pcoverPlus20;
  const belowPlus20AndAbovePcover =
    close !== null &&
    close < inputs.thresholds.pcoverPlus20 &&
    close >= inputs.thresholds.pcover;
  const belowPcover = close !== null && close < inputs.thresholds.pcover;

  return [
    `---`,
    ``,
    `### 3. Price snapshot (1 minute)`,
    ``,
    `- ${inputs.ticker} close (Friday): ${closeStr}`,
    `- Week change: ${weekChangeStr}%`,
    `- Distance from \`Pcover\`: ${distPcoverStr} (positive = cushion / negative = underwater)`,
    `- Distance from \`Pcover+20%\`: ${distPcover20Str}`,
    ``,
    `**Status flags:**`,
    `- ${cb(above20)} Above \`Pcover+20%\` — comfortable`,
    `- ${cb(belowPlus20AndAbovePcover)} Below \`Pcover+20%\` — execute sell-to-cover within 1–3 sessions (subject to blackout)`,
    `- ${cb(belowPcover)} Below \`Pcover\` — emergency, sell ALL remaining shares within next valid trading window`,
    `- [ ] Above \`Ptarget\` — windfall zone, consider scaled exits`,
  ].join('\n');
}

// ---------- section 4: trend & MA ----------

function section4TrendMa(inputs: ReviewInputs): string {
  const close = lastOrNull(inputs.candles)?.close ?? null;
  const ma20 = lastOrNull(inputs.sma20)?.value ?? null;
  const ma200 = lastOrNull(inputs.sma200)?.value ?? null;

  const slope20 = maSlope(inputs.sma20);
  const slope200 = maSlope(inputs.sma200);

  // Slope checkboxes
  const slope20Up = isUp(slope20);
  const slope20Flat = isFlat(slope20);
  const slope20Down = isDown(slope20);
  const slope200Up = isUp(slope200);
  const slope200Flat = isFlat(slope200);
  const slope200Down = isDown(slope200);

  // Price vs MA. We use strict above/below — if they're equal to the
  // cent (extremely rare), no box is checked.
  const priceAbove20 = close !== null && ma20 !== null && close > ma20;
  const priceBelow20 = close !== null && ma20 !== null && close < ma20;
  const priceAbove200 = close !== null && ma200 !== null && close > ma200;
  const priceBelow200 = close !== null && ma200 !== null && close < ma200;

  // 20 above/below 200
  const ma20Above200 = ma20 !== null && ma200 !== null && ma20 > ma200;
  const ma20Below200 = ma20 !== null && ma200 !== null && ma20 < ma200;
  const maConverging = ma20 !== null && ma200 !== null && Math.abs(ma20 - ma200) < 0.01;

  // Trend bucket — sourced from the witness verdict so the document is
  // internally consistent. The "transitioning" bucket requires human
  // judgment about *what* changed, so we don't auto-check it.
  const trendVerdict = inputs.witnesses.trend.verdict;
  const bucketBullish = trendVerdict === 'bullish';
  const bucketBearish = trendVerdict === 'bearish';
  const bucketNeutral = trendVerdict === 'neutral';

  return [
    `---`,
    ``,
    `### 4. Trend & MA check (2 minutes — Investing.com)`,
    ``,
    `- 20-day MA value: ${ma20 !== null ? fmtUsd(ma20) : '$______'} — slope: ${cb(slope20Up)} up  ${cb(slope20Flat)} flat  ${cb(slope20Down)} down`,
    `- 200-day MA value: ${ma200 !== null ? fmtUsd(ma200) : '$______'} — slope: ${cb(slope200Up)} up  ${cb(slope200Flat)} flat  ${cb(slope200Down)} down`,
    `- Price vs. 20-MA: ${cb(priceAbove20)} above  [ ] at  ${cb(priceBelow20)} below`,
    `- Price vs. 200-MA: ${cb(priceAbove200)} above  [ ] at  ${cb(priceBelow200)} below`,
    `- 20-MA vs. 200-MA: ${cb(ma20Above200)} 20 above 200 (short-term bullish)  ${cb(ma20Below200)} 20 below 200 (short-term bearish)  ${cb(maConverging)} neither/converging`,
    `- (True 50/200 "golden cross" or "death cross" status, if shown by your platform): [ ] golden  [ ] death  [ ] neither`,
    ``,
    `**Trend bucket this week:**`,
    `- ${cb(bucketBullish)} Bullish (price above both, both rising)`,
    `- ${cb(bucketNeutral)} Neutral (chop between MAs)`,
    `- ${cb(bucketBearish)} Bearish (price below both, both falling)`,
    `- [ ] Transitioning (something just changed — note what: _____________)`,
  ].join('\n');
}

// ---------- section 5: support & resistance ----------

function section5SupportResistance(): string {
  // S/R auto-detection (swing-point finding) is out of scope for v1. We
  // surface a note so a reader knows this isn't a missing feature, just an
  // intentional deferral.
  return [
    `---`,
    ``,
    `### 5. Support & resistance check (2 minutes)`,
    ``,
    `*(auto-detection out of scope for v1; check chart manually)*`,
    ``,
    `- Nearest resistance above: $______ (level: _____________)`,
    `- Nearest support below: $______ (level: _____________)`,
    `- Did price test any S/R level this week? If yes:`,
    `  - Level tested: $______`,
    `  - Outcome: [ ] held  [ ] broke  [ ] inconclusive`,
    ``,
    `**Personal alert levels — still set?** (re-check on Investing.com)`,
    `- [ ] $______ alert active`,
    `- [ ] $______ alert active`,
    `- [ ] $______ alert active`,
  ].join('\n');
}

// ---------- section 6: volume ----------

function section6Volume(inputs: ReviewInputs): string {
  // Compare last week's avg daily volume to the trailing 50-day avg.
  let weekHeavier = false;
  let weekNormal = false;
  let weekLighter = false;
  if (inputs.volume.length >= VOLUME_AVG_WINDOW) {
    const recent = inputs.volume.slice(-RECENT_VOLUME_WINDOW);
    const trailing = inputs.volume.slice(-VOLUME_AVG_WINDOW);
    const recentAvg = avg(recent.map((v) => v.value));
    const trailingAvg = avg(trailing.map((v) => v.value));
    const ratio = trailingAvg > 0 ? recentAvg / trailingAvg : 1;
    weekHeavier = ratio > 1 + VOLUME_MARGIN_PCT;
    weekLighter = ratio < 1 - VOLUME_MARGIN_PCT;
    weekNormal = !weekHeavier && !weekLighter;
  }

  // Heaviest day in the last 5 sessions and its color (green = up, red =
  // down). We use the color field rather than reading candles because
  // queries.ts already encoded the up/down classification there.
  let heaviestGreen = false;
  let heaviestRed = false;
  if (inputs.volume.length > 0) {
    const recent = inputs.volume.slice(-RECENT_VOLUME_WINDOW);
    const heaviest = recent.reduce((max, v) => (v.value > max.value ? v : max), recent[0]);
    heaviestGreen = heaviest.color === COLOR_GREEN;
    heaviestRed = !heaviestGreen;
  }

  // Volume bucket from the witness verdict — same internal-consistency
  // rationale as the trend bucket. Climactic-spike detection requires a
  // 3x+ threshold check we don't currently expose; leave it blank.
  const volVerdict = inputs.witnesses.volume.verdict;
  const accumulation = volVerdict === 'bullish';
  const distribution = volVerdict === 'bearish';
  const quiet = volVerdict === 'neutral';

  return [
    `---`,
    ``,
    `### 6. Volume check (3 minutes)`,
    ``,
    `- This week's average daily volume vs. 50-day average: ${cb(weekHeavier)} heavier  ${cb(weekNormal)} normal  ${cb(weekLighter)} lighter`,
    `- Color of the heaviest volume day: ${cb(heaviestGreen)} green  ${cb(heaviestRed)} red`,
    `- On any rally days this week: was volume rising or falling? ______`,
    `- On any decline days this week: was volume rising or falling? ______`,
    ``,
    `**Volume signal bucket:**`,
    `- ${cb(accumulation)} Accumulation (rising vol on green, falling on red)`,
    `- ${cb(distribution)} Distribution (rising vol on red, falling on green)  ⚠️ early warning`,
    `- [ ] Climactic spike (3×+ avg) — note direction: _____________`,
    `- ${cb(quiet)} Quiet / no signal`,
  ].join('\n');
}

// ---------- section 7: indicators ----------

function section7Indicators(inputs: ReviewInputs): string {
  // RSI
  const rsiLast = lastOrNull(inputs.rsi);
  const rsiVal = rsiLast?.value ?? null;
  const rsiStr = rsiVal !== null ? rsiVal.toFixed(0) : '______';

  const rsiOver70 = rsiVal !== null && rsiVal > 70;
  const rsi50to70 = rsiVal !== null && rsiVal >= 50 && rsiVal <= 70;
  const rsi30to50 = rsiVal !== null && rsiVal >= 30 && rsiVal < 50;
  const rsiUnder30 = rsiVal !== null && rsiVal < 30;

  // RSI direction over a 3-bar window — same definition as the witness
  // module so the document doesn't say "rising" while the witness panel
  // says "falling".
  let rsiRising = false;
  let rsiFlat = false;
  let rsiFalling = false;
  if (inputs.rsi.length >= 3) {
    const now = inputs.rsi[inputs.rsi.length - 1].value;
    const prev = inputs.rsi[inputs.rsi.length - 3].value;
    rsiRising = now > prev;
    rsiFalling = now < prev;
    rsiFlat = !rsiRising && !rsiFalling;
  } else if (inputs.rsi.length > 0) {
    rsiFlat = true;
  }

  // RSI/price divergence. Reuses `detectRsiDivergence` from indicators.ts,
  // which needs ClosePoint[]; derive it from candles.
  const closes: ClosePoint[] = inputs.candles.map((c) => ({ time: c.time, close: c.close }));
  const div =
    inputs.rsi.length > 0 && closes.length > 0
      ? detectRsiDivergence(inputs.rsi, closes)
      : { bearish: false, bullish: false, description: '' };

  // MACD
  const macdLast = lastOrNull(inputs.macd);
  const macdPrev = inputs.macd.length >= 2 ? inputs.macd[inputs.macd.length - 2] : null;

  const macdAboveZero = macdLast !== null && macdLast.macd > 0;
  const macdBelowZero = macdLast !== null && macdLast.macd < 0;

  const macdAboveSignal = macdLast !== null && macdLast.macd > macdLast.signal;
  const macdBelowSignal = macdLast !== null && macdLast.macd < macdLast.signal;

  // Histogram direction — compare absolute magnitudes of the last two
  // bars when they share a sign; flat when they differ in sign or the
  // change is below epsilon.
  let histExpanding = false;
  let histFlat = false;
  let histContracting = false;
  if (macdLast && macdPrev) {
    const sameSign = Math.sign(macdLast.histogram) === Math.sign(macdPrev.histogram);
    const delta = Math.abs(macdLast.histogram) - Math.abs(macdPrev.histogram);
    if (!sameSign || Math.abs(delta) < HISTOGRAM_FLAT_EPSILON) {
      histFlat = true;
    } else if (delta > 0) {
      histExpanding = true;
    } else {
      histContracting = true;
    }
  }

  // Crossover this week: did the MACD line cross above/below the signal
  // line between any two consecutive bars in the last 5 sessions?
  let bullishCross = false;
  let bearishCross = false;
  if (inputs.macd.length >= 2) {
    const window = inputs.macd.slice(-RECENT_VOLUME_WINDOW - 1); // need one extra bar to detect transition
    for (let i = 1; i < window.length; i++) {
      const prev = window[i - 1];
      const curr = window[i];
      const prevDiff = prev.macd - prev.signal;
      const currDiff = curr.macd - curr.signal;
      if (prevDiff <= 0 && currDiff > 0) bullishCross = true;
      if (prevDiff >= 0 && currDiff < 0) bearishCross = true;
    }
  }
  const noCross = !bullishCross && !bearishCross;

  return [
    `---`,
    ``,
    `### 7. Indicator check (3 minutes — Investing.com)`,
    ``,
    `**RSI(14):**`,
    `- Current value: ${rsiStr}`,
    `- Bucket: ${cb(rsiOver70)} >70 (overbought)  ${cb(rsi50to70)} 50–70 (bullish)  ${cb(rsi30to50)} 30–50 (bearish)  ${cb(rsiUnder30)} <30 (oversold)`,
    `- Direction this week: ${cb(rsiRising)} rising  ${cb(rsiFlat)} flat  ${cb(rsiFalling)} falling`,
    `- Bearish divergence visible (price higher, RSI lower)? ${cb(div.bearish)} yes  ${cb(!div.bearish && (inputs.rsi.length > 0))} no`,
    `- Bullish divergence visible (price lower, RSI higher)? ${cb(div.bullish)} yes  ${cb(!div.bullish && (inputs.rsi.length > 0))} no`,
    ``,
    `**MACD(12,26,9):**`,
    `- MACD line vs. zero: ${cb(macdAboveZero)} above  ${cb(macdBelowZero)} below`,
    `- MACD line vs. signal line: ${cb(macdAboveSignal)} above (bullish)  ${cb(macdBelowSignal)} below (bearish)`,
    `- Histogram: ${cb(histExpanding)} expanding  ${cb(histFlat)} flat  ${cb(histContracting)} contracting`,
    `- Crossover this week? ${cb(bullishCross)} bullish cross  ${cb(bearishCross)} bearish cross  ${cb(noCross)} none`,
  ].join('\n');
}

// ---------- section 8: three-witness summary ----------

function section8Witnesses(inputs: ReviewInputs): string {
  const w = inputs.witnesses;
  const trendBear = w.trend.verdict === 'bearish';
  const trendBull = w.trend.verdict === 'bullish';
  const volBear = w.volume.verdict === 'bearish';
  const volBull = w.volume.verdict === 'bullish';
  const indBear = w.indicators.verdict === 'bearish';
  const indBull = w.indicators.verdict === 'bullish';

  // Conviction tally: auto-check the bucket that matches the summary.
  const conv = w.conviction;
  const c3Bear = conv === 'high-bearish';
  const c2Bear = conv === 'moderate-bearish';
  const cMixed = conv === 'neutral';
  const c2Bull = conv === 'moderate-bullish';
  const c3Bull = conv === 'high-bullish';

  // Markdown table cell checkbox: just `[x]` or `[ ]` — no leading dash,
  // because we're inside a table.
  const cell = (checked: boolean) => (checked ? '[x]' : '[ ]');

  return [
    `---`,
    ``,
    `### 8. Three-witness summary`,
    ``,
    `Tally the bearish vs. bullish witnesses from sections 4, 6, and 7:`,
    ``,
    `|  | Bearish | Bullish |`,
    `|---|---------|---------|`,
    `| Trend (price vs. MAs, from §4) | ${cell(trendBear)} | ${cell(trendBull)} |`,
    `| Volume (distribution vs. accumulation, from §6) | ${cell(volBear)} | ${cell(volBull)} |`,
    `| Indicators (RSI + MACD net read, from §7 — see tiebreak rule below) | ${cell(indBear)} | ${cell(indBull)} |`,
    ``,
    `**RSI + MACD net read — tiebreak rule:**`,
    `- If both agree → use that direction`,
    `- If they disagree → weight MACD (the trend-following indicator) over RSI (the`,
    `  momentum oscillator); MACD line above zero counts as bullish, below zero as bearish`,
    `- If a section produced no signal this week → count as neutral (don't tally)`,
    ``,
    `**Conviction this week:**`,
    `- ${cb(c3Bear)} 3 bearish witnesses → high-conviction bearish, review exit plan`,
    `- ${cb(c2Bear)} 2 bearish, 1 bullish → moderate bearish, consider partial trim if near \`Pcover+20%\``,
    `- ${cb(cMixed)} 1 of each + 1 mixed → no conviction, hold and wait`,
    `- ${cb(c2Bull)} 2 bullish, 1 bearish → moderate bullish, hold; raise scaling sell levels if appropriate`,
    `- ${cb(c3Bull)} 3 bullish witnesses → high-conviction bullish, hold; consider raising trailing stop`,
  ].join('\n');
}

// ---------- section 9: decision ----------

function section9Decision(): string {
  // Pure judgment — leave everything blank.
  return [
    `---`,
    ``,
    `### 9. Decision (2 minutes)`,
    ``,
    `Based on the above, my action this week is:`,
    ``,
    `- [ ] **No action** — hold, monitor next week`,
    `- [ ] **Set new alerts** — at: $______, $______`,
    `- [ ] **Place limit sell order** — for ______ shares at $______`,
    `- [ ] **Execute sell-to-cover** — sell ______ shares at market within next valid window`,
    `- [ ] **Execute full exit** — sell all remaining shares within next valid window`,
    `- [ ] **Consult CPA / advisor** — about: _____________`,
    ``,
    `**Reasoning (one sentence):** _____________`,
  ].join('\n');
}

// ---------- section 10: calendar ----------

function section10Calendar(): string {
  return [
    `---`,
    ``,
    `### 10. Calendar items for the week ahead`,
    ``,
    `- [ ] Daily 60-second check (M–F end-of-day)`,
    `- [ ] Earnings date if approaching: ______`,
    `- [ ] Tax filing milestone if approaching: ______`,
    `- [ ] Advisor / CPA appointment scheduled: [ ] yes  [ ] no`,
    `- [ ] Next weekly review date: ______`,
  ].join('\n');
}

// ---------- cognitive integrity ----------

function cognitiveIntegrity(): string {
  return [
    `---`,
    ``,
    `## Cognitive integrity checks`,
    ``,
    `Before closing this review, answer honestly:`,
    ``,
    `1. **Am I letting hope drive a "hold" decision?** [ ] yes  [ ] no — if yes, force a written justification using the framework above.`,
    `2. **Am I anchoring to the recent high or to my vest price?** [ ] yes  [ ] no — if yes, ignore both; only the forward distribution matters.`,
    `3. **If ${'AAPL'} dropped 30% on Monday's open, would my plan still be viable?** [ ] yes  [ ] no — if no, I'm underhedged and need to act this week.`,
    `4. **Have I confirmed I'm not in a blackout window?** [ ] yes  [ ] no — if no, do this before any action.`,
  ].join('\n');
}

// ---------- red-flag triggers section ----------

function redFlagTriggers(inputs: ReviewInputs): string {
  const flags = activeRedFlags(inputs);
  const anyActive = flags.length > 0;
  const noneActive = !anyActive;

  return [
    `---`,
    ``,
    `## Red-flag triggers (skip the weekly cadence and act NOW if any of these occur)`,
    ``,
    `- Daily close below \`Pcover+20%\``,
    `- Daily close below $20.00 with rising red volume`,
    `- Material company news (CEO change, restated earnings, acquisition, fraud allegation)`,
    `- Major sector dislocation (CCaaS peers down 15%+ in a week)`,
    `- Personal liquidity event (sudden cash need that changes your tax-payment posture)`,
    ``,
    `**Are any active right now?** ${cb(anyActive)} yes  ${cb(noneActive)} no`,
    ...(anyActive
      ? [``, ...flags.map((f) => `- ⚠️ ${f}`)]
      : []),
    ``,
    `If any of these → re-read the relevant phase of \`aapl-monitoring-guide.md\` and act`,
    `within the next valid trading window. Do not wait for Sunday.`,
  ].join('\n');
}

// ---------- auto-fill summary footer ----------

function autoFillSummary(inputs: ReviewInputs): string {
  const ts = isoTimestamp(inputs.reviewDate);
  const latest = lastOrNull(inputs.candles);
  const latestDate = latest ? isoDate(new Date(latest.time * 1000)) : '—';

  return [
    `---`,
    ``,
    `## Auto-fill summary`,
    ``,
    `Generated at: ${ts}`,
    `Data freshness: latest bar dated ${latestDate}, fetched ${ts}`,
    `Witnesses: ${inputs.witnesses.convictionLabel}`,
    `Recommendation: ${inputs.witnesses.recommendation}`,
    ``,
    `Sections fully auto-filled: 2, 3, 4, 6, 7, 8 (computable fields)`,
    `Sections requiring judgment: 1, 5 (S/R levels), 9 (decision), 10 (calendar), cognitive integrity`,
    ``,
    `Take ~15 minutes to complete the blank fields before acting on this review.`,
  ].join('\n');
}

// ---------- helpers ----------

/**
 * Identify any red-flag conditions currently in effect. Used both for the
 * top-of-document warning banner and the in-section "are any active?"
 * tally. Pure helper — no I/O. The `Pcover+20%` flag fires on any close
 * below that threshold; the $20 flag also requires the latest bar to be
 * red AND volume to be above the trailing-20 average (the "rising red
 * volume" qualifier from the canonical template).
 */
function activeRedFlags(inputs: ReviewInputs): string[] {
  const flags: string[] = [];
  const latest = lastOrNull(inputs.candles);
  if (!latest) return flags;

  if (latest.close < inputs.thresholds.pcoverPlus20) {
    flags.push(
      `Daily close ${fmtUsd(latest.close)} below Pcover+20% (${fmtUsd(inputs.thresholds.pcoverPlus20)})`,
    );
  }

  if (latest.close < 20 && latest.close < latest.open) {
    // Check that latest volume is above the trailing-20 average; if we
    // can't tell (insufficient history), flag conservatively on price
    // alone rather than miss a real warning.
    const recent = inputs.volume.slice(-20);
    const lastVol = inputs.volume[inputs.volume.length - 1]?.value;
    const avgVol = recent.length > 0 ? avg(recent.map((v) => v.value)) : NaN;
    if (!Number.isFinite(avgVol) || (typeof lastVol === 'number' && lastVol > avgVol)) {
      flags.push(`Daily close ${fmtUsd(latest.close)} below $20.00 with elevated red volume`);
    }
  }

  return flags;
}

function maSlope<T extends { value: number }>(series: T[]): number {
  if (series.length < 2) return 0;
  const last = series[series.length - 1].value;
  const lookbackIdx = Math.max(0, series.length - 1 - MA_SLOPE_LOOKBACK);
  return last - series[lookbackIdx].value;
}

function isUp(slope: number): boolean {
  return slope > SLOPE_EPSILON;
}
function isDown(slope: number): boolean {
  return slope < -SLOPE_EPSILON;
}
function isFlat(slope: number): boolean {
  return !isUp(slope) && !isDown(slope);
}

function lastOrNull<T>(arr: T[]): T | null {
  return arr.length > 0 ? arr[arr.length - 1] : null;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function cb(checked: boolean): string {
  return checked ? '[x]' : '[ ]';
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function fmtSignedUsd(v: number): string {
  // Always show sign so "+$0.00" vs "-$0.00" disambiguates the cushion
  // direction at a glance. Treat exact zero as "+" (touching the threshold
  // counts as on-or-above, matching the threshold semantics).
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function isoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function isoTimestamp(d: Date): string {
  // Drop milliseconds for readability; keep the trailing 'Z' so the
  // timestamp is unambiguous even when copied out of the document.
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
