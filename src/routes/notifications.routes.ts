import { Router, Request, Response } from 'express';
import { clients, upstreamGet, upstreamSend } from '../utils/proxy';
import { sendDashboardError } from '../utils/transform';

/**
 * /notifications* — Platform notification surface (readme2.md §12).
 * Customer storefront calls Platform directly; this proxy serves the dashboard.
 * PATCH /notifications/:id/read aliases Platform's POST (§9.1).
 */
const router = Router();

router.get('/', async (req, res) => {
  try {
    const result = await upstreamGet(clients.platform, '/notifications', req);
    res.status(result.status).json(result.body);
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.get('/history', async (req, res) => {
  try {
    const result = await upstreamGet(clients.platform, '/notifications', req);
    res.status(result.status).json(result.body);
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.get('/delivery-status', async (req, res) => {
  try {
    const result = await upstreamGet(clients.platform, '/notifications/delivery-status', req);
    res.status(result.status).json(result.body);
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.get('/unread-count', async (req, res) => {
  try {
    const result = await upstreamGet(clients.platform, '/notifications/unread-count', req);
    res.status(result.status).json(result.body);
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.post('/push', async (req, res) => {
  try {
    const result = await upstreamSend(clients.platform, 'post', '/notifications/push', req);
    res.status(result.status).json(result.body);
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.post('/sms', async (req, res) => {
  try {
    const result = await upstreamSend(clients.platform, 'post', '/notifications/sms', req);
    res.status(result.status).json(result.body);
  } catch (err) {
    sendDashboardError(res, err);
  }
});

router.post('/email', async (req, res) => {
  try {
    const result = await upstreamSend(clients.platform, 'post', '/notifications/email', req);
    res.status(result.status).json(result.body);
  } catch (err) {
    sendDashboardError(res, err);
  }
});

// PATCH alias of POST /notifications/:id/read (§9.1) — customer POST route untouched
router.patch('/:id/read', async (req, res) => {
  try {
    const result = await upstreamSend(clients.platform, 'post', `/notifications/${req.params['id']}/read`, req, {});
    res.status(result.status).json(result.body);
  } catch (err) {
    sendDashboardError(res, err);
  }
});

export default router;
