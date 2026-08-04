import { useQueryClient } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  createRootRoute,
  redirect,
  useLocation,
  useNavigate,
} from '@tanstack/react-router';
import { Check, ChevronsUpDown, House, Radio, Settings, Tag } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Toaster } from '@/components/ui/sonner';
import { UserMenu } from '@/components/user-menu';
import { hasCredentials } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { useMe } from '@/lib/queries';

const NAV = [
  { to: '/', label: 'Home', icon: House },
  { to: '/mentions', label: 'Mentions', icon: Radio },
  { to: '/keywords', label: 'Keywords', icon: Tag },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

/** Routes that own the full viewport; no sidebar chrome. */
const BARE_ROUTES = new Set(['/login', '/onboarding']);

const isBarePath = (pathname: string): boolean =>
  BARE_ROUTES.has(pathname) || pathname.startsWith('/accept-invitation');

export const Route = createRootRoute({
  beforeLoad: ({ location }) => {
    if (location.pathname !== '/login' && !hasCredentials()) {
      // Invitation links must survive the login round-trip.
      if (location.pathname.startsWith('/accept-invitation')) {
        throw redirect({ to: '/login', search: { redirect: location.pathname } });
      }
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

function OrgSwitcher({
  orgs,
  activeOrg,
}: {
  orgs: Array<{ id: string; name: string; brandName: string | null; logoUrl: string | null }>;
  activeOrg: { id: string; name: string; brandName: string | null; logoUrl: string | null };
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const switchTo = async (organizationId: string) => {
    if (organizationId === activeOrg.id) return;
    const { error } = await authClient.organization.setActive({ organizationId });
    if (error) return;
    // Every query is org-scoped; drop the cache and restart from home.
    queryClient.clear();
    await navigate({ to: '/' });
  };

  if (orgs.length < 2) {
    return (
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-5">
        <BrandMark logoUrl={activeOrg.logoUrl} />
        <span className="truncate font-semibold tracking-tight">
          {activeOrg.brandName ?? activeOrg.name}
        </span>
      </div>
    );
  }

  return (
    <div className="border-b border-sidebar-border p-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="flex h-10 w-full items-center gap-2 rounded-md px-3 text-left transition-colors hover:bg-sidebar-accent data-popup-open:bg-sidebar-accent"
            />
          }
        >
          <BrandMark logoUrl={activeOrg.logoUrl} />
          <span className="min-w-0 flex-1 truncate font-semibold tracking-tight">
            {activeOrg.brandName ?? activeOrg.name}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent sideOffset={6}>
          {orgs.map((candidate) => (
            <DropdownMenuItem key={candidate.id} onClick={() => void switchTo(candidate.id)}>
              <span className="min-w-0 flex-1 truncate">
                {candidate.brandName ?? candidate.name}
              </span>
              {candidate.id === activeOrg.id ? <Check className="size-4" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RootLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const meQuery = useMe();
  const me = meQuery.data;
  const org = me ? (me.orgs.find((o) => o.id === me.activeOrgId) ?? me.orgs[0]) : undefined;

  // Session users whose workspace has not been onboarded are sent to the
  // onboarding flow before anything else. API-key-only users have no session
  // (useMe stays disabled) and are never gated.
  useEffect(() => {
    if (org && !org.onboarded && !isBarePath(pathname)) {
      void navigate({ to: '/onboarding' });
    }
  }, [org, pathname, navigate]);

  if (isBarePath(pathname)) {
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
        {org ? (
          <OrgSwitcher orgs={me?.orgs ?? []} activeOrg={org} />
        ) : (
          <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-5">
            <BrandMark logoUrl={null} />
            <span className="truncate font-semibold tracking-tight">Mentio</span>
          </div>
        )}
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
