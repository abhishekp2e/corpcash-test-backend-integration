# Corpcash RBAC — developer integration guide

**Package READMEs are the source of truth** for APIs, options, errors, and types. This file is the **end-to-end integration path**: how the four npm packages fit together, then how **this repository** wires them (JWT, Postgres, Express `:3000`, React `:5173`).

| Package | Source of truth | This stack uses it for |
|---------|-----------------|------------------------|
| [`@corpcash/rbac-core`](https://www.npmjs.com/package/@corpcash/rbac-core) | [packages/core/README.md](https://github.com/abhishekp2e/corpcash-rback/tree/main/packages/core#readme) | In-memory engine (`authorize`, policies, `getEffectivePermissions`) |
| [`@corpcash/rbac-node`](https://www.npmjs.com/package/@corpcash/rbac-node) | [packages/node/README.md](https://github.com/abhishekp2e/corpcash-rback/tree/main/packages/node#readme) | Express `authorize()` + `createRbacAdminRouter` |
| [`@corpcash/rbac-react`](https://www.npmjs.com/package/@corpcash/rbac-react) | [packages/react/README.md](https://github.com/abhishekp2e/corpcash-rback/tree/main/packages/react#readme) | UX gates (`RBACProvider`, `useCan`, `<Can>`, `RequireRole`) |
| [`@corpcash/rbac-store`](https://www.npmjs.com/package/@corpcash/rbac-store) | [packages/store/README.md](https://github.com/abhishekp2e/corpcash-rback/tree/main/packages/store#readme) | Postgres role graph + subject assignments |

Install from npm **^0.3.0**. In-app copy of this guide: frontend **`/docs`**.

Do **not** invent `x-user-id` demo users, port 4000, or a separate `corpcash-backend` app. This POC is Bearer JWT on **http://localhost:3000**.

---

## How the four packages fit

```
@corpcash/rbac-core          decisions only (in memory)
        ▲
        │
   ┌────┴────┬────────────────┐
   │         │                │
rbac-node  rbac-store    rbac-react
HTTP      persist roles   UX gates
adapters  + assignments   (permission-only)
```

| Layer | Package | Does | Does not |
|-------|---------|------|----------|
| Engine | **core** | `subject + action + resource (+ context) → allow/deny` | Load config from disk/DB, speak HTTP, render UI |
| HTTP | **node** | Express middleware, Nest guards, `/rbac` admin router | Persist config (re-exports store helpers) |
| Persist | **store** | Roles, `inherits`, `strictRoles`, subject → roles | Store `PolicyFn` or `onDecision` |
| UI | **react** | Hide/show controls from `permissions[]` | Enforce security, run policies |

Evaluation order (core — every adapter uses this):

1. Resolve the subject (`id` required)
2. Expand roles (inheritance)
3. Match `resource:action` (wildcards: `wallet:*`, `*:read`, `*:*`)
4. Run **every** matching policy — all must pass
5. Default deny if the permission is missing or a policy fails

Policies can only **narrow** a grant. They never add a permission. `*:*` still runs policies.

---

## 1. `@corpcash/rbac-core` — construct, policy, decide

Canonical API: **core README** (constructor fields, methods, helpers, errors, types).

```bash
npm install @corpcash/rbac-core@^0.3.0
```

```
1. new RBAC({ roles }) or new RBAC({ permissions })
2. rbac.registerPolicyFor(...)     ← instance rules; stay in code
3. rbac.authorize({ subject, action, resource, context? })
4. Hand the UI rbac.getEffectivePermissions(subject)
5. After a role-graph change: rbac.reload(nextConfig)
```

### Concepts

| Concept | Meaning | Example |
|---------|---------|---------|
| **Subject** | Who is asking | `{ id: "u1", roles: ["developer"], attributes? }` |
| **Role** | Named permissions, optional `inherits` | `developer` inherits `viewer` |
| **Permission** | `resource:action` | `wallet:read`, `*:*` |
| **Action** | Operation string | `read`, `delete`, `deploy` |
| **Resource** | Type **or** instance | `"wallet"` or `{ type: "wallet", id: "w1", ownerId }` |
| **Policy** | Extra check after a permission match | owner of the wallet |

**Role mode** (`roles`) and **permission-only mode** (`permissions`) cannot be combined. The frontend uses permission-only after `GET /me/authorization`.

### Construct

```js
import { RBAC } from "@corpcash/rbac-core";

const rbac = new RBAC({
  roles: {
    viewer: { permissions: ["wallet:read", "transaction:read"] },
    developer: {
      inherits: ["viewer"],
      permissions: ["wallet:create", "wallet:delete", "contract:deploy"],
    },
    admin: { permissions: ["*:*"] },
  },
  strictRoles: false,
  onDecision: ({ request, result, durationMs }) => {
    if (!result.allowed) console.warn(request.subject.id, result.reason, durationMs);
  },
});
```

`onDecision` exceptions are swallowed so a broken logger cannot change a decision. Invalid role graphs (cycles, dangling `inherits`, bad `resource:action`) throw at construction.

Permission-only (UI):

```js
const ui = new RBAC({ permissions: ["wallet:read", "wallet:create"] });
// malformed entries are skipped (fail closed) → ui.invalidPermissions
```

### Register policies

```js
rbac.registerPolicyFor("wallet", "delete", ({ subject, resource }) => {
  if (typeof resource !== "object" || resource == null) return false;
  return subject.id === String(resource.ownerId);
});

rbac.registerPolicy("transaction:approve", ({ subject, resource, context }) => {
  return subject.attributes?.organizationId === context?.organizationId;
});
```

Matching keys, most specific first: `wallet:delete`, `wallet:*`, `*:delete`, `*:*`. Every registered match must return `true`. `reload()` keeps policies and `onDecision`.

Use `authorizeAsync` / `canAsync` when a policy returns a promise. Sync `authorize()` / `can()` throw `AsyncPolicyError` in that case.

### Decide

```js
const subject = { id: "u1", roles: ["developer"] };

rbac.can(subject, "read", "wallet");

const result = rbac.authorize({
  subject,
  action: "delete",
  resource: { type: "wallet", id: "w1", ownerId: "u1" },
  context: { tenantId: "org_1" },
});
// { allowed, reason, resource, action, matchedRole?, matchedPermission?, ignoredRoles? }
// reason: AUTHORIZED | MISSING_PERMISSION | POLICY_DENIED | NO_SUBJECT
```

Unknown subject roles are skipped (`ignoredRoles`) unless `strictRoles: true` (`UnknownRoleError`).

### Methods you will call from adapters

| Method | Use |
|--------|-----|
| `authorize` / `authorizeAsync` | Full decision (HTTP adapters use async) |
| `can` / `canAsync` | Boolean |
| `registerPolicyFor` / `registerPolicy` | Instance rules |
| `reload({ roles, strictRoles })` | After store role-graph writes (`reloadFromStore` wraps this) |
| `getEffectivePermissions(subject)` | Flat list for the UI — **expands inheritance, not policies** |
| `getEffectiveRoles` / `hasRole` | Inheritance-aware role membership (backend engine) |

Helpers (`parsePermission`, `formatPermission`, `validateRoleGraph`, `getResourceType`) and the error table live in the **core README**.

---

## 2. `@corpcash/rbac-node` — put the engine on HTTP

Canonical API: **node README** (Express options, NestJS module, 401/403 bodies, admin mount).

```bash
npm install @corpcash/rbac-node@^0.3.0 @corpcash/rbac-core@^0.3.0
# database-backed roles
npm install @corpcash/rbac-store@^0.3.0 pg
```

```
1. createRBAC({ roles })  or  createRBACFromStore(store)
2. rbac.registerPolicyFor(...)
3. Express authorize() / Nest RbacGuard on every mutating route
4. GET /me/authorization  ← effective permissions for the UI
5. Optional: mount /rbac  ← live role edits (needs rbac:manage)
```

```
request → getSubject → authorizeAsync(subject, action, resource)
        → 401 if no subject
        → 403 if denied (reason in the body)
        → next() / handler if allowed
```

`createRBAC` is `new RBAC(config)` from core. `createRBACFromStore`, `reloadFromStore`, `memoryStore`, and `createStoreSubjectResolver` are re-exported from store.

### Express (this POC)

```js
import { createExpressMiddleware } from "@corpcash/rbac-node/express";

const { authorize } = createExpressMiddleware({
  rbac,
  getSubject: (req) => req.subject ?? null, // sync or async
  // onUnauthenticated, onForbidden — optional; see node README
});

app.get("/wallets", authorize("wallet", "read"), listWallets);

app.delete(
  "/wallets/:id",
  authorize({
    resource: "wallet",
    action: "delete",
    getResource: (req) => ({
      type: "wallet",
      id: req.wallet.id,
      ownerId: req.wallet.ownerId,
    }),
    getContext: (req) => ({ tenantId: req.headers["x-tenant"] }),
  }),
  deleteWallet,
);
```

| Status | When |
|--------|------|
| **401** | No subject, or subject has no `id` |
| **403** | Engine denied (`reason` in the JSON body) |

`authorize("wallet", "read")` is a **type-level** check. `getResource` supplies the **instance** for policies. The route's `resource` string always decides which permission is checked; a differing instance `type` is overridden and warned.

Default bodies (node README):

```json
{ "statusCode": 401, "error": "Unauthorized", "message": "Authentication required." }
{ "statusCode": 403, "error": "Forbidden", "message": "...", "reason": "POLICY_DENIED" }
```

This POC's own `requireAuth` returns `{ "error": "Unauthorized" }` / `{ "error": "Invalid or expired token" }` **before** the engine sees the request.

### Hand the UI its upper bound

```js
app.get("/me/authorization", requireAuth, loadUser, (req, res) => {
  res.json({
    subject: req.subject,
    roles: req.subject.roles,
    permissions: rbac.getEffectivePermissions(req.subject),
  });
});
```

### Admin HTTP API

Mount after the engine is loaded from a store. Every route requires `rbac:manage` or `*:*`. Route table, reload column, and curls: **store README → Admin HTTP API** (node README points there).

```js
import { createRbacAdminRouter } from "@corpcash/rbac-node/express";

app.use("/rbac", requireAuth, loadUser, createRbacAdminRouter({
  store,
  rbac,
  getSubject: (req) => req.subject,
}));
```

If `getSubject` is omitted, the router reads `x-user-id` and loads roles from the store. **This POC never uses that default** — it always passes the JWT-resolved subject.

### NestJS

Not used in this POC. Follow **node README §3**: `RbacModule.forRoot` / `forRootAsync`, `{ provide: APP_GUARD, useExisting: RbacGuard }`, `@RequirePermission`, `@PublicRoute`, `RbacAdminModule.register()`.

---

## 3. `@corpcash/rbac-react` — UX only

Canonical API: **react README** (provider props, hooks, gates).

```bash
npm install @corpcash/rbac-react@^0.3.0 @corpcash/rbac-core@^0.3.0 react
```

The backend must authorize every API request. Do **not** send the role graph or policy functions to the browser.

```
Login
  → GET /me/authorization  →  { subject, roles, permissions }
  → <RBACProvider subject={...} permissions={...}>
        ├── useCan / <Can> / <RequirePermission>   generic UI
        └── GET /wallets/:id/capabilities          instance UI (policies)
```

`permissions` expands inheritance on the server. It does **not** apply policies. Treat it as an **upper bound**: the API can still return 403.

```jsx
import {
  RBACProvider,
  useCan,
  useRole,
  useRBAC,
  Can,
  RequirePermission,
  RequireRole,
} from "@corpcash/rbac-react";

<RBACProvider
  subject={auth.subject}
  permissions={auth.permissions}
  onInvalidPermissions={(invalid) => console.warn("unusable permissions", invalid)}
>
  <Dashboard />
</RBACProvider>
```

Pass `permissions`, not `roles`. If both are set, the provider prefers `permissions` (`new RBAC({ permissions })`). Malformed strings are skipped (fail closed) and appear on `useRBAC().invalidPermissions`.

### Generic UI vs instance UI

| | Generic (Type A) | Instance (Type B) |
|--|------------------|-------------------|
| When | Not tied to one record (`wallet:create`) | Ownership / org / amount on **this** record |
| API | `permissions[]` from `/me/authorization` | `GET /wallets/:id/capabilities` (same `authorize()` as the mutating route) |
| Hook | `useCan("wallet", "create")` / `<Can>` | `caps.capabilities.delete.allowed` |
| Policy | Not evaluated (type string) | Evaluated (resource object) |

`useCan(resource, action, instance?)` still only checks the permission list in permission-only mode. Do **not** register policies in the browser. Even if someone unhides a button, `DELETE /wallets/:id` still returns 403.

### Exports (see react README for props)

| Export | Role |
|--------|------|
| `RBACProvider` | Creates the in-memory engine; must wrap hooks/gates |
| `useRBAC()` | `{ can, subject, invalidPermissions, rbac }` |
| `useCan(resource, action, instance?)` | Permission boolean |
| `useRole(roleName)` | In permission-only mode: `subject.roles` only (no client inheritance) |
| `<Can>` / `<RequirePermission>` | Conditional render / section guard |
| `<RequireRole>` | Role guard; same inheritance rules as `useRole` |

This POC: `ProtectedRoute` mounts the provider; `/roles/:role` uses `RequireRole`. A **manager** is denied on `/roles/developer` because the client does not expand inheritance.

Do **not** import `@corpcash/rbac-store` in the frontend. `rbac-core` is a transitive dependency of `rbac-react`; you do not construct `RBAC` yourself in this app.

---

## 4. `@corpcash/rbac-store` — persist roles, not policies

Canonical API: **store README** (adapters, every store method, admin `curl`s, schema).

```bash
npm install @corpcash/rbac-store@^0.3.0 @corpcash/rbac-core@^0.3.0
npm install pg
# or mysql2 / mongodb
```

| In the database | Stays in application code |
|-----------------|---------------------------|
| Role names, permissions, `inherits` | `PolicyFn` (`registerPolicyFor`) |
| `strictRoles` | `onDecision` |
| Subject id → role names | Express `getSubject`, `getResource`, JWT auth |

```
1. Create a store adapter (postgres / mysql / mongo / memory)
2. await store.migrate()      ← you call this; creates tables only
3. optional store.seed(...)   ← first-boot roles if the table is empty
4. createRBACFromStore(store)
5. registerPolicyFor(...)     ← instance rules stay in code
6. Add roles / assignments with either:

     A. Store methods                 B. Admin HTTP API (/rbac)
        store.upsertRole(...)            POST /rbac/roles
        store.assignRole(...)            PUT  /rbac/subjects/:id/roles
```

Both write paths use the **same tables**. Role-graph writes (`upsertRole`, `deleteRole`, `updateSettings`, `seed` if it inserted) need `reloadFromStore` — the admin router does this. Assignment writes do **not** reload: `getSubject` / `getRolesForSubject` run per request.

### Connect + migrate + load

```js
import { postgresStore } from "@corpcash/rbac-store/postgres";
import { createRBACFromStore } from "@corpcash/rbac-store";

const store = postgresStore({
  pool, // this POC shares db.js Pool
  // or: connectionString: process.env.DATABASE_URL
  // tablePrefix: "rbac_",
});

await store.migrate();
await store.seed({ roles: rbacConfig.roles }); // no-op if any role exists

const rbac = await createRBACFromStore(store, { onDecision });
rbac.registerPolicyFor("wallet", "delete", ownershipPolicy);
```

`migrate()` creates schema and the default settings row. It does **not** insert roles. Schema (prefix `rbac_`):

- `rbac_roles(name PK, permissions json, inherits json, updated_at)`
- `rbac_assignments(subject_id, role_name, PK(subject_id, role_name))`
- `rbac_settings(id=1, strict_roles)`

### Store methods (summary)

Full signatures and errors: **store README**. Reload after role-graph writes only.

| Method | Reloads? |
|--------|----------|
| `migrate()` / `seed(config)` / `loadConfig()` / `listRoles()` | seed: if it inserted |
| `upsertRole` / `deleteRole` / `updateSettings` | **yes** — you or the admin router |
| `getRolesForSubject` / `setRolesForSubject` / `assignRole` / `revokeRole` | **no** |
| `getSettings` | no |

`deleteRole` fails if the role is missing, still assigned, or inherited (`StoreNotFoundError` / graph errors). Writes validate `resource:action` and inheritance before commit.

`createStoreSubjectResolver(store, (req) => req.user?.id)` is the library helper. This POC uses a custom `resolveSubject` so it can attach `attributes` and fall back to `users.role`.

---

## 5. End-to-end: this repository

### Stack

| Item | Value |
|------|--------|
| Backend | `backend-integration` · Express ESM · **http://localhost:3000** |
| Frontend | `frontend-integration` · Vite + React 19 · **http://localhost:5173** |
| Auth | `Authorization: Bearer <JWT>` — payload `{ sub, username }` only |
| Roles | Store assignments, **not** the JWT |
| Policies | `backend-integration/rbac.js` |

```
backend-integration/
├── index.js            # auth, /me/authorization, resources, /rbac
├── auth.js             # users table, bcrypt, JWT
├── db.js               # pg Pool from DATABASE_URL
├── rbac.config.js      # seed catalog (RESOURCES, ACTIONS, roles)
├── rbac.js             # migrate/seed + policies + admin + capabilities
├── resources.js        # in-memory wallets / transactions (reset on restart)
└── .env

frontend-integration/
├── src/api.js
├── src/AuthContext.jsx
├── src/ProtectedRoute.jsx          # RBACProvider
├── src/RequireRole.jsx
├── src/components/AdminApiPanel.jsx
├── src/components/ResourceApiPanel.jsx
└── .env                            # VITE_API_URL
```

### Prerequisites

1. Node.js ≥ 18
2. Postgres on `localhost:5432` (user `postgres` / password `root`, or change `DATABASE_URL`)
3. npm registry access for `@corpcash/rbac-*` **^0.3.0**

### Run

```bash
# Terminal 1
cd backend-integration
cp -n .env.example .env
npm install
npm run dev               # http://localhost:3000

# Terminal 2
cd frontend-integration
cp -n .env.example .env
npm install
npm run dev               # http://localhost:5173
```

Backend `.env`:

```
PORT=3000
DATABASE_URL=postgresql://postgres:root@localhost:5432/postgres
JWT_SECRET=dev-jwt-secret-change-in-production
JWT_EXPIRES_IN=7d
CORS_ORIGIN=http://localhost:5173
```

Frontend `.env`:

```
VITE_API_URL=http://localhost:3000
```

The UI calls that origin **directly** (CORS). The Vite `/api` proxy exists but is **not** used by `src/api.js`.

Open http://localhost:5173 → Register (pick a role) → Dashboard. Docs: http://localhost:5173/docs.

### Boot sequence

1. Create `users` if missing (`auth.js`)
2. `postgresStore({ pool }).migrate()`
3. `store.seed({ roles: rbacConfig.roles })` — no-op if any role exists
4. `createRBACFromStore` then `registerPolicyFor` in `rbac.js`
5. Mount resource routes; register `POST /rbac/authorize` **before** `app.use("/rbac", ...)`
6. Mount `createRbacAdminRouter` at `/rbac`

### Subject resolution

```
Authorization: Bearer <jwt>
        ↓ verifyToken → { sub, username }
        ↓ findUserById(sub) → users row
        ↓ store.getRolesForSubject(String(id))
        ↓ if empty: fall back to users.role and write that assignment
        ↓ subject = {
            id: String(users.id),
            roles: [...store roles],
            attributes: { username, organizationId: "org_1" }
          }
```

`users.role` is the **registration snapshot**. After `PUT /rbac/subjects/:id/roles` it can drift. Authorize and the UI must use `subject.roles`. `GET /me/authorization` sets `user.role` / `user.roles` from the store.

Every subject has `attributes.organizationId = "org_1"` unless you add `users.organization_id`. That is required for the approve policy.

### Seeded role graph (`rbac.config.js`)

`store.seed()` runs only when `rbac_roles` is empty. Later edits go through `/rbac/roles`. An already-used database may contain extra roles (for example `auditor`). `GET /auth/roles` is the live list.

| Role | Direct permissions | Inherits |
|------|--------------------|----------|
| `viewer` | `wallet:read`, `transaction:read`, `dashboard:read` | — |
| `developer` | `wallet:create`, `wallet:update`, `contract:read`, `contract:deploy` | viewer |
| `manager` | `transaction:approve`, `wallet:delete`, `user:read`, `report:read` | developer |
| `admin` | `*:*` | — |

Developer has **no** `transaction:approve`. Admin `/rbac` works because `*:*` includes `rbac:manage`.

### Policies in this POC

Registered **after** `createRBACFromStore`. `reloadFromStore` keeps them.

**`wallet:delete` — ownership.** If `resource` is an object with `ownerId`, require `subject.id === String(ownerId)`. If `resource` is only the type string (`"wallet"`), this POC's policy **returns true** so Type A `/me/authorization` can still report the permission. Official core examples often `return false` when there is no instance — do not copy that blindly here.

**`transaction:approve` — org + amount.** If `resource` is an object: deny when orgs differ; if `amount > 100000` allow only when `subject.roles` includes `"admin"`; otherwise allow. Type-string resource → skip (return true). Admin is denied on `tx_3` (`org_2`) because `*:*` still runs policies.

---

## 6. This server's API contract

All JSON. Authenticated routes: `Authorization: Bearer <token>`.

Unauthenticated (POC `requireAuth`) → `401 { "error": "Unauthorized" }` or `{ "error": "Invalid or expired token" }`.

Denied by node middleware → `403 { "statusCode": 403, "error": "Forbidden", "message": "...", "reason": "MISSING_PERMISSION" | "POLICY_DENIED" | ... }`.

### Health and auth

`GET /health` → `{ "status": "ok", "db": "up" }` (or `503`).

`GET /auth/roles` → `{ "roles": ["admin", "developer", ...] }` from `store.listRoles()`.

`POST /auth/register` `{ "username", "password", "role" }`

- `201` `{ "token", "user": { "id", "username", "role", "roles" } }`
- `400` username &lt; 3, password &lt; 6, or unknown role
- `409` username taken
- Also `store.setRolesForSubject(String(id), [role])`

`POST /auth/login` — same without `role`. `401` invalid credentials.

### `GET /me/authorization`

Frontend **must** call this after login.

```json
{
  "subject": {
    "id": "1",
    "roles": ["manager"],
    "attributes": { "username": "alice", "organizationId": "org_1" }
  },
  "roles": ["manager"],
  "permissions": ["wallet:read", "wallet:create", "transaction:approve"],
  "capabilities": {
    "dashboard:read": true,
    "wallet:delete": true,
    "rbac:manage": false
  },
  "user": { "id": 1, "username": "alice", "role": "manager", "roles": ["manager"] }
}
```

`capabilities` is Type A (boolean per `resource:action`). `user.role` is `subject.roles[0]`.

### Dashboard and resources

`GET /dashboard` — `dashboard:read` → `{ "message": "Welcome, alice" }`.

Wallets are in-memory (reset on process restart):

| id | ownerId |
|----|---------|
| `wallet_1` | `"1"` (first `users.id`) |
| `wallet_2` | `"2"` |

| Method | Path | Permission / policy |
|--------|------|---------------------|
| GET | `/wallets` | `wallet:read` |
| POST | `/wallets` | `wallet:create` → `201`, `ownerId = subject.id` |
| GET | `/wallets/:id/capabilities` | Type B: `read`, `update`, `delete` |
| DELETE | `/wallets/:id` | `wallet:delete` + ownership |
| GET | `/transactions` | `transaction:read` |
| GET | `/transactions/:id/capabilities` | Type B: `read`, `approve` |
| POST | `/transactions/:id/approve` | `transaction:approve` + org/amount |
| POST | `/contracts/deploy` | `contract:deploy` |

Transactions:

| id | amount | org | Who can approve |
|----|--------|-----|-----------------|
| `tx_1` | 50000 | `org_1` | manager, admin |
| `tx_2` | 500000 | `org_1` | **admin only** |
| `tx_3` | 10000 | `org_2` | **nobody** (including admin) |

Type B response:

```json
{
  "resource": { "type": "wallet", "id": "wallet_2", "ownerId": "2" },
  "capabilities": {
    "delete": {
      "allowed": false,
      "reason": "POLICY_DENIED",
      "matchedPermission": "*:*"
    }
  }
}
```

Unknown id → `404 { "error": "Wallet not found" }` (or Transaction).

### `POST /rbac/authorize` (debug)

Any authenticated user. Registered **before** the admin router so it is not gated by `rbac:manage`.

```json
{
  "action": "delete",
  "resource": { "type": "wallet", "id": "wallet_1", "ownerId": "1" }
}
```

`400` if `action` or `resource` is missing.

### Admin routes (`createRbacAdminRouter`)

Every other `/rbac/*` path requires `rbac:manage`. Full curls: **store README**.

| Method | Path | Body | Reloads |
|--------|------|------|---------|
| GET | `/rbac/roles` | | no |
| POST | `/rbac/roles` | `{ name, permissions?, inherits? }` | yes · `201` |
| GET | `/rbac/roles/:name` | | no · `404` if missing |
| PUT | `/rbac/roles/:name` | `{ permissions?, inherits? }` | yes |
| DELETE | `/rbac/roles/:name` | | yes · `204` |
| GET | `/rbac/subjects/:id/roles` | | no |
| PUT | `/rbac/subjects/:id/roles` | `{ roles }` | no |
| POST | `/rbac/subjects/:id/roles` | `{ role }` | no · `201` |
| DELETE | `/rbac/subjects/:id/roles/:role` | | no · `204` |
| GET | `/rbac/settings` | | no |
| PATCH | `/rbac/settings` | `{ strictRoles? }` | yes |

Admin errors: `{ "error": "<ErrorName>", "message": "..." }` with `400` or `404`. After assignment writes, refresh `GET /me/authorization`.

---

## 7. This frontend

1. `api.js` prefixes paths with `VITE_API_URL` and sends `Authorization: Bearer` from `localStorage` key `rbac_token`.
2. After login/register, `AuthContext` calls `GET /me/authorization`.
3. `ProtectedRoute` mounts `<RBACProvider subject={…} permissions={…}>`.
4. Type A: `useCan` / `<Can>` on the dashboard cards.
5. Type B: **Resource APIs** panel (`/wallets/:id/capabilities`, `POST /rbac/authorize`).
6. `RequireRole` uses `subject.roles` only.
7. After `/rbac` writes, **Interactive Admin API** calls `refreshAuthorization()`.

---

## 8. Reproduce in another Express + React app

Follow the same package order. Details stay in the package READMEs.

**1. Core** — decide the catalog (`resource:action`), role graph, and which policies exist. Do not persist policies.

**2. Node** — `createExpressMiddleware` / Nest `RbacModule`; `authorize` on every mutating route; `GET /me/authorization` returns `getEffectivePermissions`.

**3. React** — `npm install @corpcash/rbac-react@^0.3.0`; wrap with `RBACProvider` + `permissions[]`; instance buttons from a capabilities endpoint.

**4. Store** — `migrate()` → `seed()` → `createRBACFromStore` → `registerPolicyFor`; assign roles with `setRolesForSubject` on register; mount `/rbac` for live edits.

This repo as a template:

| Copy | Change |
|------|--------|
| `db.js` | Connection string |
| `rbac.config.js` | `RESOURCES` / `ACTIONS` / `roles` / `CAPABILITY_CHECKS` |
| `rbac.js` | `registerPolicies` + subject attributes |
| `auth.js` | Validation / identity provider |
| `index.js` | Keep `POST /rbac/authorize` **above** `app.use("/rbac")` |
| `resources.js` | Real repositories; `getResource` must return `{ type, id, ...policyFields }` |

---

## 9. Smoke tests

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin1","password":"secret1","role":"admin"}' | jq -r .token)

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/me/authorization | jq '{roles, permissions, user}'

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/wallets/wallet_2/capabilities | jq .
# *:* still hits ownership → delete POLICY_DENIED unless you are user id 2

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/rbac/roles | jq .
```

Manager vs high-amount:

```bash
MT=$(curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"mgr1","password":"secret1","role":"manager"}' | jq -r .token)

curl -s -H "Authorization: Bearer $MT" http://localhost:3000/transactions/tx_2/capabilities | jq .capabilities.approve
# POLICY_DENIED

curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "Authorization: Bearer $MT" http://localhost:3000/transactions/tx_2/approve
# 403
```

Viewer `/rbac/roles` → `403`. Missing Bearer → `401`. Duplicate username → `409`.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Backend exits on start | Postgres down / wrong `DATABASE_URL` | Start Postgres; match user/password/db |
| Frontend login fails / CORS | `VITE_API_URL` or `CORS_ORIGIN` | `http://localhost:3000` and `http://localhost:5173` |
| UI still shows old role after `/rbac` assign | Used `users.role` or stale session | Use `subject.roles`; Admin panel refreshes `/me/authorization` |
| Type A `wallet:delete: true` but DELETE 403 | Type A skips ownership | `GET /wallets/:id/capabilities` |
| `POST /rbac/authorize` is 403 `rbac:manage` | Registered after the admin router | Keep it **above** `app.use("/rbac")` |
| `/rbac` 403 as manager | No `rbac:manage` | Sign in as `admin` (`*:*`) |
| Seed changes ignored | `rbac_roles` already populated | Edit via `/rbac`, or empty the three `rbac_*` tables and restart |
| `AsyncPolicyError` | Async policy + sync `authorize()` | Use `authorizeAsync` (Express adapter already does) |
| `UnknownRoleError` | `strictRoles: true` and a stale assignment | Fix assignments or set `strictRoles: false` |
| Client `RequireRole` denies a parent role | Permission-only mode | Expected — no inheritance on the client |
| `@corpcash/rbac-*` not found | Offline / wrong registry | `npm install` from the public registry, **^0.3.0** |

---

## 11. Who owns what

| Data / logic | Owner |
|--------------|--------|
| Engine API | **core README** |
| HTTP adapters / 401–403 | **node README** |
| UI hooks / provider | **react README** |
| Persistence + admin curls | **store README** |
| Role rows | Postgres `rbac_roles` (seeded from `rbac.config.js`) |
| Subject → roles | Postgres `rbac_assignments` |
| `users.role` | Registration snapshot only |
| Policy functions | `rbac.js` |
| Subject identity | JWT `sub` → `users.id` |
| Demo wallets / txns | `resources.js` (memory) |
| Effective permissions | Engine → `GET /me/authorization` |
| Generic UI | `useCan` / `<Can>` |
| Instance UI | `GET /…/capabilities` |
| Security | `authorize()` on each route |
