import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@yieldfabric/wallet';

/** Route guard: wait for the SDK's session restore, then either render
 *  the protected page or bounce to /login. */
export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-white">
        <span
          aria-hidden
          className="h-10 w-10 rounded-full border-2 border-brand-200 border-t-brand-600 animate-spin"
        />
      </div>
    );
  }
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
