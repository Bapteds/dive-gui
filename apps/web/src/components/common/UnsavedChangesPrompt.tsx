import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * UnsavedChangesPrompt - guard against losing unsaved form input.
 *
 * When `when` is true it does two things:
 *  - intercepts in-app (react-router) navigation to a different path and asks
 *    the operator to confirm before leaving, and
 *  - arms the native `beforeunload` dialog for hard reloads / tab close.
 * It renders nothing while inactive. Drop it inside any page or dialog that owns
 * a dirty form; pass the form's `isDirty` (scoped to "open" for dialogs) as
 * `when`. Relies on the data router (createBrowserRouter), which the app uses.
 */
interface UnsavedChangesPromptProps {
  /** True while there are unsaved changes that would be lost on navigation. */
  when: boolean;
}

export function UnsavedChangesPrompt({ when }: UnsavedChangesPromptProps) {
  // Native guard for full-page unloads (refresh, tab close, external links).
  useEffect(() => {
    if (!when) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers require returnValue to be set to trigger the prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [when]);

  // Intercept client-side navigation between paths while changes are pending.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      when && currentLocation.pathname !== nextLocation.pathname,
  );

  const blocked = blocker.state === 'blocked';

  return (
    <AlertDialog
      open={blocked}
      onOpenChange={(open) => {
        // Closing via Esc / scrim cancels the navigation (stay on the page).
        if (!open && blocker.state === 'blocked') blocker.reset();
      }}
    >
      <AlertDialogContent className="overscroll-contain">
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            You have changes that have not been saved. If you leave now, they will be lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => blocker.state === 'blocked' && blocker.reset()}>
            Stay on page
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => blocker.state === 'blocked' && blocker.proceed()}
            className="bg-danger text-white hover:bg-danger-hover"
          >
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
