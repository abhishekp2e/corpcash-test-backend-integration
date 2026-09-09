# Corpcash RBAC — this stack, copy-paste playbook

This file is the integration contract for **this repository**. Follow it as written. Do not invent `x-user-id` demo users, port 4000, or a separate `corpcash-backend` app — those are not this POC.

| Item | Value |
|------|--------|
| Backend | `rback-check/backend-integration` · Express ESM · **http://localhost:3000** |
| Frontend | `rback-check/frontend-integration` · Vite + React 19 · **http://localhost:5173** |
| Library | npm `@corpcash/rbac-{core,node,store,react}` **^0.3.0** |
| Auth | `Authorization: Bearer <JWT>` (`sub` = `users.id`) |
| Roles | Postgres via `@corpcash/rbac-store` (`rbac_roles`, `rbac_assignments`, `rbac_settings`) |
| Policies | Code only — `backend-integration/rbac.js` |
| Frontend RBAC | UX only — `RBACProvider` + `permissions[]` from `GET /me/authorization` |

---

## 0. Prerequisites (do these once)

1. **Node.js ≥ 18**
2. **Postgres** listening on `localhost:5432` with user `postgres` / password `root` (or change `DATABASE_URL`)
3. npm access to the public registry (packages `@corpcash/rbac-core`, `rbac-node`, `rbac-store`, `rbac-react` **0.3.0**)

Folder layout for this POC:

```
rback-check/
├── backend-integration/        # Express API
└── frontend-integration/       # React UI
```

---

## 1. Run this stack (no further decisions)

### Terminal 1 — backend

```bash
cd /Users/abhishekmishra/WORKDIR/work/feature-poc/rback-check/backend-integration
cp -n .env.example .env   # skip if .env already exists
npm install
npm run dev               # http://localhost:3000
```

`.env` (already matches `.env.example`):

```
PORT=3000
DATABASE_URL=postgresql://postgres:root@localhost:5432/postgres
JWT_SECRET=dev-jwt-secret-change-in-production
JWT_EXPIRES_IN=7d
CORS_ORIGIN=http://localhost:5173
```

On boot the process:

1. Creates `users` if missing (`auth.js`)
2. `postgresStore({ pool }).migrate()` → `rbac_roles`, `rbac_assignments`, `rbac_settings`
3. `store.seed({ roles: rbacConfig.roles })` — **no-op if any role already exists**
4. `createRBACFromStore(store)` then `registerPolicyFor` in `rbac.js`
5. Mounts resource routes and `/rbac` admin router

### Terminal 2 — frontend

```bash
cd /Users/abhishekmishra/WORKDIR/work/feature-poc/rback-check/frontend-integration
cp -n .env.example .env
npm install
npm run dev               # http://localhost:5173
```

`.env`:

```
VITE_API_URL=http://localhost:3000
```

The UI calls that origin **directly** (CORS). The Vite `/api` proxy exists but **is not used** by `src/api.js`.

Open http://localhost:5173 → Register (pick a role) → Dashboard.

---

## 2. Architecture

```mermaid
flowchart TB
  subgraph lib ["@corpcash/rbac-* ^0.3.0 (npm)"]
    Core["@corpcash/rbac-core"]
    Node["@corpcash/rbac-node"]
    Store["@corpcash/rbac-store"]
    React["@corpcash/rbac-react"]
    Node --> Core
    Store --> Core
    Node --> Store
    React --> Core
  end

  subgraph backend [backend-integration :3000]
    JWT["Bearer JWT → users row"]
    Sub["resolveSubject → store roles"]
    Eng["in-memory RBAC engine"]
    Pol["registerPolicyFor in rbac.js"]
    MW["authorize() middleware"]
    Admin["createRbacAdminRouter /rbac"]
    JWT --> Sub --> Eng
    Pol --> Eng
    MW --> Eng
    Admin --> Store
  end

  subgraph frontend [frontend-integration :5173]
    Auth["AuthProvider GET /me/authorization"]
    Prov["RBACProvider subject + permissions"]
    UI["Can / useCan / RequireRole"]
    Auth --> Prov --> UI
  end

  frontend -->|"Bearer JWT"| backend
```

### Golden rules

1. **One model** — `subject + action + resource (+ context) → allow/deny`
2. **Backend is the security boundary** — every mutating route runs `authorize()`
3. **Frontend never receives policy source** — only `permissions[]` and capability results
4. **Persist roles, not policies** — Postgres holds the role graph and subject assignments; `PolicyFn` / `onDecision` stay in `rbac.js`
5. **Default deny** — missing permission or failed policy → 403 `{ error: "Forbidden", reason }`
6. **JWT is identity only** — payload is `{ sub, username }`. Roles always come from `store.getRolesForSubject(sub)` on each request

