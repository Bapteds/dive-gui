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
  // The file editor opts out of the centered max-width container so it can use
  // the full viewport (full width + full height); every other page stays
  // centered at max-w-content.
  const { pathname } = useLocation();
  const fullBleed = /^\/projects\/[^/]+\/edit\/?$/.test(pathname);
  const contentClass = fullBleed
    ? 'flex min-h-0 flex-1 flex-col px-4 py-4 sm:px-6 sm:py-6'
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
        <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col">
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
