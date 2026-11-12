/**
 * String Tool Definitions
 *
 * Tool schemas for calculation, text truncation, wrapping, slug/case conversion,
 * and percentage/statistics operations.
 */

import type { ToolDefinition } from '../../types.js';

export const STRING_TOOL_DEFS: readonly ToolDefinition[] = [
  {
    name: 'calculate',
    description: 'Evaluate a mathematical expression',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'Mathematical expression to evaluate (e.g., "2 + 2 * 3")',
        },
      },
      required: ['expression'],
    },
  },
  // ===== STRING TOOLS =====
  {
    name: 'truncate_text',
    description: 'Truncate text to specified length with ellipsis',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to truncate',
        },
        length: {
          type: 'number',
          description: 'Maximum length (default: 100)',
        },
        suffix: {
          type: 'string',
          description: 'Suffix to add (default: "...")',
        },
        word_boundary: {
          type: 'boolean',
          description: 'Cut at word boundary (default: true)',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'wrap_text',
    description: 'Wrap text to specified line width',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to wrap',
        },
        width: {
          type: 'number',
          description: 'Maximum line width (default: 80)',
        },
      },
      required: ['text'],
    },
  },
  // ===== SLUG & CASE TOOLS =====
  {
    name: 'to_slug',
    description: 'Convert text to URL-friendly slug',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to convert',
        },
        separator: {
          type: 'string',
          description: 'Word separator (default: "-")',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'change_case',
    description: 'Change text case (camelCase, PascalCase, snake_case, kebab-case, CONSTANT_CASE)',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to convert',
        },
        case_type: {
          type: 'string',
          description: 'Target case: camel, pascal, snake, kebab, constant',
        },
      },
      required: ['text', 'case_type'],
    },
  },
  // ===== CALCULATION TOOLS =====
  {
    name: 'calculate_percentage',
    description: 'Calculate percentage (what % is X of Y, X% of Y, % change)',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description:
            'Operation: "of" (X% of Y), "is" (X is what % of Y), "change" (% change from X to Y)',
        },
        value1: {
          type: 'number',
          description: 'First value',
        },
        value2: {
          type: 'number',
          description: 'Second value',
        },
      },
      required: ['operation', 'value1', 'value2'],
    },
  },
  {
    name: 'calculate_statistics',
    description: 'Calculate statistics for a list of numbers',
    parameters: {
      type: 'object',
      properties: {
        numbers: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of numbers',
        },
      },
      required: ['numbers'],
    },
  },
];

// ===========================================================================
// Executors
// ===========================================================================

/**
 * String utility tool executors
 *
 * Executors: truncate_text, wrap_text, to_slug, change_case,
 *            calculate_percentage, calculate_statistics, calculate
 */

import type { ToolExecutor } from '../../types.js';
import { evaluateMathExpression } from '../../../security/safe-math.js';

export const STRING_EXECUTORS: Record<string, ToolExecutor> = {
  calculate: async (args) => {
    const expression = args.expression as string;

    const result = evaluateMathExpression(expression);
    if (result instanceof Error) {
      return { content: `Error: ${result.message}`, isError: true };
    }
    return { content: String(result) };
  },

  truncate_text: async (args) => {
    const text = args.text as string;
    const length = (args.length as number) ?? 100;
    const suffix = (args.suffix as string) ?? '...';
    const wordBoundary = args.word_boundary !== false;

    if (text.length <= length) {
      return { content: text };
    }

    let truncated = text.slice(0, length - suffix.length);
    if (wordBoundary) {
      const lastSpace = truncated.lastIndexOf(' ');
      if (lastSpace > length / 2) {
        truncated = truncated.slice(0, lastSpace);
      }
    }

    return { content: truncated + suffix };
  },

  wrap_text: async (args) => {
    const text = args.text as string;
    const width = (args.width as number) ?? 80;

    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if ((currentLine + ' ' + word).trim().length <= width) {
        currentLine = (currentLine + ' ' + word).trim();
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);

    return { content: lines.join('\n') };
  },

  to_slug: async (args) => {
    const text = args.text as string;
    const separator = (args.separator as string) ?? '-';

    const slug = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, separator)
      .replace(new RegExp(`${separator}+`, 'g'), separator);

    return { content: slug };
  },

  change_case: async (args) => {
    const text = args.text as string;
    const caseType = (args.case_type as string).toLowerCase();

    // Split into words
    const words = text
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    let result: string;
    switch (caseType) {
      case 'camel':
        result = words
          .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
          .join('');
        break;
      case 'pascal':
        result = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
        break;
      case 'snake':
        result = words.join('_');
        break;
      case 'kebab':
        result = words.join('-');
        break;
      case 'constant':
        result = words.join('_').toUpperCase();
        break;
      default:
        return { content: `Error: Unknown case type: ${caseType}`, isError: true };
    }

    return { content: result };
  },

  calculate_percentage: async (args) => {
    const operation = args.operation as string;
    const value1 = args.value1 as number;
    const value2 = args.value2 as number;

    let result: number;
    let description: string;

    switch (operation.toLowerCase()) {
      case 'of':
        result = (value1 / 100) * value2;
        description = `${value1}% of ${value2} = ${result.toFixed(2)}`;
        break;
      case 'is':
        result = (value1 / value2) * 100;
        description = `${value1} is ${result.toFixed(2)}% of ${value2}`;
        break;
      case 'change':
        result = ((value2 - value1) / value1) * 100;
        description = `Change from ${value1} to ${value2} = ${result >= 0 ? '+' : ''}${result.toFixed(2)}%`;
        break;
      default:
        return { content: 'Error: Operation must be "of", "is", or "change"', isError: true };
    }

    return { content: description };
  },

  calculate_statistics: async (args) => {
    const numbers = args.numbers as number[];

    if (numbers.length === 0) {
      return { content: 'Error: Array is empty', isError: true };
    }

    const sorted = [...numbers].sort((a, b) => a - b);
    const sum = numbers.reduce((a, b) => a + b, 0);
    const mean = sum / numbers.length;
    const len = numbers.length;
    const median =
      len % 2 === 0
        ? ((sorted[len / 2 - 1] ?? 0) + (sorted[len / 2] ?? 0)) / 2
        : (sorted[Math.floor(len / 2)] ?? 0);
    const variance =
      numbers.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / numbers.length;
    const stdDev = Math.sqrt(variance);
    const min = sorted[0] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;
    const range = max - min;

    return {
      content: `\u{1F4CA} Statistics:

Count: ${numbers.length}
Sum: ${sum.toFixed(2)}
Mean: ${mean.toFixed(2)}
Median: ${median.toFixed(2)}
Min: ${min}
Max: ${max}
Range: ${range}
Std Dev: ${stdDev.toFixed(2)}
Variance: ${variance.toFixed(2)}`,
    };
  },
};