---

## 3. Files that matter

```
backend-integration/
├── index.js            # Express: auth, /me/authorization, resources, /rbac
├── auth.js             # users table, bcrypt, JWT
├── db.js               # pg Pool from DATABASE_URL
├── rbac.config.js      # RESOURCES, ACTIONS, PERMISSIONS, seed roles
├── rbac.js             # store boot, policies, resolveSubject, capabilities
├── resources.js        # in-memory wallets + transactions (reset on restart)
└── .env

frontend-integration/
├── src/api.js
├── src/AuthContext.jsx
├── src/ProtectedRoute.jsx          # mounts RBACProvider
├── src/RequireRole.jsx
├── src/components/AdminApiPanel.jsx
├── src/components/ResourceApiPanel.jsx
└── .env                            # VITE_API_URL
```

---

## 4. Subject resolution (do not skip)

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

`users.role` is the **registration snapshot**. After `PUT /rbac/subjects/:id/roles`, the snapshot can drift. **Authorize and the UI must use `subject.roles`.** `GET /me/authorization` sets `user.role` / `user.roles` from the store.

Every subject in this POC has `attributes.organizationId = "org_1"` (unless you add `users.organization_id`). That is required for the approve policy to evaluate.

---

## 5. Seeded role graph (`rbac.config.js`)

`store.seed()` runs only when `rbac_roles` is empty. Later edits go through `/rbac/roles`, not this file. An already-used database may already contain extra roles (for example `auditor`) from earlier admin API calls — `GET /auth/roles` is the live list.

| Role | Direct permissions | Inherits |
|------|--------------------|----------|
| `viewer` | `wallet:read`, `transaction:read`, `dashboard:read` | — |
| `developer` | `wallet:create`, `wallet:update`, `contract:read`, `contract:deploy` | viewer |
| `manager` | `transaction:approve`, `wallet:delete`, `user:read`, `report:read` | developer |
| `admin` | `*:*` | — |

`GET /auth/roles` returns **current store role names** (includes roles created via `POST /rbac/roles`). Register only accepts those names.

---

## 6. Policies (backend only)

Registered in `rbac.js` **after** `createRBACFromStore`. `reloadFromStore` keeps them attached.

### `wallet:delete` — ownership

If `resource` is an object with `ownerId`, require `subject.id === String(ownerId)`. If `resource` is only the type string (`"wallet"`), the policy **returns true** (Type A / `GET /me/authorization` cannot know an instance).

### `transaction:approve` — org + amount

If `resource` is an object:

1. If both `subject.attributes.organizationId` and `resource.organizationId` are set and differ → deny
2. If `amount > 100000` → allow only when `subject.roles` includes `"admin"`
3. Otherwise allow

Same skip rule: type-string resource → policy returns true.

`*:*` still **runs policies**. Admin is denied on `tx_3` (org_2).

---

## 7. Type A vs Type B (frontend)

| | Type A — generic UI | Type B — instance UI |
|--|---------------------|----------------------|
| When | Not tied to a specific record | Ownership / org / amount on **this** record |
| Data | `permissions[]` or `capabilities` from `GET /me/authorization` | `GET /wallets/:id/capabilities` or `GET /transactions/:id/capabilities` |
| Hook | `useCan("wallet", "delete")` / `<Can>` | `caps.capabilities.delete.allowed` |
| Policy | **Not evaluated** (resource is a type string) | **Evaluated** (resource is an object) |

Never re-implement policies in React. Even if a button is visible, the mutating API re-runs `authorize()`.

---

## 8. API contract (this server)

All JSON. Authenticated routes: `Authorization: Bearer <token>`.

Unauthenticated → `401 { "error": "Unauthorized" }` or `{ "error": "Invalid or expired token" }`.

Denied by RBAC middleware → `403 { "statusCode": 403, "error": "Forbidden", "message": "...", "reason": "PERMISSION_DENIED" | "POLICY_DENIED" | ... }`.

### 8.1 Health

`GET /health` → `{ "status": "ok", "db": "up" }` (or `503` if Postgres is down).

### 8.2 Auth

`GET /auth/roles` → `{ "roles": ["admin", "developer", "manager", "viewer", ...] }` (sorted as stored).

`POST /auth/register`

```json
{ "username": "alice", "password": "secret1", "role": "manager" }
```

