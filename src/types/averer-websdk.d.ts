/**
 * @file averer-websdk.d.ts
 * @description Local TypeScript shim for `@averer/averer-websdk`.
 *
 * The installed SDK (v2.1.3 at time of writing) ships malformed
 * declaration files — `dist/lib/hooks/useAvererWallet.d.ts` weighs
 * ~480KB and contains TS syntax errors past line 8000 (some viem-
 * generated type that escaped the build pipeline). `skipLibCheck`
 * doesn't help because the errors are parse-level, not semantic.
 *
 * This file redeclares the surface we actually use. tsconfig.json
 * routes `@averer/averer-websdk` to this shim via `paths`, so the
 * compiler never reads the broken types in node_modules. The runtime
 * import still resolves normally via the bundler's module resolution.
 *
 * Re-syncing after an SDK upgrade: check
 * `node_modules/@averer/averer-websdk/dist/index.d.ts` for the
 * exported names and adjust the surface here.
 */

declare module '@averer/averer-websdk' {
  import { FC, ReactNode } from 'react';

  // ── Result types ──────────────────────────────────────────────────

  export type ProofStatus = 'valid' | 'failed' | 'pending';
  export type VerificationMode = 'individual' | 'business';

  export interface SdkSuccessRes {
    /** Wallet currently connected via Dynamic or injected provider. */
    walletAddress: string;
    /** User identity details from Dynamic / Averer IDP. */
    user: {
      email?: string;
      isAuthenticated: boolean;
      did?: string;
    };
    /**
     * One entry per `sdkQuery` item. Empty when no proofs were
     * requested (auth-only mode).
     */
    proofs: Array<{
      id: string | number;
      circuitId: string;
      subjectTitle: string;
      status: ProofStatus;
      proofData: {
        credentialType: string;
        rawProof?: unknown;
      };
    }>;
    /** Aggregate eligibility derived from all proof checks. */
    eligibility: {
      passed: boolean;
      summary: string;
    };
    /** Optional on-chain transaction emitted by the SDK. */
    onChain?: unknown;
  }

  // ── Query types ───────────────────────────────────────────────────

  /**
   * A list of zero-knowledge proof requests passed to the widget. The
   * widget walks the user through providing/issuing each credential
   * needed to satisfy the queries. Pass `[]` to opt out of any proof
   * checks (auth-only flow — wallet creation + sign-in only).
   */
  export type SdkQuery = Array<{
    id: string | number;
    circuitId: string;
    subjectTitle: string;
    optional?: boolean;
    query: Record<string, unknown>;
  }>;

  export type CircuitId = string;

  // ── Provider component ────────────────────────────────────────────

  export interface AvererSdkProviderProps {
    configId: string;
    evmNetworksOverrides?: unknown;
    rpcUrlsOverrides?: unknown;
    children?: ReactNode;
  }

  export const AvererSdkProvider: FC<AvererSdkProviderProps>;

  // ── Widget component ──────────────────────────────────────────────

  export interface AvererWebSdkProps {
    /** App name shown in the widget UI. */
    appName: string;
    mode?: VerificationMode;
    /** ZK proof eligibility queries. `[]` for pure auth. */
    sdkQuery: SdkQuery;
    /** Optional on-chain metadata if the widget should commit to chain. */
    onChainMetaData?: { method_id?: string; contract_address?: string };
    onSuccess?: (data: SdkSuccessRes) => void;
    onError?: (reason: string) => void;
  }

  export const AvererWebSdk: FC<AvererWebSdkProps>;

  // ── Wallet hook ───────────────────────────────────────────────────

  /**
   * Reads the connected wallet from the surrounding AvererSdkProvider.
   * Returns a handle whose `address` is empty until the user has
   * completed sign-in via the widget.
   *
   * `signMessage` returns `string | undefined` — the SDK has paths
   * where signing can be cancelled or unavailable.
   */
  export function useAvererWallet(): {
    address: string;
    getBalance: () => Promise<string | undefined>;
    signMessage: (message: string) => Promise<string | undefined>;
    getPublicClient: () => Promise<{
      chain: { id: number; name: string };
      [key: string]: unknown;
    }>;
    getWalletClient: () => Promise<unknown>;
  };
}
