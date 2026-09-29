import { Router, Request, Response } from 'express';
import axios from 'axios';
import { clients, proxyAndShape, upstreamGet, upstreamSend, forwardHeaders } from '../utils/proxy';
import { sendDashboardError, toDashboardEnvelope, mapErrorPayload } from '../utils/transform';
import { env } from '../config/env';

/**
 * /restaurant/* — Restaurant panel (readme2.md §12 disposition matrix).
 * Composites (§11) orchestrate Order + Payment atomically-with-compensation;
 * everything else is proxy+reshape.
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

// ═══ Dashboard / reports / metrics (R) ═══════════════════════════════════════

async function reportsProxy(req: Request, res: Response): Promise<void> {
  try {
    // req.path is router-relative inside a mounted router (/orders/metrics), so
    // map explicitly: /metrics → Reports /reports/sales-summary; /reports/X →
    // Reports /reports/X. Earlier logic matched req.path against mount-relative
    // names that never occur, so every call fell through to /reports/reports/*.
    let url: string;
    if (req.path === '/metrics' || req.path.endsWith('/metrics') || req.path === '/dashboard') {
      url = '/reports/sales-summary';
    } else if (req.path.startsWith('/reports/')) {
      url = req.path; // already /reports/... — same prefix on Reports
    } else {
      url = `/reports${req.path}`;
    }
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
}

router.get('/dashboard', (req, res) => {
  // /restaurant/dashboard → Reports /dashboard (tenant summary, §12)
  req.url = '/metrics';
  reportsProxy(req, res).catch((e) => sendDashboardError(res, e));
});
router.get('/accounting/revenue', reportsProxy);
router.get('/orders/metrics', reportsProxy);
router.get('/reports/orders', reportsProxy);
router.get('/reports/best-selling', (req, res) => {
  // best-selling → Reports /reports/sales/product (§12)
  req.url = '/reports/sales/product';
  reportsProxy(req, res).catch((e) => sendDashboardError(res, e));
});

// ═══ Orders (P + N wrappers) ═════════════════════════════════════════════════

router.get('/orders', (req, res) =>
  reshape(req, res, clients.order, 'get', '/orders', 'orders'),
);

router.get('/orders/export', async (req, res) => {
  try {
    const result = await upstreamGet(clients.order, '/orders/export', req);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders-export.csv"');
    res.status(result.status).send(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.patch('/orders/bulk-update', async (req, res) => {
  try {
    const result = await upstreamSend(clients.order, 'patch', '/orders/bulk-update', req);
    if (result.status >= 400) throw Object.assign(new Error('Upstream error'), { response: { status: result.status, data: result.body } });
    res.status(200).json(toDashboardEnvelope(result.body, 'results', 'Orders updated'));
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.get('/orders/:id', (req, res) =>
  reshape(req, res, clients.order, 'get', `/orders/${req.params['id']}`, 'order'),
);

router.get('/orders/:id/timeline', async (req, res) => {
  try {
    const result = await upstreamGet(clients.order, `/orders/${req.params['id']}/timeline`, req);
    if (result.status >= 400) throw Object.assign(new Error('Upstream error'), { response: { status: result.status, data: result.body } });
    res.status(200).json(toDashboardEnvelope(result.body, 'timeline'));
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.get('/orders/:id/invoice', invoiceComposite);

async function invoiceComposite(req: Request, res: Response): Promise<void> {
  try {
    const [orderRes, payRes] = await Promise.all([
      upstreamGet(clients.order, `/orders/${req.params['id']}`, req),
      upstreamGet(clients.payment, `/api/v1/payments/order/${req.params['id']}`, req),
    ]);
    const orderBody = (orderRes.body ?? {}) as Record<string, unknown>;
    const order = ((orderBody['data'] as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const payData = ((payRes.body as Record<string, unknown>)?.['data'] ?? null) as unknown;
    res.status(200).json({
      success: true,
      data: {
        order,
        payment: payData,
        ...(order['deliveryAddress'] ? { deliveryAddress: order['deliveryAddress'] } : {}),
      },
    });
  } catch (err) {
    sendDashboardError(res, err);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
router.patch('/orders/:id/status', (req, res) =>
  reshape(req, res, clients.order, 'patch', `/orders/${req.params['id']}/status`, 'order', undefined, 'Order status updated'),
);

router.post('/orders/:id/accept', (req, res) =>
  reshape(req, res, clients.order, 'post', `/orders/${req.params['id']}/accept`, 'order', {}, 'Order accepted'),
);

router.post('/orders/:id/reject', (req, res) =>
  reshape(req, res, clients.order, 'post', `/orders/${req.params['id']}/reject`, 'order', undefined, 'Order rejected'),
);

router.patch('/orders/:id/assign-delivery', (req, res) =>
  reshape(req, res, clients.order, 'patch', `/orders/${req.params['id']}/assign-delivery`, 'order', undefined, 'Delivery partner assigned'),
);

router.patch('/orders/:id/cancel', cancelWithRefund);

/**
 * §11 — cancel + optional refund composite: Order cancel first, then Payment
 * refund when refundAmount > 0 and a payment exists. Partial failures surface
 * both results rather than silently swallowing the refund.
 */