- `201` `{ "token": "<jwt>", "user": { "id": 1, "username": "alice", "role": "manager", "roles": ["manager"] } }`
- `400` username &lt; 3 chars, password &lt; 6, or unknown role
- `409` username taken

Also writes `store.setRolesForSubject(String(id), [role])`.

`POST /auth/login` — same body without `role`. `200` same `{ token, user }` shape. `401` invalid credentials.

### 8.3 Authorization bootstrap (frontend must call this after login)

`GET /me/authorization`

```json
{
  "subject": {
    "id": "1",
    "roles": ["manager"],
    "attributes": { "username": "alice", "organizationId": "org_1" }
  },
  "roles": ["manager"],
  "permissions": ["wallet:read", "wallet:create", "transaction:approve", "..."],
  "capabilities": {
    "dashboard:read": true,
    "wallet:read": true,
    "wallet:create": true,
    "wallet:update": true,
    "wallet:delete": true,
    "transaction:read": true,
    "transaction:approve": true,
    "contract:read": true,
    "contract:deploy": true,
    "user:read": true,
    "report:read": true,
    "rbac:manage": false
  },
  "user": { "id": 1, "username": "alice", "role": "manager", "roles": ["manager"] }
}
```

`capabilities` is Type A (boolean per `resource:action`). `user.role` is `subject.roles[0]`.

Frontend wiring:

```jsx
<RBACProvider subject={authorization.subject} permissions={authorization.permissions}>
  <Can resource="wallet" action="create">{/* Type A */}</Can>
</RBACProvider>
```

### 8.4 Dashboard

`GET /dashboard` — requires `dashboard:read` → `{ "message": "Welcome, alice" }`.

### 8.5 Wallets (in-memory; reset on process restart)

Seeded:

| id | ownerId | Meaning |
|----|---------|---------|
| `wallet_1` | `"1"` | First registered user (`users.id = 1`) is the owner |
| `wallet_2` | `"2"` | Second registered user |

`GET /wallets` — `wallet:read` → `{ "wallets": [ { "id", "ownerId", "label" } ] }`

`POST /wallets` — `wallet:create` → `201` wallet with `ownerId = subject.id`

`GET /wallets/:id/capabilities` — authenticated; **no extra permission**. Type B:

```json
{
  "resource": { "type": "wallet", "id": "wallet_1", "ownerId": "1" },
  "capabilities": {
    "read":   { "allowed": true,  "reason": "AUTHORIZED", "matchedPermission": "wallet:read" },
    "update": { "allowed": true,  "reason": "AUTHORIZED", "matchedPermission": "wallet:update" },
    "delete": { "allowed": false, "reason": "POLICY_DENIED", "matchedPermission": "wallet:delete" }
  }
}
```

`404 { "error": "Wallet not found" }` if id is unknown.

`DELETE /wallets/:id` — `wallet:delete` **and** ownership policy → `{ "deleted": "wallet_1" }`

### 8.6 Transactions (in-memory)

| id | amount | organizationId | Who can approve (this POC) |
|----|--------|----------------|----------------------------|
| `tx_1` | 50000 | `org_1` | manager (permission + policy), admin |
| `tx_2` | 500000 | `org_1` | **admin only** (amount policy) |
| `tx_3` | 10000 | `org_2` | **nobody** (org mismatch, including admin) |

Developer has **no** `transaction:approve` in this graph.

`GET /transactions` — `transaction:read`

`GET /transactions/:id/capabilities` — Type B for `read` and `approve`

`POST /transactions/:id/approve` — permission + policy → updated row `{ id, amount, organizationId, status: "approved" }`

### 8.7 Contracts

`POST /contracts/deploy` — `contract:deploy`

```json
{ "name": "demo-contract" }
```

`201 { "deployed": true, "name": "demo-contract" }`

### 8.8 Authorize debugger

`POST /rbac/authorize` — **any authenticated user** (registered **before** the admin router).

```json
{
  "action": "delete",
  "resource": { "type": "wallet", "id": "wallet_1", "ownerId": "1" }
}
```

```json
{
  "request": { "subject": { "id": "1", "roles": ["manager"], "attributes": {} }, "action": "delete", "resource": {} },
  "result": { "allowed": true, "reason": "AUTHORIZED", "matchedPermission": "wallet:delete" }
}
```

`400` if `action` or `resource` is missing.

### 8.9 Admin API (`createRbacAdminRouter`)

Every path under `/rbac` except `POST /rbac/authorize` requires `rbac:manage` (admin `*:*` has it).

