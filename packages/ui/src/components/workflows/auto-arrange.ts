import dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';

const HORIZONTAL_GAP = 80;
const VERTICAL_GAP = 100;
const GRID_SIZE = 16;

/** Snap a value to the nearest grid increment. */
function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

/**
 * Estimate node dimensions based on type and data content.
 * Nodes with more inline info (LLM, Code, HTTP) are taller.
 */
function getNodeSize(node: Node): { width: number; height: number } {
  const d = (node.data ?? {}) as Record<string, unknown>;

  switch (node.type) {
    // Large nodes — gradient header + multi-line content
    case 'llmNode': {
      let h = 120; // header + chips
      if (d.systemPrompt) h += 16;
      if (d.userMessage) h += 16;
      if (d.temperature != null) h += 18;
      if (d.responseFormat === 'json') h += 20;
      return { width: 260, height: h };
    }

    case 'httpRequestNode': {
      let h = 110;
      if (d.url) h += 16;
      if (d.auth) h += 16;
      return { width: 250, height: h };
    }

    case 'codeNode': {
      const code = (d.code as string) ?? '';
      const lines = Math.min(code.split('\n').length, 3);
      return { width: 260, height: 100 + lines * 14 };
    }

    // Medium nodes — header + expression/content
    case 'conditionNode':
      return { width: 240, height: 130 }; // split true/false zones

    case 'switchNode': {
      const cases = (d.cases as unknown[]) ?? [];
      return { width: 240, height: 110 + Math.min(cases.length, 5) * 20 };
    }

    case 'forEachNode':
      return { width: 230, height: 130 }; // each/done zones

    case 'triggerNode':
      return { width: 230, height: 110 };

    case 'subWorkflowNode': {
      let h = 110;
      const mapping = d.inputMapping as Record<string, unknown> | undefined;
      if (mapping) h += Math.min(Object.keys(mapping).length, 3) * 16;
      return { width: 240, height: h };
    }

    case 'schemaValidatorNode': {
      let h = 110;
      const schema = d.schema as Record<string, unknown> | undefined;
      const props = schema?.properties as Record<string, unknown> | undefined;
      if (props) h += Math.min(Object.keys(props).length, 3) * 14;
      return { width: 240, height: h };
    }

    // Compact nodes — header + one line of info
    case 'toolNode': {
      let h = 95;
      const args = d.toolArgs as Record<string, unknown> | undefined;
      if (args && Object.keys(args).length > 0) h += 16;
      if (d.description) h += 14;
      return { width: 230, height: h };
    }

    case 'filterNode':
    case 'mapNode':
      return { width: 220, height: 110 };

    case 'aggregateNode':
      return { width: 220, height: 110 };

    case 'dataStoreNode':
      return { width: 220, height: 110 };

    case 'delayNode':
      return { width: 200, height: 110 };

    case 'notificationNode':
      return { width: 220, height: d.message ? 110 : 90 };

    case 'approvalNode':
      return { width: 230, height: 120 };

    case 'errorHandlerNode':
      return { width: 220, height: 100 };

    case 'webhookResponseNode':
      return { width: 220, height: 100 };

    // Structural nodes — minimal
    case 'parallelNode': {
      const count = (d.branchCount as number) ?? 2;
      return { width: 200 + count * 20, height: 100 };
    }

    case 'mergeNode':
      return { width: 200, height: 90 };

    case 'stickyNoteNode': {
      const text = (d.text as string) ?? '';
      const lines = Math.min(text.split('\n').length, 5);
      return { width: 180, height: 60 + lines * 16 };
    }

    default:
      return { width: 220, height: 100 };
  }
}

/**
 * Compute an automatic top-to-bottom DAG layout for the given nodes and edges
 * using the dagre graph layout algorithm.
 *
 * Node sizes are estimated per-type so the layout adapts to the visual weight
 * of each node (LLM nodes are taller than Merge nodes, etc.).
 *
 * Returns a new array of nodes with updated positions — inputs are never mutated.
 */
export function autoArrangeNodes(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return [];

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: 'TB',
    nodesep: HORIZONTAL_GAP,
    ranksep: VERTICAL_GAP,
    marginx: 40,
    marginy: 40,
  });

  // Register each node with its estimated dimensions
  const sizeCache = new Map<string, { width: number; height: number }>();
  for (const node of nodes) {
    const size = getNodeSize(node);
    sizeCache.set(node.id, size);
    g.setNode(node.id, size);
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    const size = sizeCache.get(node.id)!;
    // dagre returns center coordinates — convert to top-left for ReactFlow
    return {
      ...node,
      position: {
        x: snapToGrid(pos.x - size.width / 2),
        y: snapToGrid(pos.y - size.height / 2),
      },
    };
  });
}
