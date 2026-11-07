/**
 * Workflows Repository
 *
 * Database operations for visual DAG tool pipelines.
 * Stores ReactFlow-compatible nodes/edges and execution logs.
 *
 * Types are defined in workflow-types.ts to allow consumers to import
 * domain types without loading the full repository class.
 */

// Re-export all types from workflow-types.ts so the barrel remains the public API
export {
  // Enums
  type WorkflowStatus,
  type WorkflowLogStatus,
  type NodeExecutionStatus,
  // Node Data
  type ToolNodeData,
  type TriggerNodeData,
  type LlmNodeData,
  type ConditionNodeData,
  type CodeNodeData,
  type TransformerNodeData,
  type ForEachNodeData,
  type HttpRequestNodeData,
  type DelayNodeData,
  type SwitchNodeData,
  type DataStoreNodeData,
  type SchemaValidatorNodeData,
  type FilterNodeData,
  type MapNodeData,
  type AggregateNodeData,
  type WebhookResponseNodeData,
  type WorkflowNodeData,
  // Graph types
  type WorkflowNode,
  type WorkflowEdge,
  type InputParameter,
  // Domain models
  type Workflow,
  type NodeResult,
  type WorkflowLog,
  type WorkflowVersion,
  // Input types
  type CreateWorkflowInput,
  type UpdateWorkflowInput,
  // Row types
  type WorkflowRow,
  type WorkflowVersionRow,
  type WorkflowLogRow,
} from './workflow-types.js';

import { BaseRepository, parseJsonField } from '../base.js';
import { generateId } from '@ownpilot/core/services';
import {
  type CreateWorkflowInput,
  type UpdateWorkflowInput,
  type Workflow,
  type WorkflowLog,
  type WorkflowLogStatus,
  type WorkflowVersion,
  type WorkflowRow,
  type WorkflowVersionRow,
  type WorkflowLogRow,
  type NodeResult,
  mapWorkflowRow,
  mapWorkflowVersionRow,
  mapWorkflowLogRow,
} from './workflow-types.js';

// ============================================================================
// Repository
// ============================================================================

export class WorkflowsRepository extends BaseRepository {
  private userId: string;

  constructor(userId = 'default') {
    super();
    this.userId = userId;
  }

  // ==========================================================================
  // Workflow CRUD
  // ==========================================================================

