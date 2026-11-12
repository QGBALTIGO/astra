/**
 * Core Tools — Barrel
 *
 * Built-in core tools with definitions and executors colocated per category
 * (consolidated from the former agent/tool-defs/ + agent/executors/ split,
 * which paired every category across two directories).
 */

import type { ToolDefinition, ToolExecutor } from '../../types.js';
import { TIME_TOOL_DEFS, TIME_EXECUTORS } from './time-tools.js';
import { FILE_TOOL_DEFS, FILE_EXECUTORS } from './file-tools.js';
import { TEXT_TOOL_DEFS, TEXT_EXECUTORS } from './text-tools.js';
import { CONVERSION_TOOL_DEFS, CONVERSION_EXECUTORS } from './conversion-tools.js';
import { GENERATOR_TOOL_DEFS, GENERATOR_EXECUTORS } from './generator-tools.js';
import { DATA_TOOL_DEFS, DATA_EXECUTORS } from './data-tools.js';
import { STRING_TOOL_DEFS, STRING_EXECUTORS } from './string-tools.js';
import { RESOURCE_TOOL_DEFS, RESOURCE_EXECUTORS } from './resource-tools.js';

/**
 * Built-in core tools
 */
export const CORE_TOOLS: readonly ToolDefinition[] = [
  ...TIME_TOOL_DEFS,
  ...FILE_TOOL_DEFS,
  ...TEXT_TOOL_DEFS,
  ...CONVERSION_TOOL_DEFS,
  ...GENERATOR_TOOL_DEFS,
  ...DATA_TOOL_DEFS,
  ...STRING_TOOL_DEFS,
  ...RESOURCE_TOOL_DEFS,
];

/**
 * Core tool executors
 */
export const CORE_EXECUTORS: Record<string, ToolExecutor> = {
  ...TIME_EXECUTORS,
  ...FILE_EXECUTORS,
  ...TEXT_EXECUTORS,
  ...CONVERSION_EXECUTORS,
  ...GENERATOR_EXECUTORS,
  ...DATA_EXECUTORS,
  ...STRING_EXECUTORS,
  ...RESOURCE_EXECUTORS,
};
