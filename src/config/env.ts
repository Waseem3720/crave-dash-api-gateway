import dotenv from 'dotenv';

dotenv.config();

/**
 * Gateway configuration (readme2.md §16).
 * All service URLs default to the documented dev ports; override per deployment.
 */
function req(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const env = {
  PORT: parseInt(process.env['GATEWAY_PORT'] || '4000', 10),
  NODE_ENV: process.env['NODE_ENV'] || 'development',

  // JWT — must match Auth Service's access-token secret
  JWT_ACCESS_SECRET: process.env['JWT_ACCESS_SECRET'] || process.env['JWT_SECRET'] || 'dev_access_secret',

  // Downstream services
  AUTH_URL: req('AUTH_URL', 'http://localhost:4001'),
  PLATFORM_URL: req('PLATFORM_URL', 'http://localhost:3002'),
  CATALOG_URL: req('CATALOG_URL', 'http://localhost:4003'),
  ORDER_URL: req('ORDER_URL', 'http://localhost:4004'),
  PAYMENT_URL: req('PAYMENT_URL', 'http://localhost:4004'),
  ACCOUNTING_URL: req('ACCOUNTING_URL', 'http://localhost:4006'),
  REPORTS_URL: req('REPORTS_URL', 'http://localhost:4007'),

  INTERNAL_API_KEY: req('INTERNAL_API_KEY', ''),

  // Resilience
  DEP_TIMEOUT_MS: parseInt(process.env['GATEWAY_DEP_TIMEOUT_MS'] || '5000', 10),

  // Role presentation labels (C-3): canonical roles stay canonical in tokens/DB
  ROLE_PRESENTATION_MAP: {
    SAAS_SUPER_ADMIN: 'SUPER_ADMIN',
    RESTAURANT_SUPER_ADMIN: 'RESTAURANT_OWNER',
  } as Record<string, string>,

  isProduction: process.env['NODE_ENV'] === 'production',
};
