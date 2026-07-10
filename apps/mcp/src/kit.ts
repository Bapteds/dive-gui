// Shared building blocks for registering MCP tools: result wrappers (with
// structured output), the error formatter, the `tool()` registrar factory, and
// small helpers reused across the tool modules.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { ApiError } from './client.js';

/** An MCP tool result: a text block plus optional machine-readable structured output. */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Coerce any handler return value into a JSON object suitable for MCP's
 * `structuredContent` (which must be an object, per the schema). Objects pass
 * through; arrays and scalars are wrapped as `{ result: … }`; null/undefined
 * yield nothing (a bare acknowledgement stays text-only).
 */
function toStructured(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { result: value };
}

/** Wrap a value as an MCP result: pretty-printed text + structured content. */
export function ok(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const result: ToolResult = {
    content: [{ type: 'text', text: text || '(empty response)' }],
  };
  const structured = toStructured(value);
  if (structured) result.structuredContent = structured;
  return result;
}

/** Wrap an error as an MCP error result with a readable, context-carrying message. */
export function fail(err: unknown): ToolResult {
  let message: string;
  if (err instanceof ApiError) {
    const where = err.endpoint ? ` (${err.endpoint})` : '';
    message = `API error ${err.status} [${err.code}]${where}: ${err.message}`;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Metadata accepted by the `tool()` registrar. */
export interface ToolMeta<S extends z.ZodRawShape> {
  title: string;
  description: string;
  inputSchema?: S;
  /** Flags a mutating/irreversible tool (surfaced to the host as `destructiveHint`). */
  destructive?: boolean;
  /**
   * Override the read-only hint. By default a tool is read-only iff its name
   * starts with list_/get_/read_/verify_/preview_; set this when the heuristic is
   * wrong (e.g. a `download_*` tool that writes to the local disk).
   */
  readOnly?: boolean;
}

/** A registrar bound to one server: `const tool = makeTool(server)`. */
export type Registrar = <S extends z.ZodRawShape>(
  name: string,
  meta: ToolMeta<S>,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
) => void;

const READ_ONLY_NAME = /^(list|get|read|verify|preview)_/;

/**
 * Build a `tool()` registrar for a server. Handlers return any JSON-serialisable
 * value (or a string); the wrapper serialises it, attaches structured content,
 * and converts thrown errors into MCP error results.
 */
export function makeTool(server: McpServer): Registrar {
  // registerTool's generics don't compose cleanly through this thin wrapper
  // (the callback return-type overload resolves poorly against a generic shape);
  // args stay typed via `handler`, so cast only the registration call itself.
  const register = server.registerTool.bind(server) as (
    n: string,
    m: unknown,
    cb: (args: unknown) => Promise<ToolResult>,
  ) => void;

  return (name, meta, handler) => {
    register(
      name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: meta.inputSchema ?? {},
        annotations: {
          readOnlyHint: meta.readOnly ?? READ_ONLY_NAME.test(name),
          destructiveHint: meta.destructive ?? false,
        },
      },
      async (args) => {
        try {
          return ok(await handler(args as z.infer<z.ZodObject<typeof meta.inputSchema & object>>));
        } catch (err) {
          return fail(err);
        }
      },
    );
  };
}

/**
 * Write downloaded bytes to a local path and return a compact descriptor. The
 * path is resolved to an absolute one so the report is unambiguous about where
 * the file landed on the machine running this server.
 */
export async function saveDownload(
  savePath: string,
  payload: { bytes: Buffer; contentType: string | null },
): Promise<{ saved: string; bytes: number; contentType: string | null }> {
  const absolute = resolve(savePath);
  await writeFile(absolute, payload.bytes);
  return { saved: absolute, bytes: payload.bytes.length, contentType: payload.contentType };
}

/**
 * Pick the multipart field for a mesh-library import from the file extension:
 * a `.zip` is a zipped polyMesh folder (`archive`); anything else (`.cgns`,
 * `.msh`) is a single mesh file (`meshFile`). Mirrors importMeshController.
 */
export function meshUploadField(filePath: string): 'archive' | 'meshFile' {
  return /\.zip$/i.test(filePath) ? 'archive' : 'meshFile';
}
