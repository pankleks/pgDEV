<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import type { SchemaData, DdlTarget } from './generated/contracts'
  import { catalogTree, filterTree } from './lib/catalogTree'
  import TreeNode from './TreeNode.svelte'

  let { data, loading, error, onrefresh, onopen, onedit }: { data: SchemaData | null; loading: boolean; error: string; onrefresh: () => void; onopen: (target: DdlTarget, label: string) => void; onedit: (oid: string) => void } = $props()
  let query = $state('')
  const expanded = new SvelteSet<string>(['tables'])
  const roots = $derived(data ? catalogTree(data) : [])
  const filtered = $derived(filterTree(roots, query))
</script>

<aside>
  <div class="browser-header"><strong>Objects</strong><button onclick={onrefresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button></div>
  <label class="search-label" for="object-search">Search objects</label>
  <input id="object-search" bind:value={query} placeholder="table, col id, fn count…" />
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if !data && !loading}<p class="notice">Connect to browse database objects.</p>{/if}
  {#if data}
    <p class="notice">Double-click an object, or press Enter, to open its DDL.</p>
    {#if !filtered.length}<p class="notice">No objects match "{query}".</p>{/if}
    <ul role="tree" aria-label="Database objects">
      {#each filtered as section (section.key)}
        <TreeNode node={{ ...section, label: `${section.label} (${query.trim() ? `${section.children.length}/` : ''}${roots.find(root => root.key === section.key)?.children.length ?? 0})` }} {expanded} {query} {onopen} {onedit} />
      {/each}
    </ul>
  {/if}
</aside>

<style>
  aside { width: 310px; min-width: 220px; flex-shrink: 0; border-right: 1px solid #444; padding: 0 12px 0 0; overflow: auto; max-height: calc(100vh - 180px); }
  .browser-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .search-label { display: block; margin: 12px 0 6px; font-size: 12px; color: #bbb; }
  input { width: 100%; box-sizing: border-box; }
  ul { padding: 0; margin: 0; }
</style>
