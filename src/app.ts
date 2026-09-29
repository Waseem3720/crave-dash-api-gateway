import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import healthRouter from './routes/health';
import authRouter from './routes/auth.routes';
import adminRouter from './routes/admin.routes';
import restaurantRouter from './routes/restaurant.routes';
import superAdminRouter from './routes/superadmin.routes';
import paymentsRouter from './routes/payments.routes';
import settingsRouter from './routes/settings.routes';
import notificationsRouter from './routes/notifications.routes';
import { makeReportsRouter } from './routes/reports.routes';
import { authenticate, requireSaasAdmin, requireRestaurantPanel, applyBranchScope } from './middleware/auth';

const app: Express = express();

// ─── Global middleware ───────────────────────────────────────────────────────
app.use(helmet());
// Dashboard browsers call this gateway directly with Authorization headers.
app.use(
  cors({
    origin: process.env['CORS_ORIGIN'] && process.env['CORS_ORIGIN'] !== '*' ? process.env['CORS_ORIGIN']!.split(',') : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-restaurant-id', 'Idempotency-Key'],
  }),
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
if (process.env['NODE_ENV'] !== 'test') {
  app.use(morgan('dev'));
}
app.set('trust proxy', 1);

// ─── Health (no auth) ────────────────────────────────────────────────────────
app.use('/health', healthRouter);

// ─── Auth (public + token routes; Auth role-dispatches the envelope) ─────────
app.use('/auth', authRouter);

// ─── Authenticated panels (JWT + panel gates + Manager branch scope) ─────────
const panelAuth = [authenticate, applyBranchScope];

// SaaS Super Admin panel (readme2.md §13)
app.use('/admin', authenticate, requireSaasAdmin, adminRouter);

// Restaurant panel (RSA / MANAGER / impersonated SSA)
app.use('/restaurant', ...panelAuth, requireRestaurantPanel, restaurantRouter);

// Super-admin platform surface (SSA only)
app.use('/super-admin', authenticate, requireSaasAdmin, superAdminRouter);

// Shared surfaces (any authenticated dashboard role)
// paymentsRouter defines its own /payments, /billing, /wallet, /loyalty,
// /pos-sessions, /cash-drawer paths internally — mount ONCE at root.
app.use('/', ...panelAuth, paymentsRouter);
app.use('/settings', ...panelAuth, settingsRouter);
app.use('/notifications', ...panelAuth, notificationsRouter);

// Reports surface (proxy — Reports enforces its own reporting permissions)
app.use('/reports', ...panelAuth, makeReportsRouter('/reports'));
app.use('/dashboard', ...panelAuth, makeReportsRouter('/dashboard'));
app.use('/audit-logs', ...panelAuth, makeReportsRouter('/audit-logs'));
app.use('/report-snapshots', ...panelAuth, makeReportsRouter('/report-snapshots'));
app.use('/scheduled-reports', ...panelAuth, makeReportsRouter('/scheduled-reports'));

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    error: 'NOT_FOUND',
    errorCode: 'NOT_FOUND',
  });
});

// ─── Global error handler ────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: unknown) => {
  console.error('[Gateway] Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: err.message || 'Internal gateway error',
    error: 'INTERNAL_SERVER_ERROR',
    errorCode: 'INTERNAL_SERVER_ERROR',
  });
});

export default app;
