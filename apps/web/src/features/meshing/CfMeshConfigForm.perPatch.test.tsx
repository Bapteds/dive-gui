import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_CFMESH_CONFIG } from '@/lib/api/types';
import type { CfMeshConfig, MeshBounds, MeshingPatch } from '@/lib/api/types';
import { CfMeshConfigForm } from './CfMeshConfigForm';

/**
 * CfMeshConfigForm per-patch tests: the tri-state layer rows (off -> noLayerPatches,
 * mirror -> nothing, Customize -> perPatch) and the per-patch local refinement,
 * asserted on the exact config object Generate submits - the same payload the
 * autosave sends. Also covers re-seeding those states from a saved config.
 */

const PATCHES: MeshingPatch[] = [
  { name: 'inlet', type: 'patch' },
  { name: 'walls', type: 'wall' },
];

const BOUNDS: MeshBounds = { min: [0, 0, 0], max: [1, 1, 1] };

function renderForm(initialConfig: CfMeshConfig | null = null) {
  const onGenerate = vi.fn();
  render(
    <CfMeshConfigForm
      stls={[{ name: 'cube.stl', sizeBytes: 684 }]}
      bounds={BOUNDS}
      patches={PATCHES}
      disabled={false}
      running={false}
      initialConfig={initialConfig}
      maxCores={8}
      onGenerate={onGenerate}
    />,
  );
  return onGenerate;
}

function openAdvanced() {
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
}

function enableGlobalLayers() {
  openAdvanced();
  fireEvent.click(screen.getByLabelText(/Add boundary layers/));
}

function generate(onGenerate: ReturnType<typeof vi.fn>): CfMeshConfig {
  fireEvent.click(screen.getByRole('button', { name: /Generate mesh/ }));
  expect(onGenerate).toHaveBeenCalled();
  return onGenerate.mock.calls[onGenerate.mock.calls.length - 1][0] as CfMeshConfig;
}

describe('CfMeshConfigForm per-patch layers (tri-state)', () => {
  it('default: every patch mirrors the global block (no perPatch, no noLayerPatches)', () => {
    const onGenerate = renderForm();
    enableGlobalLayers();
    const config = generate(onGenerate);
    expect(config.addLayers.enabled).toBe(true);
    expect(config.addLayers.perPatch).toBeUndefined();
    expect(config.addLayers.noLayerPatches).toBeUndefined();
  });

  it('unticking a patch sends it in noLayerPatches (no layers on it)', () => {
    const onGenerate = renderForm();
    enableGlobalLayers();
    // Scoped to the layers fieldset: the refinement fieldset has same-named boxes.
    const rows = within(screen.getByRole('group', { name: 'Per-patch layers' }));
    fireEvent.click(rows.getByRole('checkbox', { name: 'inlet' }));
    const config = generate(onGenerate);
    expect(config.addLayers.noLayerPatches).toEqual(['inlet']);
    expect(config.addLayers.perPatch).toBeUndefined();
  });

  it('a mirror row displays the LIVE global values read-only', () => {
    renderForm();
    enableGlobalLayers();
    const nInput = screen.getByLabelText('inlet number of layers');
    expect(nInput).toBeDisabled();
    expect(nInput).toHaveValue(DEFAULT_CFMESH_CONFIG.addLayers.nLayers);
    // Editing the GLOBAL count updates what the mirror row shows.
    fireEvent.change(screen.getByLabelText('Number of layers'), { target: { value: '7' } });
    expect(screen.getByLabelText('inlet number of layers')).toHaveValue(7);
  });

  it('Customize seeds from the globals, then sends independent perPatch values', () => {
    const onGenerate = renderForm();
    enableGlobalLayers();
    fireEvent.change(screen.getByLabelText('Number of layers'), { target: { value: '5' } });

    fireEvent.click(screen.getAllByRole('button', { name: 'Customize' })[0]); // inlet row
    const nInput = screen.getByLabelText('inlet number of layers');
    expect(nInput).toBeEnabled();
    expect(nInput).toHaveValue(5); // seeded from the current global

    fireEvent.change(nInput, { target: { value: '9' } });
    const config = generate(onGenerate);
    expect(config.addLayers.perPatch).toEqual({
      inlet: { nLayers: 9, thicknessRatio: 1.2, maxFirstLayerThickness: null },
    });
    // The customized row no longer follows a global edit.
    fireEvent.change(screen.getByLabelText('Number of layers'), { target: { value: '2' } });
    expect(screen.getByLabelText('inlet number of layers')).toHaveValue(9);
  });

  it('Reset to global drops the perPatch override (back to mirror)', () => {
    const onGenerate = renderForm();
    enableGlobalLayers();
    fireEvent.click(screen.getAllByRole('button', { name: 'Customize' })[0]);
    fireEvent.change(screen.getByLabelText('inlet number of layers'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset to global' }));
    const config = generate(onGenerate);
    expect(config.addLayers.perPatch).toBeUndefined();
    expect(config.addLayers.noLayerPatches).toBeUndefined();
  });

  it('re-seeds off/custom/mirror from a saved config', () => {
    const onGenerate = renderForm({
      ...DEFAULT_CFMESH_CONFIG,
      addLayers: {
        enabled: true,
        nLayers: 3,
        thicknessRatio: 1.2,
        maxFirstLayerThickness: null,
        perPatch: { inlet: { nLayers: 6, thicknessRatio: 1.5, maxFirstLayerThickness: null } },
        noLayerPatches: ['walls'],
      },
    });
    openAdvanced();
    // walls seeded OFF, inlet seeded CUSTOM with its saved values.
    const rows = within(screen.getByRole('group', { name: 'Per-patch layers' }));
    expect(rows.getByRole('checkbox', { name: 'walls' })).not.toBeChecked();
    expect(screen.getByLabelText('inlet number of layers')).toHaveValue(6);
    expect(screen.getByLabelText('inlet number of layers')).toBeEnabled();
    // Round-trip: generating sends the same tri-state back.
    const config = generate(onGenerate);
    expect(config.addLayers.noLayerPatches).toEqual(['walls']);
    expect(config.addLayers.perPatch).toEqual({
      inlet: { nLayers: 6, thicknessRatio: 1.5, maxFirstLayerThickness: null },
    });
  });
});

describe('CfMeshConfigForm local refinement (per patch)', () => {
  it('sends localRefinement only for ticked patches with a positive size', () => {
    const onGenerate = renderForm();
    openAdvanced();
    const sizeInput = screen.getByLabelText('inlet local cell size in metres');
    expect(sizeInput).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'inlet' }));
    fireEvent.change(screen.getByLabelText('inlet local cell size in metres'), {
      target: { value: '0.005' },
    });
    const config = generate(onGenerate);
    expect(config.localRefinement).toEqual({ inlet: { cellSize: 0.005 } });
  });

  it('omits a ticked patch whose size is blank, and the whole map when nothing is set', () => {
    const onGenerate = renderForm();
    openAdvanced();
    fireEvent.click(screen.getByRole('checkbox', { name: 'inlet' })); // ticked, no size
    const config = generate(onGenerate);
    expect(config.localRefinement).toBeUndefined();
  });

  it('re-seeds a saved refinement (ticked with its size)', () => {
    const onGenerate = renderForm({
      ...DEFAULT_CFMESH_CONFIG,
      localRefinement: { walls: { cellSize: 0.02 } },
    });
    openAdvanced();
    expect(screen.getByLabelText('walls local cell size in metres')).toHaveValue(0.02);
    const config = generate(onGenerate);
    expect(config.localRefinement).toEqual({ walls: { cellSize: 0.02 } });
  });
});
