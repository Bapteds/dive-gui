import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Link, RouterProvider } from 'react-router-dom';
import { UnsavedChangesPrompt } from './UnsavedChangesPrompt';

// jsdom + node's undici Request are mismatched for data-router navigation: the
// router builds `new Request('/path', { signal })` where the path lacks an
// origin and the AbortSignal is jsdom's (which undici rejects). Resolve the path
// against localhost and drop the signal so navigation does not throw. Scoped to
// this suite only (test files run isolated, so this does not leak elsewhere).
const BaseRequest = globalThis.Request;
globalThis.Request = class extends BaseRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const url =
      typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input;
    super(url, init ? { ...init, signal: undefined } : init);
  }
} as typeof Request;

/**
 * UnsavedChangesPrompt tests.
 *
 * Uses a real (memory) data router so useBlocker is active. Verifies that
 * in-app navigation is intercepted only when there are unsaved changes, and that
 * the confirm / cancel actions proceed / stay as expected.
 */
function setup(when: boolean) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <>
            <UnsavedChangesPrompt when={when} />
            <Link to="/next">Go next</Link>
          </>
        ),
      },
      { path: '/next', element: <div>Next page</div> },
    ],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
}

describe('UnsavedChangesPrompt', () => {
  it('blocks navigation and shows the prompt when there are unsaved changes', async () => {
    const user = userEvent.setup();
    setup(true);

    await user.click(screen.getByRole('link', { name: 'Go next' }));

    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(screen.queryByText('Next page')).not.toBeInTheDocument();
  });

  it('does not block navigation when there are no unsaved changes', async () => {
    const user = userEvent.setup();
    setup(false);

    await user.click(screen.getByRole('link', { name: 'Go next' }));

    // No guard fires, so the confirm prompt never appears.
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
  });

  it('stays on the page when the operator cancels the prompt', async () => {
    const user = userEvent.setup();
    setup(true);

    await user.click(screen.getByRole('link', { name: 'Go next' }));
    await user.click(await screen.findByRole('button', { name: 'Stay on page' }));

    expect(screen.queryByText('Next page')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go next' })).toBeInTheDocument();
  });

  it('dismisses the prompt and proceeds when the operator confirms discard', async () => {
    const user = userEvent.setup();
    setup(true);

    await user.click(screen.getByRole('link', { name: 'Go next' }));
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Discard changes' }));

    // Confirming releases the blocker, so the prompt closes (navigation proceeds).
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
  });
});