async function cancelWithRefund(req: Request, res: Response): Promise<void> {
  try {
    const cancelRes = await upstreamSend(clients.order, 'post', `/orders/${req.params['id']}/cancel`, req, {
      reason: req.body?.reason || 'Cancelled by restaurant',
    });
    if (cancelRes.status >= 400) {
      throw Object.assign(new Error('Upstream error'), { response: { status: cancelRes.status, data: cancelRes.body } });
    }

    let refundResult: unknown = null;
    const refundAmount = Number(req.body?.refundAmount || 0);
    if (refundAmount > 0) {
      // Find the confirmed payment for this order, then refund it.
      const payRes = await upstreamGet(clients.payment, `/api/v1/payments/order/${req.params['id']}`, req);
      const payments = ((payRes.body as Record<string, unknown>)?.['data'] as Record<string, unknown>) ?? {};
      const list = (payments['payments'] as Array<Record<string, unknown>>) ?? [];
      const confirmed = list.find((p) => p['status'] === 'confirmed');
      if (confirmed) {
        const refundRes = await axios.post(
          `${env.PAYMENT_URL}/api/v1/payments/${confirmed['_id']}/refund`,
          { refundAmount, reason: req.body?.reason || 'Order cancelled' },
          { headers: forwardHeaders(req), timeout: env.DEP_TIMEOUT_MS, validateStatus: () => true },
        );
        refundResult = refundRes.status < 400 ? refundRes.data : { error: refundRes.data };
      }
    }

    const order = ((cancelRes.body as Record<string, unknown>)?.['data'] ?? null);
    res.status(200).json({
      success: true,
      message: 'Order cancelled',
      data: { order: toDashboardEnvelope({ success: true, data: order }, 'order'), refund: refundResult },
    });
  } catch (err) {
    sendDashboardError(res, err);
  }
}

// ═══ POS orders (P + complete composite) ═════════════════════════════════════

router.get('/pos/orders', (req, res) =>
  reshape(req, res, clients.order, 'get', '/orders', 'orders'),
);

router.post('/pos/orders', (req, res) =>
  reshape(req, res, clients.order, 'post', '/orders', 'order', undefined, 'Order created'),
);

router.patch('/pos/orders/:id/complete', posCompleteComposite);

/**
 * §11 — POS complete composite: process payment (cash/card by method), then
 * complete the order. Idempotency-Key passthrough guards double submission.
 * On step-2 failure, mark the payment refunded-pending via its fail endpoint
 * and return 409 COMPLETION_FAILED (compensation, no orphan completion).
 */
