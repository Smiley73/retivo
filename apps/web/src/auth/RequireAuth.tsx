/**
 * Client-side route gate. Mirrors the server's RBAC posture so the UI
 * doesn't render pages the API would reject - but is NEVER the source of
 * truth. Every protected resource is authorized on the API.
 */
import React from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth, type Role } from './AuthContext';

export const RequireAuth: React.FC<{ roles?: Role[]; children: React.ReactNode }> = ({
  roles,
  children,
}) => {
  const { isAuthenticated, hasRole } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (roles && !hasRole(...roles)) {
    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <h1 className="mb-3 text-2xl font-semibold text-ink">
          Forbidden
        </h1>
        <p className="text-muted">
          You don't have permission to view this page. Required role:{' '}
          {roles.join(', ')}.
        </p>
      </main>
    );
  }
  return <>{children}</>;
};
