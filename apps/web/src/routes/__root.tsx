import {
  Link,
  Outlet,
  createRootRoute,
  redirect,
  useLocation,
  useNavigate,
} from '@tanstack/react-router';
import { House, Radio, Settings, Tag } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { UserMenu } from '@/components/user-menu';
import { hasCredentials } from '@/lib/api';
import { useMe } from '@/lib/queries';

const NAV = [
  { to: '/', label: 'Home', icon: House },
  { to: '/mentions', label: 'Mentions', icon: Radio },
  { to: '/keywords', label: 'Keywords', icon: Tag },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

/** Routes that own the full viewport; no sidebar chrome. */
const BARE_ROUTES = new Set(['/login', '/onboarding']);

export const Route = createRootRoute({
  beforeLoad: ({ location }) => {
    if (location.pathname !== '/login' && !hasCredentials()) {
      throw redirect({ to: '/login' });
    }
  },
  component: RootLayout,
});

function BrandMark({ logoUrl }: { logoUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  if (logoUrl && !failed) {
    return (
      <img
        src={logoUrl}
        alt=""
        className="size-6 shrink-0 rounded-md object-contain"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary font-mono text-sm font-bold text-primary-foreground">
      @
    </span>
  );
}

function RootLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const meQuery = useMe();
  const org = meQuery.data?.orgs[0];

  // Session users whose workspace has not been onboarded are sent to the
  // onboarding flow before anything else. API-key-only users have no session
  // (useMe stays disabled) and are never gated.
  useEffect(() => {
    if (org && !org.onboarded && !BARE_ROUTES.has(pathname)) {
      void navigate({ to: '/onboarding' });
    }
  }, [org, pathname, navigate]);

  if (BARE_ROUTES.has(pathname)) {
    return (
      <>
        <Outlet />
        <Toaster theme="light" />
      </>
    );
  }

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 flex w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-5">
          <BrandMark logoUrl={org?.logoUrl ?? null} />
          <span className="truncate font-semibold tracking-tight">
            {org ? (org.brandName ?? org.name) : 'Mentions'}
          </span>
        </div>
        <nav className="flex flex-col gap-1 p-3">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              activeOptions={{ exact: item.to === '/' }}
              activeProps={{
                className: 'bg-sidebar-accent text-sidebar-accent-foreground',
              }}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <UserMenu />
      </aside>
      <main className="ml-64">
        <Outlet />
      </main>
      <Toaster theme="light" />
    </div>
  );
}
