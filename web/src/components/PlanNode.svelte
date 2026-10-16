<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte'
  import { ArrowDownWideNarrow, Box, Combine, Filter, GitMerge, Hash, Layers, ListEnd, ListPlus, Repeat2, ScanLine, Search, Sigma, SquareFunction } from '@lucide/svelte'
  import type { PlanGraphNode } from '../lib/explain'

  let { data }: NodeProps<PlanGraphNode> = $props()
  const plan = $derived(data.plan)
  const nodeIcons = [
    [/sort/i, ArrowDownWideNarrow],
    [/aggregate|group|unique/i, Sigma],
    [/nested loop/i, Repeat2],
    [/join/i, GitMerge],
    [/hash/i, Hash],
    [/index|bitmap/i, Search],
    [/function|projectset|result/i, SquareFunction],
    [/scan/i, ScanLine],
    [/gather/i, Combine],
    [/materialize|memoize/i, Layers],
    [/append|recursive union/i, ListPlus],
    [/limit/i, ListEnd],
    [/filter/i, Filter],
  ] as const
  const Icon = $derived(nodeIcons.find(([pattern]) => pattern.test(plan['Node Type']))?.[1] ?? Box)
  const estimated = $derived(plan['Plan Rows'])
  const actual = $derived(plan['Actual Rows'])
  const mismatch = $derived(actual !== undefined && estimated !== undefined && Math.max(actual, estimated) / Math.max(1, Math.min(actual, estimated)) >= 10)
</script>

<Handle type="target" position={Position.Left} />
<div class="plan-card" class:mismatch>
  <div class="node-heading"><span class="node-icon" aria-hidden="true"><Icon size={17} strokeWidth={1.8} /></span><strong title={plan['Node Type']}>{plan['Node Type']}</strong></div>
  <div class="relation" title={plan['Index Name'] ?? plan['Relation Name']}>{plan['Relation Name'] ?? plan['Index Name'] ?? '\u00a0'}</div>
  <div>Rows: {estimated ?? '—'}{#if actual !== undefined} → {actual} actual{/if}</div>
  <div>Cost: {plan['Total Cost'] ?? '—'}{#if plan['Actual Total Time'] !== undefined} · {plan['Actual Total Time']} ms{/if}</div>
  <div>{#if plan['Actual Loops'] !== undefined}Loops: {plan['Actual Loops']}{:else}Estimated plan{/if}{#if mismatch} · ≥10× row mismatch{/if}</div>
  <div class="own" title={data.metric === 'time' ? 'Approximate own time: total time × loops minus child totals, clamped at zero. Share of summed own node time, not wall-clock time; parallel work may overlap.' : 'Approximate own cost: total cost minus child costs, clamped at zero. Share of summed own costs; not measured time.'}>
    {data.metric === 'time' ? 'Own time' : 'Est. own cost'}: ~{data.own.toFixed(2)}{data.metric === 'time' ? ' ms' : ''} · {(data.share * 100).toFixed(1)}%
  </div>
  <div class="cost" role="meter" aria-label={data.metric === 'time' ? 'Approximate own-time share' : 'Estimated own-cost share'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={data.share * 100}><span class:hot={data.heat === 'hot'} class:warm={data.heat === 'warm'} style:width={`${data.share * 100}%`}></span></div>
</div>
<Handle type="source" position={Position.Right} />

<style>
  .plan-card { box-sizing: border-box; width: 230px; height: 148px; padding: 9px 12px; background: #20232b; border: 1px solid #626978; border-radius: 6px; color: #e0e3eb; font-size: 11px; line-height: 17px; }
  .node-heading { display: flex; align-items: center; gap: 7px; }
  .node-icon { display: flex; flex-shrink: 0; color: #a6c8ff; }
  strong, .relation, .own { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  strong { font-size: 13px; }
  .relation { color: #a6c8ff; }
  .mismatch { border-color: #e3ad53; }
  .cost { height: 10px; margin-top: 6px; background: #394151; border-radius: 4px; overflow: hidden; }
  .cost span { display: block; height: 100%; background: #8aaefa; }
  .cost span.warm { background: #e3ad53; }
  .cost span.hot { background: #ef7777; }
</style>
