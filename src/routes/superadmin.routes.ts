import { Router, Request, Response } from 'express';
import { clients, proxyAndShape, upstreamGet } from '../utils/proxy';
import { sendDashboardError } from '../utils/transform';

/**
 * /super-admin/* — platform administration surface (readme2.md §12).
 * Mostly proxies to Platform/Auth/Reports; the not-yet-built platform modules
 * are explicit stubs (§9.3).
 */
const router = Router();

const reshape = async (
  req: Request,
  res: Response,
  client: (typeof clients)['platform'],
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

// ─── Subscriptions & assignments (P → Platform) ──────────────────────────────

router.get('/subscriptions', (req, res) => {
  // /super-admin/subscriptions → Platform flat /restaurant-subscriptions?restaurantId=
  // (the /restaurants/:id/subscription router needs a path param the flat surface lacks).
  const rid = req.query['restaurantId'];
  reshape(req, res, clients.platform, 'get', rid ? `/restaurant-subscriptions?restaurantId=${encodeURIComponent(String(rid))}` : '/restaurant-subscriptions', 'subscriptions');
});
router.post('/subscriptions/assign', (req, res) =>
  reshape(req, res, clients.platform, 'post', '/restaurant-subscriptions', 'subscription', undefined, 'Subscription assigned'),
);
router.put('/subscriptions/:id', (req, res) =>
  reshape(req, res, clients.platform, 'put', '/restaurant-subscriptions', 'subscription', undefined, 'Subscription updated'),
);
router.patch('/subscriptions/:id/status', (req, res) =>
  reshape(req, res, clients.platform, 'patch', '/restaurant-subscriptions/status', 'subscription', undefined, 'Status updated'),
);

// ─── Roles & permissions (P → Auth) ─────────────────────────────────────────

router.get('/roles', (req, res) =>
  reshape(req, res, clients.auth, 'get', '/roles', 'roles'),
);
router.post('/roles', (req, res) =>
  reshape(req, res, clients.auth, 'post', '/roles', 'role', undefined, 'Role created'),
);
router.get('/permissions', (req, res) =>
  reshape(req, res, clients.auth, 'get', '/permissions/modules', 'permissions'),
);

// ─── Logs & audit (P → Reports) ─────────────────────────────────────────────

router.get('/logs', async (req, res) => {
  try {
    const result = await upstreamGet(clients.reports, '/audit-logs', req);
    res.status(result.status).json(result.body);
  } catch (err) {
    sendDashboardError(res, err);
  }
});
router.get('/audit', async (req, res) => {
  try {
    const result = await upstreamGet(clients.reports, '/audit-logs', req);
    res.status(result.status).json(result.body);
  } catch (err) {
    sendDashboardError(res, err);
  }
});

// ─── Config & platform settings (P → Platform) ──────────────────────────────

router.get('/config', (req, res) => {
  // /super-admin/config → Platform /settings (operational settings, §9.2)
  reshape(req, res, clients.platform, 'get', '/settings', 'config');
});
router.put('/config', (req, res) =>
  reshape(req, res, clients.platform, 'put', '/operational-settings', 'config', undefined, 'Config updated'),
);
router.get('/platform', (req, res) => {
  // /super-admin/platform → Platform /settings (same operational-settings surface)
  reshape(req, res, clients.platform, 'get', '/settings', 'platform');
});

// ─── Health (C → gateway aggregate) ─────────────────────────────────────────

router.get('/health', async (_req, res) => {
  try {
    const result = await upstreamGet(clients.reports, '/health', _req);
    res.status(result.status).json(result.body);
  } catch {
    res.status(200).json({ success: true, data: { status: 'gateway-ok', services: 'see /health' } });
  }
});

// ─── Documented stubs (§9.3) ────────────────────────────────────────────────

const STUB_ROUTES: Array<[string, string]> = [
  ['/features', 'Feature flags module is not yet implemented'],
  ['/rate-limits', 'API rate-limit administration is not yet implemented'],
  ['/sms-templates', 'SMS templates module is not yet implemented (email templates exist in Platform)'],
];

for (const [path, msg] of STUB_ROUTES) {
  router.get(path, (_req, res) =>
    res.status(200).json({ success: true, message: `Module not yet implemented — ${msg}`, data: { items: [] } }),
  );
}

export default router;
