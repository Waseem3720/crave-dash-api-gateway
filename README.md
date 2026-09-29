# Gateway — Dashboard Aggregation Layer (port 4000)

The Gateway is the single base URL the **dashboard frontend** (SaaS Super Admin,
Restaurant Super Admin, Manager panels) calls. It proxies/composes the seven
backend microservices and reshapes responses into the dashboard contract from
`COMPREHENSIVE_API_INTEGRATION_GUIDE.md` / `readme2.md` §2.

> Storefront apps (customer web/PWA) are **not** affected — they keep calling the
> services directly. The frozen Customer contract (`Customer-Frontend-API .md`)
> is enforced by `tests/customer-regression/run.js`.

---

## Why a gateway

The dashboard frontend expects one base URL plus a slightly different response
vocabulary than the internal services speak:

| Concern | Internal services | Dashboard contract |
|---|---|---|
| Envelope | `{ success, data, meta? }` | `{ success, message?, data: { <resource>: rows }, pagination? }` |
| IDs | `_id` | `id` **and** `_id` (dual) |
| Roles in payloads | canonical (`SAAS_SUPER_ADMIN`, `RESTAURANT_SUPER_ADMIN`) | presentation labels (`SUPER_ADMIN`, `RESTAURANT_OWNER`) |
| Multi-service flows | client would need 2+ calls | one composite endpoint (POS complete, cancel+refund, invoice, employees/profile merge) |
| Missing modules | silent 404 | explicit stubs (`{ success: true, data: { items: [] } }` or documented 501) |

Canonical roles/statuses **never change** in tokens or the DB — aliases are
presentation-only, applied at the gateway boundary (readme2.md guardrails C-1/C-3).

## Architecture

```
Dashboard ──HTTP──▶ Gateway :4000 ──▶ Auth        :4001
                                 ├─▶ Platform     :3002
                                 ├─▶ Catalog      :4003
                                 ├─▶ Order        :4004   (Socket.IO KDS events)
                                 ├─▶ Payment      :4005
                                 ├─▶ Accounting   :4006
                                 └─▶ Reports      :3007
```

```
Gateway/src/
  server.ts            bootstrap (PORT=4000)
  app.ts               Express app — panel mounts
  config/env.ts        env + upstream service URLs + role presentation map
  middleware/auth.ts   JWT verify (shared JWT_ACCESS_SECRET), panel gates,
                       Manager branch scoping (applyBranchScope)
  utils/proxy.ts       axios clients + 5s per-dependency timeout, upstreamSend/Get
  utils/transform.ts   toDashboardEnvelope, normalizeRecord (id/_id + role labels),
                       sendDashboardError
  routes/
    health.ts          aggregated /health over all 7 services
    auth.routes.ts     /auth/* passthrough (Auth role-dispatches envelope itself)
    admin.routes.ts    /admin/*    — SSA panel (tenants, plans, users, reports)
    restaurant.routes.ts /restaurant/* — RSA/Manager panel + composites
    superadmin.routes.ts /super-admin/* — SSA platform surface + documented stubs
    payments.routes.ts /payments /billing /wallet /loyalty /pos-sessions /cash-drawer
    settings.routes.ts /settings/*
    notifications.routes.ts /notifications/* (+ PATCH :id/read alias)
    reports.routes.ts  /reports /dashboard /audit-logs /report-snapshots /
                       /scheduled-reports → Reports (prefix-stripped proxy)
```

## Panels & auth

| Mount | Gate (JWT role claim) | Notes |
|---|---|---|
| `/auth/*` | public (login/register/refresh) | envelope dispatched by Auth per role |
| `/admin/*` | `SAAS_SUPER_ADMIN` only | cross-tenant; `/admin/users` aliases Auth `/users` |
| `/super-admin/*` | `SAAS_SUPER_ADMIN` only | platform surface + stubs (`/features`, `/rate-limits`, `/sms-templates`) |
| `/restaurant/*` | `RESTAURANT_SUPER_ADMIN`, `MANAGER`, `SAAS_SUPER_ADMIN` | Manager branchIds enforced |
| `/payments`, `/settings`, `/notifications`, `/reports`, `/dashboard`, `/audit-logs`, … | any dashboard role | forwarding filters per panel |

**JWT**: same token as all services — signed by Auth with `JWT_ACCESS_SECRET`.
Claims used: `sub`, `role`, `userType`, `restaurantId`, `branchIds`,
`impersonatedBy?`.

