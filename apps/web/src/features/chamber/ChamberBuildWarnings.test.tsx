import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChamberBuildWarnings } from './ChamberBuildWarnings';

/**
 * ChamberBuildWarnings tests: nothing renders for a clean build, a build with
 * clamp warnings surfaces every message in an alert region, and a failed /
 * invalid Generate lists its errors in a distinct red block (optionally
 * alongside warnings from the previous successful build).
 */

describe('ChamberBuildWarnings', () => {
  it('renders nothing for a clean build', () => {
    const { container } = render(<ChamberBuildWarnings warnings={[]} errors={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists build errors in a red alert block', () => {
    const errors = [
      'the cylinder shoulder (first + middle height, i.e. 2 x HLE) is 4.2 m tall but H Kammer only allows 2.7 m.',
      'Runner Ø (mm): Enter a number',
    ];
    render(<ChamberBuildWarnings warnings={[]} errors={errors} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Build errors');
    expect(alert).not.toHaveTextContent('Build warnings');
    for (const error of errors) {
      expect(screen.getByText(error)).toBeInTheDocument();
    }
  });

  it('shows errors and warnings as separate blocks when both exist', () => {
    render(
      <ChamberBuildWarnings
        warnings={['outlet radius clamped']}
        errors={['Could not generate the chamber.']}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Build errors');
    expect(alert).toHaveTextContent('Build warnings');
  });

  it('lists every builder warning in an alert', () => {
    const warnings = [
      'outlet outer radius 0.8400 clamped to 0.6666 (X1 too large for this vane/d_last combination)',
      'chamber.step falls back to the vane-less solid (no vanes carved)',
    ];
    render(<ChamberBuildWarnings warnings={warnings} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Build warnings');
    for (const warning of warnings) {
      expect(screen.getByText(warning)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
