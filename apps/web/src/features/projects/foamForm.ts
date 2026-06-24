/**
 * foamForm - helpers tying the parsed FOAM model to the easy-mode field catalog.
 *
 * Kept out of CaseFileForm.tsx so that component file only exports components
 * (Fast Refresh friendliness), and so the editor panel can ask "is easy mode
 * worth offering / is this a recognised file?" without importing the form.
 */
import { getFoamValue, parseFoamModel } from './foamModel';
import { FOAM_FIELD_CATALOG, type FoamFileDef } from './foamFieldCatalog';

/** Find the catalog entry for a file by its FoamFile `object` (narrowed by class). */
export function matchFoamFileDef(content: string): FoamFileDef | undefined {
  const doc = parseFoamModel(content);
  const object = getFoamValue(doc, ['FoamFile', 'object']);
  if (!object) return undefined;
  const className = getFoamValue(doc, ['FoamFile', 'class']);
  return (
    FOAM_FIELD_CATALOG.find(
      (def) => def.object === object && (!def.className || def.className === className),
    ) ?? FOAM_FIELD_CATALOG.find((def) => def.object === object)
  );
}

/**
 * Whether easy mode is worth offering for this content: either the file is a
 * recognised catalog entry, or it at least parses to some top-level key/value
 * entries (so the form has something to show). List-format files (e.g.
 * polyMesh/boundary) yield nothing and stay on advanced mode.
 */
export function foamEasyModeAvailable(content: string): boolean {
  if (matchFoamFileDef(content)) return true;
  const doc = parseFoamModel(content);
  return doc.children.some((node) => node.key !== 'FoamFile' && node.type === 'leaf');
}
