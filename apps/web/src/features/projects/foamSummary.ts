/**
 * foamSummary.ts - a tolerant parser for OpenFOAM dictionary files, used to
 * render a read-only synthesis of the settings a user has entered.
 *
 * It is intentionally forgiving: it strips the banner and comments, treats
 * `{ }` as structural (sub-dictionaries) and `;` as the end of an entry, and
 * keeps the rest of an entry's tokens as its value (so `uniform (0 0 0)` stays
 * intact). The `FoamFile` header is lifted into metadata (class / object) rather
 * than shown as an entry. Anything it cannot make sense of is skipped rather
 * than throwing — this is a glanceable summary, not a validator.
 */

/** A single parsed entry: a leaf (key + value) or a sub-dictionary (children). */
export interface FoamEntry {
  key: string;
  /** Present for a leaf entry (`key value;`). */
  value?: string;
  /** Present for a sub-dictionary (`key { … }`). */
  children?: FoamEntry[];
}

/** The parsed synthesis of a dictionary file. */
export interface FoamSummary {
  /** The FoamFile `class`, if declared (e.g. `dictionary`, `volVectorField`). */
  className?: string;
  /** The FoamFile `object`, if declared (e.g. `controlDict`). */
  object?: string;
  /** Top-level entries (excluding the FoamFile header). */
  entries: FoamEntry[];
}

/** Strip block + line comments, then split into tokens around `{ } ;`. */
function tokenize(content: string): string[] {
  const noComments = content
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments (incl. the banner)
    .replace(/\/\/[^\n]*/g, ' '); // line comments
  return noComments
    .replace(/([{};])/g, ' $1 ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Parse a run of entries starting at `start`, stopping at `}` or end. */
function parseEntries(tokens: string[], start: number): { entries: FoamEntry[]; next: number } {
  const entries: FoamEntry[] = [];
  let keyParts: string[] = [];
  let i = start;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token === '}') {
      i += 1;
      break;
    }

    if (token === '{') {
      const key = keyParts.join(' ');
      const { entries: children, next } = parseEntries(tokens, i + 1);
      if (key) entries.push({ key, children });
      keyParts = [];
      i = next;
      continue;
    }

    if (token === ';') {
      if (keyParts.length > 0) {
        const [key, ...rest] = keyParts;
        entries.push({ key, value: rest.length > 0 ? rest.join(' ') : undefined });
      }
      keyParts = [];
      i += 1;
      continue;
    }

    keyParts.push(token);
    i += 1;
  }

  return { entries, next: i };
}

/** Find a direct child entry's value by key. */
function childValue(entries: FoamEntry[], key: string): string | undefined {
  return entries.find((entry) => entry.key === key && entry.value !== undefined)?.value;
}

/** Parse an OpenFOAM dictionary into a glanceable summary. */
export function parseFoam(content: string): FoamSummary {
  const tokens = tokenize(content);
  const { entries } = parseEntries(tokens, 0);

  const foamFile = entries.find((entry) => entry.key === 'FoamFile' && entry.children);
  const rest = entries.filter((entry) => entry.key !== 'FoamFile');

  return {
    className: foamFile?.children ? childValue(foamFile.children, 'class') : undefined,
    object: foamFile?.children ? childValue(foamFile.children, 'object') : undefined,
    entries: rest,
  };
}

/** Count entries recursively (leaves and sub-dictionaries). */
export function countFoamEntries(entries: FoamEntry[]): number {
  return entries.reduce(
    (total, entry) => total + 1 + (entry.children ? countFoamEntries(entry.children) : 0),
    0,
  );
}
