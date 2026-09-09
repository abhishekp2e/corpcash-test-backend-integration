/**
 * Backend RBAC — Postgres-backed role graph via @corpcash/rbac-store,
 * engine from @corpcash/rbac-core, Express admin + authorize from @corpcash/rbac-node.
 */
import { formatPermission } from "@corpcash/rbac-core";
import {
  createExpressMiddleware,
  createRbacAdminRouter,
} from "@corpcash/rbac-node/express";
import { createRBACFromStore } from "@corpcash/rbac-store";
import { postgresStore } from "@corpcash/rbac-store/postgres";
import { pool } from "./db.js";
import {
  ACTIONS,
  CAPABILITY_CHECKS,
  RESOURCES,
  rbacConfig,
} from "./rbac.config.js";

/** @type {import("@corpcash/rbac-store").RBACStore} */
let store;
/** @type {import("@corpcash/rbac-core").RBAC} */
let rbac;
/** @type {ReturnType<typeof createExpressMiddleware>["authorize"]} */
let authorize;
/** @type {import("express").Router} */
let adminRouter;

function registerPolicies(engine) {
  engine.registerPolicyFor(
    RESOURCES.wallet,
    ACTIONS.delete,
    ({ subject, resource }) => {
      if (
        typeof resource !== "object" ||
        resource == null ||
        !("ownerId" in resource)
      ) {
        return true;
      }
      return subject.id === String(resource.ownerId);
    },
  );

  engine.registerPolicyFor(
    RESOURCES.transaction,
    ACTIONS.approve,
    ({ subject, resource }) => {
      if (typeof resource !== "object" || resource == null) return true;

      const subjectOrg = subject.attributes?.organizationId;
      const resourceOrg = resource.organizationId;
      if (
        subjectOrg != null &&
        resourceOrg != null &&
        subjectOrg !== resourceOrg
      ) {
        return false;
      }

      const amount = Number(resource.amount ?? 0);
      if (amount > 100_000) {
        return subject.roles.includes("admin");
      }
      return true;
    },
  );
}

/**
 * Migrate + seed role graph from rbac.config.js (seed is a no-op if roles exist).
 */
export async function initRbac() {
  store = postgresStore({ pool });
  try {
    await store.migrate();
  } catch (err) {
    // Concurrent / partial CREATE TABLE can race on pg_type; retry once.
    if (err?.code !== "23505") throw err;
    await store.migrate();
  }
  await store.seed({ roles: rbacConfig.roles });

  rbac = await createRBACFromStore(store, {
    onDecision: ({ request, result, durationMs }) => {
      if (result.allowed) return;
      console.warn(
        "[rbac]",
        result.reason,
        request.subject?.id,
        `${result.resource}:${result.action}`,
        `${durationMs ?? "?"}ms`,
      );
    },
  });

  registerPolicies(rbac);

  const getSubject = (req) => req.subject ?? null;
  ({ authorize } = createExpressMiddleware({ rbac, getSubject }));
  adminRouter = createRbacAdminRouter({ store, rbac, getSubject });

  return { store, rbac, authorize, adminRouter };
}

export function getStore() {
  return store;
}

export function getRbac() {
  return rbac;
}

export function getAuthorize() {
  return authorize;
}

export function getAdminRouter() {
  return adminRouter;
}

/** Resolve subject roles from the store (fallback to users.role). */
export async function resolveSubject(user) {
  const id = String(user.id);
  let roles = await store.getRolesForSubject(id);
  if (roles.length === 0 && user.role) {
    roles = [user.role];
    await store.setRolesForSubject(id, roles);
  }
  return {
    id,
    roles,
    attributes: {
      username: user.username,
      // Demo default: every user is in org_1 so tx_1 / tx_2 policies can run.
      organizationId: user.organization_id ?? "org_1",
    },
  };
}

export async function assignUserRole(userId, role) {
  await store.setRolesForSubject(String(userId), [role]);
}

export async function listAssignableRoles() {
  const roles = await store.listRoles();
  return roles.map((r) => r.name);
}

/** Type A — permission-only map for generic UI (policies skip without an instance). */
export function getCapabilities(subject) {
  const capabilities = {};
  for (const [resource, action] of CAPABILITY_CHECKS) {
    const result = rbac.authorize({ subject, resource, action });
    capabilities[formatPermission(resource, action)] = result.allowed;
  }
  return capabilities;
}

/**
 * Type B — per-instance capabilities. Pass a resource *object* so policies
 * (ownership, org, amount) actually evaluate.
 */
export function getInstanceCapabilities(subject, resource, actions) {
  const capabilities = {};
  for (const action of actions) {
    const result = rbac.authorize({ subject, action, resource });
    capabilities[action] = {
      allowed: result.allowed,
      reason: result.reason,
      matchedPermission: result.matchedPermission ?? null,
    };
  }
  return { resource, capabilities };
}
