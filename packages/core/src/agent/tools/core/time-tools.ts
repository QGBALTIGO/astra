/**
 * Time Tool Definitions
 *
 * Tool schemas for time and date operations.
 */

import type { ToolDefinition } from '../../types.js';

export const TIME_TOOL_DEFS: readonly ToolDefinition[] = [
  {
    name: 'get_current_time',
    description: 'Get the current date and time in ISO format',
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA timezone name (e.g., "America/New_York")',
        },
      },
    },
  },
  {
    name: 'format_date',
    description: 'Format a date in various formats',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description:
            'Date string to format (ISO format or natural language like "tomorrow", "next week")',
        },
        format: {
          type: 'string',
          description: 'Output format: iso, short, long, relative, custom (with pattern)',
        },
        timezone: {
          type: 'string',
          description: 'Target timezone (default: UTC)',
        },
      },
      required: ['date'],
    },
  },
  {
    name: 'date_diff',
    description: 'Calculate difference between two dates',
    parameters: {
      type: 'object',
      properties: {
        date1: {
          type: 'string',
          description: 'First date (ISO format)',
        },
        date2: {
          type: 'string',
          description: 'Second date (ISO format, defaults to now)',
        },
        unit: {
          type: 'string',
          description: 'Unit for result: days, hours, minutes, seconds, weeks, months, years',
        },
      },
      required: ['date1'],
    },
  },
  {
    name: 'add_to_date',
    description: 'Add or subtract time from a date',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Starting date (ISO format, defaults to now)',
        },
        amount: {
          type: 'number',
          description: 'Amount to add (negative to subtract)',
        },
        unit: {
          type: 'string',
          description: 'Unit: days, hours, minutes, seconds, weeks, months, years',
        },
      },
      required: ['amount', 'unit'],
    },
  },
];

// ===========================================================================
// Executors
// ===========================================================================

/**
 * Time-related tool executors
 *
 * Executors: get_current_time, format_date, date_diff, add_to_date
 */

import type { ToolExecutor } from '../../types.js';
import { getErrorMessage } from '../../../services/error-utils.js';

export const TIME_EXECUTORS: Record<string, ToolExecutor> = {
  get_current_time: async (args) => {
    const timezone = (args.timezone as string) || 'UTC';
    try {
      const now = new Date();
      const formatted = now.toLocaleString('en-US', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'long',
      });
      return { content: `Current time in ${timezone}: ${formatted}` };
    } catch {
      return { content: `Current time (UTC): ${new Date().toISOString()}` };
    }
  },

  format_date: async (args) => {
    const dateStr = args.date as string;
    const format = (args.format as string) ?? 'long';
    const timezone = (args.timezone as string) ?? 'UTC';

    try {
      let date: Date;

      // Handle natural language dates
      const now = new Date();
      const lower = dateStr.toLowerCase();
      if (lower === 'now' || lower === 'today') {
        date = now;
      } else if (lower === 'tomorrow') {
        date = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      } else if (lower === 'yesterday') {
        date = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      } else if (lower === 'next week') {
        date = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      } else {
        date = new Date(dateStr);
      }

      if (isNaN(date.getTime())) {
        return { content: `Error: Invalid date: ${dateStr}`, isError: true };
      }

      let result: string;
      switch (format) {
        case 'iso':
          result = date.toISOString();
          break;
        case 'short':
          result = date.toLocaleDateString('en-US', { timeZone: timezone });
          break;
        case 'long':
          result = date.toLocaleDateString('en-US', {
            timeZone: timezone,
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          });
          break;
        case 'relative': {
          const diff = date.getTime() - now.getTime();
          const days = Math.round(diff / (24 * 60 * 60 * 1000));
          if (days === 0) result = 'Today';
          else if (days === 1) result = 'Tomorrow';
          else if (days === -1) result = 'Yesterday';
          else if (days > 0) result = `In ${days} days`;
          else result = `${Math.abs(days)} days ago`;
          break;
        }
        default:
          result = date.toISOString();
      }

      return { content: result };
    } catch (error) {
      return {
        content: `Error: ${getErrorMessage(error, 'Invalid date')}`,
        isError: true,
      };
    }
  },

  date_diff: async (args) => {
    const date1Str = args.date1 as string;
    const date2Str = (args.date2 as string) ?? new Date().toISOString();
    const unit = (args.unit as string) ?? 'days';

    try {
      const date1 = new Date(date1Str);
      const date2 = new Date(date2Str);

      if (isNaN(date1.getTime()) || isNaN(date2.getTime())) {
        return { content: 'Error: Invalid date', isError: true };
      }

      const diffMs = date2.getTime() - date1.getTime();
      let result: number;

      switch (unit) {
        case 'seconds':
          result = diffMs / 1000;
          break;
        case 'minutes':
          result = diffMs / (1000 * 60);
          break;
        case 'hours':
          result = diffMs / (1000 * 60 * 60);
          break;
        case 'days':
          result = diffMs / (1000 * 60 * 60 * 24);
          break;
        case 'weeks':
          result = diffMs / (1000 * 60 * 60 * 24 * 7);
          break;
        case 'months':
          result = diffMs / (1000 * 60 * 60 * 24 * 30.44);
          break;
        case 'years':
          result = diffMs / (1000 * 60 * 60 * 24 * 365.25);
          break;
        default:
          return { content: `Error: Unknown unit: ${unit}`, isError: true };
      }

      return { content: `${result.toFixed(2)} ${unit}` };
    } catch (error) {
      return {
        content: `Error: ${getErrorMessage(error, 'Invalid date')}`,
        isError: true,
      };
    }
  },

  add_to_date: async (args) => {
    const dateStr = (args.date as string) ?? new Date().toISOString();
    const amount = args.amount as number;
    const unit = args.unit as string;

    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        return { content: 'Error: Invalid date', isError: true };
      }

      let msToAdd: number;
      switch (unit) {
        case 'seconds':
          msToAdd = amount * 1000;
          break;
        case 'minutes':
          msToAdd = amount * 1000 * 60;
          break;
        case 'hours':
          msToAdd = amount * 1000 * 60 * 60;
          break;
        case 'days':
          msToAdd = amount * 1000 * 60 * 60 * 24;
          break;
        case 'weeks':
          msToAdd = amount * 1000 * 60 * 60 * 24 * 7;
          break;
        case 'months':
          date.setUTCMonth(date.getUTCMonth() + amount);
          return { content: date.toISOString() };
        case 'years':
          date.setUTCFullYear(date.getUTCFullYear() + amount);
          return { content: date.toISOString() };
        default:
          return { content: `Error: Unknown unit: ${unit}`, isError: true };
      }

      const newDate = new Date(date.getTime() + msToAdd);
      return { content: newDate.toISOString() };
    } catch (error) {
      return {
        content: `Error: ${getErrorMessage(error, 'Invalid operation')}`,
        isError: true,
      };
    }
  },
};
