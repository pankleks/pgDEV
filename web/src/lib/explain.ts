import dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/svelte'

export interface PlanNode extends Record<string, unknown> {
  'Node Type': string
  Plans?: PlanNode[]
  'Relation Name'?: string
  'Index Name'?: string
  'Total Cost'?: number
  'Plan Rows'?: number
  'Actual Rows'?: number
  'Actual Total Time'?: number
  'Actual Loops'?: number
}

export interface ExplainPlan extends Record<string, unknown> {
  Plan: PlanNode
}

export function parseExplainPlan(value: unknown): ExplainPlan {
  const decoded = typeof value === 'string' ? JSON.parse(value) : value
  const plan = Array.isArray(decoded) && decoded.length === 1 ? decoded[0] : null
  if (!plan || typeof plan !== 'object' || !plan.Plan) throw new Error('Invalid JSON execution plan')
  const pending: unknown[] = [plan.Plan]
  while (pending.length) {
    const node = pending.pop()
    if (!node || typeof node !== 'object' || !('Node Type' in node) || typeof node['Node Type'] !== 'string') {
      throw new Error('Invalid execution plan node')
    }
    if ('Plans' in node) {
      if (!Array.isArray(node.Plans)) throw new Error('Invalid execution plan children')
      pending.push(...node.Plans)
    }
  }
  return plan as ExplainPlan
}

export type PlanGraphNode = Node<{ plan: PlanNode; share: number; own: number; metric: 'time' | 'cost'; heat: 'none' | 'normal' | 'warm' | 'hot' }, 'plan'>

/** PostgreSQL lists parents first; edges point from child producers to consumers. */
export function planGraph(plan: ExplainPlan): { nodes: PlanGraphNode[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph().setGraph({ rankdir: 'LR', ranksep: 75, nodesep: 35 })
    .setDefaultEdgeLabel(() => ({}))
  const nodes: PlanGraphNode[] = []
  const edges: Edge[] = []
  const pending: { plan: PlanNode; parent?: string }[] = [{ plan: plan.Plan }]
  const metric = plan.Plan['Actual Total Time'] !== undefined ? 'time' : 'cost'
  const inclusive = (node: PlanNode) => metric === 'time'
    ? (node['Actual Total Time'] ?? 0) * (node['Actual Loops'] ?? 0)
    : (node['Total Cost'] ?? 0)
  while (pending.length) {
    const entry = pending.pop()!
    const id = String(nodes.length)
    graph.setNode(id, { width: 230, height: 148 })
    // ponytail: child subtraction approximates own work; overlapping parallel/async nodes need profiler data for exact attribution.
    const own = Math.max(0, inclusive(entry.plan) - (entry.plan.Plans ?? []).reduce((sum, child) => sum + inclusive(child), 0))
    nodes.push({
      id, type: 'plan', position: { x: 0, y: 0 },
      data: { plan: entry.plan, share: 0, own, metric, heat: 'none' },
    })
    if (entry.parent !== undefined) {
      graph.setEdge(id, entry.parent)
      edges.push({
        id: `${id}-${entry.parent}`, source: id, target: entry.parent, type: 'smoothstep',
        style: 'stroke: #b8d4ff; stroke-width: 2.5px;',
        markerEnd: { type: 'arrowclosed', color: '#b8d4ff', width: 12, height: 12 },
      })
    }
    for (const child of [...(entry.plan.Plans ?? [])].reverse()) pending.push({ plan: child, parent: id })
  }
  dagre.layout(graph)
  const total = nodes.reduce((sum, node) => sum + node.data.own, 0)
  const ranked = nodes.map(node => node.data.own).filter(own => own > 0).sort((a, b) => b - a)
  // Round up for small plans; ties at a cutoff receive the same color.
  const hot = ranked[Math.ceil(ranked.length * 0.1) - 1] ?? Infinity
  const warm = ranked[Math.ceil(ranked.length * 0.3) - 1] ?? Infinity
  for (const node of nodes) {
    const position = graph.node(node.id)
    node.position = { x: position.x - 115, y: position.y - 74 }
    node.data.share = total > 0 ? node.data.own / total : 0
    node.data.heat = node.data.own === 0 ? 'none' : node.data.own >= hot ? 'hot' : node.data.own >= warm ? 'warm' : 'normal'
  }
  return { nodes, edges }
}
