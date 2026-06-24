import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AlertTriangle, Grid3x3, Loader2, Maximize, MonitorX, Scissors } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Diamond } from '@/components/brand/Diamond';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import type { MeshPatch, MeshPatchType } from '@/lib/api/types';
import { PatchTable } from './PatchTable';
import { RenamePatchDialog } from './RenamePatchDialog';
import { AutoPatchDialog } from './AutoPatchDialog';
import {
  useMeshEdgesQuery,
  useMeshGeometryQuery,
  useMeshManifestQuery,
  useRebuildMesh,
  useSetPatchType,
} from './useMesh';

/**
 * MeshViewer - the "Visualize" tab body: a patch table (left) and an interactive
 * three.js render of the OpenFOAM boundary patches (right). Lazy-loaded so the
 * three.js bundle never weighs on the initial app load.
 *
 * It owns the shared `selected` patch state that links the table and the canvas:
 * selecting a patch in either place highlights it orange and dims the rest. It
 * also resolves every state the original inspector never had to: building the
 * preview, an empty mesh, a build/parse failure (with retry), and a browser
 * without WebGL.
 *
 * The whole thing is one bordered panel split by a hairline (no nested cards),
 * and the canvas sits on a light "studio" stage so it reads as a CFD viewer
 * while staying on the brand's light palette.
 */

/** Read a brand token (a hex color) off the document root so materials stay token-driven. */
function readToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Detect WebGL support once (jsdom and locked-down browsers have none). */
function detectWebgl(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
    );
  } catch {
    return false;
  }
}

export function MeshViewer({ projectId }: { projectId: string }) {
  const webglAvailable = useMemo(detectWebgl, []);
  const [selected, setSelected] = useState<string | null>(null);
  // The patch being renamed, or null when the rename dialog is closed.
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  // Whether the auto-patch dialog is open.
  const [autoPatchOpen, setAutoPatchOpen] = useState(false);

  const manifest = useMeshManifestQuery(projectId);
  const patches = manifest.data?.patches ?? [];
  const hasPatches = patches.length > 0;

  // Geometry + edges are fetched only once the build succeeded, there are patches
  // to show, and the browser can actually render them.
  const viewerEnabled = manifest.isSuccess && hasPatches && webglAvailable;
  const geometry = useMeshGeometryQuery(projectId, viewerEnabled);
  const edges = useMeshEdgesQuery(projectId, viewerEnabled);
  const rebuild = useRebuildMesh(projectId);
  const setPatchType = useSetPatchType(projectId);

  const handleRebuild = () => {
    setSelected(null);
    rebuild.mutate();
  };

  const handleSetType = (name: string, type: string) => {
    setPatchType.mutate(
      { patch: name, type: type as MeshPatchType },
      {
        onError: (error) =>
          toast.error(
            error instanceof ApiError ? error.message : 'Could not change the patch type.',
          ),
      },
    );
  };

  return (
    <>
      <section
        aria-label="3D mesh preview"
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface shadow-sm lg:grid lg:grid-cols-[minmax(220px,18rem)_1fr]"
      >
        {/* Left: patch table (or its loading / empty stand-ins). */}
        <div className="flex min-h-0 flex-col border-b border-border p-4 sm:p-5 lg:border-b-0 lg:border-r">
          <div className="flex shrink-0 items-center justify-between gap-2 pb-3">
            <h2 className="min-w-0 text-sm font-semibold text-text">
              Boundary patches
              {hasPatches && (
                <span className="ml-1.5 font-normal tabular-nums text-text-secondary">
                  ({patches.length})
                </span>
              )}
            </h2>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="shrink-0"
              onClick={() => setAutoPatchOpen(true)}
            >
              <Scissors strokeWidth={1.75} aria-hidden="true" />
              Auto-patch
            </Button>
          </div>
          {manifest.isPending ? (
            <PatchTableSkeleton />
          ) : manifest.isError ? (
            <p className="text-sm text-text-secondary">{manifestErrorMessage(manifest.error)}</p>
          ) : !hasPatches ? (
            <p className="text-sm text-text-secondary">No boundary patches in this mesh.</p>
          ) : (
            <PatchTable
              patches={patches}
              selected={selected}
              onSelect={setSelected}
              onRename={setRenameTarget}
              onSetType={handleSetType}
            />
          )}
        </div>

        {/* Right: the 3D stage (or the matching state for this moment). */}
        <div className="relative min-h-[55vh] lg:min-h-0">
          <CanvasArea
            webglAvailable={webglAvailable}
            manifest={manifest}
            geometry={geometry}
            edges={edges}
            hasPatches={hasPatches}
            patches={patches}
            selected={selected}
            onSelect={setSelected}
            onRebuild={handleRebuild}
            rebuilding={rebuild.isPending}
          />
        </div>
      </section>

      <RenamePatchDialog
        projectId={projectId}
        from={renameTarget}
        existingNames={patches.map((patch) => patch.name)}
        onClose={() => setRenameTarget(null)}
        onRenamed={(oldName, newName) => {
          // Keep the selection (and its 3D highlight) on the patch after rename.
          setSelected((current) => (current === oldName ? newName : current));
        }}
      />

      <AutoPatchDialog
        projectId={projectId}
        open={autoPatchOpen}
        onClose={() => setAutoPatchOpen(false)}
        // autoPatch replaced the patches with auto-generated ones, so the old
        // selection no longer applies once the viewer rebuilds.
        onPatched={() => setSelected(null)}
      />
    </>
  );
}