**Manager branch scoping** (`applyBranchScope`): a MANAGER token with non-empty
`branchIds` cannot request a foreign `branchId` (→ 403); an unscoped list gets
`branchId=<claim>` injected. Notes: Auth populates the token's `branchIds` from
the `employee_branches` collection (not the user doc); Order additionally
enforces this server-side (defense in depth).

## Standard reshapes (every panel response)

1. **Envelope** → `data.<resourceName>` (rows), `data.pagination`
   `{ page, limit, total, pages }` derived from upstream `meta`.
2. **ID alias** → every record gets both `id` and `_id` (recursively).
3. **Role labels** → `role: SAAS_SUPER_ADMIN → SUPER_ADMIN`,
   `RESTAURANT_SUPER_ADMIN → RESTAURANT_OWNER` in user objects.
4. **Date aliases** → `createdAtDate` / `updatedAtDate` (`YYYY-MM-DD`) added.
5. **Errors** → `{ success: false, message, error, errorCode, details? }`;
   upstream 4xx/5xx statuses pass through; timeouts → `504 UPSTREAM_TIMEOUT`.

## Composite endpoints (§11)

| Endpoint | Flow |
|---|---|
| `PATCH /restaurant/pos/orders/:id/complete` | Payment capture → Order complete. Step-2 failure marks payment refund-pending and returns **409**. `Idempotency-Key` passthrough. |
| `PATCH /restaurant/orders/:id/cancel` | Order cancel (+ auto refund trigger when order was paid). |
| `GET /restaurant/orders/:id/invoice` | Order + payment merged into one invoice payload. |
| `GET /restaurant/employees` | Auth employees + Platform staff profiles merged. |
| `GET /restaurant/profile` | `user` (Auth /auth/me) + `restaurant` (Platform) + `settings`. |
| `POST /restaurant/customers/:id/message` | Notification dispatch (email/SMS by template). |
| `PATCH /restaurant/customers/bulk` | Bulk customer operations (ban/unban). |

## Documented stubs (never silent 404s)

`GET /super-admin/features`, `/super-admin/rate-limits`,
`/super-admin/sms-templates` → `200 { success, message: "Module not yet
implemented — …", data: { items: [] } }`. Ratings/forecast report stubs live in
Reports (`/reports/*`), also documented 501/empty responses.

## Upstream URL map (defaults)

| Env var | Default | Service |
|---|---|---|
| `AUTH_SERVICE_URL` | `http://localhost:4001` | Auth |
| `PLATFORM_SERVICE_URL` | `http://localhost:3002` | Platform |
| `CATALOG_SERVICE_URL` | `http://localhost:4003` | Catalog |
| `ORDER_SERVICE_URL` | `http://localhost:4004` | Order |
| `PAYMENT_SERVICE_URL` | `http://localhost:4005` | Payment |
| `ACCOUNTING_SERVICE_URL` | `http://localhost:4006` | Accounting |
| `REPORTS_SERVICE_URL` | `http://localhost:3007` | Reports |
| `JWT_ACCESS_SECRET` | — | **must equal** Auth's `JWT_ACCESS_SECRET` |
| `INTERNAL_API_KEY` | — | must match the shared service-to-service key |
| `ROLE_PRESENTATION_MAP` overrides | built-in C-3 map | labels only |

## Running

```bash
cd Gateway
npm install
cp .env.example .env        # fill JWT_ACCESS_SECRET + INTERNAL_API_KEY
PORT=4000 npm run dev       # http://localhost:4000/health
```

`GET /health` returns `200` with a per-service status map (503 if any core
service is down).

## Testing

| Suite | Command | Asserts |
|---|---|---|
| Dashboard contract (live) | `node tests/dashboard-contract/run.js` | envelope, gates, reshapes, composites, stubs — 32 checks |
| Customer regression (live) | `node tests/customer-regression/run.js` | frozen customer contract — 37 checks |
| Order unit tests | `cd Order && npm test` | aliases + canonical transition guards |

Both live suites need the services running (customer suite exits 2 when nothing
is reachable, so CI never gets a false green). The dashboard suite seeds its own
SSA/RSA/MANAGER users and one test tenant (`tests/dashboard-contract/seed.js`,
idempotent, password `DashTest123!` — local dev only).
