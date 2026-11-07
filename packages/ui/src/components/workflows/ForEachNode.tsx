/**
 * ForEachNode — ReactFlow node for iterating over arrays in workflows.
 * Loop visualization with prominent repeat icon, item variable chip,
 * max iterations badge, and clearly labeled dual output handles.
 */

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Repeat, CheckCircle2, XCircle, Activity, AlertCircle } from '../icons';
import type { NodeExecutionStatus } from '../../api/types';

export interface ForEachNodeData extends Record<string, unknown> {
  label: string;
  arrayExpression: string;
  itemVariable?: string;
  maxIterations?: number;
  onError?: 'stop' | 'continue';
  description?: string;
  executionStatus?: NodeExecutionStatus;
  executionError?: string;
  executionDuration?: number;
  executionOutput?: unknown;
  /** Runtime: current iteration during execution */
  currentIteration?: number;
  /** Runtime: total items being iterated */
  totalIterations?: number;
}

export type ForEachNodeType = Node<ForEachNodeData>;

const statusStyles: Record<NodeExecutionStatus, { border: string; bg: string }> = {
  pending: { border: 'border-sky-300 dark:border-sky-700', bg: '' },
  running: { border: 'border-warning', bg: 'bg-warning/5' },
  success: { border: 'border-success', bg: 'bg-success/5' },
  error: { border: 'border-error', bg: 'bg-error/5' },
  skipped: { border: 'border-text-muted/50', bg: 'bg-text-muted/5' },
};

const statusIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  running: Activity,
  success: CheckCircle2,
  error: XCircle,
  skipped: AlertCircle,
};

function ForEachNodeComponent({ data, selected }: NodeProps<ForEachNodeType>) {
  const status = (data.executionStatus as NodeExecutionStatus | undefined) ?? 'pending';
  const style = statusStyles[status];
  const StatusIcon = statusIcons[status];
  const currentIter = data.currentIteration as number | undefined;
  const totalIter = data.totalIterations as number | undefined;
  const maxIter = data.maxIterations as number | undefined;
  const itemVar = (data.itemVariable as string) ?? '';

  return (
    <div
      className={`
        relative min-w-[190px] max-w-[270px] rounded-lg border-2 shadow-sm overflow-hidden
        bg-white dark:bg-gray-900
        ${style.border} ${style.bg}
        ${selected ? 'ring-2 ring-sky-500 ring-offset-1' : ''}
        ${status === 'running' ? 'animate-pulse' : ''}
        transition-all duration-200
      `}
    >
      {/* Input Handle */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-sky-500 !border-2 !border-white dark:!border-sky-950"
      />

      {/* Header with prominent loop icon */}
      <div className="bg-sky-50 dark:bg-sky-950/40 px-3 py-2">
        <div className="flex items-center gap-2">
          {/* Circular loop indicator */}
          <div className="w-7 h-7 rounded-full border-2 border-sky-400 border-dashed flex items-center justify-center shrink-0">
            <Repeat className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
          </div>
          <span className="font-medium text-sm text-sky-900 dark:text-sky-100 truncate flex-1">
            {(data.label as string) || 'ForEach'}
          </span>
          {StatusIcon && (
            <StatusIcon
              className={`w-4 h-4 shrink-0 ${
                status === 'success'
                  ? 'text-success'
                  : status === 'error'
                    ? 'text-error'
                    : status === 'running'
                      ? 'text-warning'
                      : 'text-text-muted'
              }`}
            />
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-3 py-2 space-y-1.5">
        {/* Chips row: item variable + max iterations */}
        <div className="flex items-center gap-1 flex-wrap">
          {itemVar && (
            <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono font-semibold rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">
              {itemVar}
            </span>
          )}
          {maxIter != null && (
            <span className="inline-block px-1.5 py-0.5 text-[9px] font-medium rounded-full bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
              max {maxIter}
            </span>
          )}
        </div>

        {/* Array expression preview */}
        {!!data.arrayExpression && (
          <p
            className="text-[10px] text-sky-600/70 dark:text-sky-400/50 truncate font-mono"
            title={data.arrayExpression as string}
          >
            {data.arrayExpression as string}
          </p>
        )}

        {/* Iteration progress during execution */}
        {status === 'running' && currentIter != null && totalIter != null && totalIter > 0 && (
          <div>
            <div className="flex items-center justify-between text-[9px] text-sky-700 dark:text-sky-300 mb-0.5">
              <span>
                {(currentIter as number) + 1}/{totalIter}
              </span>
            </div>
            <div className="w-full h-1.5 bg-sky-200 dark:bg-sky-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-sky-500 rounded-full transition-all duration-300"
                style={{
                  width: `${(((currentIter as number) + 1) / (totalIter as number)) * 100}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Completed iteration count */}
        {status === 'success' && !!data.executionOutput && (
          <span className="inline-block px-1.5 py-0.5 text-[9px] font-medium rounded bg-sky-500/20 text-sky-700 dark:text-sky-300">
            {(data.executionOutput as { count?: number })?.count ?? 0} items processed
          </span>
        )}

        {/* Error message */}
        {status === 'error' && !!data.executionError && (
          <p className="text-xs text-error truncate" title={data.executionError as string}>
            {data.executionError as string}
          </p>
        )}

        {/* Duration */}
        {data.executionDuration != null && (
          <p className="text-[10px] text-text-muted dark:text-dark-text-muted">
            {(data.executionDuration as number) < 1000
              ? `${data.executionDuration}ms`
              : `${((data.executionDuration as number) / 1000).toFixed(1)}s`}
          </p>
        )}

        {/* Dual output labels */}
        <div className="flex mt-1 -mx-3 -mb-2 border-t border-gray-200 dark:border-gray-700">
          <div className="flex-1 text-center py-1 text-[9px] font-bold text-sky-600 dark:text-sky-400 bg-sky-50/50 dark:bg-sky-950/30">
            EACH
          </div>
          <div className="w-px bg-gray-200 dark:bg-gray-700" />
          <div className="flex-1 text-center py-1 text-[9px] font-bold text-sky-500/60 dark:text-sky-400/50 bg-gray-50 dark:bg-gray-800/50">
            DONE
          </div>
        </div>
      </div>

      {/* Each Output Handle (left) — connects to body subgraph */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="each"
        className="!w-3 !h-3 !bg-sky-500 !border-2 !border-white dark:!border-sky-950"
        style={{ left: '30%' }}
      />

      {/* Done Output Handle (right) — connects to post-loop nodes */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="done"
        className="!w-3 !h-3 !bg-sky-400 !border-2 !border-white dark:!border-sky-950"
        style={{ left: '70%' }}
      />
    </div>
  );
}

export const ForEachNode = memo(ForEachNodeComponent);
