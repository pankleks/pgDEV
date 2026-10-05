<script lang="ts">
  import { Copy, X } from '@lucide/svelte'
  import { useToast } from '../composables/toast'
  import { copyText } from '../lib/gridio'
  import { formatCellValue } from '../lib/cellvalue'
  import type { CellValueTarget } from '../lib/valueTarget'

  let { target, onclose }: { target: CellValueTarget; onclose: () => void } = $props()
  const toast = useToast()
  const text = $derived(formatCellValue(target.value, target.type))
  let copying = $state(false)

  async function copy() {
    if (copying) return
    copying = true
    try {
      const ok = await copyText(text)
      toast.show(ok ? 'Value copied.' : 'Copy to clipboard failed')
      if (ok) onclose()
    } finally {
      copying = false
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onclose()
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- The backdrop handles only pointer dismissal; dialog controls remain keyboard accessible. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" onmousedown={(event) => { if (event.target === event.currentTarget) onclose() }}>
  <div class="modal valuedialog-modal" role="dialog" aria-modal="true" aria-label={target.column} tabindex="-1">
    <button class="icon valuedialog-close" title="Close" onclick={onclose}><X size={16} /></button>
    <h2>
      <span class="valuedialog-column">{target.column}</span>
      {#if target.type}<span class="valuedialog-type">({target.type})</span>{/if}
    </h2>
    <pre class="valuedialog-text">{text}</pre>
    <div class="valuedialog-foot">
      <span class="valuedialog-length">{text.length.toLocaleString()} character(s)</span>
      <span class="valuedialog-actions">
        <button class="primary" disabled={copying} onclick={copy}><Copy size={14} /> COPY</button>
      </span>
    </div>
  </div>
</div>