/** Map a manifest fetch error to a short, human message (NO_MESH should not occur here). */
function manifestErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'NO_MESH') {
    return 'This project has no mesh to visualize.';
  }
  return 'Could not load the patch list.';
}

/**
 * The right-hand stage. Decides, in order: WebGL missing -> manifest building ->
 * manifest failed -> mesh empty -> geometry loading -> geometry failed -> render.
 */
function CanvasArea({
  webglAvailable,
  manifest,
  geometry,
  edges,
  hasPatches,
  patches,
  selected,
  onSelect,
  onRebuild,
  rebuilding,
}: {
  webglAvailable: boolean;
  manifest: ReturnType<typeof useMeshManifestQuery>;
  geometry: ReturnType<typeof useMeshGeometryQuery>;
  edges: ReturnType<typeof useMeshEdgesQuery>;
  hasPatches: boolean;
  patches: MeshPatch[];
  selected: string | null;
  onSelect: (name: string | null) => void;
  onRebuild: () => void;
  rebuilding: boolean;
}) {
  if (!webglAvailable) {
    return (
      <StageMessage
        icon={<MonitorX className="size-6 text-text-secondary" strokeWidth={1.5} aria-hidden="true" />}
        title="3D rendering isn't available"
        body="Your browser doesn't support WebGL, so the mesh can't be shown here."
      />
    );
  }

  if (manifest.isPending) {
    return (
      <StageMessage
        icon={<Loader2 className="size-6 animate-spin text-primary" strokeWidth={1.75} aria-hidden="true" />}
        title="Building 3D preview"
        body="Extracting the boundary patches. This runs once and is cached afterwards."
      />
    );
  }

  if (manifest.isError) {
    return (
      <StageError
        message={buildErrorMessage(manifest.error)}
        detail={errorDetail(manifest.error)}
        onRetry={onRebuild}
        retrying={rebuilding}
      />
    );
  }

  if (!hasPatches) {
    return (
      <StageMessage
        icon={<Diamond size={22} className="text-primary" />}
        title="Nothing to display"
        body="No boundary patches were found in this mesh."
      />
    );
  }

  // Wait for both the geometry and the edge buffer so the scene builds once with
  // its final edges (the edges query resolves to data, or to null on a 404).
  if (geometry.isPending || edges.isPending) {
    return (
      <StageMessage
        icon={<Loader2 className="size-6 animate-spin text-primary" strokeWidth={1.75} aria-hidden="true" />}
        title="Loading geometry"
        body="Preparing the 3D surfaces."
      />
    );
  }

  if (geometry.isError || !geometry.data) {
    return (
      <StageError
        message="Could not load the 3D geometry."
        detail={errorDetail(geometry.error)}
        onRetry={onRebuild}
        retrying={rebuilding}
      />
    );
  }

  return (
    <MeshScene
      geometry={geometry.data}
      edges={edges.data ?? null}
      patches={patches}
      selected={selected}
      onSelect={onSelect}
      onRebuild={onRebuild}
      rebuilding={rebuilding}
    />
  );
}

/** Friendly headline for a build failure (502) vs a generic error. */
function buildErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'MESH_BUILD_FAILED') {
    return 'Could not build the 3D preview.';
  }
  return 'Could not load the 3D preview.';
}

/** The server's error message, surfaced as a collapsible technical detail. */
function errorDetail(error: unknown): string | null {
  return error instanceof ApiError ? error.message : null;
}

// ---------------------------------------------------------------------------
// three.js scene
// ---------------------------------------------------------------------------

/** Per-patch render handles kept across renders for cheap highlight updates. */
interface PatchObject {
  name: string;
  material: THREE.MeshLambertMaterial;
  /** Edge overlay, or null when the mesh is too dense to build edges for. */
  edges: THREE.LineSegments | null;
  edgeMaterial: THREE.LineBasicMaterial | null;
}

/** Squared pointer-move threshold (px^2) below which a drag still counts as a click. */
const CLICK_DRAG_THRESHOLD_SQ = 36;

/**
 * Triangle-count caps that keep the viewer fluid on heavy meshes:
 *  - above BUILD: skip the (costly) edge overlay entirely;
 *  - above SHOW: build edges but start hidden (orbit stays smooth; toggle to show).
 * Below SHOW, edges are on by default to match the original inspector's look.
 */
const EDGE_BUILD_CAP = 2_000_000;
const EDGE_SHOW_CAP = 400_000;

/** Count triangles in a buffer geometry (indexed or not). */
function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  return Math.floor((index ? index.count : position ? position.count : 0) / 3);
}

/**
 * Build the edge line geometry for a patch: the true cell edges from edges.bin
 * when available (the real mesh grid, no triangulation diagonals), else a capped
 * client-side feature-edge overlay, else null (mesh too heavy / no data).
 */
function buildEdgeGeometry(
  edges: ArrayBuffer | null,
  meta: MeshPatch | undefined,
  fallbackGeometry: THREE.BufferGeometry,
  canFallback: boolean,
): THREE.BufferGeometry | null {
  if (edges && meta && typeof meta.edgeOffset === 'number' && meta.edgeCount && meta.edgeCount > 0) {
    const byteOffset = meta.edgeOffset * 3 * Float32Array.BYTES_PER_ELEMENT;
    const floatLength = meta.edgeCount * 3;
    if (byteOffset + floatLength * Float32Array.BYTES_PER_ELEMENT <= edges.byteLength) {
      const positions = new Float32Array(edges, byteOffset, floatLength);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      return geometry;
    }
  }
  // A 1 deg threshold drops coplanar triangulation diagonals; still imperfect on
  // curved surfaces, which is exactly why the precise edges.bin path is preferred.
  if (canFallback) {
    return new THREE.EdgesGeometry(fallbackGeometry, 1);
  }
  return null;
}