  async create(input: CreateWorkflowInput): Promise<Workflow> {
    const id = generateId('wf');
    const now = new Date().toISOString();

    await this.execute(
      `INSERT INTO workflows (id, user_id, name, description, nodes, edges, status, variables, input_schema, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        this.userId,
        input.name,
        input.description ?? null,
        JSON.stringify(input.nodes),
        JSON.stringify(input.edges),
        input.status ?? 'inactive',
        JSON.stringify(input.variables ?? {}),
        JSON.stringify(input.inputSchema ?? []),
        now,
        now,
      ]
    );

    const workflow = await this.get(id);
    if (!workflow) throw new Error('Failed to create workflow');
    return workflow;
  }

  async get(id: string): Promise<Workflow | null> {
    const row = await this.queryOne<WorkflowRow>(
      'SELECT * FROM workflows WHERE id = $1 AND user_id = $2',
      [id, this.userId]
    );
    return row ? mapWorkflowRow(row, parseJsonField) : null;
  }

  async update(id: string, input: UpdateWorkflowInput): Promise<Workflow | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const updates: string[] = ['updated_at = $1'];
    const values: unknown[] = [new Date().toISOString()];
    let paramIndex = 2;

    if (input.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(input.name);
    }
    if (input.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(input.description);
    }
    if (input.nodes !== undefined) {
      updates.push(`nodes = $${paramIndex++}`);
      values.push(JSON.stringify(input.nodes));
    }
    if (input.edges !== undefined) {
      updates.push(`edges = $${paramIndex++}`);
      values.push(JSON.stringify(input.edges));
    }
    if (input.status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      values.push(input.status);
    }
    if (input.variables !== undefined) {
      updates.push(`variables = $${paramIndex++}`);
      values.push(JSON.stringify(input.variables));
    }
    if (input.inputSchema !== undefined) {
      updates.push(`input_schema = $${paramIndex++}`);
      values.push(JSON.stringify(input.inputSchema));
    }

    values.push(id, this.userId);

    await this.execute(
      `UPDATE workflows SET ${updates.join(', ')} WHERE id = $${paramIndex++} AND user_id = $${paramIndex}`,
      values
    );

    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    // Detach logs: preserve workflow name, set workflow_id = NULL
    const workflow = await this.get(id);
    if (workflow) {
      await this.execute(
        `UPDATE workflow_logs SET workflow_name = COALESCE(workflow_name, $1), workflow_id = NULL WHERE workflow_id = $2`,
        [workflow.name, id]
      );
    }

    const result = await this.execute('DELETE FROM workflows WHERE id = $1 AND user_id = $2', [
      id,
      this.userId,
    ]);
    return result.changes > 0;
  }

  async getPage(limit: number, offset: number): Promise<Workflow[]> {
    const rows = await this.query<WorkflowRow>(
      'SELECT * FROM workflows WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3',
      [this.userId, limit, offset]
    );
    return rows.map((r) => mapWorkflowRow(r, parseJsonField));
  }

  async count(): Promise<number> {
    const row = await this.queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM workflows WHERE user_id = $1',
      [this.userId]
    );
    return parseInt(row?.count ?? '0', 10);
  }

  /** Return all distinct tool names used by active workflows — avoids loading full node data. */
  async getActiveToolNames(): Promise<string[]> {
    const rows = await this.query<{ tool_name: string }>(
      `SELECT DISTINCT node->'data'->>'toolName' AS tool_name
       FROM workflows,
            LATERAL jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(nodes) = 'array' THEN nodes
                ELSE '[]'::jsonb
              END
            ) AS node
       WHERE user_id = $1
         AND status = 'active'
         AND nodes IS NOT NULL
         AND node->>'type' = 'tool'
         AND COALESCE(node->'data'->>'toolName', '') <> ''`,
      [this.userId]
    );
    return rows.map((r) => r.tool_name).filter(Boolean);
  }

  async markRun(id: string): Promise<void> {
    await this.execute(
      `UPDATE workflows SET last_run = $1, run_count = run_count + 1, updated_at = $1 WHERE id = $2 AND user_id = $3`,
      [new Date().toISOString(), id, this.userId]
    );
  }

  // ==========================================================================
  // Workflow Versions
  // ==========================================================================

  async createVersion(workflowId: string): Promise<WorkflowVersion> {
    const workflow = await this.get(workflowId);
    if (!workflow) throw new Error('Workflow not found');

    // Get next version number
    const latest = await this.queryOne<{ max_version: number | null }>(
      `SELECT MAX(version) as max_version FROM workflow_versions WHERE workflow_id = $1`,
      [workflowId]
    );
    const nextVersion = (latest?.max_version ?? 0) + 1;

    const id = generateId('wfver');
    const now = new Date().toISOString();

    await this.execute(
      `INSERT INTO workflow_versions (id, workflow_id, version, nodes, edges, variables, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        workflowId,
        nextVersion,
        JSON.stringify(workflow.nodes),
        JSON.stringify(workflow.edges),
        JSON.stringify(workflow.variables),
        now,
      ]
    );

    // Cleanup: keep only the last 50 versions
    await this.execute(
      `DELETE FROM workflow_versions WHERE workflow_id = $1 AND id NOT IN (
        SELECT id FROM workflow_versions WHERE workflow_id = $1
        ORDER BY version DESC LIMIT 50
      )`,
      [workflowId]
    );

