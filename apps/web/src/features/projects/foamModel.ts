/**
 * foamModel.ts - a position-aware parser for OpenFOAM dictionary files.
 *
 * Unlike foamSummary.ts (which throws away source positions to produce a
 * glanceable tree), this parser keeps the character span of every entry's value
 * and every sub-dictionary body. That lets "easy mode" edit a single field by
 * *splicing* the new value into the original text — preserving the banner,
 * comments, macros (`#include`, `#codeStream`), formatting and anything it does
 * not understand. It never re-serializes the whole file.
 *
 * It is deliberately tolerant: it skips block/line comments, double-quoted
 * strings and `#{ … #}` verbatim blocks, then treats `{ } ;` as structure (the
 * same shape foamSummary assumes, which already drives the Summary tab). Files
 * it cannot make sense of simply yield fewer addressable fields; the raw editor
 * (advanced mode) always remains available as the source of truth.
 */

/** A leaf entry `key value;` with the spans needed to rewrite its value. */
export interface FoamLeaf {
  type: 'leaf';
  key: string;
  /** Trimmed value text (empty string for a bare `key;`). */
  value: string;
  /** Whether the entry carried a value at all (`key value;` vs `key;`). */
  hasValue: boolean;
  /** Offset of the value's first char; equals `valueEnd` when there is none. */
  valueStart: number;
  /** Offset of the terminating `;`. */
  valueEnd: number;
}

/** A sub-dictionary `key { … }` with its body span (for nested addressing). */
export interface FoamDict {
  type: 'dict';
  key: string;
  /** Offset just after the opening `{`. */
  bodyStart: number;
  /** Offset of the closing `}`. */
  bodyEnd: number;
  children: FoamNode[];
}

export type FoamNode = FoamLeaf | FoamDict;

/** The parsed file: its top-level nodes (FoamFile header included). */
export interface FoamDocument {
  children: FoamNode[];
}

interface Token {
  text: string;
  start: number;
  end: number;
  kind: 'word' | '{' | '}' | ';';
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * Scan into tokens, recording offsets into the ORIGINAL text. Comments, strings
 * and `#{ … #}` blocks are consumed so their contents never affect structure;
 * strings/verbatim blocks survive as opaque word tokens (they may be a value).
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const c = text[i];

    if (isSpace(c)) {
      i += 1;
      continue;
    }
    // Block comment.
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // Line comment.
    if (c === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    // Structural punctuation.
    if (c === '{' || c === '}' || c === ';') {
      tokens.push({ text: c, start: i, end: i + 1, kind: c });
      i += 1;
      continue;
    }
    // Double-quoted string — one opaque word token.
    if (c === '"') {
      const start = i;
      i += 1;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      i += 1; // closing quote
      tokens.push({ text: text.slice(start, i), start, end: i, kind: 'word' });
      continue;
    }
    // `#{ … #}` verbatim code block — one opaque word token.
    if (c === '#' && text[i + 1] === '{') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '#' && text[i + 1] === '}')) i += 1;
      i += 2;
      tokens.push({ text: text.slice(start, i), start, end: i, kind: 'word' });
      continue;
    }
    // A word: run until whitespace, structure, or the start of a comment/string.
    const start = i;
    while (i < n) {
      const d = text[i];
      if (isSpace(d) || d === '{' || d === '}' || d === ';') break;
      if (d === '/' && (text[i + 1] === '*' || text[i + 1] === '/')) break;
      if (d === '"') break;
      if (d === '#' && text[i + 1] === '{') break;
      i += 1;
    }
    tokens.push({ text: text.slice(start, i), start, end: i, kind: 'word' });
  }

  return tokens;
}

