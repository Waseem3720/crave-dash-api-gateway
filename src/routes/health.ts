import { Router, Request, Response } from 'express';
import axios from 'axios';
import { env } from '../config/env';

const router = Router();

/**
 * GET /health — aggregated health of all seven services (readme2.md §2).
 * 200 when every service answers; per-service status list always included.
 */
router.get('/', async (_req: Request, res: Response) => {
  const services: Record<string, string> = {
    auth: env.AUTH_URL,
    platform: env.PLATFORM_URL,
    catalog: env.CATALOG_URL,
    order: env.ORDER_URL,
    payment: env.PAYMENT_URL,
    accounting: env.ACCOUNTING_URL,
    reports: env.REPORTS_URL,
  };

  const entries = await Promise.all(
    Object.entries(services).map(async ([name, base]) => {
      try {
        await axios.get(`${base}/health`, { timeout: 2_000, validateStatus: () => true });
        return [name, 'ok'] as const;
      } catch {
        return [name, 'unreachable'] as const;
      }
    }),
  );

  const status = Object.fromEntries(entries);
  const allOk = Object.values(status).every((s) => s === 'ok');

  res.status(allOk ? 200 : 503).json({
    success: allOk,
    service: 'gateway',
    status: allOk ? 'ok' : 'degraded',
    services: status,
    timestamp: new Date().toISOString(),
  });
});

export default router;
