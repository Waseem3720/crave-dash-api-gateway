import { Router, Request, Response } from 'express';
import { clients, proxyAndShape, upstreamGet, upstreamSend } from '../utils/proxy';
import { sendDashboardError } from '../utils/transform';

/**
 * /admin/* — SaaS Super Admin panel (readme2.md §12 disposition matrix).
 * P = proxy+reshape, R = Reports aggregation proxy.
 */
const router = Router();

const reshape = async (
  req: Request,
  res: Response,
  client: typeof clients.platform,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  url: string,
  resourceName: string,
  body?: unknown,
  message?: string,
): Promise<void> => {
  try {
    const shaped = await proxyAndShape(client, method, url, req, resourceName, body, message);
    res.status(200).json(shaped);
  } catch (err) {
    sendDashboardError(res, err);
  }
};

// ─── Restaurants (P) ─────────────────────────────────────────────────────────

router.get('/restaurants', (req, res) =>
  reshape(req, res, clients.platform, 'get', '/restaurants', 'restaurants'),
);

router.get('/restaurants/:id', (req, res) =>
  reshape(req, res, clients.platform, 'get', `/restaurants/${req.params['id']}`, 'restaurant'),
);

router.post('/restaurants', (req, res) =>
  reshape(req, res, clients.platform, 'post', '/restaurants', 'restaurant', undefined, 'Restaurant created'),
);

router.put('/restaurants/:id', (req, res) =>
  reshape(req, res, clients.platform, 'put', `/restaurants/${req.params['id']}`, 'restaurant', undefined, 'Restaurant updated'),
);

router.patch('/restaurants/:id/status', (req, res) =>
  reshape(req, res, clients.platform, 'patch', `/restaurants/${req.params['id']}/status`, 'restaurant', undefined, 'Restaurant status updated'),
);

// ─── Subscription plans (P) ──────────────────────────────────────────────────

router.get('/subscription-plans', (req, res) =>
  reshape(req, res, clients.platform, 'get', '/subscription-plans', 'plans'),
);

router.post('/subscription-plans', (req, res) =>
  reshape(req, res, clients.platform, 'post', '/subscription-plans', 'plan', undefined, 'Plan created'),
);

router.put('/subscription-plans/:id', (req, res) =>
  reshape(req, res, clients.platform, 'put', `/subscription-plans/${req.params['id']}`, 'plan', undefined, 'Plan updated'),
);

// Short alias — some dashboard pages reference /admin/plans
router.get('/plans', (req, res) =>
  reshape(req, res, clients.platform, 'get', '/subscription-plans', 'plans'),
);

// ─── Orders, customers, billing, dashboard stats (R — Reports aggregations) ──

async function reportsProxy(req: Request, res: Response): Promise<void> {
  try {
    // /admin/* → Reports /admin/* (inside a mounted router req.path is already
    // router-relative, e.g. /orders — never prepend-derive from req.url).
    const result = await upstreamGet(clients.reports, `/admin${req.path}`, req);
    if (result.status >= 400) {
      const err = new Error('Upstream error') as Error & { response?: { status: number; data: unknown } };
      err.response = { status: result.status, data: result.body };
      throw err;
    }
    res.status(200).json(result.body);
  } catch (err) {
    sendDashboardError(res, err);
  }
}

router.get('/orders', reportsProxy);
router.get('/customers', reportsProxy);
router.get('/billing/transactions', reportsProxy);
router.get('/billing/platform-fees', reportsProxy);

/** Factory: proxy an explicit Reports URL (for /admin/dashboard/stats → /dashboard/saas). */
function reportsProxyTo(url: string) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await upstreamGet(clients.reports, url, req);
      if (result.status >= 400) {
        const err = new Error('Upstream error') as Error & { response?: { status: number; data: unknown } };
        err.response = { status: result.status, data: result.body };
        throw err;
      }
      res.status(200).json(result.body);
    } catch (err) {
      sendDashboardError(res, err);
    }
  };
}
router.get('/dashboard/stats', (req, res) => {
  // /admin/dashboard/stats → Reports /dashboard/saas (§12)
  reportsProxyTo('/dashboard/saas')(req, res).catch((e) => sendDashboardError(res, e));
});

// ─── Super admins (N — Auth /users) ─────────────────────────────────────────

router.get('/super-admins', (req, res) =>
  reshape(req, res, clients.auth, 'get', '/users', 'users'),
);

router.post('/super-admins', (req, res) =>
  reshape(req, res, clients.auth, 'post', '/users', 'user', undefined, 'Admin created'),
);

// Dashboard "Users" page aliases → Auth /users management (readme2.md §4.2)
router.get('/users', (req, res) =>
  reshape(req, res, clients.auth, 'get', '/users', 'users'),
);

router.post('/users', (req, res) =>
  reshape(req, res, clients.auth, 'post', '/users', 'user', undefined, 'Admin created'),
);

router.patch('/users/:id/status', (req, res) =>
  reshape(req, res, clients.auth, 'patch', `/users/${req.params['id']}/status`, 'user', undefined, 'Status updated'),
);

router.patch('/super-admins/:id/status', (req, res) =>
  reshape(req, res, clients.auth, 'patch', `/users/${req.params['id']}/status`, 'user', undefined, 'Status updated'),
);

export default router;
