<script lang="ts">
  // Per-position "Recent Earnings" widget rendered between WitnessPanel
  // and ChartPanel. Surfaces the 4 most recent earnings releases with
  // their EPS estimate / actual / surprise % — the data behind the
  // green/red/gray markers on the chart.
  //
  // Why a separate widget vs. hover tooltips on the chart markers:
  //   Lightweight Charts v5's marker plugin doesn't expose hover
  //   events; building a custom plugin for tooltip overlay was scoped
  //   out of this batch. The widget gives the user the per-event EPS
  //   detail in a stable, always-visible table — same information,
  //   different UX. See the chart's markers + this table together.

  import { settings, getActivePosition } from '../lib/settings.svelte';
  import { getEval } from '../lib/evaluation.svelte';

  // Same activePosition derivation as the other per-ticker widgets —
  // touch settings.activePositionId + positions.length so the derived
  // re-runs on tab switches and position list edits.
  const activePosition = $derived.by(() => {
    settings.activePositionId;
    settings.positions.length;
    return getActivePosition();
  });

  const slice = $derived(activePosition ? getEval(activePosition.ticker) : null);

  // Most-recent 4 events. Sorted descending by time so newest sits at
  // the top — the natural reading order for "what just happened?".
  // Slice (not splice) so we don't mutate the underlying reactive array.
  const recentEarnings = $derived.by(() => {
    if (!slice || slice.earnings.length === 0) return [];
    return [...slice.earnings].sort((a, b) => b.time - a.time).slice(0, 4);
  });

  function fmtEps(v: number | null): string {
    if (v == null) return '—';
    return `$${v.toFixed(2)}`;
  }

  function fmtSurprise(v: number | null): { label: string; tone: string } {
    if (v == null) return { label: '—', tone: 'muted' };
    const sign = v > 0 ? '+' : '';
    return {
      label: `${sign}${v.toFixed(1)}%`,
      tone: v > 0 ? 'good' : v < 0 ? 'bad' : 'muted',
    };
  }
</script>

{#if activePosition && recentEarnings.length > 0}
  <section class="earnings-widget">
    <header class="panel-header">
      <h2>Recent Earnings</h2>
      <span class="muted">Last {recentEarnings.length} releases</span>
    </header>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Time</th>
            <th scope="col" class="num">Estimate</th>
            <th scope="col" class="num">Actual</th>
            <th scope="col" class="num">Surprise</th>
          </tr>
        </thead>
        <tbody>
          {#each recentEarnings as e (e.dt)}
            {@const surprise = fmtSurprise(e.surprisePct)}
            <tr>
              <td class="dt">{e.dt}</td>
              <td>{e.timeOfDay ?? '—'}</td>
              <td class="num">{fmtEps(e.epsEstimate)}</td>
              <td class="num">{fmtEps(e.epsActual)}</td>
              <td class="num" data-tone={surprise.tone}>{surprise.label}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
{/if}

<style>
  /* Mirrors the WitnessPanel chrome (dark surface, border, radius)
     so the visual rhythm above the chart stays consistent. */
  .earnings-widget {
    display: flex;
    flex-direction: column;
    gap: var(--gap);
    padding: var(--gap-lg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: 14px;
    text-align: left;
  }

  .panel-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  h2 {
    margin: 0;
    font-size: 18px;
    color: var(--text);
  }

  .muted {
    font-size: 12px;
    color: var(--muted);
  }

  .table-wrap {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }

  th,
  td {
    padding: 8px 10px;
    text-align: left;
    border-bottom: 1px solid #2a2c35;
  }

  thead th {
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
  }

  tbody tr:last-child td {
    border-bottom: none;
  }

  .num {
    text-align: right;
    font-family: var(--mono, ui-monospace, Consolas, monospace);
  }

  .dt {
    font-family: var(--mono, ui-monospace, Consolas, monospace);
    color: var(--text);
  }

  /* Surprise % colour — same palette as the chart markers so the user
     can scan from chart marker to widget row without learning two
     colour systems (review pattern from witness conviction box). */
  td[data-tone='good'] {
    color: var(--bull, #22c55e);
    font-weight: 600;
  }

  td[data-tone='bad'] {
    color: var(--bear, #ef5350);
    font-weight: 600;
  }

  td[data-tone='muted'] {
    color: var(--muted, #9ca3af);
  }
</style>
