/**
 * Backend RBAC wiring — uses @corpcash/rbac-core + @corpcash/rbac-node only.
 * Roles/permissions live in rbac.config.js; policies register here.
 */
import { formatPermission } from "@corpcash/rbac-core";
import { createRBAC } from "@corpcash/rbac-node";
import { createExpressMiddleware } from "@corpcash/rbac-node/express";
import {
  ACTIONS,
  CAPABILITY_CHECKS,
  RESOURCES,
  rbacConfig,
} from "./rbac.config.js";

/** Engine from rbac-node (wraps @corpcash/rbac-core RBAC). */
export const rbac = createRBAC({
  roles: rbacConfig.roles,
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

/**
 * Policy: wallet:delete — only the owner may delete (guide §4.5).
 * When resource is a type string (capability probe), skip instance check.
 */
rbac.registerPolicyFor(RESOURCES.wallet, ACTIONS.delete, ({ subject, resource }) => {
  if (typeof resource !== "object" || resource == null || !("ownerId" in resource)) {
    return true;
  }
  return subject.id === String(resource.ownerId);
});

/**
 * Policy: transaction:approve — same org; high amounts require admin (guide §4.5).
 */
rbac.registerPolicyFor(
  RESOURCES.transaction,
  ACTIONS.approve,
  ({ subject, resource }) => {
    if (typeof resource !== "object" || resource == null) return true;

    const subjectOrg = subject.attributes?.organizationId;
    const resourceOrg = resource.organizationId;
    if (subjectOrg != null && resourceOrg != null && subjectOrg !== resourceOrg) {
      return false;
    }

    const amount = Number(resource.amount ?? 0);
    if (amount > 100_000) {
      return subject.roles.includes("admin");
    }
    return true;
  },
);

/** Express authorize() from @corpcash/rbac-node/express */
export const { authorize } = createExpressMiddleware({
  rbac,
  getSubject: (req) => req.subject ?? null,
});

/**
 * Flat capability map for GET /me/authorization (UX bootstrap).
 * Uses core formatPermission so keys stay "resource:action".
 */
export function getCapabilities(subject) {
  const capabilities = {};
  for (const [resource, action] of CAPABILITY_CHECKS) {
    const result = rbac.authorize({ subject, resource, action });
    capabilities[formatPermission(resource, action)] = result.allowed;
  }
  return capabilities;
}
