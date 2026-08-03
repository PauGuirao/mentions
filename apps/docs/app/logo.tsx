export function Logo() {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="flex size-6 items-center justify-center rounded-md bg-fd-primary font-mono text-sm font-bold text-fd-primary-foreground">
        @
      </span>
      <span className="font-semibold">Mentions</span>
      <span className="rounded-md border border-fd-border px-1.5 py-0.5 text-xs text-fd-muted-foreground">
        Docs
      </span>
    </span>
  );
}
