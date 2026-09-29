import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

/**
 * Gateway auth (readme2.md §2):
 * - validates the same JWT the services accept (shared JWT_ACCESS_SECRET)
 * - panel-level role gates per panel
 * - Manager branch scoping: MANAGER tokens with a non-empty branchIds claim are
 *   restricted to those branches (single-resource enforcement happens in
 *   services too — defense in depth).
 *
 * Auth Service token shape: { sub, role, userType, restaurantId, branchIds?, ... }
 */
export interface GatewayUser {
  sub: string;
  role: string;
  userType: string;
  restaurantId: string | null;
  branchIds: string[];
  impersonatedBy?: string;
  permissions?: Record<string, unknown>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      gwUser?: GatewayUser;
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'Authentication required', error: 'UNAUTHORIZED', errorCode: 'UNAUTHORIZED' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), env.JWT_ACCESS_SECRET) as GatewayUser;
    req.gwUser = {
      ...payload,
      branchIds: payload.branchIds || [],
    };
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token', error: 'UNAUTHORIZED', errorCode: 'UNAUTHORIZED' });
  }
}

function deny(res: Response, message: string): void {
  res.status(403).json({ success: false, message, error: 'FORBIDDEN', errorCode: 'FORBIDDEN' });
}

/** /admin/* — SaaS Super Admin only (impersonation tokens carry the original admin claim). */
export function requireSaasAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.gwUser?.role !== 'SAAS_SUPER_ADMIN') {
    deny(res, 'SaaS Super Admin access required');
    return;
  }
  next();
}

/** /restaurant/* — Restaurant Super Admin, Manager, or impersonated SSA. */
export function requireRestaurantPanel(req: Request, res: Response, next: NextFunction): void {
  const role = req.gwUser?.role;
  if (role === 'RESTAURANT_SUPER_ADMIN' || role === 'MANAGER' || role === 'SAAS_SUPER_ADMIN') {
    next();
    return;
  }
  deny(res, 'Restaurant panel access required');
}

/** /super-admin/* — alias of the admin gate (§2). */
export const requireSuperAdminPanel = requireSaasAdmin;

/**
 * Manager branch scoping (§2/§13): for MANAGER tokens with branchIds, inject a
 * branchId filter (when the caller didn't specify one) and reject explicit
 * branchIds outside the claim.
 */
export function applyBranchScope(req: Request, _res: Response, next: NextFunction): void {
  const user = req.gwUser;
  if (user?.role === 'MANAGER' && user.branchIds.length > 0) {
    const requested = (req.query['branchId'] as string) || (req.body?.branchId as string);
    if (requested && !user.branchIds.includes(requested)) {
      deny(_res, 'You are not assigned to this branch');
      return;
    }
    if (!requested) {
      req.query['branchId'] = user.branchIds.join(',');
    }
  }
  next();
}
