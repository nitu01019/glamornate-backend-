/**
 * zod-powered request validators. Returns 400 on any failure with a flat
 * message per-field.
 */

import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';
import { errResponse } from '../../lib/contracts';

export type ValidatedTarget = 'query' | 'body' | 'params';

export function validate<T>(target: ValidatedTarget, schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const input = req[target];
    const result = schema.safeParse(input);

    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      res.status(400).json(errResponse(`Invalid ${target}: ${issues}`));
      return;
    }

    // Immutable replacement — attach parsed data as a new prop
    (req as Request & Record<string, unknown>)[`validated_${target}`] = result.data;
    next();
  };
}

/**
 * Type-safe accessor for a validated section of the request.
 */
export function getValidated<T>(req: Request, target: ValidatedTarget): T {
  const value = (req as Request & Record<string, unknown>)[`validated_${target}`];
  return value as T;
}