| Method | Path | Body | Success |
|--------|------|------|---------|
| GET | `/rbac/roles` | | `[{ name, permissions, inherits }]` |
| POST | `/rbac/roles` | `{ name, permissions?, inherits? }` | `201` role |
| GET | `/rbac/roles/:name` | | role or `404` |
| PUT | `/rbac/roles/:name` | `{ permissions?, inherits? }` | role (reloads engine) |
| DELETE | `/rbac/roles/:name` | | `204` (reloads engine) |
| GET | `/rbac/subjects/:id/roles` | | `{ subjectId, roles }` |
| PUT | `/rbac/subjects/:id/roles` | `{ roles: ["developer"] }` | replace all assignments |
| POST | `/rbac/subjects/:id/roles` | `{ role: "viewer" }` | `201` add one |
| DELETE | `/rbac/subjects/:id/roles/:role` | | `204` revoke one |
| GET | `/rbac/settings` | | `{ strictRoles }` |
| PATCH | `/rbac/settings` | `{ strictRoles: false }` | settings (reloads engine) |

Role-graph writes call `reloadFromStore` (policies stay registered). Assignment writes apply on the **next** `resolveSubject` — refresh `GET /me/authorization` in the UI.

Admin errors: `{ "error": "<ErrorName>", "message": "..." }` with `400` or `404`.

---

## 9. Frontend integration (this app)

1. `api.js` prefixes every path with `VITE_API_URL` and sends `Authorization: Bearer` from `localStorage` key `rbac_token`.
2. After login/register, `AuthContext` calls `GET /me/authorization` and stores `subject`, `permissions`, `capabilities`.
3. `ProtectedRoute` mounts:

```jsx
<RBACProvider subject={authorization.subject} permissions={authorization.permissions}>
  {children}
</RBACProvider>
```

4. Type A: `useCan("wallet", "create")`, `<Can resource="wallet" action="create">`.
5. Type B: Resource APIs panel → `/wallets/:id/capabilities`.
6. `RequireRole` checks `subject.roles` (no inheritance on the client). A manager is denied on `/roles/developer`.
7. After `/rbac` writes, `AdminApiPanel` calls `refreshAuthorization()`.

Do **not** import `@corpcash/rbac-core` or `@corpcash/rbac-store` in the frontend.

---

## 10. Reproduce this in another Express + React app

### Backend

```bash
npm install @corpcash/rbac-core@^0.3.0 @corpcash/rbac-node@^0.3.0 @corpcash/rbac-store@^0.3.0 pg jsonwebtoken bcryptjs express cors dotenv
```

Copy these modules as-is and change only secrets and catalogs:

| Copy | Purpose |
|------|---------|
| `db.js` | `Pool({ connectionString: process.env.DATABASE_URL })` |
| `rbac.config.js` | Edit `RESOURCES` / `ACTIONS` / `rbacConfig.roles` / `CAPABILITY_CHECKS` |
| `rbac.js` | Keep boot + `resolveSubject`; replace `registerPolicies` |
| `auth.js` | Keep JWT + `users`; change validation if needed |
| `index.js` | Keep middleware order: `POST /rbac/authorize` **before** `app.use("/rbac", ...)` |
| `resources.js` | Replace with your real repositories; keep `getResource` returning `{ type, id, ...policyFields }` |

Boot order that must not change:

```js
const store = postgresStore({ pool });
await store.migrate();
await store.seed({ roles: rbacConfig.roles });
const rbac = await createRBACFromStore(store, { onDecision });
rbac.registerPolicyFor(/* your policies */);
const { authorize } = createExpressMiddleware({
  rbac,
  getSubject: (req) => req.subject ?? null,
});
app.use("/rbac", requireAuth, loadUser, createRbacAdminRouter({ store, rbac, getSubject: (req) => req.subject }));
```

Protect a type-only route:

```js
app.get("/wallets", requireAuth, loadUser, authorize("wallet", "read"), handler);
```

Protect an instance route (policies need the object):

```js
app.delete(
  "/wallets/:id",
  requireAuth,
  loadUser,
  loadWalletParam,
  authorize({
    resource: "wallet",
    action: "delete",
    getResource: (req) => ({ type: "wallet", id: req.wallet.id, ownerId: req.wallet.ownerId }),
  }),
  handler,
);
```

Expose Type A + Type B:

```js
// Type A
res.json({ permissions: rbac.getEffectivePermissions(subject), capabilities: getCapabilities(subject) });
// Type B
res.json(getInstanceCapabilities(subject, walletResource(wallet), ["read", "delete"]));
```

