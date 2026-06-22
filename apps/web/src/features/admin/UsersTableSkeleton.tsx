import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * UsersTableSkeleton - loading placeholder for the roster (DESIGN.md section 6).
 *
 * Renders the real table chrome (header + container) with shimmer blocks in
 * place of N rows, mirroring the final layout instead of a centered spinner.
 * Created hides below `md` and Last login below `lg` to match the live table's
 * responsive behavior.
 */

interface UsersTableSkeletonProps {
  /** Number of placeholder rows to render. */
  rows?: number;
}

export function UsersTableSkeleton({ rows = 5 }: UsersTableSkeletonProps) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface shadow-sm">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-bg">
            <TableHead scope="col">Name</TableHead>
            <TableHead scope="col">Email</TableHead>
            <TableHead scope="col">Role</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col" className="hidden lg:table-cell">
              Last login
            </TableHead>
            <TableHead scope="col" className="hidden md:table-cell">
              Created
            </TableHead>
            <TableHead scope="col" className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody aria-hidden="true">
          {Array.from({ length: rows }).map((_, index) => (
            <TableRow key={index} className="hover:bg-transparent">
              <TableCell>
                <Skeleton className="h-4 w-32" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-48" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-6 w-24 rounded-sm" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-6 w-20 rounded-sm" />
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                <Skeleton className="h-4 w-20" />
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <Skeleton className="h-4 w-20" />
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  <Skeleton className="size-8 rounded-sm" />
                  <Skeleton className="size-8 rounded-sm" />
                  <Skeleton className="size-8 rounded-sm" />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
