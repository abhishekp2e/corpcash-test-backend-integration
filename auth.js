import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "./db.js";
import { ROLES } from "./rbac.config.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

export async function initUsersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export async function registerUser({ username, password, role, roles }) {
  const normalized = String(username ?? "").trim();
  if (!normalized || normalized.length < 3) {
    const err = new Error("Username must be at least 3 characters");
    err.status = 400;
    throw err;
  }
  if (!password || String(password).length < 6) {
    const err = new Error("Password must be at least 6 characters");
    err.status = 400;
    throw err;
  }
  const allowed = Array.isArray(roles) && roles.length ? roles : ROLES;
  if (!allowed.includes(role)) {
    const err = new Error(`Role must be one of: ${allowed.join(", ")}`);
    err.status = 400;
    throw err;
  }

  const passwordHash = await bcrypt.hash(String(password), 10);

  try {
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id, username, role, created_at`,
      [normalized, passwordHash, role],
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === "23505") {
      const conflict = new Error("Username already taken");
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }
}

export async function loginUser({ username, password }) {
  const normalized = String(username ?? "").trim();
  const result = await pool.query(
    `SELECT id, username, password_hash, role, created_at
     FROM users WHERE username = $1`,
    [normalized],
  );
  const user = result.rows[0];
  if (!user) {
    const err = new Error("Invalid username or password");
    err.status = 401;
    throw err;
  }

  const ok = await bcrypt.compare(String(password ?? ""), user.password_hash);
  if (!ok) {
    const err = new Error("Invalid username or password");
    err.status = 401;
    throw err;
  }

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    created_at: user.created_at,
  };
}

export async function findUserById(id) {
  const result = await pool.query(
    `SELECT id, username, role, created_at FROM users WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Public user for auth responses. `role` / `roles` must come from the store
 * subject (not the `users.role` registration snapshot).
 */
export function toPublicUser(user, subject) {
  const roles = subject?.roles?.length ? subject.roles : user.role ? [user.role] : [];
  return {
    id: user.id,
    username: user.username,
    role: roles[0] ?? user.role,
    roles,
  };
}
