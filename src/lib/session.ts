/**
 * Caller identity beyond what the wallet-SDK's `useAuth()` exposes.
 *
 * `GET /protected/jwt` is the canonical "who am I on the fabric"
 * lookup — it resolves the bearer to the identifiers every payments
 * call needs (https://yieldfabric.com/docs/guides/building-with-yf):
 *
 *   user_id            — owner of MQ messages; needed for status polling
 *   default_wallet_id  — the wallet UUID used by activity feeds and as
 *                        `counterpartWalletId` in obligation mutations
 *   account_address    — the caller's on-chain smart-account address
 */
import { tokenManager } from '@yieldfabric/wallet/core/tokenManager';
import { AUTH_URL } from '../config';

export interface JwtInfo {
  user_id?: string;
  account_address?: string | null;
  group_account_address?: string | null;
  default_wallet_id?: string | null;
  [k: string]: unknown;
}

export async function fetchJwtInfo(): Promise<JwtInfo> {
  const token = tokenManager.getCurrentToken();
  if (!token) throw new Error('not signed in');
  const res = await fetch(`${AUTH_URL}/protected/jwt`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`/protected/jwt failed: HTTP ${res.status}`);
  return (await res.json()) as JwtInfo;
}
