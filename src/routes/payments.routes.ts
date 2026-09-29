import { Router, Request, Response } from 'express';
import { clients, upstreamGet, upstreamSend } from '../utils/proxy';
import { sendDashboardError, toDashboardEnvelope } from '../utils/transform';

/**
 * /payments/*, /billing/* — Payment Service surface (readme2.md §12).
 * Payment routes live under /api/v1 — the gateway strips that prefix for the
 * dashboard. Responses are reshaped into the dashboard envelope.
 */
const router = Router();

async function shapePaymentResponse(
  req: Request,
  res: Response,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  paymentPath: string,
  resourceName: string,
  body?: unknown,
  message?: string,
): Promise<void> {
  try {
    const result =
      method === 'get'
        ? await upstreamGet(clients.payment, `/api/v1${paymentPath}`, req)
        : await upstreamSend(clients.payment, method, `/api/v1${paymentPath}`, req, body);
    if (result.status >= 400) {
      throw Object.assign(new Error('Upstream error'), { response: { status: result.status, data: result.body } });
    }
    res.status(200).json(toDashboardEnvelope(result.body, resourceName, message));
  } catch (err) {
    sendDashboardError(res, err);
  }
}

// ─── Payments ────────────────────────────────────────────────────────────────

router.post('/payments/process', (req, res) => {
  // Dashboard callers send `paymentMethod` (Dashboard.md §3.1) — map to Payment's
  // `method` field (model requires it) and default the currency.
  const body = { ...req.body };
  if (body.paymentMethod && !body.method) body.method = body.paymentMethod;
  if (!body.method && body.paymentMethod === undefined) body.method = 'cash';
  body.method = body.method || body.paymentMethod || 'cash';
  if (!body.currency) body.currency = 'GBP';
  shapePaymentResponse(req, res, 'post', '/payments', 'payment', body, 'Payment processed');
});
router.post('/payments/refund', (req, res) => {
  const paymentId = String(req.body?.paymentId || '');
  const path = paymentId ? `/payments/${paymentId}/refund` : '/payments';
  shapePaymentResponse(req, res, 'post', path, 'refund', undefined, 'Refund recorded');
});
router.get('/payments/methods', (req, res) =>
  shapePaymentResponse(req, res, 'get', '/payment-methods', 'methods'),
);
router.get('/payments', (req, res) =>
  shapePaymentResponse(req, res, 'get', '/payments', 'payments'),
);
router.get('/payments/history', (req, res) =>
  shapePaymentResponse(req, res, 'get', '/transactions', 'transactions'),
);

// ─── POS surfaces (alias without /api/v1) ───────────────────────────────────

router.get('/pos-sessions', (req, res) =>
  shapePaymentResponse(req, res, 'get', '/pos-sessions', 'sessions'),
);
router.post('/pos-sessions', (req, res) =>
  shapePaymentResponse(req, res, 'post', '/pos-sessions', 'session', undefined, 'Session opened'),
);
router.post('/pos-sessions/:id/close', (req, res) =>
  shapePaymentResponse(req, res, 'post', `/pos-sessions/${req.params['id']}/close`, 'session', undefined, 'Session closed'),
);
router.get('/pos-sessions/:id/z-report', (req, res) =>
  shapePaymentResponse(req, res, 'get', `/pos-sessions/${req.params['id']}/z-report`, 'zReport'),
);
router.get('/cash-drawer', (req, res) =>
  shapePaymentResponse(req, res, 'get', '/cash-drawer', 'drawer'),
);
router.get('/cash-operations', (req, res) =>
  // → Payment /api/v1/cash-operations (POS compliance surface, §3.2)
  shapePaymentResponse(req, res, 'get', '/cash-operations', 'operations'),
);
router.post('/cash-in', (req, res) =>
  shapePaymentResponse(req, res, 'post', '/cash-in', 'operation', undefined, 'Cash in recorded'),
);
router.post('/cash-out', (req, res) =>
  shapePaymentResponse(req, res, 'post', '/cash-out', 'operation', undefined, 'Cash out recorded'),
);
router.post('/no-sale', (req, res) =>
  shapePaymentResponse(req, res, 'post', '/no-sale', 'operation', undefined, 'No-sale logged'),
);

// ─── Billing aliases ─────────────────────────────────────────────────────────

router.get('/billing/invoices', (req, res) =>
  shapePaymentResponse(req, res, 'get', '/transactions', 'invoices'),
);
router.get('/billing/history', (req, res) =>
  shapePaymentResponse(req, res, 'get', '/transactions', 'transactions'),
);
router.get('/billing/subscription', async (req, res) => {
  // Subscriptions live on Platform, not Payment — read the tenant's latest via
  // the flat restaurant-subscriptions surface and reshape as `subscription`.
  try {
    const rid = req.gwUser?.restaurantId;
    if (!rid) {
      return res.status(403).json({ success: false, message: 'No restaurant context', error: 'FORBIDDEN', errorCode: 'FORBIDDEN' });
    }
    const result = await upstreamGet(clients.platform, `/restaurant-subscriptions?restaurantId=${encodeURIComponent(String(rid))}`, req);
    if (result.status >= 400) {
      throw Object.assign(new Error('Upstream error'), { response: { status: result.status, data: result.body } });
    }
    const raw: unknown = (result.body as { data?: unknown })?.data;
    const rawSubs: unknown = (raw as { subscriptions?: unknown } | undefined)?.subscriptions;
    const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray(rawSubs) ? rawSubs : [];
    res.status(200).json(toDashboardEnvelope({ success: true, data: list[0] ?? null }, 'subscription'));
  } catch (err) {
    sendDashboardError(res, err);
  }
});
router.post('/billing/calculate', async (req, res) => {
  try {
    const rid = req.gwUser?.restaurantId;
    if (!rid) {
      return res.status(403).json({ success: false, message: 'No restaurant context', error: 'FORBIDDEN', errorCode: 'FORBIDDEN' });
    }
    const result = await upstreamSend(clients.platform, 'post', `/restaurants/${rid}/billing-config/calculate`, req, req.body);
    if (result.status >= 400) {
      throw Object.assign(new Error('Upstream error'), { response: { status: result.status, data: result.body } });
    }
    res.status(200).json(toDashboardEnvelope(result.body, 'calculation'));
  } catch (err) {
    sendDashboardError(res, err);
  }
});

// ─── Wallet / loyalty / referrals self-service passthrough (staff-facing) ────

router.get('/wallet', (req, res) =>
  shapePaymentResponse(req, res, 'get', '/wallet', 'wallet'),
);
router.get('/loyalty/points', (req, res) =>
  shapePaymentResponse(req, res, 'get', '/loyalty/points', 'points'),
);
router.get('/referrals/code', (req, res) =>
  shapePaymentResponse(req, res, 'get', '/referrals/code', 'code'),
);

export default router;
