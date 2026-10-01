<script lang="ts">
  import TreeNode from './TreeNode.svelte'
  import type { CatalogNode } from './lib/catalogTree'
  import type { DdlTarget } from './generated/contracts'
  import type { SvelteSet } from 'svelte/reactivity'
  import { parseSearch, searchTerms, scopedHighlight } from '../../web/src/lib/browserSearch'

  let { node, expanded, query, onopen }: { node: CatalogNode; expanded: SvelteSet<string>; query: string; onopen: (target: DdlTarget, label: string) => void } = $props()
  const open = $derived(!!query.trim() || expanded.has(node.key))
  const parsed = $derived(parseSearch(query))
  const groups = $derived(searchTerms(parsed.term))

  function toggle() { if (expanded.has(node.key)) expanded.delete(node.key); else expanded.add(node.key) }
  function openDdl() { if (node.target) onopen(node.target, node.label) }
</script>

<li role="treeitem" aria-selected="false" aria-expanded={node.children.length ? open : undefined}>
  <div class="node">
    <button class="label" onclick={toggle} ondblclick={openDdl} onkeydown={(event) => { if (event.key === 'Enter' && node.target) { event.preventDefault(); openDdl() } }} title={node.detail ?? node.label}>
      <span class="chevron">{node.children.length ? open ? '▾' : '▸' : '·'}</span>
      <span>{@html scopedHighlight(node.label, groups, parsed.type, node.scopes)}</span>
    </button>
    {#if node.detail}<span class="detail">{node.detail}</span>{/if}
  </div>
  {#if open && node.children.length}
    <ul role="group">{#each node.children as child (child.key)}<TreeNode node={child} {expanded} {query} {onopen} />{/each}</ul>
  {/if}
</li>

<style>
  li { list-style: none; }
  ul { padding-left: 14px; margin: 0; }
  .node { display: flex; flex-direction: column; padding: 2px 0; }
  .label { background: transparent; border: 0; padding: 5px 2px; text-align: left; overflow-wrap: anywhere; display: flex; gap: 5px; }
  .label:hover { background: #333; }
  .chevron { width: 12px; flex-shrink: 0; color: #aaa; }
  .detail { color: #999; font-size: 11px; padding-left: 20px; overflow-wrap: anywhere; }
  :global(mark.search-hit) { background: #80640c; color: #fff; }
</style>
