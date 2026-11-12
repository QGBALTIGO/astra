/**
 * NotificationNode — Sends notifications to the user via WebSocket or other channels.
 * Alert visual with severity-colored left stripe, message preview,
 * and bell icon with severity color.
 */

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Bell, CheckCircle2, XCircle, Activity, AlertCircle } from '../icons';
import type { NodeExecutionStatus } from '../../api/types';

export interface NotificationNodeData extends Record<string, unknown> {
  label: string;
  description?: string;
  /** Notification message template (supports {{templates}}) */
  message?: string;
  /** Notification severity */
  severity?: 'info' | 'warning' | 'error' | 'success';
  executionStatus?: NodeExecutionStatus;
  executionError?: string;
  executionDuration?: number;
  executionOutput?: unknown;
  outputAlias?: string;
}

export type NotificationNodeType = Node<NotificationNodeData>;

const severityConfig: Record<
  string,
  { stripe: string; iconBg: string; iconColor: string; badge: string; badgeText: string }
> = {
  info: {
    stripe: 'bg-blue-500',
    iconBg: 'bg-blue-100 dark:bg-blue-900/40',
    iconColor: 'text-blue-600 dark:text-blue-400',
    badge: 'bg-blue-100 dark:bg-blue-900/40',
    badgeText: 'text-blue-700 dark:text-blue-300',
  },
  warning: {
    stripe: 'bg-amber-500',
    iconBg: 'bg-amber-100 dark:bg-amber-900/40',
    iconColor: 'text-amber-600 dark:text-amber-400',
    badge: 'bg-amber-100 dark:bg-amber-900/40',
    badgeText: 'text-amber-700 dark:text-amber-300',
  },
  error: {
    stripe: 'bg-red-500',
    iconBg: 'bg-red-100 dark:bg-red-900/40',
    iconColor: 'text-red-600 dark:text-red-400',
    badge: 'bg-red-100 dark:bg-red-900/40',
    badgeText: 'text-red-700 dark:text-red-300',
  },
  success: {
    stripe: 'bg-emerald-500',
    iconBg: 'bg-emerald-100 dark:bg-emerald-900/40',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    badge: 'bg-emerald-100 dark:bg-emerald-900/40',
    badgeText: 'text-emerald-700 dark:text-emerald-300',
  },
};

const statusStyles: Record<NodeExecutionStatus, { border: string; bg: string }> = {
  pending: { border: 'border-purple-300 dark:border-purple-700', bg: '' },
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

function NotificationNodeComponent({ data, selected }: NodeProps<NotificationNodeType>) {
  const status = (data.executionStatus as NodeExecutionStatus | undefined) ?? 'pending';
  const style = statusStyles[status];
  const StatusIcon = statusIcons[status];
  const severity = (data.severity as string) ?? 'info';
  const sevConf = severityConfig[severity] ?? {
    stripe: 'bg-blue-500',
    iconBg: 'bg-blue-100 dark:bg-blue-900/40',
    iconColor: 'text-blue-600 dark:text-blue-400',
    badge: 'bg-blue-100 dark:bg-blue-900/40',
    badgeText: 'text-blue-700 dark:text-blue-300',
  };
  const message = (data.message as string) ?? '';

  return (
    <div
      className={`
        relative min-w-[180px] max-w-[260px] rounded-lg border shadow-sm overflow-hidden
        bg-white dark:bg-gray-900
        ${style.border} ${style.bg}
        ${selected ? 'ring-2 ring-purple-500 ring-offset-1' : ''}
        ${status === 'running' ? 'animate-pulse' : ''}
        transition-all duration-200
      `}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-purple-500 !border-2 !border-white dark:!border-purple-950"
      />

      {/* Severity-colored left stripe layout */}
      <div className="flex">
        <div className={`w-1.5 shrink-0 ${sevConf.stripe}`} />

        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="px-3 py-2">
            <div className="flex items-center gap-2">
              {/* Bell icon with severity color */}
              <div
                className={`w-7 h-7 rounded-full ${sevConf.iconBg} flex items-center justify-center shrink-0`}
              >
                <Bell className={`w-3.5 h-3.5 ${sevConf.iconColor}`} />
              </div>
              <div className="flex-1 min-w-0">
                <span className="font-medium text-sm text-text-primary dark:text-dark-text-primary truncate block">
                  {(data.label as string) || 'Notification'}
                </span>
                {/* Severity badge */}
                <span
                  className={`inline-block mt-0.5 px-1.5 py-0.5 text-[9px] font-bold rounded uppercase tracking-wide ${sevConf.badge} ${sevConf.badgeText}`}
                >
                  {severity}
                </span>
              </div>
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

          {/* Message preview */}
          {message && (
            <div className="px-3 pb-2">
              <p
                className="text-[10px] text-gray-600 dark:text-gray-400 line-clamp-2"
                title={message}
              >
                {message}
              </p>
            </div>
          )}

          {/* Error message */}
          {status === 'error' && data.executionError && (
            <div className="px-3 pb-2">
              <p className="text-xs text-error truncate" title={data.executionError as string}>
                {data.executionError as string}
              </p>
            </div>
          )}

          {/* Duration */}
          {data.executionDuration != null && (
            <div className="px-3 pb-2">
              <p className="text-[10px] text-text-muted dark:text-dark-text-muted">
                {(data.executionDuration as number) < 1000
                  ? `${data.executionDuration}ms`
                  : `${((data.executionDuration as number) / 1000).toFixed(1)}s`}
              </p>
            </div>
          )}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-purple-500 !border-2 !border-white dark:!border-purple-950"
      />
    </div>
  );
}

export const NotificationNode = memo(NotificationNodeComponent);
