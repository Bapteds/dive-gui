import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChamberBuildWarnings } from './ChamberBuildWarnings';

/**
 * ChamberBuildWarnings tests: nothing renders for a clean build, and a build
 * with clamp warnings surfaces every message in an alert region.
 */

describe('ChamberBuildWarnings', () => {
  it('renders nothing for a clean build', () => {
    const { container } = render(<ChamberBuildWarnings warnings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists every builder warning in an alert', () => {
    const warnings = [
      'the hollow stack 3.3984 m exceeds H Kammer 2.7000 m; the internal part is scaled to 0.7945 to fit (its heights are reduced to match)',
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
