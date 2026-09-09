/**
 * In-memory demo resources for policy-aware routes.
 * Not persisted — restart resets them. Role graph lives in Postgres via rbac-store.
 */

let walletSeq = 2;

const wallets = [
  { id: "wallet_1", ownerId: "1", label: "Primary (owner = user id 1)" },
  { id: "wallet_2", ownerId: "2", label: "Secondary (owner = user id 2)" },
];

const transactions = [
  { id: "tx_1", amount: 50_000, organizationId: "org_1", status: "pending" },
  { id: "tx_2", amount: 500_000, organizationId: "org_1", status: "pending" },
  { id: "tx_3", amount: 10_000, organizationId: "org_2", status: "pending" },
];

export function listWallets() {
  return wallets;
}

export function findWallet(id) {
  return wallets.find((w) => w.id === String(id)) ?? null;
}

export function createWallet(ownerId) {
  walletSeq += 1;
  const wallet = {
    id: `wallet_${walletSeq}`,
    ownerId: String(ownerId),
    label: `Wallet ${walletSeq}`,
  };
  wallets.push(wallet);
  return wallet;
}

export function deleteWallet(id) {
  const index = wallets.findIndex((w) => w.id === String(id));
  if (index === -1) return false;
  wallets.splice(index, 1);
  return true;
}

export function listTransactions() {
  return transactions;
}

export function findTransaction(id) {
  return transactions.find((t) => t.id === String(id)) ?? null;
}

export function approveTransaction(id) {
  const tx = findTransaction(id);
  if (!tx) return null;
  tx.status = "approved";
  return tx;
}