async function posCompleteComposite(req: Request, res: Response): Promise<void> {
  try {
    const orderId = req.params['id'];
    const paymentMethod = String(req.body?.paymentMethod || 'cash').toLowerCase();
    const totalAmount = Number(req.body?.totalAmount || 0);

    const payEndpoint = paymentMethod === 'cash' ? '/api/v1/payments/cash' : '/api/v1/payments';
    const payBody =
      paymentMethod === 'cash'
        ? { orderId, amount: totalAmount, method: 'cash' }
        : { orderId, amount: totalAmount, currency: 'USD', method: paymentMethod };

    const payRes = await axios.post(`${env.PAYMENT_URL}${payEndpoint}`, payBody, {
      headers: forwardHeaders(req),
      timeout: env.DEP_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (payRes.status >= 400) {
      throw Object.assign(new Error('Payment failed'), { response: { status: payRes.status, data: payRes.data } });
    }

    const completeRes = await axios.post(`${env.ORDER_URL}/orders/${orderId}/complete`, {}, {
      headers: forwardHeaders(req),
      timeout: env.DEP_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (completeRes.status >= 400) {
      // Compensate: mark the just-created payment failed so money state stays consistent.
      const payment = (payRes.data as Record<string, unknown>)?.['data'] as Record<string, unknown> | undefined;
      if (payment?.['_id']) {
        await axios.post(`${env.PAYMENT_URL}/api/v1/payments/${payment['_id']}/fail`, {}, {
          headers: forwardHeaders(req),
          timeout: env.DEP_TIMEOUT_MS,
          validateStatus: () => true,
        }).catch(() => {});
      }
      res.status(409).json({
        success: false,
        message: 'Order completion failed after payment — payment marked failed',
        error: 'COMPLETION_FAILED',
        errorCode: 'COMPLETION_FAILED',
        details: completeRes.data,
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Order completed',
      data: {
        order: (completeRes.data as Record<string, unknown>)?.['data'] ?? null,
        payment: (payRes.data as Record<string, unknown>)?.['data'] ?? null,
      },
    });
  } catch (err) {
    sendDashboardError(res, err);
  }
}

// ═══ Customers (P + admin wallet/loyalty aliases) ════════════════════════════

router.get('/customers', (req, res) =>
  reshape(req, res, clients.order, 'get', '/customers', 'customers'),
);

router.get('/customers/:id', (req, res) =>
  reshape(req, res, clients.order, 'get', `/customers/${req.params['id']}`, 'customer'),
);

router.put('/customers/:id', (req, res) =>
  reshape(req, res, clients.order, 'put', `/customers/${req.params['id']}`, 'customer', undefined, 'Customer updated'),
);

router.get('/customers/:id/orders', (req, res) =>
  reshape(req, res, clients.order, 'get', `/customers/${req.params['id']}/orders`, 'orders'),
);

router.patch('/customers/:id/ban', async (req, res) => {
  req.url = `/customers/${req.params['id']}/status`;
  req.body = { status: false };
  await reshape(req, res, clients.order, 'patch', `/customers/${req.params['id']}/status`, 'customer', { status: false }, 'Customer banned');
});

router.patch('/customers/bulk', bulkCustomers);

async function bulkCustomers(req: Request, res: Response): Promise<void> {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const status = Boolean(req.body?.status);
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const id of ids) {
    try {
      const r = await upstreamSend(clients.order, 'patch', `/customers/${id}/status`, req, { status });
      results.push({ id, ok: r.status < 400, ...(r.status >= 400 ? { error: 'update failed' } : {}) });
    } catch {
      results.push({ id, ok: false, error: 'upstream unavailable' });
    }
  }
  res.status(200).json({ success: true, message: 'Bulk update processed', data: { results, modifiedCount: results.filter((r) => r.ok).length } });
}

router.post('/customers/:id/message', messageCustomer);

async function messageCustomer(req: Request, res: Response): Promise<void> {
  try {
    const { subject, message, channel } = req.body ?? {};
    const customerId = req.params['id'];
    const emailRes = await axios.post(
      `${env.PLATFORM_URL}/notifications/email`,
      { restaurantId: req.gwUser?.restaurantId, recipients: [], customerId, subject: subject || 'Message from restaurant', body: message || '' },
      { headers: forwardHeaders(req), timeout: env.DEP_TIMEOUT_MS, validateStatus: () => true },
    );
    let smsResult: unknown = null;
    if (channel === 'sms' || channel === 'both') {
      const smsRes = await axios.post(
        `${env.PLATFORM_URL}/notifications/sms`,
        { restaurantId: req.gwUser?.restaurantId, customerId, message: message || '' },
        { headers: forwardHeaders(req), timeout: env.DEP_TIMEOUT_MS, validateStatus: () => true },
      );
      smsResult = smsRes.data;
    }
    res.status(200).json({
      success: true,
      message: 'Message dispatched',
      data: { email: emailRes.data, sms: smsResult },
    });
  } catch (err) {
    sendDashboardError(res, err);
  }
}

router.get('/customers/:id/wallet', async (req, res) => {
  try {
    const result = await upstreamGet(clients.payment, `/api/v1/wallet/admin/${req.params['id']}`, req);
    if (result.status >= 400) throw Object.assign(new Error('Upstream error'), { response: { status: result.status, data: result.body } });
    res.status(200).json(toDashboardEnvelope(result.body, 'wallet'));
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.post('/customers/:id/wallet', async (req, res) => {
  try {
    const body = { userId: req.params['id'], amount: req.body?.amount, reference: req.body?.reference };
    const result = await upstreamSend(clients.payment, 'post', '/api/v1/wallet/credit', req, body);
    if (result.status >= 400) throw Object.assign(new Error('Upstream error'), { response: { status: result.status, data: result.body } });
    res.status(200).json(toDashboardEnvelope(result.body, 'wallet', 'Wallet credited'));
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.get('/customers/:id/loyalty', async (req, res) => {
  try {
    const result = await upstreamGet(clients.payment, `/api/v1/loyalty/admin/${req.params['id']}`, req);
    if (result.status >= 400) throw Object.assign(new Error('Upstream error'), { response: { status: result.status, data: result.body } });
    res.status(200).json(toDashboardEnvelope(result.body, 'loyalty'));
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.post('/customers/:id/loyalty/redeem', async (req, res) => {
  try {
    const body = { points: req.body?.points, orderId: req.body?.orderId };
    const result = await upstreamSend(clients.payment, 'post', `/api/v1/loyalty/admin/${req.params['id']}/redeem`, req, body);
    if (result.status >= 400) throw Object.assign(new Error('Upstream error'), { response: { status: result.status, data: result.body } });
    res.status(200).json(toDashboardEnvelope(result.body, 'loyalty', 'Points redeemed'));
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.get('/customers/:id/referrals', (req, res) =>
  reshape(req, res, clients.payment, 'get', '/api/v1/referrals', 'referrals'),
);

router.get('/customers/export', async (req, res) => {
  try {
    const result = await upstreamGet(clients.reports, '/reports/export', req);
    res.status(result.status).json(result.body);
  } catch (err) {
    sendDashboardError(res, err);
  }
});

// ═══ Catalog (P) ═════════════════════════════════════════════════════════════

router.get('/categories', (req, res) =>
  reshape(req, res, clients.catalog, 'get', '/categories', 'categories'),
);
router.post('/categories', (req, res) =>
  reshape(req, res, clients.catalog, 'post', '/categories', 'category', undefined, 'Category created'),
);
router.put('/categories/:id', (req, res) =>
  reshape(req, res, clients.catalog, 'put', `/categories/${req.params['id']}`, 'category', undefined, 'Category updated'),
);
router.delete('/categories/:id', async (req, res) => {
  try {
    const result = await upstreamSend(clients.catalog, 'delete', `/categories/${req.params['id']}`, req);
    res.status(200).json({ success: true, message: 'Category deleted', data: { deleted: result.status < 400 } });
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.get('/items', (req, res) =>
  reshape(req, res, clients.catalog, 'get', '/items', 'items'),
);
router.post('/items', (req, res) =>
  reshape(req, res, clients.catalog, 'post', '/items', 'item', undefined, 'Item created'),
);
router.put('/items/:id', (req, res) =>
  reshape(req, res, clients.catalog, 'put', `/items/${req.params['id']}`, 'item', undefined, 'Item updated'),
);
router.delete('/items/:id', async (req, res) => {
  try {
    const result = await upstreamSend(clients.catalog, 'delete', `/items/${req.params['id']}`, req);
    res.status(200).json({ success: true, message: 'Item deleted', data: { deleted: result.status < 400 } });
  } catch (err) {
    sendDashboardError(res, err);
  }
});

// ═══ Branches (P) ════════════════════════════════════════════════════════════

router.get('/branches', (req, res) =>
  reshape(req, res, clients.platform, 'get', '/branches', 'branches'),
);
router.post('/branches', (req, res) =>
  reshape(req, res, clients.platform, 'post', '/branches', 'branch', undefined, 'Branch created'),
);
router.put('/branches/:id', (req, res) =>
  reshape(req, res, clients.platform, 'put', `/branches/${req.params['id']}`, 'branch', undefined, 'Branch updated'),
);
router.delete('/branches/:id', async (req, res) => {
  try {
    const result = await upstreamSend(clients.platform, 'delete', `/branches/${req.params['id']}`, req);
    res.status(200).json({ success: true, message: 'Branch deleted', data: { deleted: result.status < 400 } });
  } catch (err) {
    sendDashboardError(res, err);
  }
});

// ═══ Coupons (P) ═════════════════════════════════════════════════════════════

router.get('/coupons', (req, res) =>
  reshape(req, res, clients.platform, 'get', '/coupons', 'coupons'),
);
router.post('/coupons', (req, res) =>
  reshape(req, res, clients.platform, 'post', '/coupons', 'coupon', undefined, 'Coupon created'),
);
router.put('/coupons/:id', (req, res) =>
  reshape(req, res, clients.platform, 'put', `/coupons/${req.params['id']}`, 'coupon', undefined, 'Coupon updated'),
);
router.delete('/coupons/:id', async (req, res) => {
  try {
    const result = await upstreamSend(clients.platform, 'delete', `/coupons/${req.params['id']}`, req);
    res.status(200).json({ success: true, message: 'Coupon deleted', data: { deleted: result.status < 400 } });
  } catch (err) {
    sendDashboardError(res, err);
  }
});

// ═══ Employees (C — Auth + Platform merge) ═══════════════════════════════════

router.get('/employees', employeesMerge);

async function employeesMerge(req: Request, res: Response): Promise<void> {
  try {
    const [authRes, profilesRes] = await Promise.all([
      upstreamGet(clients.auth, '/employees', req),
      upstreamGet(clients.platform, '/staff-profiles', req),
    ]);
    const accounts = ((authRes.body as Record<string, unknown>)?.['data'] as unknown) ?? [];
    const profiles = ((profilesRes.body as Record<string, unknown>)?.['data'] as unknown) ?? [];
    const accList = Array.isArray(accounts) ? accounts : ((accounts as Record<string, unknown>)['employees'] as unknown[] | undefined) ?? [];
    const profList = Array.isArray(profiles) ? profiles : [];
    const profByUser = new Map(profList.map((p) => [String((p as Record<string, unknown>)['userId'] ?? (p as Record<string, unknown>)['id'] ?? ''), p]));

    const merged = (accList as Array<Record<string, unknown>>).map((acc) => {
      const key = String(acc['userId'] ?? acc['id'] ?? acc['_id'] ?? '');
      const prof = (profByUser.get(key) ?? {}) as Record<string, unknown>;
      return {
        ...acc,
        salary: prof['salary'],
        joinDate: prof['joinDate'] ?? prof['joinedAt'],
        branchId: prof['branchId'] ?? acc['branchIds'],
      };
    });
    res.status(200).json(toDashboardEnvelope({ success: true, data: merged }, 'employees'));
  } catch (err) {
    sendDashboardError(res, err);
  }
}

router.post('/employees', async (req, res) => {
  try {
    // Account first (Auth), then profile (Platform) — profile failure is surfaced but non-fatal.
    const authRes = await upstreamSend(clients.auth, 'post', '/employees', req);
    if (authRes.status >= 400) {
      throw Object.assign(new Error('Upstream error'), { response: { status: authRes.status, data: authRes.body } });
    }
    const created = ((authRes.body as Record<string, unknown>)?.['data'] ?? authRes.body) as Record<string, unknown>;
    const userId = String(created['userId'] ?? created['id'] ?? created['_id'] ?? '');
    let profile: unknown = null;
    if (userId && (req.body?.salary || req.body?.branchId)) {
      const profRes = await upstreamSend(clients.platform, 'post', '/staff-profiles', req, {
        userId,
        restaurantId: req.gwUser?.restaurantId,
        role: req.body?.role,
        salary: req.body?.salary,
        branchId: req.body?.branchId,
        joinDate: req.body?.startDate,
      });
      profile = profRes.status < 400 ? (profRes.body as Record<string, unknown>)?.['data'] ?? null : null;
    }
    res.status(201).json({
      success: true,
      message: 'Employee created',
      data: { account: created, profile },
    });
  } catch (err) {
    sendDashboardError(res, err);
  }
});

// ═══ Profile (C — restaurant + settings merge) ═══════════════════════════════

router.get('/profile', profileMerge);

async function profileMerge(req: Request, res: Response): Promise<void> {
  try {
    const rid = req.gwUser?.restaurantId;
    if (!rid) {
      res.status(403).json({ success: false, message: 'No restaurant context', error: 'FORBIDDEN', errorCode: 'FORBIDDEN' });
      return;
    }
    const [restRes, settingsRes, meRes] = await Promise.all([
      upstreamGet(clients.platform, `/restaurants/${rid}`, req),
      upstreamGet(clients.platform, `/settings`, req),
      upstreamGet(clients.auth, `/auth/me`, req),
    ]);
    const restaurant = ((restRes.body as Record<string, unknown>)?.['data'] ?? null);
    const settings = ((settingsRes.body as Record<string, unknown>)?.['data'] ?? null);
    const meBody = (meRes.body as Record<string, unknown>) ?? {};
    // Auth returns the wrapped { data: { user } } for employee roles (§4.1);
    // tolerate the flat customer shape too.
    const meData = (meBody['data'] ?? meBody) as Record<string, unknown> | undefined;
    const user = meData?.['user'] ?? meData ?? null;
    res.status(200).json({
      success: true,
      data: { user, restaurant, settings },
    });
  } catch (err) {
    sendDashboardError(res, err);
  }
}

router.put('/profile', (req, res) =>
  reshape(req, res, clients.platform, 'put', `/restaurants/${req.gwUser?.restaurantId}/own`, 'restaurant', undefined, 'Profile updated'),
);

// ═══ Delivery (P) ════════════════════════════════════════════════════════════

router.get('/delivery-partners', (req, res) =>
  reshape(req, res, clients.order, 'get', '/deliverymen', 'deliveryPartners'),
);
router.get('/delivery-partners/:id', (req, res) =>
  reshape(req, res, clients.order, 'get', `/deliverymen/${req.params['id']}`, 'deliveryPartner'),
);
router.post('/delivery-partners', (req, res) =>
  reshape(req, res, clients.order, 'post', '/deliverymen', 'deliveryPartner', undefined, 'Delivery partner created'),
);
router.get('/delivery/requests', (req, res) =>
  reshape(req, res, clients.order, 'get', '/deliverymen/pending', 'requests'),
);
router.patch('/delivery/requests/:id', async (req, res) => {
  const action = String(req.body?.action || 'approve');
  const applicationStatus = action === 'reject' ? 'rejected' : 'approved';
  await reshape(req, res, clients.order, 'patch', `/deliverymen/${req.params['id']}/application-status`, 'deliveryPartner', { applicationStatus }, `Request ${applicationStatus}`);
});
router.patch('/delivery-partners/:id/status', (req, res) =>
  reshape(req, res, clients.order, 'patch', `/deliverymen/${req.params['id']}/status`, 'deliveryPartner', undefined, 'Status updated'),
);
router.get('/delivery-partners/:id/earnings', (req, res) =>
  reshape(req, res, clients.payment, 'get', `/api/v1/deliveryman-wallet/${req.params['id']}`, 'earnings'),
);
router.get('/delivery-partners/:id/wallet', (req, res) =>
  reshape(req, res, clients.payment, 'get', `/api/v1/deliveryman-wallet/${req.params['id']}/transactions`, 'transactions'),
);
router.get('/delivery-partners/:id/reviews', (req, res) =>
  reshape(req, res, clients.order, 'get', `/deliverymen/${req.params['id']}/reviews`, 'reviews'),
);

router.get('/deliveries', (req, res) =>
  reshape(req, res, clients.order, 'get', '/deliveries', 'deliveries'),
);
router.get('/deliveries/:id/track', (req, res) =>
  reshape(req, res, clients.order, 'get', `/deliveries/${req.params['id']}`, 'delivery'),
);
router.patch('/deliveries/:id/complete', async (req, res) => {
  req.url = `/deliveries/${req.params['id']}/delivered`;
  await reshape(req, res, clients.order, 'patch', `/deliveries/${req.params['id']}/delivered`, 'delivery', undefined, 'Delivery completed');
});
router.get('/delivery/analytics', (req, res) => {
  req.url = '/delivery';
  reportsProxy(req, res).catch((e) => sendDashboardError(res, e));
});

// ═══ KDS (P) ═════════════════════════════════════════════════════════════════

router.get('/kds/orders', (req, res) => {
  // Kitchen display: accepted + preparing orders (§12; WS in Phase 9)
  req.query['status'] = 'accepted,preparing';
  reshape(req, res, clients.order, 'get', '/orders', 'orders');
});

// ═══ Stubs (§9.3) ════════════════════════════════════════════════════════════

const STUB_ROUTES: Array<[string, string]> = [
  ['/settings/webhooks', 'Webhooks module is not yet implemented'],
  ['/reports/ratings', 'Ratings analytics unavailable — no reviews domain exists yet'],
];

for (const [path, msg] of STUB_ROUTES) {
  router.get(path, (_req, res) =>
    res.status(200).json({ success: true, message: `Module not yet implemented — ${msg}`, data: { items: [] } }),
  );
}

export default router;
