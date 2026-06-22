import { forwardRef } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

/**
 * Tooltip - on Radix Tooltip. Explains disabled actions and icon-only buttons.
 *
 * A single TooltipProvider is mounted once near the app root (see providers).
 * Content uses a dark surface for contrast against light UI, the md shadow, and
 * the scale+fade entrance. Tooltips never carry essential-only information.
 */
const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-tooltip max-w-xs rounded-sm bg-text px-2.5 py-1.5 text-xs font-medium text-white shadow-md',
        'data-[state=delayed-open]:animate-content-in data-[state=closed]:animate-content-out',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