function MeshScene({
  geometry,
  edges,
  patches,
  selected,
  onSelect,
  onRebuild,
  rebuilding,
}: {
  geometry: ArrayBuffer;
  /** Raw cell-edge buffer (true mesh grid), or null to fall back to feature edges. */
  edges: ArrayBuffer | null;
  patches: MeshPatch[];
  selected: string | null;
  onSelect: (name: string | null) => void;
  onRebuild: () => void;
  rebuilding: boolean;
}) {
  // Set when the GLB cannot be parsed (or yields no meshes): show an error panel
  // instead of a silent blank canvas.
  const [failed, setFailed] = useState(false);
  // Whether an edge overlay exists for this mesh, and whether it is shown.
  const [edgesAvailable, setEdgesAvailable] = useState(false);
  const [edgesVisible, setEdgesVisible] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const patchObjectsRef = useRef<Map<string, PatchObject>>(new Map());
  const resetViewRef = useRef<() => void>(() => {});
  // Request a single on-demand frame (wired up inside the scene effect).
  const requestRenderRef = useRef<() => void>(() => {});
  // Latest onSelect, read inside the imperative pointer handler without re-binding.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  // Latest selection, read at build/click time so the scene effect does not need
  // `selected` as a dependency (which would rebuild the whole scene).
  const selectedAtBuildRef = useRef(selected);
  selectedAtBuildRef.current = selected;
  // Latest patches (for per-patch edge offsets), read at build time via the ref so
  // the effect depends only on the geometry/edges payloads.
  const patchesRef = useRef(patches);
  patchesRef.current = patches;

  // Build the scene once per geometry payload; tear everything down on cleanup.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const neutral = new THREE.Color(readToken('--color-neutral', '#bcbdbf'));
    const accent = new THREE.Color(readToken('--color-accent', '#ee7f00'));
    const edgeColor = new THREE.Color(readToken('--color-text-secondary', '#5b6676'));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    renderer.domElement.classList.add('block', 'size-full');
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.style.cursor = 'grab';

    scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd3da, 1.1));
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.6);
    keyLight.position.set(1, 1.4, 1.2);
    scene.add(keyLight);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !prefersReducedMotion;
    controls.dampingFactor = 0.12;

    const patchObjects = patchObjectsRef.current;
    patchObjects.clear();
    const root = new THREE.Group();
    scene.add(root);

    const loader = new GLTFLoader();
    let disposed = false;

    // --- on-demand rendering: draw only when something changes (idle is free) ---
    let renderRequested = false;
    const renderFrame = () => {
      renderRequested = false;
      controls.update(); // applies damping inertia; harmless when settled
      renderer.render(scene, camera);
    };
    const requestRender = () => {
      if (disposed || renderRequested) return;
      renderRequested = true;
      requestAnimationFrame(renderFrame);
    };
    requestRenderRef.current = requestRender;
    // OrbitControls fires 'change' on input and during damping inertia; each one
    // schedules exactly one frame, so motion stays smooth and idle costs nothing.
    controls.addEventListener('change', requestRender);

    /** Frame the whole mesh and aim the camera at its center. */
    const fitView = () => {
      const box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const radius = sphere.radius || 1;
      const distance = radius / Math.sin((camera.fov * Math.PI) / 180 / 2);
      const dir = new THREE.Vector3(0.8, 0.5, 1).normalize();
      camera.position.copy(sphere.center).addScaledVector(dir, distance * 1.25);
      camera.near = radius / 100;
      camera.far = radius * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(sphere.center);
      controls.update();
      requestRender();
    };
    resetViewRef.current = fitView;

    const onParsed = (gltf: { scene: THREE.Object3D }) => {
      if (disposed) return;
      const loaded = gltf.scene;
      // Collect the meshes first WITHOUT mutating the tree during traversal, then
      // add the loaded scene as a whole so every node transform is preserved.
      // (Reparenting individual meshes into a fresh group strips their ancestor
      // transforms and can push the geometry off-screen -> a blank canvas.)
      const meshes: THREE.Mesh[] = [];
      loaded.traverse((object) => {
        if (object instanceof THREE.Mesh) meshes.push(object);
      });
      if (meshes.length === 0) {
        setFailed(true);
        return;
      }

      // Scale the edge overlay to the mesh size so heavy meshes stay fluid.
      const totalTris = meshes.reduce((sum, mesh) => sum + triangleCount(mesh.geometry), 0);
      // Real cell edges (from edges.bin) are cheap to build; the client-side
      // feature-edge fallback (EdgesGeometry) is the expensive one to cap.
      const canFallback = totalTris <= EDGE_BUILD_CAP;
      const showEdges = totalTris <= EDGE_SHOW_CAP;
      const patchByName = new Map(patchesRef.current.map((patch) => [patch.name, patch]));
      let builtAnyEdges = false;

      meshes.forEach((mesh) => {
        const name = mesh.name || mesh.parent?.name || '';
        // trimesh exports surfaces without vertex normals; compute them so the
        // material is lit instead of rendering unlit/near-invisible.
        if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();

        // MeshLambertMaterial: single diffuse pass, far cheaper per pixel than the
        // PBR standard material. polygonOffset pushes the surface back a hair so
        // the edge lines sit cleanly on top (no z-fighting / broken lines).
        const material = new THREE.MeshLambertMaterial({
          color: neutral.clone(),
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        mesh.material = material;

        // Prefer the true cell edges (the real mesh grid, no triangulation
        // diagonals) shipped in edges.bin; fall back to a client-side
        // feature-edge overlay when this render has none.
        const meta = patchByName.get(name);
        const edgeGeometry = buildEdgeGeometry(edges, meta, mesh.geometry, canFallback);
        let edgeObject: THREE.LineSegments | null = null;
        let edgeMaterial: THREE.LineBasicMaterial | null = null;
        if (edgeGeometry) {
          edgeMaterial = new THREE.LineBasicMaterial({
            color: edgeColor.clone(),
            transparent: true,
            opacity: 0.32,
          });
          edgeObject = new THREE.LineSegments(edgeGeometry, edgeMaterial);
          edgeObject.visible = showEdges;
          // Add as a child so the edges inherit the mesh's GLB transform and stay
          // perfectly aligned with the surface.
          mesh.add(edgeObject);
          builtAnyEdges = true;
        }

        if (name) patchObjects.set(name, { name, material, edges: edgeObject, edgeMaterial });
      });

      root.add(loaded);
      setEdgesAvailable(builtAnyEdges);
      setEdgesVisible(showEdges);
      fitView();
      applyHighlight(patchObjects, selectedAtBuildRef.current, neutral, accent);
      requestRender();
    };

    try {
      // A parse failure (bad/corrupt GLB) surfaces an error panel instead of a
      // silent blank canvas.
      loader.parse(geometry, '', onParsed, () => setFailed(true));
    } catch {
      setFailed(true);
    }

    // --- interaction: orbit (controls) + pick (raycaster on click only) ---
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downX = 0;
    let downY = 0;

    const onPointerDown = (event: PointerEvent) => {
      downX = event.clientX;
      downY = event.clientY;
      renderer.domElement.style.cursor = 'grabbing';
    };
    const onPointerUp = (event: PointerEvent) => {
      renderer.domElement.style.cursor = 'grab';
      const dx = event.clientX - downX;
      const dy = event.clientY - downY;
      if (dx * dx + dy * dy > CLICK_DRAG_THRESHOLD_SQ) return; // it was an orbit drag
      // Raycast ONLY on a click, never on hover, so moving the mouse never pays
      // the full-mesh intersection cost (the main source of viewer lag).
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster
        .intersectObjects(root.children, true)
        .find((intersection) => intersection.object instanceof THREE.Mesh);
      const name = hit ? hit.object.name || hit.object.parent?.name || null : null;
      onSelectRef.current(name && name === selectedAtBuildRef.current ? null : name);
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    // --- sizing ---
    const resize = () => {
      const { clientWidth, clientHeight } = container;
      if (clientWidth === 0 || clientHeight === 0) return;
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(clientWidth, clientHeight, false);
      requestRender();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      controls.removeEventListener('change', requestRender);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      root.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
        if (object instanceof THREE.LineSegments) object.geometry.dispose();
      });
      patchObjects.forEach(({ material, edgeMaterial }) => {
        material.dispose();
        edgeMaterial?.dispose();
      });
      patchObjects.clear();
      requestRenderRef.current = () => {};
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // Rebuilt when the geometry or the edge buffer changes; selection and edge
    // visibility are applied by the effects below (selection read via the ref).
  }, [geometry, edges]);

  // Apply the highlight whenever the selection changes (cheap material swap).
  useEffect(() => {
    const neutral = new THREE.Color(readToken('--color-neutral', '#bcbdbf'));
    const accent = new THREE.Color(readToken('--color-accent', '#ee7f00'));
    applyHighlight(patchObjectsRef.current, selected, neutral, accent);
    requestRenderRef.current();
  }, [selected, patches]);

  // Toggle the edge overlay (cheap: a visibility flag + one frame, no rebuild).
  useEffect(() => {
    patchObjectsRef.current.forEach(({ edges }) => {
      if (edges) edges.visible = edgesVisible;
    });
    requestRenderRef.current();
  }, [edgesVisible]);

  if (failed) {
    return (
      <StageError
        message="Could not display the 3D geometry."
        detail="The rendered file could not be parsed. Rebuilding may fix it."
        onRetry={onRebuild}
        retrying={rebuilding}
      />
    );
  }

  return (
    <div className="absolute inset-0">
      {/* Light studio stage: a subtle token-driven radial so the mesh reads with
          depth without a dark canvas. The WebGL canvas is transparent over it. */}
      <div
        ref={containerRef}
        className="size-full"
        style={{
          background:
            'radial-gradient(120% 120% at 50% 35%, var(--color-surface) 0%, var(--color-bg) 78%)',
        }}
      />
      <div className="pointer-events-none absolute right-3 top-3 flex flex-col gap-2">
        {edgesAvailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                aria-pressed={edgesVisible}
                aria-label={edgesVisible ? 'Hide mesh edges' : 'Show mesh edges'}
                className={cn('pointer-events-auto shadow-sm', edgesVisible && 'border-primary text-primary')}
                onClick={() => setEdgesVisible((value) => !value)}
              >
                <Grid3x3 strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{edgesVisible ? 'Hide mesh edges' : 'Show mesh edges'}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              className="pointer-events-auto shadow-sm"
              aria-label="Reset view"
              onClick={() => resetViewRef.current()}
            >
              <Maximize strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset view</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * Recolor every patch for the current selection: nothing selected -> all neutral
 * and opaque; a selection -> that patch accent-orange and opaque, the rest dimmed
 * (opacity 0.12), matching the original inspector's highlight.
 */
function applyHighlight(
  patchObjects: Map<string, PatchObject>,
  selected: string | null,
  neutral: THREE.Color,
  accent: THREE.Color,
) {
  patchObjects.forEach(({ name, material, edgeMaterial }) => {
    if (selected === null) {
      material.color.copy(neutral);
      material.opacity = 1;
      material.transparent = false;
      if (edgeMaterial) edgeMaterial.opacity = 0.28;
    } else if (name === selected) {
      material.color.copy(accent);
      material.opacity = 1;
      material.transparent = false;
      if (edgeMaterial) edgeMaterial.opacity = 0.4;
    } else {
      material.color.copy(neutral);
      material.opacity = 0.12;
      material.transparent = true;
      if (edgeMaterial) edgeMaterial.opacity = 0.05;
    }
    material.needsUpdate = true;
  });
}

// ---------------------------------------------------------------------------
// state stand-ins
// ---------------------------------------------------------------------------

/** A centered icon + message filling the stage (loading / empty / WebGL states). */
function StageMessage({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div
      className="flex size-full flex-col items-center justify-center gap-3 px-6 py-12 text-center"
      role="status"
      aria-live="polite"
    >
      <span className="grid size-12 place-items-center rounded-md bg-primary-tint">{icon}</span>
      <div className="flex max-w-xs flex-col gap-1">
        <p className="text-base font-semibold text-text">{title}</p>
        <p className="text-sm text-text-secondary">{body}</p>
      </div>
    </div>
  );
}

/** The error stage: a danger-tinted panel with the technical detail and a retry. */
function StageError({
  message,
  detail,
  onRetry,
  retrying,
}: {
  message: string;
  detail: string | null;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="flex size-full items-center justify-center px-6 py-12">
      <div
        role="alert"
        className="flex w-full max-w-md flex-col items-center gap-3 rounded-md border border-danger/40 bg-danger-tint px-5 py-6 text-center"
      >
        <AlertTriangle className="size-6 text-danger" strokeWidth={1.75} aria-hidden="true" />
        <p className="text-base font-semibold text-text">{message}</p>
        {detail && (
          <details className="w-full text-left">
            <summary className="cursor-pointer text-sm text-text-secondary">Technical details</summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-surface p-3 text-xs text-text-secondary">
              {detail}
            </pre>
          </details>
        )}
        <Button type="button" onClick={onRetry} loading={retrying} className="mt-1">
          Try again
        </Button>
      </div>
    </div>
  );
}

/** Skeleton rows mirroring the patch table while the manifest builds. */
function PatchTableSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <div className="h-8 w-full animate-pulse rounded-sm bg-border" />
      <div className="overflow-hidden rounded-md border border-border">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
            <div className="h-4 w-24 animate-pulse rounded-sm bg-border" />
            <div className="ml-auto h-4 w-10 animate-pulse rounded-sm bg-border" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default MeshViewer;
