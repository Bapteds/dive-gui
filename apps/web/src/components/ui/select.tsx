import { forwardRef } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFieldControl } from './field';

/**
 * Select - dropdown select on Radix Select (DESIGN.md section 6).
 *
 * The trigger matches the Input shape (40px, sm radius, hairline border, focus
 * ring). The content popover uses the md shadow. The trigger consumes Field
 * context so it inherits id / aria-invalid / aria-describedby when wrapped in a
 * Field. Fully keyboard operable via Radix.
 */
const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => {
  const field = useFieldControl();
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      {...field}
      className={cn(
        'flex h-10 w-full items-center justify-between gap-2 rounded-sm border border-border bg-surface px-3 py-2',
        'text-sm text-text',
        'transition-[border-color,box-shadow] duration-fast ease-out',
        'hover:border-border-strong',
        'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:bg-bg disabled:text-text-secondary',
        'aria-[invalid=true]:border-danger',
        'data-[placeholder]:text-text-secondary',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      className={cn(
        'relative z-dropdown max-h-[18rem] min-w-[8rem] overflow-hidden rounded-sm border border-border bg-surface shadow-md',
        'data-[state=open]:animate-content-in data-[state=closed]:animate-content-out',
        position === 'popper' && 'w-[var(--radix-select-trigger-width)]',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Viewport className="overscroll-contain p-1">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectItem = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-pointer select-none items-center rounded-[6px] py-2 pl-8 pr-2.5 text-sm text-text outline-none',
      'transition-colors duration-fast ease-out data-[highlighted]:bg-bg',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  >
    <span className="absolute left-2.5 grid size-3.5 place-items-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="size-3.5 text-primary" strokeWidth={2} aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem };
