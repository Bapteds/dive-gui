import { useMemo } from 'react';
import { ChevronDown, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getFoamValue,
  parseFoamModel,
  setFoamValue,
  type FoamDocument,
  type FoamNode,
} from './foamModel';
import { type FoamFieldDef, type FoamFileDef } from './foamFieldCatalog';
import { matchFoamFileDef } from './foamForm';

/**
 * CaseFileForm - the "easy mode" form editor for an OpenFOAM case file.
 *
 * It parses the raw file (foamModel), matches it against the field catalog
 * (foamFieldCatalog) by its FoamFile `object`, and renders each entry as a
 * control: a <select> for enumerated keys (boundary-condition types, schemes,
 * solver/model choices, on/off flags) and a text input for everything else.
 * Editing one field splices just that value back into the raw text via
 * setFoamValue, so comments, the banner, macros and unknown content are
 * preserved byte-for-byte. Anything the catalog doesn't know still renders as a
 * text input, and complex/unknown sub-dictionaries (e.g. `functions`) defer to
 * advanced mode rather than being flattened into noise.
 */

interface CaseFileFormProps {
  /** Raw file content. */
  value: string;
  /** Receives the rewritten file content after an edit. */
  onChange: (next: string) => void;
  /** Render controls disabled (no edits). */
  readOnly?: boolean;
}

/** Deepest nesting the form renders before deferring to advanced mode. */
const MAX_DEPTH = 4;

