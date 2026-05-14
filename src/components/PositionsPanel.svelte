<script lang="ts">
  // Phase A: positions manager. Replaces the old single-position
  // SettingsPanel. Holds the API key (still single — one Twelve Data
  // account) plus a list of positions with add/edit/delete.
  //
  // Validation lives in `lib/settings.svelte.ts::validatePosition` so
  // tests can exercise it without the DOM.

  import {
    settings,
    save,
    addPosition,
    updatePosition,
    removePosition,
    validatePosition,
    type Position,
    type ValidationError,
  } from '../lib/settings.svelte';
  import { formatUsd } from '../lib/math';

  let showApiKey = $state(false);

  // editingId: string when editing an existing position, '__new__' when
  // adding, null when no form is open.
  let editingId = $state<string | null>(null);
  const NEW_ROW = '__new__';

  // Working-copy fields for the inline form. Bound to the inputs; when
  // Save fires we validate then commit via add/updatePosition.
  let formTicker = $state('');
  let formVestPrice = $state(0);
  let formShares = $state(0);
  let formTaxRate = $state(0.45);
  let formTaxDueDate = $state('');
  let formErrors = $state<ValidationError[]>([]);
  // Whether the optional tax-tracking subsection is expanded. Auto-opens
  // when editing a position that already has tax fields populated.
  let taxOpen = $state(false);

  // Auto-collapse when at least one position exists; if empty the panel
  // stays open so first-time users can see the "Add Position" button
  // immediately. Mirrors the old SettingsPanel behavior — we snapshot
  // once at mount so editing settings doesn't re-collapse the panel.
  const initiallyConfigured = settings.positions.length > 0;
  let open = $state(!initiallyConfigured);

  // Persist API-key changes — the position mutations already call save()
  // themselves, but the API key is bound directly with `bind:value` and
  // needs an effect to capture changes.
  $effect(() => {
    settings.apiKey;
    save();
  });

  function startAdd(): void {
    formTicker = '';
    formVestPrice = 0;
    formShares = 0;
    formTaxRate = 0.45;
    formTaxDueDate = '';
    formErrors = [];
    taxOpen = false;
    editingId = NEW_ROW;
  }

  function startEdit(p: Position): void {
    formTicker = p.ticker;
    formVestPrice = p.vestPrice;
    formShares = p.shares;
    formTaxRate = p.taxRate;
    formTaxDueDate = p.taxDueDate;
    formErrors = [];
    // Auto-expand the optional section if the position already has any
    // tax fields populated, so the user can see what they entered.
    taxOpen = p.vestPrice > 0 || p.shares > 0 || p.taxDueDate !== '';
    editingId = p.id;
  }

  function cancelEdit(): void {
    editingId = null;
    formErrors = [];
  }

  function commitForm(): void {
    // Coerce numeric form fields with NaN-safe fallback. <input type=number>
    // and <input type=range> with bind:value can produce NaN if the field
    // was emptied, which would silently fail validation with "must be
    // finite" — fall back to 0 so the validation message is meaningful.
    const num = (v: unknown): number => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const candidate: Omit<Position, 'id'> = {
      ticker: formTicker.trim().toUpperCase(),
      vestPrice: num(formVestPrice),
      shares: num(formShares),
      taxRate: num(formTaxRate),
      taxDueDate: formTaxDueDate,
    };
    const errors = validatePosition(candidate);
    if (errors.length > 0) {
      formErrors = errors;
      // Auto-expand the tax section if any error is in those fields, so
      // the user can see the inline error message.
      if (errors.some((e) => e.field !== 'ticker')) {
        taxOpen = true;
      }
      return;
    }
    if (editingId === NEW_ROW) {
      addPosition(candidate);
    } else if (editingId) {
      updatePosition(editingId, candidate);
    }
    editingId = null;
    formErrors = [];
  }

  function onDelete(id: string, ticker: string): void {
    if (!confirm(`Remove position ${ticker}? This does not clear cached market data.`)) {
      return;
    }
    removePosition(id);
  }

  function errorFor(field: ValidationError['field']): string | null {
    return formErrors.find((e) => e.field === field)?.message ?? null;
  }

  function summaryLine(): string {
    const n = settings.positions.length;
    if (n === 0) return 'No positions yet — click to add one.';
    if (n === 1) return `1 position: ${settings.positions[0].ticker} — click to manage.`;
    const list = settings.positions.map((p) => p.ticker).join(', ');
    return `${n} positions: ${list} — click to manage.`;
  }
</script>

