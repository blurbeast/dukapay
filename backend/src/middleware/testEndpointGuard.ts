import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError.js';

/**
 * Checks whether test endpoints are permitted to execute in the current environment.
 * Test endpoints are strictly disabled in production or when ENABLE_TEST_ENDPOINTS is set to false.
 */
export const isTestEndpointAllowed = (): boolean => {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }
  if (process.env.ENABLE_TEST_ENDPOINTS === 'false') {
    return false;
  }
  return true;
};

/**
 * Express middleware that rejects test endpoint access when running in production
 * or when test endpoints are explicitly disabled.
 */
export const disableInProduction = (_req: Request, _res: Response, next: NextFunction): void => {
  if (!isTestEndpointAllowed()) {
    throw AppError.forbidden('Test endpoints are disabled in production');
  }
  next();
};
