import { useNavigate } from '@tanstack/react-router';
import { ChevronsUpDown, CreditCard, LogOut, Settings } from 'lucide-react';
import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { authClient, clearLoggedIn } from '@/lib/auth-client';

function initialsOf(name: string, email: string): string {
  const source = name.trim() || email;
  const words = source.split(/\s+/).filter(Boolean);
  const initials =
    words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : source.slice(0, 2);
  return initials.toUpperCase();
}

function UserAvatar({ name, email, image }: { name: string; email: string; image?: string | null }) {
  const [failed, setFailed] = useState(false);
  if (image && !failed) {
    return (
      <img
        src={image}
        alt=""
        referrerPolicy="no-referrer"
        className="size-7 shrink-0 rounded-full"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
      {initialsOf(name, email)}
    </span>
  );
}

/** Sidebar footer: the signed-in user with a Settings / Billing / Sign out
 *  menu, or a neutral line for API-key-only sessions. */
export function UserMenu() {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const user = session?.user;

  const signOut = async () => {
    try {
      await authClient.signOut();
    } catch {
      // Revocation is best-effort; the local marker is cleared regardless.
    }
    clearLoggedIn();
    await navigate({ to: '/login' });
  };

  if (!user) {
    return (
      <div className="mt-auto border-t border-sidebar-border p-4">
        <p className="text-xs text-muted-foreground">
          Tracking dev platforms via the Mentions API.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-auto border-t border-sidebar-border p-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-md p-2 text-left transition-colors hover:bg-sidebar-accent data-popup-open:bg-sidebar-accent"
            />
          }
        >
          <UserAvatar name={user.name} email={user.email} image={user.image} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{user.name || user.email}</span>
            <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" sideOffset={6}>
          <DropdownMenuItem onClick={() => void navigate({ to: '/settings' })}>
            <Settings /> Settings
          </DropdownMenuItem>
          <DropdownMenuItem disabled>
            <CreditCard /> Billing (coming soon)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void signOut()}>
            <LogOut /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
