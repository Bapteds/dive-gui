import { useEffect, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { FileCode, FolderTree } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { UnsavedChangesPrompt } from '@/components/common/UnsavedChangesPrompt';
import { ApiError } from '@/lib/api/client';
import type { CreateTemplateInput, Template, UpdateTemplateInput } from '@/lib/api/types';
import { useCreateTemplate, useUpdateTemplate } from './useTemplates';
import { parseTagInput, templateFormSchema, type TemplateFormValues } from './schemas';

/**
 * TemplateFormDialog - unified create / edit dialog for a template's metadata
 * (name + tags + description). On create you also choose how it starts: an empty
 * file set (add files in the editor next) or a single file you write inline. On
 * edit it just saves the metadata. Maps server validation errors onto the name
 * field and toasts anything else.
 */

interface TemplateFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided the dialog edits this template; otherwise it creates one. */
  template?: Template | null;
  /** Called with the created template so the caller can open its editor. */
  onCreated?: (template: Template) => void;
}

export function TemplateFormDialog({
  open,
  onOpenChange,
  template,
  onCreated,
}: TemplateFormDialogProps) {
  const isEdit = !!template;
  const createTemplate = useCreateTemplate();
  const updateTemplate = useUpdateTemplate();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    setFocus,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<TemplateFormValues>({
    resolver: zodResolver(templateFormSchema),
    mode: 'onBlur',
    defaultValues: { name: '', tags: '', description: '', kind: 'set', path: '', content: '' },
  });

  // Reset whenever the dialog opens: blank for create, prefilled for edit.
  useEffect(() => {
    if (!open) return;
    reset({
      name: template?.name ?? '',
      tags: template?.tags.join(', ') ?? '',
      description: template?.description ?? '',
      kind: 'set',
      path: '',
      content: '',
    });
  }, [open, template, reset]);

  const kind = watch('kind');
  const submitting = createTemplate.isPending || updateTemplate.isPending;

  const onValid = async (values: TemplateFormValues) => {
    const tags = parseTagInput(values.tags);
    const description = values.description?.trim() ? values.description.trim() : undefined;
    try {
      if (isEdit && template) {
        const payload: UpdateTemplateInput = { name: values.name.trim(), description, tags };
        await updateTemplate.mutateAsync({ id: template.id, input: payload });
        toast.success('Template updated.');
      } else {
        const payload: CreateTemplateInput = {
          name: values.name.trim(),
          description,
          tags,
          ...(values.kind === 'file' && values.path?.trim()
            ? { file: { path: values.path.trim(), content: values.content ?? '' } }
            : {}),
        };
        const created = await createTemplate.mutateAsync(payload);
        toast.success('Template created.');
        onCreated?.(created);
      }
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') {
        setError('name', { type: 'server', message: error.message });
        setFocus('name');
        return;
      }
      toast.error(
        error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <UnsavedChangesPrompt when={open && isDirty && !submitting} />
      <DialogContent className="max-h-[88vh] overflow-y-auto overscroll-contain sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit template' : 'New template'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update this template’s name, tags and description.'
              : 'Name and tag your template. Start empty and add files in the editor, or write a single file now.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onValid)} noValidate className="flex flex-col gap-4">
          <Field label="Name" required error={errors.name?.message}>
            <Input
              autoFocus
              spellCheck={false}
              disabled={submitting}
              placeholder="e.g. Steady RANS starter"
              {...register('name')}
            />
          </Field>

          <Field
            label="Tags"
            error={errors.tags?.message}
            helperText="Comma-separated. Used for search and sorting (e.g. mesh, inlet, steady)."
          >
            <Input
              spellCheck={false}
              disabled={submitting}
              placeholder="mesh, inlet, steady"
              {...register('tags')}
            />
          </Field>

          {!isEdit && (
            <Field label="Start with">
              <div role="group" aria-label="How the template starts" className="grid grid-cols-2 gap-2">
                <KindButton
                  active={kind === 'set'}
                  disabled={submitting}
                  onClick={() => setValue('kind', 'set', { shouldDirty: true })}
                  icon={<FolderTree className="size-4" strokeWidth={1.75} aria-hidden="true" />}
                  title="Empty file set"
                  hint="Add files in the editor"
                />
                <KindButton
                  active={kind === 'file'}
                  disabled={submitting}
                  onClick={() => setValue('kind', 'file', { shouldDirty: true })}
                  icon={<FileCode className="size-4" strokeWidth={1.75} aria-hidden="true" />}
                  title="Single file"
                  hint="Write one file now"
                />
              </div>
            </Field>
          )}

          {!isEdit && kind === 'file' && (
            <>
              <Field
                label="File path"
                required
                error={errors.path?.message}
                helperText="Where the file lands when applied, e.g. system/fvSolution."
              >
                <Input
                  spellCheck={false}
                  disabled={submitting}
                  placeholder="system/fvSolution"
                  className="font-mono"
                  {...register('path')}
                />
              </Field>
              <Field label="Content" error={errors.content?.message}>
                <Textarea
                  spellCheck={false}
                  disabled={submitting}
                  rows={8}
                  placeholder="Paste or write the file content…"
                  className="font-mono text-xs"
                  {...register('content')}
                />
              </Field>
            </>
          )}

          <Field
            label="Description"
            error={errors.description?.message}
            helperText="Optional. Describe the context this template is for."
          >
            <Textarea
              spellCheck={false}
              disabled={submitting}
              placeholder="e.g. Minimal incompressible steady-state setup"
              {...register('description')}
            />
          </Field>

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              {isEdit ? 'Save changes' : 'Create template'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One choice in the "Start with" segmented control (empty set vs single file). */
function KindButton({
  active,
  disabled,
  onClick,
  icon,
  title,
  hint,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex flex-col items-start gap-0.5 rounded-md border p-3 text-left transition-colors duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
        active ? 'border-primary bg-primary-tint' : 'border-border bg-surface hover:border-border-strong',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span className={cn('flex items-center gap-1.5 text-sm font-medium', active ? 'text-primary' : 'text-text')}>
        {icon}
        {title}
      </span>
      <span className="text-xs text-text-secondary">{hint}</span>
    </button>
  );
}
