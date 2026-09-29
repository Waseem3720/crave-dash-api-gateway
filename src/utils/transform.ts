import { Response } from 'express';
import { env } from '../config/env';

/**
 * Dashboard response reshapes (readme2.md §2 "standard reshapes").
 * Applied to every dashboard-facing response at the gateway:
 *   1. envelope { success, message?, data: { <resource>: rows }, pagination?, meta? }
 *   2. id + _id on every record
 *   3. role presentation labels in user objects
 *   4. errors { success:false, message, error, errorCode, details? }
 */

export function presentationRole(role: unknown): unknown {
  if (typeof role === 'string') return env.ROLE_PRESENTATION_MAP[role] ?? role;
  return role;
}

/** Deep-copy with id/_id aliasing and role presentation mapping. */
export function normalizeRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeRecord);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'role' || k === '_roleLabel') {
        out[k] = presentationRole(v);
      } else if (k === 'createdAt' || k === 'updatedAt' || k.endsWith('At') || k.endsWith('Date')) {
        out[k] = v;
        if ((k === 'createdAt' || k === 'updatedAt' || k === 'joinedAt') && (typeof v === 'string' || v instanceof Date)) {
          const d = v instanceof Date ? v : new Date(v);
          if (!Number.isNaN(d.getTime())) out[`${k}Date`] = d.toISOString().slice(0, 10);
        }
      } else {
        out[k] = normalizeRecord(v);
      }
    }
    // id/_id alias — add whichever is missing
    const rawId = out['id'] ?? out['_id'];
    if (rawId !== undefined) {
      out['id'] = rawId;
      out['_id'] = rawId;
    }
    return out;
  }
  return value;
}

/**
 * Reshape an upstream service response (order-service envelope
 * `{ success, data, meta? }` or any service payload) into the dashboard
 * envelope. `resourceName` is the key the dashboard reads rows from (§2.1).
 */
export function toDashboardEnvelope(
  upstreamBody: unknown,
  resourceName: string,
  message?: string,
): unknown {
  const body = (upstreamBody ?? {}) as Record<string, unknown>;
  const success = body['success'] !== false;
  if (!success) return body; // error passthrough (handled by mapError)

  let data = body['data'];
  // Upstream list endpoints wrap rows directly in data (data: [...]) or in a
  // named key (data: { orders: [...] }). Normalize both to data.<resourceName>.
  let rows: unknown;
  let pagination: unknown;
  const meta = body['meta'] as Record<string, unknown> | undefined;

  if (Array.isArray(data)) {
    rows = data;
    pagination = meta
      ? {
          page: meta['page'],
          limit: meta['limit'],
          total: meta['total'],
          pages: meta['totalPages'] ?? meta['pages'],
        }
      : undefined;
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const candidate = obj[resourceName];
    if (candidate !== undefined) {
      rows = candidate;
    } else if (Array.isArray(obj['items'])) {
      rows = obj['items'];
    } else {
      // Detail payloads: keep the object as-is
      rows = data;
    }
    // pagination may come as meta { page, limit, total, totalPages } or explicit pagination
    pagination =
      obj['pagination'] ??
      (meta
        ? {
            page: meta['page'],
            limit: meta['limit'],
            total: meta['total'],
            pages: meta['totalPages'] ?? meta['pages'],
          }
        : undefined);
  } else {
    rows = data;
  }

  const normalizedRows = normalizeRecord(rows);
  const out: Record<string, unknown> = {
    success: true,
    ...(message || body['message'] ? { message: message || body['message'] } : {}),
    data: { [resourceName]: normalizedRows },
  };
  if (pagination && typeof pagination === 'object' && pagination !== null && 'total' in (pagination as Record<string, unknown>)) {
    const p = pagination as { page?: number; limit?: number; total?: number; pages?: number; totalPages?: number };
    out['data'] = {
      [resourceName]: normalizedRows,
      pagination: {
        page: p.page ?? 1,
        limit: p.limit ?? 20,
        total: p.total ?? 0,
        pages: p.pages ?? p.totalPages ?? 1,
      },
    };
    // meta alias (§2.1) — harmless, helps non-dashboard clients
    out['meta'] = {
      page: p.page ?? 1,
      limit: p.limit ?? 20,
      total: p.total ?? 0,
      totalPages: p.pages ?? p.totalPages ?? 1,
    };
  }
  return out;
}

/** Map any upstream/axios error into the dashboard error shape. */
export function mapErrorPayload(err: unknown): { status: number; body: Record<string, unknown> } {
  const anyErr = err as { response?: { status?: number; data?: Record<string, unknown> }; message?: string; code?: string };
  const status = anyErr?.response?.status ?? 502;
  const upstream = anyErr?.response?.data as Record<string, unknown> | undefined;
  const upstreamError = (upstream?.['error'] ?? upstream) as Record<string, unknown> | undefined;
  const code =
    (typeof upstreamError?.['code'] === 'string' && upstreamError['code']) ||
    (typeof upstream?.['errorCode'] === 'string' && upstream?.['errorCode']) ||
    'UPSTREAM_ERROR';
  const message =
    (typeof upstreamError?.['message'] === 'string' && upstreamError['message']) ||
    (typeof upstream?.['error'] === 'string' && upstream?.['error']) ||
    anyErr?.message ||
    'Upstream service error';
  return {
    status,
    body: {
      success: false,
      message,
      error: code,
      errorCode: code,
      ...(upstreamError?.['details'] ? { details: upstreamError['details'] } : {}),
    },
  };
}

/** Send a dashboard-shaped error response. */
export function sendDashboardError(res: Response, err: unknown): Response {
  const { status, body } = mapErrorPayload(err);
  return res.status(status).json(body);
}
