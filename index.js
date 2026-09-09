import "dotenv/config";
import cors from "cors";
import express from "express";
import {
  findUserById,
  initUsersTable,
  loginUser,
  registerUser,
  signToken,
  toPublicUser,
  verifyToken,
} from "./auth.js";
import { checkDb, pool } from "./db.js";
import { ACTIONS, RESOURCES } from "./rbac.config.js";
import {
  assignUserRole,
  getAdminRouter,
  getAuthorize,
  getCapabilities,
  getInstanceCapabilities,
  getRbac,
  initRbac,
  listAssignableRoles,
  resolveSubject,
} from "./rbac.js";
import {
  approveTransaction,
  createWallet,
  deleteWallet,
  findTransaction,
  findWallet,
  listTransactions,
  listWallets,
} from "./resources.js";

const PORT = Number(process.env.PORT) || 3000;
const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    credentials: true,
  }),
);
app.use(express.json());

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    req.auth = verifyToken(header.slice(7));
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

async function loadUser(req, res, next) {
  try {
    const user = await findUserById(req.auth.sub);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    req.user = user;
    req.subject = await resolveSubject(user);
    next();
  } catch (err) {
    next(err);
  }
}

function walletResource(wallet) {
  return {
    type: RESOURCES.wallet,
    id: wallet.id,
    ownerId: String(wallet.ownerId),
  };
}

function transactionResource(tx) {
  return {
    type: RESOURCES.transaction,
    id: tx.id,
    amount: tx.amount,
    organizationId: tx.organizationId,
    status: tx.status,
  };
}

function loadWalletParam(req, res, next) {
  const wallet = findWallet(req.params.id);
  if (!wallet) {
    res.status(404).json({ error: "Wallet not found" });
    return;
  }
  req.wallet = wallet;
  next();
}

function loadTransactionParam(req, res, next) {
  const tx = findTransaction(req.params.id);
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  req.transaction = tx;
  next();
}

app.get("/health", async (_req, res) => {
  try {
    const dbOk = await checkDb();
    res.json({ status: "ok", db: dbOk ? "up" : "down" });
  } catch (err) {
    res.status(503).json({
      status: "degraded",
      db: "down",
      error: err instanceof Error ? err.message : "db check failed",
    });
  }
});

app.get("/auth/roles", async (_req, res, next) => {
  try {
    res.json({ roles: await listAssignableRoles() });
  } catch (err) {
    next(err);
  }
});

app.post("/auth/register", async (req, res, next) => {
  try {
    const roles = await listAssignableRoles();
    const { username, password, role } = req.body ?? {};
    if (!roles.includes(role)) {
      res.status(400).json({
        error: `Role must be one of: ${roles.join(", ")}`,
      });
      return;
    }
    const user = await registerUser({ username, password, role, roles });
    await assignUserRole(user.id, role);
    const subject = await resolveSubject(user);
    const token = signToken(user);
    res.status(201).json({
      token,
      user: toPublicUser(user, subject),
    });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

app.post("/auth/login", async (req, res, next) => {
  try {
    const user = await loginUser(req.body ?? {});
    const subject = await resolveSubject(user);
    const token = signToken(user);
    res.json({
      token,
      user: toPublicUser(user, subject),
    });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

app.get("/me/authorization", requireAuth, loadUser, (req, res) => {
  const rbac = getRbac();
  res.json({
    subject: req.subject,
    roles: req.subject.roles,
    permissions: rbac.getEffectivePermissions(req.subject),
    capabilities: getCapabilities(req.subject),
    user: toPublicUser(req.user, req.subject),
  });
});

async function start() {
  await initUsersTable();
  await initRbac();

  const authorize = getAuthorize();
  const rbac = getRbac();

  app.get(
    "/dashboard",
    requireAuth,
    loadUser,
    authorize(RESOURCES.dashboard, ACTIONS.read),
    (req, res) => {
      res.json({ message: `Welcome, ${req.user.username}` });
    },
  );

  app.get(
    "/wallets",
    requireAuth,
    loadUser,
    authorize(RESOURCES.wallet, ACTIONS.read),
    (_req, res) => {
      res.json({ wallets: listWallets() });
    },
  );

  app.post(
    "/wallets",
    requireAuth,
    loadUser,
    authorize(RESOURCES.wallet, ACTIONS.create),
    (req, res) => {
      res.status(201).json(createWallet(req.subject.id));
    },
  );

  app.get(
    "/wallets/:id/capabilities",
    requireAuth,
    loadUser,
    loadWalletParam,
    (req, res) => {
      res.json(
        getInstanceCapabilities(req.subject, walletResource(req.wallet), [
          ACTIONS.read,
          ACTIONS.update,
          ACTIONS.delete,
        ]),
      );
    },
  );

  app.delete(
    "/wallets/:id",
    requireAuth,
    loadUser,
    loadWalletParam,
    authorize({
      resource: RESOURCES.wallet,
      action: ACTIONS.delete,
      getResource: (req) => walletResource(req.wallet),
    }),
    (req, res) => {
      deleteWallet(req.params.id);
      res.json({ deleted: req.params.id });
    },
  );

  app.get(
    "/transactions",
    requireAuth,
    loadUser,
    authorize(RESOURCES.transaction, ACTIONS.read),
    (_req, res) => {
      res.json({ transactions: listTransactions() });
    },
  );

  app.get(
    "/transactions/:id/capabilities",
    requireAuth,
    loadUser,
    loadTransactionParam,
    (req, res) => {
      res.json(
        getInstanceCapabilities(
          req.subject,
          transactionResource(req.transaction),
          [ACTIONS.read, ACTIONS.approve],
        ),
      );
    },
  );

  app.post(
    "/transactions/:id/approve",
    requireAuth,
    loadUser,
    loadTransactionParam,
    authorize({
      resource: RESOURCES.transaction,
      action: ACTIONS.approve,
      getResource: (req) => transactionResource(req.transaction),
    }),
    (req, res) => {
      res.json(approveTransaction(req.params.id));
    },
  );

  app.post(
    "/contracts/deploy",
    requireAuth,
    loadUser,
    authorize(RESOURCES.contract, ACTIONS.deploy),
    (req, res) => {
      res.status(201).json({
        deployed: true,
        name: req.body?.name ?? "Untitled",
      });
    },
  );

  // Must be registered before app.use("/rbac") so it is not swallowed by the
  // admin router (which requires rbac:manage and has no /authorize route).
  app.post("/rbac/authorize", requireAuth, loadUser, (req, res) => {
    const { action, resource } = req.body ?? {};
    if (!action || resource == null) {
      res.status(400).json({ error: "action and resource are required" });
      return;
    }
    const result = rbac.authorize({
      subject: req.subject,
      action,
      resource,
    });
    res.json({
      request: { subject: req.subject, action, resource },
      result,
    });
  });

  // Admin API — requires rbac:manage (*:* covers admin). Roles live in Postgres.
  app.use("/rbac", requireAuth, loadUser, getAdminRouter());

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log("RBAC admin API: /rbac/roles (requires rbac:manage)");
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

async function shutdown() {
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
