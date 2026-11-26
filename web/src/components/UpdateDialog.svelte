<script lang="ts">
  import { Copy, Download, ExternalLink, X } from '@lucide/svelte'
  import { dialogFocus } from '../lib/dialogfocus'
  import { copyText } from '../lib/gridio'
  import { noteBlocks } from '../lib/releasenotes'
  import type { AvailableUpdate } from '../desktop'
  import { useUpdates } from '../composables/updates'
  import { useToast } from '../composables/toast'

  let { update, current, onclose }: { update: AvailableUpdate; current: string; onclose: () => void } = $props()
  const updates = useUpdates()
  const toast = useToast()
  const blocks = $derived(noteBlocks(update.notes))
  const published = $derived.by(() => {
    const date = new Date(update.publishedAt)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  })

  async function copy(command: string) {
    toast.show(await copyText(command) ? 'Update command copied.' : 'Copy to clipboard failed')
  }
  async function open(kind: 'release' | 'download') {
    try { await updates.open(kind) } catch (cause) { toast.show((cause as Error).message) }
  }
</script>

<!-- Pointer dismissal only (mousedown: a text selection dragged out of a field must not close it). -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" onmousedown={(event) => { if (event.target === event.currentTarget) onclose() }}>
  <div class="modal settings-modal update-modal" role="dialog" aria-modal="true" aria-label="Update available" tabindex="-1" use:dialogFocus={onclose}>
    <div class="modal-head">
      <div>
        <h2>pgDEV {update.version} is available</h2>
        <p class="modal-sub">You have {current}{#if published} · released {published}{/if}</p>
      </div>
      <button class="icon modal-close" title="Close" aria-label="Close" onclick={onclose}><X size={16} /></button>
    </div>
    <div class="modal-body">
      <section class="settings-section">
        <h3>Update this installation</h3>
        {#each update.instructions as item (item.target)}
          <div class="update-step">
            <strong>{item.label}</strong>
            <small>{item.note}</small>
            {#if item.command}
              <div class="update-command">
                <code>{item.command}</code>
                <button class="btn-sm" title="Copy the command" onclick={() => copy(item.command!)}><Copy size={13} /> Copy</button>
              </div>
            {:else if item.download}
              <div><button class="btn-sm primary" onclick={() => open('download')}><Download size={13} /> Download</button></div>
            {/if}
          </div>
        {:else}
          <p class="update-empty">No ready-made command for this system. Download the new version from the release page.</p>
        {/each}
      </section>

      <section class="settings-section">
        <h3>Release notes</h3>
        <div class="release-notes">
          {#each blocks as block, index (index)}
            {#if block.kind === 'heading'}
              <p class="note-heading level-{block.level}">{#each block.spans as span, i (i)}{#if span.code}<code>{span.text}</code>{:else if span.bold}<strong>{span.text}</strong>{:else}{span.text}{/if}{/each}</p>
            {:else if block.kind === 'item'}
              <p class="note-item" style:padding-left={`${14 + block.depth * 16}px`}>{#each block.spans as span, i (i)}{#if span.code}<code>{span.text}</code>{:else if span.bold}<strong>{span.text}</strong>{:else}{span.text}{/if}{/each}</p>
            {:else if block.kind === 'quote'}
              <p class="note-quote">{#each block.spans as span, i (i)}{#if span.code}<code>{span.text}</code>{:else if span.bold}<strong>{span.text}</strong>{:else}{span.text}{/if}{/each}</p>
            {:else}
              <p>{#each block.spans as span, i (i)}{#if span.code}<code>{span.text}</code>{:else if span.bold}<strong>{span.text}</strong>{:else}{span.text}{/if}{/each}</p>
            {/if}
          {:else}
            <p class="update-empty">No release notes.</p>
          {/each}
          {#if update.notesTruncated}<p class="update-empty">The notes are shortened; the release page has them in full.</p>{/if}
        </div>
      </section>
    </div>

    <div class="modal-foot">
      <button title="Hide this version's notice until a newer release" onclick={() => updates.skip()}>Skip this version</button>
      <span class="spacer"></span>
      <button onclick={() => open('release')}><ExternalLink size={13} /> Release page</button>
      <button class="primary" onclick={onclose}>Close</button>
    </div>
  </div>
</div>
