import React from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import {
  AppAuthProvider,
  DEFAULT_AUTH_PROVIDERS,
  SignatureWorkflow,
  WalletProvider,
  setAuthRegistry,
} from '@yieldfabric/wallet';

import RequireAuth from './components/RequireAuth';
import Shell from './components/Shell';
import Login from './pages/Login';
import Overview from './pages/Overview';
import NewLease from './pages/NewLease';
import Leases from './pages/Leases';
import NewLoan from './pages/NewLoan';
import Loans from './pages/Loans';
import Wallet from './pages/Wallet';

/**
 * This app excludes the Averer provider from its auth / login flow. The
 * SDK resolves sign-in chips by intersecting what the auth service
 * advertises (`auth.providers.enabled`) with the app's provider
 * registry — so dropping `averer` removes its chip even on deployments
 * that advertise it. Email, MetaMask, passkey, and any other advertised
 * provider keep working.
 */
const authProviders = { ...DEFAULT_AUTH_PROVIDERS };
delete authProviders.averer;
setAuthRegistry(authProviders);

/**
 * Root providers.
 *
 * `<WalletProvider>` is the wallet-SDK's single mount point: it owns the
 * auth session (tokens, refresh, the `useAuth` hook) and every SDK UI
 * surface.
 *
 * `<SignatureWorkflow />` is the zero-config global signing mount. A
 * rental does real on-chain work — when a tenant or landlord is an
 * EXTERNAL signer (MetaMask / passkey, no custodial key), the pending
 * message routes to a Manual signature: the SDK pops a toast + drawer
 * for them to sign before the executor fires. Email/password users have
 * a custodial key and are signed server-side, so they never see it — but
 * mounting it means BOTH kinds of user work without extra code.
 * Docs: https://yieldfabric.com/docs/guides/signatures
 *
 * `disableGlobalSigner: true` pairs with the Averer exclusion above — it
 * stops the SDK lazy-loading `@averer/averer-websdk` after login.
 * MetaMask and passkey signing don't go through that SDK and keep
 * working.
 *
 * `<AppAuthProvider>` layers YieldFabric's group + delegation state on
 * top of the wallet auth state. It's mounted INSIDE `<WalletProvider>`
 * (it consumes `useAuth()`) and ABOVE everything that reads
 * `useAuthContext()` — which the SDK's `<SignatureWorkflow />` and the
 * Shell's `<SignatureCenterLauncher>` / `<IncomingPaymentsLauncher>` do.
 * Without it those surfaces throw "useAuthContext must be used within an
 * <AppAuthProvider>".
 */
function RootProviders({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const walletConfig = React.useMemo(
    () => ({
      onNavigate: (href: string, opts?: { replace?: boolean }) =>
        navigate(href, opts?.replace ? { replace: true } : undefined),
      disableGlobalSigner: true,
    }),
    [navigate]
  );
  return (
    <WalletProvider config={walletConfig}>
      <AppAuthProvider>
        {children}
        <SignatureWorkflow />
      </AppAuthProvider>
    </WalletProvider>
  );
}

export default function App() {
  return (
    <RootProviders>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <RequireAuth>
              <Shell />
            </RequireAuth>
          }
        >
          <Route path="/" element={<Overview />} />
          <Route path="/lease" element={<NewLease />} />
          <Route path="/leases" element={<Leases />} />
          <Route path="/loan" element={<NewLoan />} />
          <Route path="/loans" element={<Loans />} />
          <Route path="/wallet" element={<Wallet />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </RootProviders>
  );
}
