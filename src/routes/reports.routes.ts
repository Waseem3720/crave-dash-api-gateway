import { Router, Request, Response } from 'express';
import { clients, upstreamGet, upstreamSend } from '../utils/proxy';
import { sendDashboardError } from '../utils/transform';

/**
 * Reports proxy factory (readme2.md §12).
 * Mounted at each Reports prefix (/reports, /dashboard, /audit-logs,
 * /report-snapshots, /scheduled-reports); forwards mount prefix + path so
 * e.g. GET /dashboard/saas reaches Reports /dashboard/saas. Reports already
 * emits the dashboard-compatible envelope — no reshape here.
 */
export function makeReportsRouter(mountPrefix: string): Router {
  const router = Router();

  router.all('/*', async (req: Request, res: Response) => {
    try {
      const path = `${mountPrefix}${req.path === '/' ? '' : req.path}`;
      const method = req.method.toLowerCase();
      const result =
        method === 'get'
          ? await upstreamGet(clients.reports, path, req)
          : await upstreamSend(clients.reports, method as 'post' | 'put' | 'patch' | 'delete', path, req);
      res.status(result.status).json(result.body);
    } catch (err) {
      sendDashboardError(res, err);
    }
  });

  return router;
}
