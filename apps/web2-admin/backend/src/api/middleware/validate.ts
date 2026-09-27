import { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AnySchema } from 'yup';

import { RequestShapeError } from '../../domain/errors/index.js';

/**
 * Validate-and-coerce middleware. The validated, type-narrowed result replaces
 * the original `req.body` (or params) so downstream handlers see clean data.
 *
 * Yup's ValidationError is caught by errorHandler and mapped to HTTP 400.
 */
export function validateBody(schema: AnySchema): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = await schema.validate(req.body ?? {}, {
        abortEarly: false,
        stripUnknown: true,
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function validateParams(schema: AnySchema): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const validated = await schema.validate(req.params, {
        abortEarly: false,
        stripUnknown: true,
      });
      // Express 5's req.params is not writable, only mutable.
      Object.assign(req.params, validated);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** A schema of the contracts package, as far as a route needs one: it reads a value, or says every reason it cannot. */
export interface ContractSchema {
  safeParse(
    input: unknown,
  ): { success: true; data: unknown } | { success: false; error: { issues: { message: string }[] } };
}

function readWith(schema: ContractSchema, input: unknown): unknown {
  const result = schema.safeParse(input);
  if (!result.success) throw new RequestShapeError(result.error.issues.map((issue) => issue.message));
  return result.data;
}

/** As validateBody, for a shape the apps share. A refusal is a RequestShapeError, answered as a yup one is. */
export function validateContractBody(schema: ContractSchema): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = readWith(schema, req.body ?? {});
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** As validateParams, for a shape the apps share. */
export function validateContractParams(schema: ContractSchema): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      Object.assign(req.params, readWith(schema, req.params));
      next();
    } catch (err) {
      next(err);
    }
  };
}
