import { Toaster as SonnerToaster, type ToasterProps } from 'sonner';

/**
 * Toaster - tokenised sonner toast host (DESIGN.md section 6).
 *
 * Top-right, 4s auto-dismiss, light theme. Toasts are announced politely and
 * never steal focus (sonner default). Success toasts carry the success accent,
 * error toasts the danger accent; both keep the app's surface / border / radius.
 * Re-exports `toast` so callers import the trigger from one place.
 */
export { toast } from 'sonner';

export function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      theme="light"
      position="top-right"
      duration={4000}
      gap={12}
      toastOptions={{
        classNames: {
          toast:
            'group rounded-md border border-border bg-surface text-text shadow-md text-sm gap-2 px-4 py-3',
          title: 'text-sm font-medium text-text',
          description: 'text-xs text-text-secondary',
          // Accessible CTA fill (white bold on --color-cta clears AA); the lighter
          // brand orange would only reach ~2.74:1 behind white text.
          actionButton:
            'rounded-sm bg-cta px-2.5 py-1 text-xs font-bold text-white transition-colors hover:bg-cta-hover',
          cancelButton: 'rounded-sm px-2.5 py-1 text-xs font-medium text-text-secondary',
          success: 'group-data-[type=success]:text-success [&_[data-icon]]:text-success',
          error: 'group-data-[type=error]:text-danger [&_[data-icon]]:text-danger',
          closeButton: 'border-border bg-surface text-text-secondary hover:text-text',
        },
      }}
      style={
        {
          // Drive sonner's internal CSS variables from the design tokens.
          '--normal-bg': 'var(--color-surface)',
          '--normal-text': 'var(--color-text)',
          '--normal-border': 'var(--color-border)',
          '--border-radius': 'var(--radius-md)',
          zIndex: 'var(--z-toast)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}
