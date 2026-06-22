import { createContext, forwardRef, useContext, useId } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Label } from './label';

/**
 * Field - label + control + helper/error wrapper.
 *
 * Composes a labelled form control with accessible wiring: the label's `htmlFor`
 * targets the control, helper/error text is linked via `aria-describedby`, and
 * the error is announced with `role="alert"` (DESIGN.md section 6). Children read
 * the generated ids and invalid state from context via `useFieldControl`.
 */
interface FieldContextValue {
  id: string;
  descriptionId: string;
  errorId: string;
  hasError: boolean;
  hasHelper: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * useFieldControl - props a control should spread to inherit Field wiring.
 *
 * Returns `id`, `aria-invalid`, and `aria-describedby` pointing at whichever of
 * helper / error text is present. Safe to call outside a Field (returns empty).
 */
export function useFieldControl(): {
  id?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
} {
  const ctx = useContext(FieldContext);
  if (!ctx) return {};
  const describedBy =
    [ctx.hasError ? ctx.errorId : null, ctx.hasHelper ? ctx.descriptionId : null]
      .filter(Boolean)
      .join(' ') || undefined;
  return {
    id: ctx.id,
    'aria-invalid': ctx.hasError || undefined,
    'aria-describedby': describedBy,
  };
}

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Visible field label. */
  label: string;
  /** Persistent helper text shown below the control when no error is present. */
  helperText?: string;
  /** Error message; when set it replaces the helper text and marks the control invalid. */
  error?: string;
  /** Mark the field required (renders an asterisk and sets the control state). */
  required?: boolean;
}

const Field = forwardRef<HTMLDivElement, FieldProps>(
  ({ className, label, helperText, error, required, children, ...props }, ref) => {
    const id = useId();
    const descriptionId = `${id}-description`;
    const errorId = `${id}-error`;
    const hasError = Boolean(error);
    const hasHelper = Boolean(helperText) && !hasError;

    return (
      <FieldContext.Provider value={{ id, descriptionId, errorId, hasError, hasHelper }}>
        <div ref={ref} className={cn('flex flex-col gap-2', className)} {...props}>
          <Label htmlFor={id}>
            {label}
            {required && (
              <span className="ml-0.5 text-danger" aria-hidden="true">
                *
              </span>
            )}
          </Label>
          {children}
          {hasHelper && (
            <p id={descriptionId} className="text-xs text-text-secondary">
              {helperText}
            </p>
          )}
          {hasError && (
            <p
              id={errorId}
              role="alert"
              className="flex items-start gap-1.5 text-xs font-medium text-danger"
            >
              <AlertCircle className="mt-px size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              <span>{error}</span>
            </p>
          )}
        </div>
      </FieldContext.Provider>
    );
  },
);
Field.displayName = 'Field';

export { Field };
