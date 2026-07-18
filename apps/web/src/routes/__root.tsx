import { Link, Outlet, createRootRoute } from '@tanstack/react-router';
import { Radio, Settings, Tag } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';

const NAV = [
  { to: '/mentions', label: 'Mentions', icon: Radio },
  { to: '/keywords', label: 'Keywords', icon: Tag },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

export const Route = createRootRoute({ component: RootLayout });

function RootLayout() {
  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 flex w-56 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-5">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary font-mono text-sm font-bold text-primary-foreground">
            @
          </span>
          <span className="font-semibold tracking-tight">Mentions</span>
        </div>
        <nav className="flex flex-col gap-1 p-3">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              activeProps={{
                className: 'bg-sidebar-accent text-sidebar-accent-foreground',
              }}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto border-t border-sidebar-border p-4">
          <p className="text-xs text-muted-foreground">
            Tracking dev platforms via the Mentions API.
          </p>
        </div>
      </aside>
      <main className="ml-56">
        <Outlet />
      </main>
      <Toaster theme="light" />
    </div>
  );
}