<details class="positions" bind:open>
  <summary class="positions-summary">
    <span class="summary-label">Positions:</span>
    <span class="summary-line">{summaryLine()}</span>
  </summary>

  <div class="positions-body">
    <fieldset>
      <legend>Twelve Data API</legend>

      <label>
        <span>API key</span>
        <span class="api-key">
          <input
            type={showApiKey ? 'text' : 'password'}
            bind:value={settings.apiKey}
            autocomplete="off"
            spellcheck="false"
          />
          <button type="button" onclick={() => (showApiKey = !showApiKey)}>
            {showApiKey ? 'Hide' : 'Show'}
          </button>
        </span>
      </label>

      <p class="hint">
        Get a free Twelve Data API key at
        <a href="https://twelvedata.com/" target="_blank" rel="noopener noreferrer"
          >twelvedata.com</a
        >
        (800 req/day on free tier).
      </p>
      <p class="hint warn">
        Stored locally in plaintext in this browser profile. Don't paste keys for
        shared accounts.
      </p>
    </fieldset>

    <fieldset>
      <legend>Positions</legend>

      {#if settings.positions.length === 0 && editingId !== NEW_ROW}
        <p class="empty">No positions yet. Click "Add Position" to start.</p>
      {/if}

      {#if settings.positions.length > 0}
        <table class="positions-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Vest</th>
              <th>Shares</th>
              <th>Tax</th>
              <th>Due</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each settings.positions as pos (pos.id)}
              <tr>
                <td class="mono">{pos.ticker}</td>
                <td class="mono">{pos.vestPrice > 0 ? formatUsd(pos.vestPrice) : '—'}</td>
                <td class="mono">{pos.shares > 0 ? pos.shares : '—'}</td>
                <td class="mono">{pos.taxRate > 0 ? `${(pos.taxRate * 100).toFixed(0)}%` : '—'}</td>
                <td class="mono">{pos.taxDueDate || '—'}</td>
                <td class="actions-cell">
                  <button type="button" class="ghost-sm" onclick={() => startEdit(pos)}>
                    Edit
                  </button>
                  <button type="button" class="ghost-sm danger" onclick={() => onDelete(pos.id, pos.ticker)}>
                    Delete
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      {#if editingId === null}
        <div class="add-row">
          <button type="button" onclick={startAdd}>+ Add Position</button>
        </div>
      {:else}
        <div class="form-card">
          <h3>{editingId === NEW_ROW ? 'New position' : 'Edit position'}</h3>

          <label>
            <span>Ticker <span class="req">*</span></span>
            <input
              type="text"
              bind:value={formTicker}
              placeholder="e.g. AAPL, AAPL, NVDA"
              autocomplete="off"
              maxlength="10"
            />
            {#if errorFor('ticker')}<span class="field-error">{errorFor('ticker')}</span>{/if}
          </label>

          <details class="tax-tracking" bind:open={taxOpen}>
            <summary>
              <span class="tax-toggle">Tax tracking (optional)</span>
              <span class="tax-hint">
                For RSU positions with a known tax overhang. Leave collapsed for
                generic equity monitoring.
              </span>
            </summary>

            <div class="tax-fields">
              <label>
                <span>Vest price (USD)</span>
                <input type="number" step="0.01" min="0" bind:value={formVestPrice} />
                {#if errorFor('vestPrice')}<span class="field-error">{errorFor('vestPrice')}</span>{/if}
              </label>

              <label>
                <span>Shares</span>
                <input type="number" step="any" min="0" bind:value={formShares} />
                {#if errorFor('shares')}<span class="field-error">{errorFor('shares')}</span>{/if}
              </label>

              <label>
                <span>Tax rate ({(formTaxRate * 100).toFixed(1)}%)</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.005"
                  bind:value={formTaxRate}
                />
                {#if errorFor('taxRate')}<span class="field-error">{errorFor('taxRate')}</span>{/if}
              </label>

              <label>
                <span>Tax due date</span>
                <input type="date" bind:value={formTaxDueDate} />
                {#if errorFor('taxDueDate')}<span class="field-error">{errorFor('taxDueDate')}</span>{/if}
              </label>
            </div>
          </details>

          <div class="form-actions">
            <button type="button" onclick={commitForm}>Save</button>
            <button type="button" class="ghost" onclick={cancelEdit}>Cancel</button>
          </div>
        </div>
      {/if}
    </fieldset>
  </div>
</details>

<style>
  .positions {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: 14px;
    text-align: left;
    overflow: hidden;
  }

  .positions-summary {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 14px 20px;
    cursor: pointer;
    font-size: 14px;
    list-style: none;
    user-select: none;
  }

  .positions-summary::-webkit-details-marker {
    display: none;
  }

  .positions-summary::before {
    content: '▸';
    color: var(--muted);
    font-size: 11px;
    transition: transform 0.15s ease;
    display: inline-block;
  }

  .positions[open] > .positions-summary::before {
    transform: rotate(90deg);
  }

  .positions-summary:hover {
    background: rgba(255, 255, 255, 0.02);
  }

  .summary-label {
    color: var(--text);
    font-weight: 600;
    font-size: 16px;
  }

  .summary-line {
    color: var(--muted);
    font-size: 13px;
  }

  .positions-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 0 20px 20px;
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }

  fieldset {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 16px 16px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  legend {
    padding: 0 6px;
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  label {
    display: grid;
    grid-template-columns: 160px 1fr;
    align-items: center;
    gap: 12px;
  }

  label > span:first-child {
    color: var(--muted);
  }

  .field-error {
    grid-column: 2 / -1;
    color: #fca5a5;
    font-size: 12px;
  }

  input[type='text'],
  input[type='number'],
  input[type='password'],
  input[type='date'] {
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    color: var(--text);
    font-family: inherit;
    font-size: 14px;
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
  }

  input[type='range'] {
    width: 100%;
  }

  .api-key {
    display: flex;
    gap: 8px;
  }

  .api-key input {
    flex: 1;
  }

  button {
    background: #2563eb;
    color: var(--text);
    border: 1px solid #1d4ed8;
    border-radius: var(--radius-sm);
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: background 0.12s ease;
  }

  button:hover:not(:disabled) {
    background: #1d4ed8;
  }

  button.ghost {
    background: var(--border);
    border-color: var(--border-strong);
    color: var(--text);
    font-weight: 400;
  }

  button.ghost:hover {
    background: var(--border-strong);
  }

  button.ghost-sm {
    background: var(--border);
    border: 1px solid var(--border-strong);
    color: var(--text);
    padding: 4px 8px;
    font-size: 12px;
    font-weight: 400;
  }

  button.ghost-sm:hover {
    background: var(--border-strong);
  }

  button.ghost-sm.danger {
    color: #fca5a5;
  }

  button.ghost-sm.danger:hover {
    background: rgba(239, 68, 68, 0.15);
    border-color: rgba(239, 68, 68, 0.4);
  }

  .empty {
    color: var(--muted);
    font-size: 13px;
    margin: 0;
    padding: 8px 0;
    text-align: center;
  }

  .positions-table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }

  .positions-table th {
    text-align: left;
    color: var(--muted);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
  }

  .positions-table td {
    padding: 8px;
    border-bottom: 1px solid #2a2c35;
    color: var(--text);
    font-size: 13px;
  }

  .positions-table tr:last-child td {
    border-bottom: none;
  }

  .mono {
    font-family: var(--mono);
  }

  .actions-cell {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }

  .add-row {
    display: flex;
    justify-content: flex-start;
    margin-top: 4px;
  }

  .form-card {
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 4px;
  }

  .form-card h3 {
    margin: 0 0 4px;
    font-size: 13px;
    color: var(--text);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }

  .form-actions {
    display: flex;
    gap: 8px;
    margin-top: 6px;
  }

  /* Required-field marker on the ticker label. */
  .req {
    color: #fca5a5;
    margin-left: 2px;
  }

  /* Optional tax-tracking subsection: collapsed by default, expandable
     for users who want the Pcover/exit-framework features. Designed to
     feel secondary so generic equity monitoring is the primary path. */
  .tax-tracking {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0;
    background: rgba(0, 0, 0, 0.15);
  }

  .tax-tracking > summary {
    padding: 8px 12px;
    cursor: pointer;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    user-select: none;
  }

  .tax-tracking > summary::-webkit-details-marker {
    display: none;
  }

  .tax-tracking > summary::before {
    content: '▸';
    color: var(--muted);
    font-size: 10px;
    margin-right: 6px;
    display: inline-block;
    transition: transform 0.15s ease;
  }

  .tax-tracking[open] > summary::before {
    transform: rotate(90deg);
  }

  .tax-tracking > summary:hover {
    background: rgba(255, 255, 255, 0.02);
  }

  .tax-toggle {
    color: var(--text);
    font-weight: 500;
    font-size: 13px;
  }

  .tax-hint {
    color: var(--muted);
    font-size: 11px;
    margin-left: 16px;
  }

  .tax-fields {
    padding: 10px 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    border-top: 1px solid var(--border);
  }

  .hint {
    grid-column: 1 / -1;
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--muted);
  }

  .hint a {
    color: var(--link);
  }

  .hint.warn {
    color: #fde68a;
  }
</style>
