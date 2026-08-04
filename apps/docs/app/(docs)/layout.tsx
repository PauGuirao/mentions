import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/notebook';
import { LargeSearchToggle } from 'fumadocs-ui/components/layout/search-toggle';
import { ThemeToggle } from 'fumadocs-ui/components/layout/theme-toggle';
import { SidebarFooter } from 'fumadocs-ui/components/layout/sidebar';
import { BookOpen, Code, FileJson, Workflow } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { baseOptions } from '@/lib/layout.shared';

/* The Overview tab owns every page outside the API Reference and MCP root
 * folders, so its navbar tab highlights on all of them (a bare '/' URL would
 * prefix-match everything). */
const overviewUrls = new Set(
  source
    .getPages()
    .map((page) => page.url)
    .filter((url) => !url.startsWith('/api') && !url.startsWith('/mcp')),
);

/* The notebook layout hides the sidebar footer on desktop; passing a footer
 * component (not a node) lets us drop that className and keep it visible. */
function Footer({ children }: ComponentProps<'div'>) {
  return (
    <SidebarFooter className="flex flex-col gap-2 border-t px-3 py-3">
      {children}
      <div className="flex items-center gap-1.5">
        <a
          href="https://app.mentio.dev"
          className="flex-1 rounded-lg bg-fd-primary px-3 py-1.5 text-center text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
        >
          Dashboard
        </a>
        <ThemeToggle />
      </div>
      <a
        href="https://api.mentio.dev/v1/openapi.json"
        className="inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-1.5 text-sm text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
      >
        <FileJson className="size-4" />
        OpenAPI
      </a>
    </SidebarFooter>
  );
}

export default function RootDocsLayout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      {...baseOptions()}
      // Search and theme toggle live in the sidebar instead of the navbar.
      searchToggle={{ enabled: false }}
      themeSwitch={{ enabled: false }}
      tabMode="navbar"
      sidebar={{
        defaultOpenLevel: 1,
        prefetch: true,
        banner: <LargeSearchToggle className="w-full" />,
        footer: Footer,
        tabs: [
          { title: 'Overview', url: '/', urls: overviewUrls, icon: <BookOpen /> },
          { title: 'API Reference', url: '/api', icon: <Code /> },
          { title: 'MCP', url: '/mcp', icon: <Workflow /> },
        ],
      }}
    >
      {children}
    </DocsLayout>
  );
}
