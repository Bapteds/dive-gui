import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

/**
 * AppShell - the authenticated layout (DESIGN.md section 5).
 *
 * Fixed top Header, a left Sidebar on desktop, and a main content area that
 * renders the matched child route via <Outlet/>. Content is centered to a
 * 1200px max width with 24-32px padding; on mobile it goes full width with
 * px-4. The whole shell sits on the page-bg tint.
 */
export function AppShell() {
  // Project pages opt out of the centered max-width container to use the full
  // width. Two flavors:
  //  - the file editor (`…/edit`) is pinned to exactly the viewport minus the
  //    64px (h-16) sticky header and clipped at every size, so the page never
  //    scrolls and the editor scrolls internally (a fixed height is
  //    deterministic and lets descendants resolve `height: 100%`);
  //  - the project detail page is full width and, from `lg` up (where there is
  //    vertical room), is pinned the same way so the page itself never scrolls
  //    and its Case files region scrolls internally. Below `lg` it flows and
  //    scrolls normally, which is the right behaviour on a phone.
  // Every other page stays centered at max-w-content.
  const { pathname } = useLocation();
  const isEditor = /^\/(projects|templates)\/[^/]+\/edit\/?$/.test(pathname);
  const isProjectDetail = /^\/projects\/[^/]+\/?$/.test(pathname);
  const contentClass = isEditor
    ? 'flex h-[calc(100dvh_-_4rem)] flex-col overflow-hidden px-4 py-4 sm:px-6 sm:py-6'
    : isProjectDetail
      ? 'w-full px-4 py-6 sm:px-6 sm:py-8 lg:flex lg:h-[calc(100dvh_-_4rem)] lg:flex-col lg:overflow-hidden lg:px-8'
      : 'mx-auto w-full max-w-content px-4 py-6 sm:px-6 sm:py-8 lg:px-8';

  return (
    <div className="flex min-h-[100dvh] flex-col bg-bg">
      {/* First focusable element: lets keyboard users jump straight to content. */}
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Header />
      <div className="flex flex-1">
        <Sidebar />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1">
          <div className={contentClass}>
            {/* Suspense boundary for the code-split route components: the shell
                stays put while the next page's chunk loads. */}
            <Suspense
              fallback={
                <div
                  className="flex min-h-[40vh] items-center justify-center"
                  role="status"
                  aria-live="polite"
                >
                  <Loader2
                    className="size-5 animate-spin text-text-secondary"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span className="sr-only">Loading</span>
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}