/** A DOM-id-safe, path-unique id so each control's label resolves uniquely. */
function fieldId(path: string[]): string {
  return `foam-${path.join('-').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** Resolve the field definition for a leaf at `path`, or null for a plain text field. */
function lookupFieldDef(def: FoamFileDef | undefined, path: string[]): FoamFieldDef | null {
  if (!def || path.length === 0) return null;

  // A boundaryField patch's `type` uses the field's BC-type list.
  if (path.length === 3 && path[0] === 'boundaryField' && path[2] === 'type' && def.boundaryFieldTypes) {
    return {
      key: 'type',
      label: 'Boundary type',
      kind: 'enum',
      options: def.boundaryFieldTypes,
      help: 'Boundary condition applied to this patch.',
    };
  }

  if (path.length === 1) {
    return def.fields.find((field) => field.key === path[0]) ?? null;
  }

  // Inside a named sub-dictionary (RAS, SIMPLE, ddtSchemes, solvers/<field>, …):
  // match by the leaf's own key against that sub-dictionary's representative fields.
  const sub = def.subDicts?.find((entry) => entry.key === path[0]);
  if (sub) {
    const leafKey = path[path.length - 1];
    return sub.fields.find((field) => field.key === leafKey) ?? null;
  }
  return null;
}

/** Whether a top-level dict should expand into a form section (vs. defer to advanced). */
function isStructuredSection(def: FoamFileDef | undefined, key: string): boolean {
  if (key === 'boundaryField') return true;
  if (!def) return true; // No catalog match: best-effort, expand everything.
  return !!def.subDicts?.some((entry) => entry.key === key);
}

export function CaseFileForm({ value, onChange, readOnly = false }: CaseFileFormProps) {
  const doc = useMemo<FoamDocument>(() => parseFoamModel(value), [value]);
  const def = useMemo(() => matchFoamFileDef(value), [value]);

  const object = getFoamValue(doc, ['FoamFile', 'object']);
  const className = getFoamValue(doc, ['FoamFile', 'class']);

  const commit = (path: string[], nextValue: string) => {
    if (readOnly) return;
    const next = setFoamValue(value, path, nextValue);
    if (next !== null && next !== value) onChange(next);
  };

  // Top-level nodes excluding the FoamFile header (shown as read-only meta).
  const topNodes = doc.children.filter((node) => node.key !== 'FoamFile');
  const hasAnything = topNodes.length > 0;

  return (
    <div className="flex h-full flex-col overflow-y-auto overflow-x-hidden overscroll-contain">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4 sm:p-6">
        <header className="flex flex-col gap-1 border-b border-border pb-4">
          <div className="flex items-center gap-2">
            <FileText className="size-4 text-primary" strokeWidth={1.75} aria-hidden="true" />
            <h3 className="text-base font-semibold text-text">{def?.title ?? object ?? 'File'}</h3>
            {className && (
              <span className="rounded-sm bg-bg px-1.5 py-0.5 font-mono text-xs text-text-secondary">
                {className}
              </span>
            )}
          </div>
          {def?.description ? (
            <p className="text-sm text-text-secondary">{def.description}</p>
          ) : (
            <p className="text-sm text-text-secondary">
              Pick values from the lists below. Switch to Advanced to edit the raw file.
            </p>
          )}
        </header>

        {!hasAnything ? (
          <p className="rounded-md border border-dashed border-border-strong px-4 py-8 text-center text-sm text-text-secondary">
            No structured fields were found in this file. Use Advanced mode to edit it directly.
          </p>
        ) : (
          <NodeFields
            nodes={topNodes}
            basePath={[]}
            depth={0}
            def={def}
            readOnly={readOnly}
            onCommit={commit}
          />
        )}
      </div>
    </div>
  );
}

/** Render a list of nodes (leaves as fields, dicts as sections). */
function NodeFields({
  nodes,
  basePath,
  depth,
  def,
  readOnly,
  onCommit,
}: {
  nodes: FoamNode[];
  basePath: string[];
  depth: number;
  def: FoamFileDef | undefined;
  readOnly: boolean;
  onCommit: (path: string[], value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {nodes.map((node) => {
        const path = [...basePath, node.key];
        if (node.type === 'leaf') {
          return (
            <FieldRow
              key={node.key}
              id={fieldId(path)}
              fieldKey={node.key}
              value={node.value}
              fieldDef={lookupFieldDef(def, path)}
              readOnly={readOnly}
              onCommit={(next) => onCommit(path, next)}
            />
          );
        }

        // A sub-dictionary. At the top level, only expand known/structured ones.
        const expand = depth > 0 || isStructuredSection(def, node.key);
        if (!expand) {
          return <DeferredSection key={node.key} label={node.key} />;
        }
        if (depth >= MAX_DEPTH) {
          return <DeferredSection key={node.key} label={path.join(' / ')} />;
        }
        const subDef = def?.subDicts?.find((entry) => entry.key === node.key);
        return (
          <Section key={node.key} title={subDef?.label ?? node.key} help={subDef?.help}>
            <NodeFields
              nodes={node.children}
              basePath={path}
              depth={depth + 1}
              def={def}
              readOnly={readOnly}
              onCommit={onCommit}
            />
          </Section>
        );
      })}
    </div>
  );
}

/** A titled group for a sub-dictionary. */
function Section({
  title,
  help,
  children,
}: {
  title: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-surface">
      <div className="border-b border-border px-3 py-2">
        <p className="font-mono text-sm font-medium text-text">{title}</p>
        {help && <p className="mt-0.5 text-xs text-text-secondary">{help}</p>}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** A complex/unknown block the form does not edit (e.g. functions). */
function DeferredSection({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border px-3 py-2.5">
      <span className="min-w-0 truncate font-mono text-sm text-text-secondary">{label}</span>
      <span className="shrink-0 text-xs text-text-secondary">Edit in Advanced mode</span>
    </div>
  );
}

/** One labelled control: a <select> for enums/flags, a text input otherwise. */
function FieldRow({
  id,
  fieldKey,
  value,
  fieldDef,
  readOnly,
  onCommit,
}: {
  id: string;
  fieldKey: string;
  value: string;
  fieldDef: FoamFieldDef | null;
  readOnly: boolean;
  onCommit: (value: string) => void;
}) {
  const label = fieldDef?.label ?? fieldKey;
  const isEnum = (fieldDef?.kind === 'enum' || fieldDef?.kind === 'bool') && !!fieldDef.options;

  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:items-start sm:gap-3">
      <div className="flex flex-col pt-1.5">
        <label htmlFor={id} className="text-sm font-medium text-text">
          {label}
        </label>
        <span className="font-mono text-xs text-text-secondary" translate="no">
          {fieldKey}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {isEnum ? (
          <EnumControl
            id={id}
            value={value}
            options={fieldDef.options as string[]}
            disabled={readOnly}
            onChange={onCommit}
          />
        ) : (
          <TextControl
            id={id}
            value={value}
            placeholder={fieldDef?.example}
            disabled={readOnly}
            onCommit={onCommit}
          />
        )}
        {fieldDef?.help && <p className="text-xs text-text-secondary">{fieldDef.help}</p>}
      </div>
    </div>
  );
}

/** A styled native <select>; the current value is always selectable. */
function EnumControl({
  id,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  options: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  // Keep the current value selectable even if it isn't a catalog option.
  const withCurrent = value && !options.includes(value) ? [value, ...options] : options;

  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'h-9 w-full appearance-none rounded-md border border-border bg-surface pl-3 pr-9 text-sm text-text',
          'transition-colors duration-fast ease-out hover:border-border-strong',
          'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        {withCurrent.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
        strokeWidth={1.75}
        aria-hidden="true"
      />
    </div>
  );
}

/**
 * A text input that commits on blur / Enter (not per keystroke), so editing a
 * scientific value like `1e-06` never round-trips through the parser mid-typing.
 * `key` reseeds it whenever the external value changes.
 */
function TextControl({
  id,
  value,
  placeholder,
  disabled,
  onCommit,
}: {
  id: string;
  value: string;
  placeholder?: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  return (
    <input
      id={id}
      key={value}
      type="text"
      defaultValue={value}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      autoComplete="off"
      translate="no"
      onBlur={(event) => {
        const next = event.target.value.trim();
        if (next !== value) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      className={cn(
        'h-9 w-full rounded-md border border-border bg-surface px-3 font-mono text-sm text-text',
        'transition-colors duration-fast ease-out hover:border-border-strong',
        'placeholder:text-text-secondary/60',
        'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed disabled:opacity-60',
      )}
    />
  );
}
