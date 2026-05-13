<script lang="ts">
  // Placeholder: future home of API rate-limit / staleness / error indicators.
  interface Props {
    message?: string;
    tone?: 'info' | 'warn' | 'error' | 'ok';
  }

  let { message = '', tone = 'info' }: Props = $props();
</script>

{#if message}
  <div class="banner {tone}" role="status">{message}</div>
{/if}

<style>
  .banner {
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 14px;
    border: 1px solid transparent;
  }
  .info {
    background: rgba(59, 130, 246, 0.1);
    border-color: rgba(59, 130, 246, 0.4);
    color: #93c5fd;
  }
  .warn {
    background: rgba(234, 179, 8, 0.12);
    border-color: rgba(234, 179, 8, 0.4);
    color: #fde68a;
  }
  .error {
    background: rgba(239, 68, 68, 0.12);
    border-color: rgba(239, 68, 68, 0.4);
    color: #fca5a5;
  }
  .ok {
    background: rgba(34, 197, 94, 0.12);
    border-color: rgba(34, 197, 94, 0.4);
    color: #86efac;
  }
</style>
