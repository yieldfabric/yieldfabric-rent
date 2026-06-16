import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  IncomingPaymentsLauncher,
  SignatureCenterLauncher,
  useAuth,
} from '@yieldfabric/wallet';

/**
 * App chrome shared by every signed-in page.
 *
 * The two launchers on the right are wallet-SDK drop-ins, mounted the
 * same way the first-party app mounts them:
 *
 *   `<IncomingPaymentsLauncher>` — badge with the count of payments /
 *     obligations awaiting YOUR acceptance; opens the inbox drawer. This
 *     is where a tenant accepts the proposed lease and, later, the
 *     property account accepts incoming rent.
 *   `<SignatureCenterLauncher>` — the wallet panel (pending signatures,
 *     history, profile, keys).
 */
const navLink = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
    isActive
      ? 'bg-brand-600 text-white'
      : 'text-ink-soft hover:text-ink hover:bg-surface-alt'
  }`;

export default function Shell() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-surface-alt">
      <header className="sticky top-0 z-30 bg-white border-b border-line">
        <div className="mx-auto max-w-6xl px-6 h-16 flex items-center gap-4">
          <NavLink to="/" className="flex items-center gap-2 mr-2">
            <span className="h-8 w-8 rounded-lg bg-brand-600 text-white grid place-items-center text-sm font-bold">
              YF
            </span>
            <span className="font-semibold tracking-tight text-ink-deep hidden sm:block">
              Rent
            </span>
          </NavLink>

          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={navLink}>
              Overview
            </NavLink>
            <NavLink to="/leases" className={navLink}>
              Leases
            </NavLink>
            <NavLink to="/loans" className={navLink}>
              Loans
            </NavLink>
            <NavLink to="/wallet" className={navLink}>
              Wallet
            </NavLink>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <IncomingPaymentsLauncher variant="icon-label" />
            <SignatureCenterLauncher variant="icon-label" />
            <span className="hidden md:block text-xs text-ink-mute max-w-[14rem] truncate">
              {user?.email}
            </span>
            <button onClick={() => logout()} className="btn-secondary !px-3 !py-1.5 text-xs">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8 pb-24">
        <Outlet />
      </main>
    </div>
  );
}
