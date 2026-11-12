/**
 * Shared validation helper used by every route that parses JSON.
 *
 * The schemas themselves live in sibling files grouped by domain
 * (agent, productivity, workflow-claws, data, integrations).
 */

import type { z } from 'zod';

/**
 * Error thrown by validateBody when schema validation fails.
 * Carries the raw Zod issues so catch blocks can use zodValidationError().
 */
export class ValidationError extends Error {
  constructor(public readonly issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>) {
    const summary = issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    super(`Validation failed: ${summary}`);
    this.name = 'ValidationError';
  }
}

/**
 * Validate request body against a Zod schema.
 * Returns parsed data on success, throws ValidationError (with Zod issues) on failure.
 */
export function validateBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}
