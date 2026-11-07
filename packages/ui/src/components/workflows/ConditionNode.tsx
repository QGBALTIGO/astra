/**
 * ConditionNode — ReactFlow node for if/else branching in workflows.
 * Decision-focused design with expression in code-block style,
 * angled header accent, and split TRUE/FALSE bottom indicators.
 */

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { GitBranch, CheckCircle2, XCircle, Activity, AlertCircle } from '../icons';
import type { NodeExecutionStatus } from '../../api/types';

export interface ConditionNodeData extends Record<string, unknown> {
  label: string;
  /** JS expression that evaluates to truthy/falsy */
  expression: string;
  description?: string;
  executionStatus?: NodeExecutionStatus;
  executionError?: string;
  executionDuration?: number;
  executionOutput?: unknown;
  /** Which branch was taken during execution */
  branchTaken?: string;
}

type ConditionNodeType = Node<ConditionNodeData>;

const statusStyles: Record<NodeExecutionStatus, { border: string; bg: string }> = {
  pending: { border: 'border-emerald-300 dark:border-emerald-700', bg: '' },
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

function ConditionNodeComponent({ data, selected }: NodeProps<ConditionNodeType>) {
  const status = (data.executionStatus as NodeExecutionStatus | undefined) ?? 'pending';
  const style = statusStyles[status];
  const StatusIcon = statusIcons[status];
  const branchTaken = data.branchTaken as string | undefined;
  const expression = (data.expression as string) ?? '';

  return (
    <div
      className={`
        relative min-w-[180px] max-w-[260px] rounded-lg border-2 shadow-sm overflow-hidden
        bg-white dark:bg-gray-900
        ${style.border} ${style.bg}
        ${selected ? 'ring-2 ring-emerald-500 ring-offset-1' : ''}
        ${status === 'running' ? 'animate-pulse' : ''}
        transition-all duration-200
      `}
    >
      {/* Input Handle */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-emerald-500 !border-2 !border-white dark:!border-emerald-950"
      />

      {/* Angled header accent with diamond icon */}
      <div className="relative bg-gradient-to-r from-emerald-500/10 to-transparent dark:from-emerald-500/20 px-3 pt-2 pb-1">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-emerald-500/20 flex items-center justify-center shrink-0 rotate-45">
            <GitBranch className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 -rotate-45" />
          </div>
          <span className="font-medium text-sm text-emerald-900 dark:text-emerald-100 truncate flex-1">
            {(data.label as string) || 'Condition'}
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

      {/* Body Content */}
      <div className="px-3 py-2 space-y-1.5">
        {/* Expression in code-block style */}
        {expression && (
          <div className="bg-gray-900 dark:bg-gray-950 rounded px-2 py-1.5 overflow-hidden">
            <p className="text-[10px] text-emerald-300 font-mono truncate" title={expression}>
              {expression}
            </p>
          </div>
        )}

        {/* Branch taken indicator */}
        {branchTaken && status === 'success' && (
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-gray-400">Result:</span>
            <span
              className={`inline-block px-1.5 py-0.5 text-[9px] font-bold rounded ${
                branchTaken === 'true'
                  ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
                  : 'bg-red-500/20 text-red-700 dark:text-red-300'
              }`}
            >
              {branchTaken === 'true' ? 'TRUE' : 'FALSE'}
            </span>
          </div>
        )}

        {/* Error message */}
        {status === 'error' && data.executionError && (
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

        {/* Split bottom TRUE/FALSE indicators */}
        <div className="flex mt-1 -mx-3 -mb-2">
          <div
            className={`flex-1 text-center py-1 text-[9px] font-bold border-t ${
              branchTaken === 'true' && status === 'success'
                ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700'
                : 'bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-500/60 dark:text-emerald-400/40 border-gray-200 dark:border-gray-700'
            }`}
          >
            TRUE
          </div>
          <div className="w-px bg-gray-200 dark:bg-gray-700" />
          <div
            className={`flex-1 text-center py-1 text-[9px] font-bold border-t ${
              branchTaken === 'false' && status === 'success'
                ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-300 dark:border-red-700'
                : 'bg-red-50/50 dark:bg-red-950/20 text-red-500/60 dark:text-red-400/40 border-gray-200 dark:border-gray-700'
            }`}
          >
            FALSE
          </div>
        </div>
      </div>

      {/* True Output Handle (left) */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="true"
        className="!w-3 !h-3 !bg-emerald-500 !border-2 !border-white dark:!border-emerald-950"
        style={{ left: '30%' }}
      />

      {/* False Output Handle (right) */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="false"
        className="!w-3 !h-3 !bg-red-400 !border-2 !border-white dark:!border-emerald-950"
        style={{ left: '70%' }}
      />
    </div>
  );
}

export const ConditionNode = memo(ConditionNodeComponent);
