# backend-integration

Express API for the Corpcash RBAC POC. Port **3000**, JWT Bearer auth, Postgres role graph via `@corpcash/rbac-store`.

**Do not guess the contract.** Follow [BACKEND_FRONTEND_INTEGRATION.md](./BACKEND_FRONTEND_INTEGRATION.md) exactly.

```bash
cp -n .env.example .env
npm install
npm run dev
```

Requires Postgres at `DATABASE_URL` (default `postgresql://postgres:root@localhost:5432/postgres`).

RBAC packages come from npm (`@corpcash/rbac-core`, `rbac-node`, `rbac-store` **^0.3.0**).
