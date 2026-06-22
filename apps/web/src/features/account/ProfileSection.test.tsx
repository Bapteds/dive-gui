import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { User } from '@/lib/api/types';

/**
 * ProfileSection tests.
 *
 * Verifies the read-only-vs-editable split: email and role are displayed (not
 * editable inputs), while the name is editable with a Save action that is
 * disabled until the field actually changes. The API + auth context are mocked.
 */
const { updateMeMock, setUserMock } = vi.hoisted(() => ({
  updateMeMock: vi.fn(),
  setUserMock: vi.fn(),
}));

vi.mock('@/lib/api/auth', () => ({
  updateMe: updateMeMock,
  changePassword: vi.fn(),
}));

vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ setUser: setUserMock }),
}));

import { ProfileSection } from './ProfileSection';

const baseUser: User = {
  id: 'u1',
  email: 'katharina.vogel@dive-turbinen.de',
  fullName: 'Katharina Vogel',
  role: 'USER',
  isProtected: false,
  isActive: true,
  lastLoginAt: '2026-06-20T08:15:00.000Z',
  createdAt: '2026-01-04T09:00:00.000Z',
  updatedAt: '2026-01-04T09:00:00.000Z',
};

function renderSection(user: User = baseUser) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProfileSection user={user} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updateMeMock.mockReset();
  setUserMock.mockReset();
});

describe('ProfileSection', () => {
  it('shows email and role as read-only details, not editable inputs', () => {
    renderSection();
    expect(screen.getByText('katharina.vogel@dive-turbinen.de')).toBeInTheDocument();
    expect(screen.getByText('User')).toBeInTheDocument();
    // Email is shown for reference only: there is no email field to edit.
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('keeps Save disabled until the name changes, then saves it', async () => {
    updateMeMock.mockResolvedValueOnce({ user: { ...baseUser, fullName: 'Katharina Vogel-Brandt' } });
    const user = userEvent.setup();
    renderSection();

    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    const name = screen.getByLabelText('Full name');
    await user.clear(name);
    await user.type(name, 'Katharina Vogel-Brandt');
    await waitFor(() => expect(save).toBeEnabled());

    await user.click(save);
    await waitFor(() => expect(updateMeMock).toHaveBeenCalledWith('Katharina Vogel-Brandt'));
    expect(setUserMock).toHaveBeenCalledTimes(1);
  });
});
