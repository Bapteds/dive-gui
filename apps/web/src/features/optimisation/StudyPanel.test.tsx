import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicStudy, StudyDetail, StudyEvaluation } from '@dive/shared';

/**
 * StudyPanel tests (WS-H spec §9, adapted to §0): stages of the running
 * evaluation, owner-only controls, the evaluations table (infeasible reason,
 * budget-hit flag) and the charts' table alternatives. The API module is mocked.
 */

vi.mock('@/lib/api/studies', () => ({
  startStudy: vi.fn(),
  stopStudy: vi.fn(),
  resumeStudy: vi.fn(),
  deleteStudy: vi.fn(),
  downloadStudyCsv: vi.fn(),
}));

vi.mock('@/components/ui/sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import * as api from '@/lib/api/studies';
import { StudyPanel } from './StudyPanel';

function study(partial: Partial<PublicStudy> = {}): PublicStudy {
  return {
    id: 's1',
    name: 'Width sweep',
    projectId: 'p1',
    owner: { id: 'u1', fullName: 'Lena Hoffmann' },
    baseSource: 'save',
    baseLabel: 'Kaplan 1450',
    baseInput: { x1: 1450, x2: 7.85, x3: 8 },
    paramSpace: [
      { key: 'width', label: 'B Kammer', base: 4450, min: 4050, max: 4850, step: 50, bandPct: 10, source: 'band' },
    ],
    bandPct: 10,
    weights: { headLoss: 0.5, vortex: 0.5 },
    mode: 'weighted',
    sampler: 'tpe',
    seed: null,
    vortexMetric: 'maskedQVolume',
    maxEvaluations: 30,
    maxDurationHours: null,
    keepBest: 3,
    keepLast: 2,
    meshingSourceId: 'chamber-ref',
    cores: 4,
    criteria: null,
    normalisation: { headLoss: 2, vortex: 0.5 },
    status: 'running',
    reason: null,
    counted: 3,
    currentIndex: 3,
    canControl: true,
    startedAt: '2026-09-30T08:00:00.000Z',
    finishedAt: null,
    createdAt: '2026-09-30T07:50:00.000Z',
    updatedAt: '2026-09-30T08:30:00.000Z',
    ...partial,
  };
}

function evaluation(partial: Partial<StudyEvaluation>): StudyEvaluation {
  return {
    index: 0,
    status: 'done',
    stage: 'solving',
    designParams: { width: 4450 },
    chamberHash: 'abc',
    meshingSessionId: 'study-width-sweep-0',
    meshingSessionName: 'study-width-sweep-0',
    sessionAvailable: true,
    runId: 'r0',
    runStatus: 'converged',
    budgetHit: false,
    dp0: 19620,
    headLoss: 2,
    maskedQVolume: 0.5,
    omegaRms: 10,
    objective: 1,
    refusalReason: null,
    warnings: [],
    startedAt: '2026-09-30T08:00:00.000Z',
    finishedAt: '2026-09-30T08:10:00.000Z',
    ...partial,
  };
}

const EVALUATIONS: StudyEvaluation[] = [
  evaluation({}),
  evaluation({
    index: 1,
    designParams: { width: 4200 },
    headLoss: 1,
    maskedQVolume: 0.25,
    objective: 0.5,
  }),
  evaluation({
    index: 2,
    status: 'infeasible',
    stage: 'building',
    designParams: { width: 4050 },
    dp0: null,
    headLoss: null,
    maskedQVolume: null,
    omegaRms: null,
    objective: null,
    runStatus: null,
    refusalReason: 'Cannot build the chamber. The guide vanes do not fit.',
  }),
  evaluation({
    index: 3,
    status: 'solving',
    designParams: { width: 4700 },
    dp0: null,
    headLoss: null,
    maskedQVolume: null,
    omegaRms: null,
    objective: null,
    runStatus: null,
  }),
];

function detail(s: Partial<PublicStudy> = {}, evaluations = EVALUATIONS): StudyDetail {
  return { study: study(s), evaluations, best: 1, paretoFront: [0, 1] };
}

function renderPanel(d: StudyDetail) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <StudyPanel projectId="p1" detail={d} onEdit={vi.fn()} onDeleted={vi.fn()} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StudyPanel', () => {
  it('shows the stage of the running evaluation and the pause control', () => {
    renderPanel(detail());
    expect(screen.getByText('Running')).toBeInTheDocument();
    const stages = screen.getByRole('list', { name: 'Evaluation stages' });
    const current = within(stages)
      .getAllByRole('listitem')
      .find((li) => li.getAttribute('aria-current') === 'step');
    expect(current).toHaveTextContent('Solve');
    expect(screen.getByText(/3 of 30 evaluations/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
  });

  it('starts a draft (owner) and hides the controls from other members', async () => {
    const user = userEvent.setup();
    vi.mocked(api.startStudy).mockResolvedValue(study({ status: 'running' }));
    const { unmount } = renderPanel(
      detail({ status: 'draft', counted: 0, currentIndex: null, normalisation: null }, []),
    );
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(api.startStudy).toHaveBeenCalledWith('p1', 's1');
    unmount();

    renderPanel(detail({ status: 'draft', canControl: false, counted: 0, currentIndex: null }, []));
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only the study owner or a super-admin/)).toBeInTheDocument();
  });

  it('lists the evaluations with the refusal reason and the budget-hit flag', () => {
    renderPanel(
      detail({ status: 'completed', currentIndex: null }, [
        ...EVALUATIONS.slice(0, 3),
        evaluation({ index: 3, budgetHit: true, runStatus: 'completed', objective: 0.9, headLoss: 1.9, maskedQVolume: 0.45 }),
      ]),
    );
    const table = screen.getByRole('table', { name: 'Evaluations' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(within(rows[3]).getByText('Infeasible')).toBeInTheDocument();
    expect(within(rows[3]).getByText(/guide vanes do not fit/)).toBeInTheDocument();
    expect(within(rows[4]).getByText(/Time budget/)).toBeInTheDocument();
    expect(within(rows[2]).getByText('4200')).toBeInTheDocument();
    // The best design is marked and can be opened in the Chamber page.
    expect(screen.getByRole('button', { name: 'Open in Chamber' })).toBeInTheDocument();
  });

  it('offers table alternatives for both charts', async () => {
    const user = userEvent.setup();
    renderPanel(detail({ status: 'completed', currentIndex: null }));
    await user.click(screen.getByText('Show objective values'));
    const objective = screen.getByRole('table', { name: /Objective per evaluation/ });
    expect(within(objective).getByText('0.500')).toBeInTheDocument();
    await user.click(screen.getByText('Show head loss and vortex values'));
    const scatter = screen.getByRole('table', { name: /Head loss against/ });
    expect(within(scatter).getAllByText('Pareto front')).toHaveLength(2);
  });
});
