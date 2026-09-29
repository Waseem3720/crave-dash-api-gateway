import { Router, Request, Response } from 'express';
import { clients, upstreamGet, upstreamSend } from '../utils/proxy';
import { sendDashboardError, toDashboardEnvelope } from '../utils/transform';
import { env } from '../config/env';

/**
 * /settings/* — settings surface (readme2.md §9.2).
 * - GET/PUT /settings                → Platform operational-settings summary
 * - GET/PUT /settings/notifications  → Platform notification-settings
 * - GET/POST/DELETE /settings/api-keys → restaurant API key (single-key model)
 * - /settings/webhooks               → documented stub (§9.3)
 */
const router = Router();

router.get('/', async (req, res) => {
  try {
    // Platform serves operational settings at /settings (operational-settings router:
    // router.use('/settings', …) — the flat /operational-settings path is not routed).
    const result = await upstreamGet(clients.platform, '/settings', req);
    res.status(200).json(toDashboardEnvelope(result.body, 'settings'));
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.put('/', async (req, res) => {
  try {
    const result = await upstreamSend(clients.platform, 'put', '/settings', req);
    if (result.status >= 400) {
      throw Object.assign(new Error('Upstream error'), { response: { status: result.status, data: result.body } });
    }
    res.status(200).json(toDashboardEnvelope(result.body, 'settings', 'Settings updated'));
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.get('/notifications', async (req, res) => {
  try {
    const result = await upstreamGet(clients.platform, '/notification-settings', req);
    res.status(200).json(toDashboardEnvelope(result.body, 'settings'));
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.put('/notifications', async (req, res) => {
  try {
    const result = await upstreamSend(clients.platform, 'put', '/notification-settings', req);
    if (result.status >= 400) {
      throw Object.assign(new Error('Upstream error'), { response: { status: result.status, data: result.body } });
    }
    res.status(200).json(toDashboardEnvelope(result.body, 'settings', 'Notification settings updated'));
  } catch (err) {
    sendDashboardError(res, err);
  }
});

// Single-key model: the restaurant has one API key (§9.2 — multi-key out of scope)
router.get('/api-keys', async (req, res) => {
  try {
    const rid = req.gwUser?.restaurantId;
    if (!rid) {
      return res.status(403).json({ success: false, message: 'No restaurant context', error: 'FORBIDDEN', errorCode: 'FORBIDDEN' });
    }
    const result = await upstreamGet(clients.platform, `/restaurants/${rid}/api-key`, req);
    const key = (result.body as Record<string, unknown>)?.['data'] ?? null;
    res.status(200).json({ success: true, data: { items: key ? [key] : [] } });
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.post('/api-keys', async (req, res) => {
  try {
    const rid = req.gwUser?.restaurantId;
    if (!rid) {
      return res.status(403).json({ success: false, message: 'No restaurant context', error: 'FORBIDDEN', errorCode: 'FORBIDDEN' });
    }
    const result = await upstreamSend(clients.platform, 'post', `/restaurants/${rid}/api-key/regenerate`, req);
    if (result.status >= 400) {
      throw Object.assign(new Error('Upstream error'), { response: { status: result.status, data: result.body } });
    }
    const key = (result.body as Record<string, unknown>)?.['data'] ?? null;
    res.status(201).json({ success: true, message: 'API key regenerated', data: { items: key ? [key] : [] } });
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.delete('/api-keys/:id', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'Single-key model — use POST /settings/api-keys to rotate; individual key deletion not supported',
    data: { deleted: false },
  });
});

// Stub (§9.3)
router.get('/webhooks', (_req, res) =>
  res.status(200).json({ success: true, message: 'Module not yet implemented — webhooks', data: { items: [] } }),
);

export default router;
