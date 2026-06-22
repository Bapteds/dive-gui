import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Loader2, Pencil, SquarePen, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { toast } from '@/components/ui/sonner';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/AuthProvider';
import { ApiError } from '@/lib/api/client';
import type { Template } from '@/lib/api/types';
import { useDeleteTemplate, useTemplatesQuery } from '@/features/templates/useTemplates';
import { TemplateFormDialog } from '@/features/templates/TemplateFormDialog';

/**
 * TemplatesPage - the shared, reusable file templates.
 *
 * Templates are shared across the team: everyone sees every template (with its
 * author) and can apply it to a project; only the author or a super-admin can
 * edit or delete one. The single orange CTA for the zone is the header "New
 * template" button. States: loading / error / empty / data.
 */

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : dateFormatter.format(date);
}

export function TemplatesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: templates, isPending, isError, refetch, isRefetching } = useTemplatesQuery();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);

  const canManage = (template: Template) =>
    user?.role === 'SUPER_ADMIN' || template.owner.id === user?.id;

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (template: Template) => {
    setEditing(template);
    setFormOpen(true);
  };

  const newTemplateButton = (
    <Button type="button" onClick={openCreate}>
      New template
    </Button>
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Templates"
        subtitle="Reusable, shared file sets you can apply to any project's case."
        action={newTemplateButton}
      />

      {isPending ? (
        <TemplatesTableSkeleton />
      ) : isError ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-md border border-danger/40 bg-danger-tint px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle
              className="mt-0.5 size-5 shrink-0 text-danger"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium text-text">We could not load the templates.</p>
              <p className="text-sm text-text-secondary">Check your connection and try again.</p>
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void refetch()}
            loading={isRefetching}
            className="shrink-0"
          >
            Try again
          </Button>
        </div>
      ) : templates.length === 0 ? (
        <EmptyState
          title="No templates yet."
          description="Create a reusable file set you can apply to any project."
          action={newTemplateButton}
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-surface shadow-sm">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-bg">
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col" className="hidden md:table-cell">
                  Description
                </TableHead>
                <TableHead scope="col">Author</TableHead>
                <TableHead scope="col" className="hidden lg:table-cell">
                  Created
                </TableHead>
                <TableHead scope="col" className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((template) => {
                const author = template.owner.id === user?.id ? 'You' : template.owner.email;
                return (
                  <TableRow key={template.id}>
                    <TableCell className="font-medium text-text">
                      <Link
                        to={`/templates/${template.id}/edit`}
                        className="rounded-sm hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
                      >
                        {template.name}
                      </Link>
                    </TableCell>
                    <TableCell className="hidden min-w-0 text-text-secondary md:table-cell">
                      <span className="line-clamp-1 break-words">
                        {template.description || '—'}
                      </span>
                    </TableCell>
                    <TableCell className="text-text-secondary">{author}</TableCell>
                    <TableCell className="hidden text-text-secondary tabular-nums lg:table-cell">
                      {formatDate(template.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          asChild
                          variant="ghost"
                          size="icon"
                          aria-label={`Open ${template.name} in the editor`}
                        >
                          <Link to={`/templates/${template.id}/edit`}>
                            <SquarePen strokeWidth={1.75} aria-hidden="true" />
                          </Link>
                        </Button>
                        {canManage(template) && (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Edit ${template.name} details`}
                              className="text-text-secondary hover:bg-bg hover:text-text"
                              onClick={() => openEdit(template)}
                            >
                              <Pencil strokeWidth={1.75} aria-hidden="true" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Delete ${template.name}`}
                              className="text-text-secondary hover:bg-danger-tint hover:text-danger"
                              onClick={() => setDeleting(template)}
                            >
                              <Trash2 strokeWidth={1.75} aria-hidden="true" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <TemplateFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        template={editing}
        onCreated={(template) => navigate(`/templates/${template.id}/edit`)}
      />
      <DeleteTemplateDialog template={deleting} onOpenChange={(open) => !open && setDeleting(null)} />
    </div>
  );
}

/** Confirm-and-delete dialog for a template. */
function DeleteTemplateDialog({
  template,
  onOpenChange,
}: {
  template: Template | null;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteTemplate();

  const handleConfirm = async () => {
    if (!template) return;
    try {
      await remove.mutateAsync(template.id);
      toast.success('Template deleted.');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete the template.');
    }
  };

  return (
    <AlertDialog
      open={!!template}
      onOpenChange={(next) => {
        if (!remove.isPending) onOpenChange(next);
      }}
    >
      <AlertDialogContent className="overscroll-contain">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this template?</AlertDialogTitle>
          <AlertDialogDescription>
            {template ? `“${template.name}” and its files will be permanently removed. ` : ''}
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="border-danger/50 bg-danger text-white hover:bg-danger/90"
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
            disabled={remove.isPending}
            aria-busy={remove.isPending || undefined}
          >
            {remove.isPending && (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            )}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Loading placeholder mirroring the templates table. */
function TemplatesTableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface shadow-sm" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-4 border-b border-border px-4 py-3.5 last:border-b-0"
        >
          <Skeleton className="h-4 w-40" />
          <Skeleton className="hidden h-4 w-64 md:block" />
          <Skeleton className="ml-auto h-4 w-24" />
        </div>
      ))}
    </div>
  );
}