    const version = await this.getVersion(workflowId, nextVersion);
    if (!version) throw new Error('Failed to create version');
    return version;
  }

  async getVersions(workflowId: string, limit = 20, offset = 0): Promise<WorkflowVersion[]> {
    const rows = await this.query<WorkflowVersionRow>(
      `SELECT wv.* FROM workflow_versions wv
       JOIN workflows w ON wv.workflow_id = w.id
       WHERE wv.workflow_id = $1 AND w.user_id = $2
       ORDER BY wv.version DESC LIMIT $3 OFFSET $4`,
      [workflowId, this.userId, limit, offset]
    );
    return rows.map((r) => mapWorkflowVersionRow(r, parseJsonField));
  }

  async countVersions(workflowId: string): Promise<number> {
    const row = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM workflow_versions wv
       JOIN workflows w ON wv.workflow_id = w.id
       WHERE wv.workflow_id = $1 AND w.user_id = $2`,
      [workflowId, this.userId]
    );
    return parseInt(row?.count ?? '0', 10);
  }

  async getVersion(workflowId: string, version: number): Promise<WorkflowVersion | null> {
    const row = await this.queryOne<WorkflowVersionRow>(
      `SELECT wv.* FROM workflow_versions wv
       JOIN workflows w ON wv.workflow_id = w.id
       WHERE wv.workflow_id = $1 AND wv.version = $2 AND w.user_id = $3`,
      [workflowId, version, this.userId]
    );
    return row ? mapWorkflowVersionRow(row, parseJsonField) : null;
  }

  async restoreVersion(workflowId: string, version: number): Promise<Workflow | null> {
    const ver = await this.getVersion(workflowId, version);
    if (!ver) return null;

    // Snapshot current state before restoring
    await this.createVersion(workflowId);

    // Update workflow with version data
    return this.update(workflowId, {
      nodes: ver.nodes,
      edges: ver.edges,
      variables: ver.variables,
    });
  }

  // ==========================================================================
  // Workflow Logs
  // ==========================================================================

  async createLog(workflowId: string, workflowName: string): Promise<WorkflowLog> {
    const id = generateId('wflog');
    const now = new Date().toISOString();

    await this.execute(
      `INSERT INTO workflow_logs (id, workflow_id, workflow_name, status, node_results, started_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, workflowId, workflowName, 'running', '{}', now]
    );

    const log = await this.getLog(id);
    if (!log) throw new Error('Failed to create workflow log');
    return log;
  }

  async updateLog(
    logId: string,
    update: {
      status?: WorkflowLogStatus;
      nodeResults?: Record<string, NodeResult>;
      error?: string;
      completedAt?: string;
      durationMs?: number;
    }
  ): Promise<void> {
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (update.status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      values.push(update.status);
    }
    if (update.nodeResults !== undefined) {
      updates.push(`node_results = $${paramIndex++}`);
      values.push(JSON.stringify(update.nodeResults));
    }
    if (update.error !== undefined) {
      updates.push(`error = $${paramIndex++}`);
      values.push(update.error);
    }
    if (update.completedAt !== undefined) {
      updates.push(`completed_at = $${paramIndex++}`);
      values.push(update.completedAt);
    }
    if (update.durationMs !== undefined) {
      updates.push(`duration_ms = $${paramIndex++}`);
      values.push(update.durationMs);
    }

    if (updates.length === 0) return;

    values.push(logId);
    await this.execute(
      `UPDATE workflow_logs SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  }

  async getLog(id: string): Promise<WorkflowLog | null> {
    const row = await this.queryOne<WorkflowLogRow>(
      `SELECT wl.* FROM workflow_logs wl
       JOIN workflows w ON wl.workflow_id = w.id
       WHERE wl.id = $1 AND w.user_id = $2`,
      [id, this.userId]
    );
    return row ? mapWorkflowLogRow(row, parseJsonField) : null;
  }

  async getLogsForWorkflow(workflowId: string, limit = 20, offset = 0): Promise<WorkflowLog[]> {
    const rows = await this.query<WorkflowLogRow>(
      `SELECT wl.* FROM workflow_logs wl
       JOIN workflows w ON wl.workflow_id = w.id
       WHERE wl.workflow_id = $1 AND w.user_id = $2
       ORDER BY wl.started_at DESC LIMIT $3 OFFSET $4`,
      [workflowId, this.userId, limit, offset]
    );
    return rows.map((r) => mapWorkflowLogRow(r, parseJsonField));
  }

  async countLogsForWorkflow(workflowId: string): Promise<number> {
    const row = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM workflow_logs wl
       JOIN workflows w ON wl.workflow_id = w.id
       WHERE wl.workflow_id = $1 AND w.user_id = $2`,
      [workflowId, this.userId]
    );
    return parseInt(row?.count ?? '0', 10);
  }

  async getRecentLogs(limit = 20, offset = 0): Promise<WorkflowLog[]> {
    const rows = await this.query<WorkflowLogRow>(
      `SELECT wl.* FROM workflow_logs wl
       JOIN workflows w ON wl.workflow_id = w.id
       WHERE w.user_id = $1
       ORDER BY wl.started_at DESC LIMIT $2 OFFSET $3`,
      [this.userId, limit, offset]
    );
    return rows.map((r) => mapWorkflowLogRow(r, parseJsonField));
  }

  async countLogs(): Promise<number> {
    const row = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM workflow_logs wl
       JOIN workflows w ON wl.workflow_id = w.id
       WHERE w.user_id = $1`,
      [this.userId]
    );
    return parseInt(row?.count ?? '0', 10);
  }

  /**
   * List all workflow logs with 'running' status across all workflows.
   * Used at server boot to recover orphaned workflows via the job queue.
   */
  async listRunningLogs(): Promise<Array<{ id: string; userId: string }>> {
    const rows = await this.query<{ id: string; user_id: string }>(
      `SELECT wl.id, w.user_id
       FROM workflow_logs wl
       JOIN workflows w ON wl.workflow_id = w.id
       WHERE wl.status = 'running'`
    );
    return rows.map((r) => ({ id: r.id, userId: r.user_id }));
  }

  /**
   * Find a workflow by its trigger node's webhookPath (global lookup, cross-user).
   * Used by the webhook endpoint to match incoming requests to workflows.
   */
  async getByWebhookPath(webhookPath: string): Promise<Workflow | null> {
    // Query all active workflows and find one with a matching trigger node webhookPath.
    // Uses PostgreSQL JSONB operators for efficient filtering.
    const row = await this.queryOne<WorkflowRow>(
      `SELECT w.* FROM workflows w,
       LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(w.nodes) = 'array' THEN w.nodes ELSE '[]'::jsonb END
       ) AS node
       WHERE w.status = 'active'
         AND node->>'type' = 'triggerNode'
         AND node->'data'->>'triggerType' = 'webhook'
         AND node->'data'->>'webhookPath' = $1
       LIMIT 1`,
      [webhookPath]
    );
    return row ? mapWorkflowRow(row, parseJsonField) : null;
  }

  /**
   * Get workflow runs that appear orphaned — 'running' with no completed_at
   * and started_at older than threshold.
   */
  async getOrphanedRuns(thresholdMs: number): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.query<{ id: string; name: string }>(
      `SELECT wl.id, w.name
       FROM workflow_logs wl
       JOIN workflows w ON wl.workflow_id = w.id
       WHERE wl.status = 'running'
         AND wl.completed_at IS NULL
         AND EXTRACT(EPOCH FROM (NOW() - wl.started_at)) * 1000 > $1`,
      [thresholdMs]
    );
    return rows;
  }

  /**
   * Mark a running workflow log as failed (used during orphan recovery).
   */
  async markRunFailed(logId: string, reason: string): Promise<void> {
    await this.execute(
      `UPDATE workflow_logs
       SET status = 'failed', completed_at = NOW(), error = $2
       WHERE id = $1 AND status = 'running'`,
      [logId, `orphan_recovery: ${reason}`]
    );
  }

  /**
   * Persist node outputs to the workflow log (gap 24.1 Phase 2).
   * Called after each node completes so crash recovery can resume from last successful state.
   */
  async persistNodeOutputs(logId: string, nodeOutputs: Record<string, NodeResult>): Promise<void> {
    await this.updateLog(logId, { nodeResults: nodeOutputs });
  }

  /**
   * Get workflow log with node outputs for crash recovery (gap 24.1 Phase 2).
   * Returns null if log is not found or not in 'running' state.
   */
  async getLogForRecovery(logId: string): Promise<{
    logId: string;
    workflowId: string;
    nodeResults: Record<string, NodeResult>;
  } | null> {
    const rows = await this.query<{
      id: string;
      workflow_id: string;
      node_results: string;
      status: WorkflowLogStatus;
    }>(`SELECT id, workflow_id, node_results, status FROM workflow_logs WHERE id = $1`, [logId]);
    if (rows.length === 0) return null;
    const row = rows[0]!;
    if (row.status !== 'running') return null;
    return {
      logId: row.id,
      workflowId: row.workflow_id ?? '',
      nodeResults: parseJsonField<Record<string, NodeResult>>(row.node_results, {}),
    };
  }

  /**
   * Delete workflow logs older than maxAgeDays.
   * For gap 24.3 retention enforcement.
   */
  async cleanupOldWorkflowLogs(maxAgeDays = 90): Promise<number> {
    const result = await this.execute(
      `DELETE FROM workflow_logs WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < NOW() - INTERVAL '1 day' * $1`,
      [maxAgeDays]
    );
    return result.changes;
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createWorkflowsRepository(userId = 'default'): WorkflowsRepository {
  return new WorkflowsRepository(userId);
}
