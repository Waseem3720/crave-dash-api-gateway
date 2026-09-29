import { Router, Request, Response } from 'express';
import { clients, upstreamSend, upstreamGet } from '../utils/proxy';
import { sendDashboardError } from '../utils/transform';

/**
 * /auth/* — thin proxy to Auth Service (readme2.md §12).
 * Auth Service performs the role-dispatched envelope itself (§4.1), so the
 * gateway forwards bodies/headers untouched. No reshape here on purpose:
 * customer storefront apps use direct service URLs; the dashboard reads the
 * wrapped `data` block Auth adds for non-customer roles.
 */
const router = Router();

const AUTH_METHODS: Record<string, 'post' | 'get'> = {
  '/login': 'post',
  '/logout': 'post',
  '/refresh': 'post',
  '/register': 'post',
  '/forgot-password': 'post',
  '/reset-password': 'post',
  '/change-password': 'post',
  '/me': 'get',
  '/otp/verify': 'post',
  '/otp/resend': 'post',
};

router.all('/*', async (req: Request, res: Response) => {
  try {
    const method = AUTH_METHODS[req.path] ?? (req.method.toLowerCase() === 'get' ? 'get' : 'post');
    const result =
      method === 'get'
        ? await upstreamGet(clients.auth, `/auth${req.path}`, req)
        : await upstreamSend(clients.auth, method, `/auth${req.path}`, req);
    res.status(result.status).json(result.body);
  } catch (err) {
    sendDashboardError(res, err);
  }
});

export default router;
