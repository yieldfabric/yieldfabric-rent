/**
 * Wallet data — balances, the obligations a wallet holds, and accept.
 *
 * Mirrors the data layer of the first-party app's wallet detail page
 * (`yieldfabric-app/src/pages/wallets/[walletId].tsx`), trimmed to the
 * essentials:
 *
 *   BALANCES   — the confidential balance per asset, read off the vault
 *                (`/balance?denomination=…`, REST) — see lib/graphql.
 *   POSITIONS  — `GET_WALLET_BY_ID` returns the wallet's positions; each
 *                position's `asset` is a UNION: an `Asset` (a token
 *                holding) or a `Payment` (an obligation / payment leg the
 *                wallet is party to, with `status` + `canAccept`).
 *   ACCEPT     — claim an incoming payment / obligation into the wallet
 *                (`accept`, the same mutation `ACCEPT_PAYMENT` the
 *                first-party page uses), then poll to settlement.
 *
 * Reads ride the federated gateway; the accept mutation goes
 * payments-direct.
 */
import { gatewayQuery, paymentsMutation } from './graphql';

// ── Position / wallet shapes (the slice this app reads) ──────────────

export interface AssetHolding {
  __typename: 'Asset';
  id: string;
  name?: string | null;
  assetType?: string | null;
  currency?: string | null;
}

export interface PaymentHolding {
  __typename: 'Payment';
  id: string;
  amount?: string | null;
  balance?: string | null;
  status?: string | null;
  paymentType?: string | null;
  contractId?: string | null;
  canAccept?: boolean | null;
  contract?: { id: string; name?: string | null } | null;
  asset?: { id: string; currency?: string | null } | null;
  payer?: { entity?: { id?: string; name?: string } | null; wallet?: { id?: string } | null } | null;
  payee?: { entity?: { id?: string; name?: string } | null; wallet?: { id?: string } | null } | null;
}

export type PositionAsset = AssetHolding | PaymentHolding;

export interface WalletPosition {
  id: string;
  quantity: number;
  asset?: PositionAsset | null;
}

export interface WalletView {
  id: string;
  entityId?: string | null;
  name?: string | null;
  address?: string | null;
  chainId?: number | null;
  positions: WalletPosition[];
}

const WALLET_QUERY = `
  query RentWalletById($id: String!) {
    wallet(id: $id) {
      id
      entityId
      name
      address
      chainId
      positions {
        id
        quantity
        asset {
          __typename
          ... on Asset {
            id
            name
            assetType
            currency
          }
          ... on Payment {
            id
            amount
            balance
            status
            paymentType
            contractId
            canAccept
            contract { id name }
            asset { id currency }
            payer { entity { id name } wallet { id } }
            payee { entity { id name } wallet { id } }
          }
        }
      }
    }
  }
`;

export async function fetchWallet(walletId: string): Promise<WalletView | null> {
  const data = await gatewayQuery<{ wallet: WalletView | null }>(WALLET_QUERY, { id: walletId });
  return data.wallet ?? null;
}

/** The `Payment`-typed positions — the obligations / payment legs the
 *  wallet is party to (what the wallet page lists as contracts). */
export function paymentPositions(wallet: WalletView | null): PaymentHolding[] {
  if (!wallet) return [];
  return wallet.positions
    .map((p) => p.asset)
    .filter((a): a is PaymentHolding => !!a && a.__typename === 'Payment');
}

/** Claim an incoming payment / obligation into `walletId`. The same
 *  `accept(input: { paymentId, walletId })` the first-party wallet page
 *  fires (its `ACCEPT_PAYMENT`). Runs under the caller's own bearer.
 *  Returns the `messageId` to poll to settlement. */
export async function acceptPayment(
  paymentId: string,
  walletId?: string
): Promise<{ success?: boolean; message?: string; messageId?: string }> {
  const data = await paymentsMutation<{
    accept: { success?: boolean; message?: string; messageId?: string };
  }>(
    'mutation AcceptPayment($input: AcceptInput!) { accept(input: $input) { success message messageId } }',
    { input: { paymentId, walletId: walletId ?? undefined } }
  );
  if (!data.accept?.success) {
    throw new Error(data.accept?.message || 'accept rejected');
  }
  return data.accept;
}