/** Parse a run of entries from `start`, stopping after a `}` or at the end. */
function parseEntries(
  text: string,
  tokens: Token[],
  start: number,
): { nodes: FoamNode[]; next: number } {
  const nodes: FoamNode[] = [];
  let keyTokens: Token[] = [];
  let i = start;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token.kind === '}') {
      i += 1;
      break;
    }

    if (token.kind === '{') {
      const key = keyTokens.map((t) => t.text).join(' ');
      const { nodes: children, next } = parseEntries(text, tokens, i + 1);
      // bodyEnd is the closing `}` token, which sits at `next - 1`.
      const closing = tokens[next - 1];
      const bodyEnd = closing && closing.kind === '}' ? closing.start : token.end;
      if (key) {
        nodes.push({ type: 'dict', key, bodyStart: token.end, bodyEnd, children });
      }
      keyTokens = [];
      i = next;
      continue;
    }

    if (token.kind === ';') {
      if (keyTokens.length > 0) {
        const [keyTok, ...valueToks] = keyTokens;
        const hasValue = valueToks.length > 0;
        const valueStart = hasValue ? valueToks[0].start : token.start;
        const valueEnd = token.start;
        nodes.push({
          type: 'leaf',
          key: keyTok.text,
          value: hasValue ? text.slice(valueStart, valueEnd).trim() : '',
          hasValue,
          valueStart,
          valueEnd,
        });
      }
      keyTokens = [];
      i += 1;
      continue;
    }

    keyTokens.push(token);
    i += 1;
  }

  return { nodes, next: i };
}

/** Parse an OpenFOAM dictionary, keeping source positions for in-place edits. */
export function parseFoamModel(text: string): FoamDocument {
  const tokens = tokenize(text);
  const { nodes } = parseEntries(text, tokens, 0);
  return { children: nodes };
}

/** Find a node by its path of keys (e.g. ['boundaryField', 'inlet', 'type']). */
export function findNode(doc: FoamDocument, path: string[]): FoamNode | null {
  let nodes: FoamNode[] = doc.children;
  let found: FoamNode | null = null;

  for (const key of path) {
    found = nodes.find((node) => node.key === key) ?? null;
    if (!found) return null;
    nodes = found.type === 'dict' ? found.children : [];
  }
  return found;
}

/** Read a leaf value by path, or null if it is absent / not a leaf. */
export function getFoamValue(doc: FoamDocument, path: string[]): string | null {
  const node = findNode(doc, path);
  return node && node.type === 'leaf' ? node.value : null;
}

/** Direct children of the node at `path` (or the root when `path` is empty). */
export function childrenAt(doc: FoamDocument, path: string[]): FoamNode[] {
  if (path.length === 0) return doc.children;
  const node = findNode(doc, path);
  return node && node.type === 'dict' ? node.children : [];
}

/**
 * Return new text with the leaf at `path` set to `value`, splicing only that
 * value span so everything else is byte-for-byte preserved. Returns null when
 * the path is absent or not a leaf (the caller should fall back / no-op).
 */
export function setFoamValue(text: string, path: string[], value: string): string | null {
  const doc = parseFoamModel(text);
  const node = findNode(doc, path);
  if (!node || node.type !== 'leaf') return null;

  if (node.hasValue) {
    return text.slice(0, node.valueStart) + value + text.slice(node.valueEnd);
  }
  // Bare `key;` — insert ` value` before the terminating `;`.
  return `${text.slice(0, node.valueStart)} ${value}${text.slice(node.valueStart)}`;
}

/**
 * Insert a new `key value;` entry at the end of the dictionary body at
 * `parentPath` (root when empty). Indentation follows the parent's depth.
 * Returns null when the parent is missing or is not a dictionary.
 */
export function insertFoamField(
  text: string,
  parentPath: string[],
  key: string,
  value: string,
): string | null {
  const doc = parseFoamModel(text);

  if (parentPath.length === 0) {
    // Append at end of file on its own line.
    const trimmedEnd = text.replace(/\s*$/, '');
    return `${trimmedEnd}\n${key} ${value};\n`;
  }

  const parent = findNode(doc, parentPath);
  if (!parent || parent.type !== 'dict') return null;

  const indent = '    '.repeat(parentPath.length);
  const insertion = `\n${indent}${key} ${value};`;
  return text.slice(0, parent.bodyEnd).replace(/\s*$/, '') + insertion + '\n' + text.slice(parent.bodyEnd);
}
