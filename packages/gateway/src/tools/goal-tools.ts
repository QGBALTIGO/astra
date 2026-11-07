/**
 * Goal Tool Executor
 *
 * Execute the LLM-facing goal tools (create_goal, list_goals,
 * decompose_goal, complete_step, etc.) by delegating to GoalService.
 *
 * Extracted from `routes/goals.ts` so the tool registry doesn't have to
 * reach back into the routes/ layer for executors.
 */

import { getGoalService } from '@ownpilot/core/services';
import type { GoalStatus } from '../db/repositories/goals.js';
import { GoalServiceError } from '../services/goal-service.js';
import { sanitizeId, getErrorMessage } from '../utils/common.js';
import { wsGateway } from '../ws/server.js';
import type { ToolExecutionResult } from '../services/tool/executor.js';

/**
 * Execute goal tool — delegates to GoalService.
 */
export async function executeGoalTool(
  toolId: string,
  params: Record<string, unknown>,
  userId = 'default'
): Promise<ToolExecutionResult> {
  const service = getGoalService();

  try {
    switch (toolId) {
      case 'create_goal': {
        const { title, description, priority, dueDate, parentId } = params as {
          title: string;
          description?: string;
          priority?: number;
          dueDate?: string;
          parentId?: string;
        };

        const goal = await service.createGoal(userId, {
          title,
          description,
          priority,
          dueDate,
          parentId,
        });

        wsGateway.broadcast('data:changed', { entity: 'goal', action: 'created', id: goal.id });
        return {
          success: true,
          result: {
            message: `Created goal: "${goal.title}"`,
            goal: {
              id: goal.id,
              title: goal.title,
              priority: goal.priority,
              dueDate: goal.dueDate,
            },
          },
        };
      }

      case 'list_goals': {
        const { status, limit = 10 } = params as {
          status?: GoalStatus;
          limit?: number;
        };

        const goals = await service.listGoals(userId, {
          status: status ?? 'active',
          limit,
          orderBy: 'priority',
        });

        if (goals.length === 0) {
          return {
            success: true,
            result: {
              message: `No ${status ?? 'active'} goals found.`,
              goals: [],
            },
          };
        }

        return {
          success: true,
          result: {
            message: `Found ${goals.length} ${status ?? 'active'} goal(s).`,
            goals: goals.map((g) => ({
              id: g.id,
              title: g.title,
              status: g.status,
              priority: g.priority,
              progress: g.progress,
              dueDate: g.dueDate,
            })),
          },
        };
      }

      case 'update_goal': {
        const { goalId, status, progress, title, description, priority, dueDate } = params as {
          goalId: string;
          status?: GoalStatus;
          progress?: number;
          title?: string;
          description?: string;
          priority?: number;
          dueDate?: string;
        };

        if (!goalId) {
          return { success: false, error: 'goalId is required' };
        }

        const updated = await service.updateGoal(userId, goalId, {
          status,
          progress,
          title,
          description,
          priority,
          dueDate,
        });

        if (!updated) {
          return { success: false, error: `Goal not found: ${sanitizeId(goalId)}` };
        }

        wsGateway.broadcast('data:changed', { entity: 'goal', action: 'updated', id: goalId });
        return {
          success: true,
          result: {
            message: `Updated goal: "${updated.title}"`,
            goal: {
              id: updated.id,
              title: updated.title,
              status: updated.status,
              progress: updated.progress,
            },
          },
        };
      }

      case 'decompose_goal': {
        const { goalId, steps } = params as {
          goalId: string;
          steps: Array<{ title: string; description?: string }>;
        };

        if (!goalId) {
          return { success: false, error: 'goalId is required' };
        }
        if (!steps || !Array.isArray(steps) || steps.length === 0) {
          return { success: false, error: 'steps array is required' };
        }

        const createdSteps = await service.decomposeGoal(
          userId,
          goalId,
          steps.filter((s) => s.title)
        );

        const goal = await service.getGoal(userId, goalId);

        return {
          success: true,
          result: {
            message: `Added ${createdSteps.length} steps to "${goal?.title ?? goalId}"`,
            steps: createdSteps.map((s) => ({
              id: s.id,
              title: s.title,
              orderNum: s.orderNum,
            })),
          },
        };
      }

      case 'get_next_actions': {
        const { limit = 5 } = params as { limit?: number };

        const actions = await service.getNextActions(userId, limit);

        if (actions.length === 0) {
          return {
            success: true,
            result: {
              message: 'No actionable steps found. All caught up!',
              actions: [],
            },
          };
        }

        return {
          success: true,
          result: {
            message: `Found ${actions.length} actionable step(s).`,
            actions: actions.map((a) => ({
              stepId: a.id,
              stepTitle: a.title,
              goalTitle: a.goalTitle,
              status: a.status,
            })),
          },
        };
      }

      case 'complete_step': {
        const { stepId, result } = params as {
          stepId: string;
          result?: string;
        };

        if (!stepId) {
          return { success: false, error: 'stepId is required' };
        }

        const updated = await service.completeStep(userId, stepId, result);

        if (!updated) {
          return { success: false, error: `Step not found: ${sanitizeId(stepId)}` };
        }

        return {
          success: true,
          result: {
            message: `Completed step: "${updated.title}"`,
            step: {
              id: updated.id,
              title: updated.title,
              status: updated.status,
            },
          },
        };
      }

      case 'get_goal_details': {
        const { goalId } = params as { goalId: string };

        if (!goalId) {
          return { success: false, error: 'goalId is required' };
        }

        const goalWithSteps = await service.getGoalWithSteps(userId, goalId);
        if (!goalWithSteps) {
          return { success: false, error: `Goal not found: ${sanitizeId(goalId)}` };
        }

        const { steps, ...goal } = goalWithSteps;

        return {
          success: true,
          result: {
            goal: {
              id: goal.id,
              title: goal.title,
              description: goal.description,
              status: goal.status,
              priority: goal.priority,
              progress: goal.progress,
              dueDate: goal.dueDate,
              createdAt: goal.createdAt,
            },
            steps: steps.map((s) => ({
              id: s.id,
              title: s.title,
              status: s.status,
              orderNum: s.orderNum,
            })),
            stepCount: steps.length,
            completedSteps: steps.filter((s) => s.status === 'completed').length,
          },
        };
      }

      case 'get_goal_stats': {
        const stats = await service.getStats(userId);

        return {
          success: true,
          result: {
            message: `You have ${stats.total} goals total, ${stats.byStatus.active} active.`,
            stats,
          },
        };
      }

      default:
        return { success: false, error: `Unknown tool: ${sanitizeId(toolId)}` };
    }
  } catch (err) {
    if (err instanceof GoalServiceError) {
      return { success: false, error: err.message };
    }
    return {
      success: false,
      error: getErrorMessage(err),
    };
  }
}
