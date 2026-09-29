import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Request } from 'express';
import { env } from '../config/env';
import { toDashboardEnvelope } from './transform';

/**
 * Upstream proxy helpers (readme2.md §2).
 * - Per-dependency timeout (DEP_TIMEOUT_MS)
 * - Authorization + x-restaurant-id passthrough untouched (C-4: services
 *   re-derive tenant from JWT; the header stays advisory)
 * - Dashboard envelope reshape applied on success
 */

function buildClient(baseURL: string): AxiosInstance {
  return axios.create({
    baseURL,
    timeout: env.DEP_TIMEOUT_MS,
    // Do NOT throw on upstream error statuses — callers decide how to map them.
    validateStatus: () => true,
  });
}

export const clients = {
  auth: buildClient(env.AUTH_URL),
  platform: buildClient(env.PLATFORM_URL),
  catalog: buildClient(env.CATALOG_URL),
  order: buildClient(env.ORDER_URL),
  payment: buildClient(env.PAYMENT_URL),
  accounting: buildClient(env.ACCOUNTING_URL),
  reports: buildClient(env.REPORTS_URL),
};

export function forwardHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = req.headers.authorization;
  if (auth) headers['Authorization'] = auth;
  const rid = req.headers['x-restaurant-id'];
  if (rid) headers['x-restaurant-id'] = String(rid);
  const idem = req.headers['idempotency-key'];
  if (idem) headers['Idempotency-Key'] = String(idem);
  return headers;
}

export interface ProxyResult {
  status: number;
  body: unknown;
}

/** GET proxy returning raw upstream body + status (no reshape). */
export async function upstreamGet(
  client: AxiosInstance,
  url: string,
  req: Request,
  params?: Record<string, unknown>,
): Promise<ProxyResult> {
  const config: AxiosRequestConfig = { headers: forwardHeaders(req) };
  // Forward the caller's query string (page/limit/period/filters…) unless the
  // caller passed explicit params — before this, proxies silently dropped every
  // query string (Dashboard contract: pagination on all list surfaces).
  const effective = params && Object.keys(params).length ? params : (req.query as Record<string, unknown>);
  if (effective && Object.keys(effective).length) config.params = effective;
  const res = await client.get(url, config);
  return { status: res.status, body: res.data };
}

/** POST/PUT/PATCH/DELETE proxy returning raw upstream body + status. */
export async function upstreamSend(
  client: AxiosInstance,
  method: 'post' | 'put' | 'patch' | 'delete',
  url: string,
  req: Request,
  body?: unknown,
): Promise<ProxyResult> {
  const config: AxiosRequestConfig = { headers: forwardHeaders(req) };
  const query = req.query as Record<string, unknown>;
  if (query && Object.keys(query).length) config.params = query;
  const res = await client.request({ method, url, data: body ?? req.body, ...config });
  return { status: res.status, body: res.data };
}

/**
 * Proxy + reshape into the dashboard envelope. Throws on non-2xx with the
 * mapped error payload; callers catch and pass to sendDashboardError.
 */
export async function proxyAndShape(
  client: AxiosInstance,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  url: string,
  req: Request,
  resourceName: string,
  body?: unknown,
  message?: string,
): Promise<unknown> {
  const result =
    method === 'get'
      ? await upstreamGet(client, url, req, body as Record<string, unknown>)
      : await upstreamSend(client, method, url, req, body);
  if (result.status >= 400) {
    const err = new Error('Upstream error') as Error & { response?: { status: number; data: unknown } };
    err.response = { status: result.status, data: result.body };
    throw err;
  }
  return toDashboardEnvelope(result.body, resourceName, message);
}

/**
 * Fan-out helper with graceful partial failure (§2): returns per-call results,
 * never throws for individual dependency failures.
 */
export async function fanOut<T>(calls: Promise<T>[]): Promise<(T | null)[]> {
  return Promise.all(calls.map((p) => p.catch(() => null)));
}
