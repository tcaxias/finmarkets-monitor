// Reactive runtime flags shared across UI components.
// Lives in its own module to avoid circular imports between duckdb.ts and
// any consumer that needs to display these flags reactively.

export const runtimeState = $state({
  // Whether the DuckDB instance is backed by OPFS (data survives reload)
  // or in-memory (data lost on refresh). Set during DuckDB init.
  isPersistent: false,
});
