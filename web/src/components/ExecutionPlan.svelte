<script lang="ts">
  import { SvelteFlow, Background, Controls } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'
  import { planGraph, type ExplainPlan, type PlanNode as PlanNodeData } from '../lib/explain'
  import PlanNode from './PlanNode.svelte'
  import { copyText } from '../lib/gridio'
  import { useToast } from '../composables/toast'

  let { plan }: { plan: ExplainPlan } = $props()
  const graph = $derived(planGraph(plan))
  let selected = $state<PlanNodeData | null>(null)
  let raw = $state(false)
  const nodeTypes = { plan: PlanNode }
  const toast = useToast()
  async function copyPlan() {
    toast.show(await copyText(JSON.stringify(plan, null, 2)) ? 'Plan JSON copied.' : 'Copy to clipboard failed')
  }
</script>

<div class="execution-plan" data-component="execution-plan">
  <div class="plan-toolbar">
    <span>{plan['Execution Time'] !== undefined ? `Execution: ${plan['Execution Time']} ms` : 'Estimated plan'}{#if plan['Planning Time'] !== undefined} · Planning: {plan['Planning Time']} ms{/if}</span>
    <span class="spacer"></span>
    <button class="btn-sm" aria-pressed={raw} onclick={() => { raw = !raw }}>{raw ? 'Graph' : 'JSON'}</button>
    <button class="btn-sm" onclick={copyPlan}>Copy JSON</button>
  </div>
  {#if raw}
    <pre class="raw-plan">{JSON.stringify(plan, null, 2)}</pre>
  {:else}
    <div class="plan-content">
      <div class="plan-canvas">
        <SvelteFlow nodes={graph.nodes} edges={graph.edges} {nodeTypes} fitView minZoom={0.1} maxZoom={2} proOptions={{ hideAttribution: true }}
          nodesDraggable={false} nodesConnectable={false} deleteKey={null} colorMode="dark"
          onnodeclick={({ node }) => { selected = node.data.plan }}
          onselectionchange={({ nodes }) => { if (nodes[0]) selected = nodes[0].data.plan }}>
          <Background />
          <Controls showLock={false} />
        </SvelteFlow>
      </div>
      {#if selected}
        <aside class="plan-details" aria-label="Plan node details">
          <div class="detail-head"><strong>{selected['Node Type']}</strong><button class="btn-sm" aria-label="Close node details" onclick={() => { selected = null }}>×</button></div>
          <dl>{#each Object.entries(selected).filter(([key]) => key !== 'Plans') as [key, value]}
            <dt>{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}</dd>
          {/each}</dl>
        </aside>
      {/if}
    </div>
    <div class="plan-legend" title="Own work subtracts child totals and clamps negatives to zero. Shares are normalized to 100% when measurable; parallel/async work and rounding make attribution approximate, not wall-clock percentages.">
      Bars: {graph.nodes[0]?.data.metric === 'time' ? 'approximate own-time share (all loops)' : 'estimated own-cost share, not time'} · Sum: {graph.nodes.some(node => node.data.own > 0) ? '100%' : 'unavailable (zero totals)'} · Amber ≥25% · Node times/rows above are per-loop and include children
    </div>
  {/if}
</div>

<style>
  .execution-plan { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
  .plan-toolbar, .detail-head { display: flex; align-items: center; gap: 8px; padding: 5px 10px; }
  .plan-toolbar, .plan-legend { font-size: 11px; color: #aeb5c5; }
  .plan-content { display: flex; flex: 1; min-height: 0; }
  .plan-canvas { flex: 1; min-width: 0; min-height: 0; }
  .plan-details { width: 300px; max-width: 45%; overflow: auto; border-left: 1px solid #343947; font-size: 12px; }
  .detail-head { justify-content: space-between; }
  dl { padding: 0 12px; }
  dt { color: #aeb5c5; margin-top: 8px; }
  dd { margin: 2px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .raw-plan { margin: 0; padding: 12px; overflow: auto; flex: 1; font-size: 12px; }
  .plan-legend { padding: 4px 10px; }
</style>
