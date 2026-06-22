import { cn } from '@/lib/utils';

/**
 * SettingsSection - the hairline-bordered surface that groups one account
 * concern (DESIGN.md section 1: hairlines do the work of cards).
 *
 * A header zone (section title + one muted description line) sits above the
 * body, separated by a 1px divider. The body (`children`) is supplied by the
 * caller and typically holds a form whose own footer bar carries the single
 * primary action. No diamond marker here: the hairline structure is the
 * signature, and repeating a glyph per section would read as templated.
 */
export interface SettingsSectionProps {
  /** Section heading (renders as an h2 under the page h1). */
  title: string;
  /** One short line describing the section. */
  description: string;
  children: React.ReactNode;
  className?: string;
}

export function SettingsSection({ title, description, children, className }: SettingsSectionProps) {
  return (
    <section className={cn('rounded-md border border-border bg-surface shadow-sm', className)}>
      <header className="border-b border-border px-5 py-4 sm:px-6">
        <h2 className="text-lg font-semibold text-text">{title}</h2>
        <p className="mt-1 text-sm text-text-secondary">{description}</p>
      </header>
      {children}
    </section>
  );
}
