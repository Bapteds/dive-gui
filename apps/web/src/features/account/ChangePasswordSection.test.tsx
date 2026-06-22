import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/client';

/**
 * ChangePasswordSection tests.
 *
 * Covers the form's two pieces of real logic: client validation blocks a
 * mismatched confirmation before any request, and a server `INVALID_PASSWORD`
 * is mapped to a field error on the current-password input (not a generic
 * toast). The API layer and the auth context are mocked so the test exercises
 * the component, not the network.
 */
const { changePasswordMock, setUserMock } = vi.hoisted(() => ({
  changePasswordMock: vi.fn(),
  setUserMock: vi.fn(),
}));

vi.mock('@/lib/api/auth', () => ({
  changePassword: changePasswordMock,
  updateMe: vi.fn(),
}));

vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ setUser: setUserMock }),
}));

import { ChangePasswordSection } from './ChangePasswordSection';

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChangePasswordSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  changePasswordMock.mockReset();
  setUserMock.mockReset();
});

describe('ChangePasswordSection', () => {
  it('blocks submission and shows an error when the confirmation does not match', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.type(screen.getByLabelText('Current password'), 'Sup3rSecret!');
    await user.type(screen.getByLabelText('New password'), 'Brand-New-Pass-1');
    await user.type(screen.getByLabelText('Confirm new password'), 'Different-Pass-2');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();
    expect(changePasswordMock).not.toHaveBeenCalled();
  });

  it('maps a server INVALID_PASSWORD to a current-password field error', async () => {
    changePasswordMock.mockRejectedValueOnce(
      new ApiError('INVALID_PASSWORD', 'Your current password is incorrect', 400),
    );
    const user = userEvent.setup();
    renderSection();

    await user.type(screen.getByLabelText('Current password'), 'wrong-password');
    await user.type(screen.getByLabelText('New password'), 'Brand-New-Pass-1');
    await user.type(screen.getByLabelText('Confirm new password'), 'Brand-New-Pass-1');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText('That password is incorrect.')).toBeInTheDocument();
    expect(changePasswordMock).toHaveBeenCalledWith('wrong-password', 'Brand-New-Pass-1');
  });

  it('clears the fields and syncs the session on a successful change', async () => {
    changePasswordMock.mockResolvedValueOnce({
      accessToken: 'fresh-token',
      user: {
        id: 'u1',
        email: 'user@dive-turbinen.de',
        fullName: 'Regular User',
        role: 'USER',
        isProtected: false,
        isActive: true,
        lastLoginAt: '2026-06-20T08:15:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const user = userEvent.setup();
    renderSection();

    const current = screen.getByLabelText('Current password');
    await user.type(current, 'Sup3rSecret!');
    await user.type(screen.getByLabelText('New password'), 'Brand-New-Pass-1');
    await user.type(screen.getByLabelText('Confirm new password'), 'Brand-New-Pass-1');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() => expect(changePasswordMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(current).toHaveValue(''));
    expect(setUserMock).toHaveBeenCalledTimes(1);
  });
});
