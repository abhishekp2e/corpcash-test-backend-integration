import "dotenv/config";
import cors from "cors";
import express from "express";
import {
  findUserById,
  initUsersTable,
  loginUser,
  registerUser,
  signToken,
  toSubject,
  verifyToken,
} from "./auth.js";
import { checkDb, pool } from "./db.js";
import { ACTIONS, RESOURCES, ROLES } from "./rbac.config.js";
import { authorize, getCapabilities, rbac } from "./rbac.js";

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
    req.subject = toSubject(user);
    next();
  } catch (err) {
    next(err);
  }
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

app.get("/auth/roles", (_req, res) => {
  res.json({ roles: ROLES });
});

app.post("/auth/register", async (req, res, next) => {
  try {
    const user = await registerUser(req.body ?? {});
    const token = signToken(user);
    res.status(201).json({
      token,
      user: { id: user.id, username: user.username, role: user.role },
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
    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

/** Frontend bootstrap: subject + effective permissions + capability map */
app.get("/me/authorization", requireAuth, loadUser, (req, res) => {
  res.json({
    subject: req.subject,
    roles: req.subject.roles,
    permissions: rbac.getEffectivePermissions(req.subject),
    capabilities: getCapabilities(req.subject),
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
    },
  });
});

app.get(
  "/dashboard",
  requireAuth,
  loadUser,
  authorize(RESOURCES.dashboard, ACTIONS.read),
  (req, res) => {
    res.json({ message: `Welcome, ${req.user.username}` });
  },
);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

async function start() {
  await initUsersTable();
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
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