On register: `await store.setRolesForSubject(String(user.id), [role])`.

### Frontend

```bash
npm install @corpcash/rbac-react@^0.3.0
```

```jsx
const authz = await fetch(`${API}/me/authorization`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());

<RBACProvider subject={authz.subject} permissions={authz.permissions}>
  <Can resource="wallet" action="create"><CreateWallet /></Can>
</RBACProvider>
```

Instance buttons:

```js
const { capabilities } = await fetch(`${API}/wallets/${id}/capabilities`, { headers }).then((r) => r.json());
if (capabilities.delete.allowed) { /* show Delete */ }
```

---

## 11. Smoke tests (copy, replace TOKEN)

Register an admin (first user is usually `id=1`, which owns `wallet_1`):

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin1","password":"secret1","role":"admin"}' | jq -r .token)

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/me/authorization | jq '{roles, permissions, user}'

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/wallets | jq .
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/wallets/wallet_2/capabilities | jq .
# admin + *:* still hits ownership policy → delete on wallet_2 is POLICY_DENIED unless you are user id 2

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/transactions/tx_2/capabilities | jq .
# approve.allowed true (admin + same org)

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/rbac/roles | jq .
```

Manager vs high-amount (register a second user as `manager`):

```bash
MT=$(curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"mgr1","password":"secret1","role":"manager"}' | jq -r .token)

curl -s -H "Authorization: Bearer $MT" http://localhost:3000/transactions/tx_2/capabilities | jq .capabilities.approve
# { allowed: false, reason: "POLICY_DENIED", ... }

curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "Authorization: Bearer $MT" http://localhost:3000/transactions/tx_2/approve
# 403
```

Viewer cannot hit `/rbac`:

```bash
VT=$(curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"view1","password":"secret1","role":"viewer"}' | jq -r .token)

curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $VT" http://localhost:3000/rbac/roles
# 403
```

Username already taken → `409`. Missing Bearer → `401`.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Backend exits on start | Postgres down / wrong `DATABASE_URL` | Start Postgres; match user/password/db |
| `ECONNREFUSED 5432` | No Postgres | `pg_isready` / start the server |
| Frontend login fails / CORS | `VITE_API_URL` or `CORS_ORIGIN` | `http://localhost:3000` and `http://localhost:5173` |
| UI still shows old role after `/rbac` assign | Used `users.role` or stale session | Use `subject.roles`; click Send on Admin panel (it refreshes `/me/authorization`) |
| Type A says `wallet:delete: true` but DELETE 403 | Type A skips ownership | Call `/wallets/:id/capabilities` |
| `POST /rbac/authorize` is 403 `rbac:manage` | Route registered after admin router | Keep `app.post("/rbac/authorize")` **above** `app.use("/rbac", ...)` |
| `/rbac` 403 as manager | No `rbac:manage` | Sign in as `admin` (`*:*`) |
| Seed changes ignored | `rbac_roles` already populated | `DELETE` extra roles via API, or empty the three `rbac_*` tables and restart |
| `@corpcash/rbac-*` not found | npm install failed / offline | `npm install` on the public registry; packages are `@corpcash/rbac-core`, `rbac-node`, `rbac-store`, `rbac-react` **^0.3.0** |
| Wallets empty / unexpected owners | Process restarted or user ids ≠ 1/2 | Restart resets `resources.js`; first two `users.id` values own the seed wallets |
| JWT `roles` claim missing | Intentional | Engine never reads the JWT for roles |

---

## 13. Who owns what

| Data / logic | Owner |
|--------------|--------|
| Role definitions | Postgres `rbac_roles` (seeded from `rbac.config.js`) |
| Subject → roles | Postgres `rbac_assignments` |
| `users.role` | Registration snapshot only |
| Policy functions | `rbac.js` |
| Subject identity | JWT `sub` → `users.id` |
| Wallet / transaction records | `resources.js` (demo memory) |
| Effective permissions | Engine → `GET /me/authorization` |
| Generic UI | `useCan` / `<Can>` |
| Instance UI | `GET /…/capabilities` |
| Security | `authorize()` on each route |

---

## 14. Related docs

- npm: [`@corpcash/rbac-core`](https://www.npmjs.com/package/@corpcash/rbac-core), [`rbac-node`](https://www.npmjs.com/package/@corpcash/rbac-node), [`rbac-store`](https://www.npmjs.com/package/@corpcash/rbac-store), [`rbac-react`](https://www.npmjs.com/package/@corpcash/rbac-react)
- In-app copy of this guide: frontend `/docs`
