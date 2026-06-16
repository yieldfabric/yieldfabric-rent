/**
 * Group-delegation JWTs — "acting as the property account".
 *
 * A rental's property account belongs to a GROUP entity, not the
 * landlord personally. The rent, the confidential balance, and the
 * per-entity-encrypted positions all live under that group. A plain
 * landlord JWT fails the wallet-ownership checks (and can't decrypt the
 * group's positions), so every call that acts AS the property account —
 * reading its balance, collecting a due rent leg, exchanging credit for
 * cash, sending under the agent policy — must carry a short-lived
 * delegation JWT scoped to the group.
 *
 * `delegationService.createDelegationToken` (POST /auth/delegation/jwt)
 * mints one. We cache it per-group until shortly before expiry so a
 * burst of group-acting calls reuses a single token.
 *
 * Docs: https://yieldfabric.com/docs/guides/delegation
 */
import { delegationService } from '@yieldfabric/wallet/core/delegationService';
import { tokenManager } from '@yieldfabric/wallet/core/tokenManager';

/** Scope the rental flows need against a property group: sign on-chain
 *  (collect / exchange / send) + read/update the group. */
const DELEGATION_SCOPE = [
  'CryptoOperations',
  'ReadGroup',
  'UpdateGroup',
  'ManageGroupMembers',
];
const TTL_SECONDS = 600;

const cache = new Map<string, { jwt: string; expiresAtMs: number }>();

/** Mint (or reuse) a delegation JWT for `groupId`. Cached until ~60s
 *  before expiry. */
export async function groupDelegationJwt(groupId: string): Promise<string> {
  const now = Date.now();
  const hit = cache.get(groupId);
  if (hit && hit.expiresAtMs - 60_000 > now) return hit.jwt;

  const userToken = tokenManager.getCurrentToken() ?? undefined;
  const resp = await delegationService.createDelegationToken(
    {
      group_id: groupId,
      delegation_scope: DELEGATION_SCOPE,
      expiry_seconds: TTL_SECONDS,
    },
    userToken
  );
  const jwt = resp.delegation_jwt;
  cache.set(groupId, { jwt, expiresAtMs: now + TTL_SECONDS * 1000 });
  return jwt;
}
