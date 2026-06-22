import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
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
import { UnsavedChangesPrompt } from '@/components/common/UnsavedChangesPrompt';
import { ApiError } from '@/lib/api/client';
import type { CreateTemplateInput, Template, UpdateTemplateInput } from '@/lib/api/types';
import { useCreateTemplate, useUpdateTemplate } from './useTemplates';
import { templateFormSchema, type TemplateFormValues } from './schemas';

/**
 * TemplateFormDialog - unified create / edit dialog for a template's metadata
 * (name + description). On create it then sends the operator to the editor to
 * add files; on edit it just saves the metadata. Maps server validation errors
 * onto the name field and toasts anything else.
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
    formState: { errors, isDirty },
  } = useForm<TemplateFormValues>({
    resolver: zodResolver(templateFormSchema),
    mode: 'onBlur',
    defaultValues: { name: '', description: '' },
  });

  // Reset whenever the dialog opens: blank for create, prefilled for edit.
  useEffect(() => {
    if (!open) return;
    reset({ name: template?.name ?? '', description: template?.description ?? '' });
  }, [open, template, reset]);

  const submitting = createTemplate.isPending || updateTemplate.isPending;

  const onValid = async (values: TemplateFormValues) => {
    const payload = {
      name: values.name.trim(),
      description: values.description?.trim() ? values.description.trim() : undefined,
    };
    try {
      if (isEdit && template) {
        await updateTemplate.mutateAsync({ id: template.id, input: payload as UpdateTemplateInput });
        toast.success('Template updated.');
      } else {
        const created = await createTemplate.mutateAsync(payload as CreateTemplateInput);
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
      toast.error(error instanceof ApiError ? error.message : 'Something went wrong. Please try again.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <UnsavedChangesPrompt when={open && isDirty && !submitting} />
      <DialogContent className="overscroll-contain">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit template' : 'New template'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update this template’s name and description.'
              : 'Name your template; you’ll add its files next.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onValid)} noValidate className="flex flex-col gap-4">
          <Field label="Name" required error={errors.name?.message}>
            <Input
              autoFocus
              spellCheck={false}
              disabled={submitting}
              placeholder="e.g. Steady RANS starter…"
              {...register('name')}
            />
          </Field>

          <Field
            label="Description"
            error={errors.description?.message}
            helperText="Optional. Describe the context this template is for."
          >
            <Textarea
              spellCheck={false}
              disabled={submitting}
              placeholder="e.g. Minimal incompressible steady-state setup…"
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
