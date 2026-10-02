<script lang="ts">
  import type { NoticeOutput } from './lib/notices'
  let { output }: { output: NoticeOutput } = $props()
</script>

{#if output.notices.length || output.noticesTruncated}
  <section aria-label="PostgreSQL messages">
    <h3>PostgreSQL messages</h3>
    <ol>
      {#each output.notices as notice}
        <li class:warning={notice.severity === 'WARNING'}>
          <strong>{notice.severity} · {notice.code}</strong> — {notice.message}
          {#if notice.detail}<div><b>Detail:</b> {notice.detail}</div>{/if}
          {#if notice.hint}<div><b>Hint:</b> {notice.hint}</div>{/if}
          {#if notice.context}<details><summary>Context</summary><pre>{notice.context}</pre></details>{/if}
        </li>
      {/each}
    </ol>
    {#if output.noticesTruncated}<p class="warning">Some PostgreSQL messages were omitted because the output limit was reached.</p>{/if}
  </section>
{/if}

<style>
  section { border: 1px solid #444; padding: 12px; margin: 12px 0; max-height: 300px; overflow: auto; }
  h3 { margin-top: 0; }
  ol { padding-left: 22px; }
  li { margin: 8px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .warning { color: #dfb85b; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
