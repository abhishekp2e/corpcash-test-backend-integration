/**
 * RBAC catalog used as the *initial seed* for @corpcash/rbac-store.
 *
 * After first boot, live role definitions live in Postgres (`rbac_roles`).
 * Changing this file does not update an already-seeded database — use
 * `/rbac/roles` (or re-seed an empty store). Policies stay in `rbac.js`.
 *
 * Routes and capability APIs should import RESOURCES / ACTIONS / perm()
 * instead of hard-coding "wallet:read"-style strings.
 *
 * Permission format used by @corpcash/rbac-*: "resource:action"
 * Wildcards: "wallet:*", "*:read", "*:*"
 */

/** @typedef {typeof RESOURCES[keyof typeof RESOURCES]} Resource */
/** @typedef {typeof ACTIONS[keyof typeof ACTIONS]} Action */

/**
 * Protected object types in the system.
 * Use RESOURCES.wallet (not the string "wallet") when calling authorize().
 */
export const RESOURCES = Object.freeze({
  wallet: "wallet",
  transaction: "transaction",
  dashboard: "dashboard",
  contract: "contract",
  user: "user",
  report: "report",
  rbac: "rbac",
});

/**
 * Operations that can be performed on a resource.
 * Paired with RESOURCES via perm() / PERMISSIONS.
 */
export const ACTIONS = Object.freeze({
  read: "read",
  create: "create",
  update: "update",
  delete: "delete",
  approve: "approve",
  deploy: "deploy",
  manage: "manage",
});

/**
 * Default assignable roles at first seed / registration fallback.
 * After seed, GET /auth/roles reads store.listRoles() (may include extra roles).
 */
export const ROLES = Object.freeze(["viewer", "developer", "manager", "admin"]);

/**
 * Builds a permission string in "resource:action" form.
 * Catalog code uses this; runtime modules prefer formatPermission from
 * @corpcash/rbac-core (see rbac.js).
 *
 * @param {Resource} resource
 * @param {Action} action
 * @returns {string} e.g. "wallet:read"
 */
export function perm(resource, action) {
  return `${resource}:${action}`;
}

/** Full access — matches every resource and action in the engine. */
const ALL = "*:*";

/**
 * Named permissions used when defining roles.
 * Prefer PERMISSIONS.walletRead over perm(...) inline so role configs stay readable
 * and rename-safe.
 */
export const PERMISSIONS = Object.freeze({
  dashboardRead: perm(RESOURCES.dashboard, ACTIONS.read),
  walletRead: perm(RESOURCES.wallet, ACTIONS.read),
  walletCreate: perm(RESOURCES.wallet, ACTIONS.create),
  walletUpdate: perm(RESOURCES.wallet, ACTIONS.update),
  walletDelete: perm(RESOURCES.wallet, ACTIONS.delete),
  transactionRead: perm(RESOURCES.transaction, ACTIONS.read),
  transactionApprove: perm(RESOURCES.transaction, ACTIONS.approve),
  contractRead: perm(RESOURCES.contract, ACTIONS.read),
  contractDeploy: perm(RESOURCES.contract, ACTIONS.deploy),
  userRead: perm(RESOURCES.user, ACTIONS.read),
  reportRead: perm(RESOURCES.report, ACTIONS.read),
  rbacManage: perm(RESOURCES.rbac, ACTIONS.manage),
  all: ALL,
});

/** Allowlist used by boot-time validation below. */
const KNOWN_PERMISSIONS = new Set(Object.values(PERMISSIONS));

/**
 * Role graph seeded once via store.seed({ roles }).
 *
 * - permissions: granted directly to the role
 * - inherits: also receives permissions from parent role(s)
 * - admin uses "*:*" instead of listing every permission
 *
 * Effective permissions are expanded by the engine (GET /me/authorization).
 */
export const rbacConfig = {
  roles: {
    viewer: {
      permissions: [
        PERMISSIONS.walletRead,
        PERMISSIONS.transactionRead,
        PERMISSIONS.dashboardRead,
      ],
    },
    developer: {
      inherits: ["viewer"],
      permissions: [
        PERMISSIONS.walletCreate,
        PERMISSIONS.walletUpdate,
        PERMISSIONS.contractRead,
        PERMISSIONS.contractDeploy,
      ],
    },
    manager: {
      inherits: ["developer"],
      permissions: [
        PERMISSIONS.transactionApprove,
        PERMISSIONS.walletDelete,
        PERMISSIONS.userRead,
        PERMISSIONS.reportRead,
      ],
    },
    admin: {
      permissions: [PERMISSIONS.all],
    },
  },
};

/**
 * [resource, action] pairs evaluated on the backend for the UI capability map.
 *
 * Why a separate list: the frontend should not re-implement RBAC; it only
 * receives booleans from GET /me/authorization. Add an entry here when the UI
 * needs to show/hide a control for that permission.
 */
export const CAPABILITY_CHECKS = Object.freeze([
  [RESOURCES.dashboard, ACTIONS.read],
  [RESOURCES.wallet, ACTIONS.read],
  [RESOURCES.wallet, ACTIONS.create],
  [RESOURCES.wallet, ACTIONS.update],
  [RESOURCES.wallet, ACTIONS.delete],
  [RESOURCES.transaction, ACTIONS.read],
  [RESOURCES.transaction, ACTIONS.approve],
  [RESOURCES.contract, ACTIONS.read],
  [RESOURCES.contract, ACTIONS.deploy],
  [RESOURCES.user, ACTIONS.read],
  [RESOURCES.report, ACTIONS.read],
  [RESOURCES.rbac, ACTIONS.manage],
]);

/**
 * Ensures a permission string exists in PERMISSIONS (or is a wildcard).
 * Catches typos like "walet:read" as soon as this module loads.
 *
 * @param {string} permission
 */
function assertKnownPermission(permission) {
  if (permission.includes("*")) return;
  if (!KNOWN_PERMISSIONS.has(permission)) {
    throw new Error(`Unknown permission: ${permission}`);
  }
}

// Boot validation: fail fast if role config or capability checks drift
// from the RESOURCES / ACTIONS / PERMISSIONS catalogs.
for (const [roleName, def] of Object.entries(rbacConfig.roles)) {
  for (const permission of def.permissions ?? []) {
    try {
      assertKnownPermission(permission);
    } catch (err) {
      throw new Error(`Role "${roleName}": ${err.message}`);
    }
  }
}

for (const [resource, action] of CAPABILITY_CHECKS) {
  assertKnownPermission(perm(resource, action));
  if (!Object.values(RESOURCES).includes(resource)) {
    throw new Error(`Unknown resource in CAPABILITY_CHECKS: ${resource}`);
  }
  if (!Object.values(ACTIONS).includes(action)) {
    throw new Error(`Unknown action in CAPABILITY_CHECKS: ${action}`);
  }
}
