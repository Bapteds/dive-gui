import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AlertTriangle, Crosshair, Maximize, MonitorX, MousePointerClick } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { PartTransform } from '@/lib/api/types';
import {
  anchorFromPatch,
  bakedRootTransform,
  computePlacement,
  targetFromHit,
  type HitTarget,
} from './placement';

/**
 * AssemblyViewer - the live three.js canvas for the "Assemble" tab.
 *
 * It renders the whole assembly in ONE scene: the base part (opaque neutral, the
 * only pickable body), every already-placed part (opaque neutral, at its committed
 * transform), and the part currently being placed (semi-transparent ORANGE ghost,
 * DoubleSide) whose position/orientation updates live as the user picks a base
 * face, chooses a mating patch, and drags the roll/offset controls.
 *
 * PARITY (the whole point): all placement math runs in RAW polyMesh coordinates.
 * The trimesh/GLTF export bakes a Z-up->Y-up flip on each GLB; we neutralise it by
 * wrapping every loaded part in a group whose matrix is the inverse of that baked
 * transform, so each part's frame == its raw polyMesh frame. The base's baked flip
 * is re-applied ONCE on the shared content root purely for a natural view. The
 * result: the `(q, t)` we preview is exactly the `(q, t)` we POST to the server.
 *
 * Scene scaffolding (renderer / OrbitControls / on-demand render / dispose) is
 * borrowed from MeshViewer.tsx; that file is intentionally left untouched.
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

/** Squared pointer-move threshold (px^2) below which a drag still counts as a click. */
const CLICK_DRAG_THRESHOLD_SQ = 36;
/** Opacity of the semi-transparent orange preview ghost. */
const PREVIEW_OPACITY = 0.35;

/** A part with its loaded geometry, as handed to the viewer. */
export interface ViewerPart {
  meshId: string;
  name: string;
  geometry: ArrayBuffer;
}

/** An already-placed part: a part plus its committed rigid transform. */
export interface PlacedViewerPart extends ViewerPart {
  transform: PartTransform;
}

export interface AssemblyViewerProps {
  /** The base part (never moved); the only body the user can pick a face on. */
  base: ViewerPart;
  /** Parts already confirmed, rendered opaque at their transform. */
  placed: PlacedViewerPart[];
  /** The part being placed now (orange ghost), or null when none is active. */
  active: ViewerPart | null;
  /** The active part's chosen mating patch (its face that meets the base). */
  matingPatch: string | null;
  /** The picked base face (raw point + normal + patch), or null. */
  target: HitTarget | null;
  /** User roll about the base mount normal, in radians. */
  rollRad: number;
  /** Offset along the base mount normal, in metres. */
  offset: number;
  /** The user clicked a face on the base. */
  onPickBaseFace: (target: HitTarget) => void;
  /** The live-computed placement for the active part (null while incomplete). */
  onPreviewTransform: (transform: PartTransform | null) => void;
  /** A GLB failed to parse (so the workspace can show an error state). */
  onError?: () => void;
}

/** Per-part scene handles kept across renders for cheap live updates. */
interface PartHandles {
  /** The placement group (its matrix carries the rigid transform). */
  group: THREE.Group;
  /** The loaded GLB root (for `anchorFromPatch`, in raw/local space). */
  loaded: THREE.Object3D;
  materials: THREE.Material[];
}

/** Compose a rigid transform into a Matrix4 (no scale). */
function composeMatrix(transform: PartTransform): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...transform.translation),
    new THREE.Quaternion(...transform.rotation),
    new THREE.Vector3(1, 1, 1),
  );
}

/** Set an object's local matrix explicitly and stop auto-updates. */
function setMatrix(object: THREE.Object3D, matrix: THREE.Matrix4): void {
  object.matrix.copy(matrix);
  object.matrixAutoUpdate = false;
  object.matrixWorldNeedsUpdate = true;
}

/** Parse a GLB ArrayBuffer into its scene object (or reject). */
function parseGlb(loader: GLTFLoader, buffer: ArrayBuffer): Promise<THREE.Object3D> {
  return new Promise((resolve, reject) => {
    try {
      loader.parse(buffer, '', (gltf) => resolve(gltf.scene), reject);
    } catch (err) {
      reject(err instanceof Error ? err : new Error('GLB parse failed'));
    }
  });
}

export function AssemblyViewer({
  base,
  placed,
  active,
  matingPatch,
  target,
  rollRad,
  offset,
  onPickBaseFace,
  onPreviewTransform,
  onError,
}: AssemblyViewerProps) {
  const webglAvailable = useMemo(detectWebgl, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const failedRef = useRef<HTMLDivElement>(null);

  // Latest inputs, read inside imperative handlers without re-binding the scene.
  const inputsRef = useRef({ base, placed, active, matingPatch, target, rollRad, offset });
  inputsRef.current = { base, placed, active, matingPatch, target, rollRad, offset };
  const onPickRef = useRef(onPickBaseFace);
  onPickRef.current = onPickBaseFace;
  const onPreviewRef = useRef(onPreviewTransform);
  onPreviewRef.current = onPreviewTransform;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Imperative hooks wired up inside the scene effect and read by the input effect.
  const requestRenderRef = useRef<() => void>(() => {});
  const resetViewRef = useRef<() => void>(() => {});
  const applyPreviewRef = useRef<() => void>(() => {});

  // A signature that changes only when the SET of bodies (or a committed
  // transform) changes - so roll/offset/target tweaks never rebuild the scene.
  const sceneKey = useMemo(() => {
    const placedKey = placed
      .map(
        (p) =>
          `${p.meshId}:${p.geometry.byteLength}:${p.transform.rotation.join(',')}:${p.transform.translation.join(',')}`,
      )
      .join('|');
    return `${base.meshId}:${base.geometry.byteLength}|${placedKey}|${active ? `${active.meshId}:${active.geometry.byteLength}` : ''}`;
  }, [base, placed, active]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !webglAvailable) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const neutral = new THREE.Color(readToken('--color-neutral', '#bcbdbf'));
    const placedTint = new THREE.Color(readToken('--color-primary-light', '#1e63b5'));
    const accent = new THREE.Color(readToken('--color-accent', '#ee7f00'));
    const primary = new THREE.Color(readToken('--color-primary', '#004a99'));

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

    // The shared content root: the base's baked Z-up->Y-up flip is applied here
    // once, so the whole assembly reads naturally while each part below stays in
    // raw space.
    const contentRoot = new THREE.Group();
    scene.add(contentRoot);

    let disposed = false;

    // --- on-demand rendering: draw only when something changes ---
    let renderRequested = false;
    const renderFrame = () => {
      renderRequested = false;
      controls.update();
      renderer.render(scene, camera);
    };
    const requestRender = () => {
      if (disposed || renderRequested) return;
      renderRequested = true;
      requestAnimationFrame(renderFrame);
    };
    requestRenderRef.current = requestRender;
    controls.addEventListener('change', requestRender);

    // Handles kept for live updates / disposal.
    const basePatchMaterials = new Map<string, THREE.MeshLambertMaterial>();
    let baseRoot: THREE.Group | null = null;
    let activeHandles: PartHandles | null = null;
    const disposables: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];

    /** Frame the base + placed parts (not the ghost, which may sit far off). */
    const fitView = () => {
      const box = new THREE.Box3();
      contentRoot.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh && mesh.userData.fit !== false) {
          mesh.updateWorldMatrix(true, false);
          box.expandByObject(mesh);
        }
      });
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

    /**
     * Build one part: neutralise its baked flip, wrap it in a placement group,
     * material it, and return the handles. `fit=false` keeps the ghost out of the
     * auto-frame. Returns the loaded root for raw-space anchor math.
     */
    const buildPart = (
      loaded: THREE.Object3D,
      makeMaterial: () => THREE.MeshLambertMaterial,
      onMaterial: (name: string, material: THREE.MeshLambertMaterial) => void,
      fit: boolean,
    ): PartHandles => {
      const baked = bakedRootTransform(loaded);
      const neutralGroup = new THREE.Group();
      setMatrix(neutralGroup, new THREE.Matrix4().copy(baked).invert());
      neutralGroup.add(loaded);

      const group = new THREE.Group(); // the placement group (rigid transform)
      group.add(neutralGroup);

      const materials: THREE.Material[] = [];
      loaded.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
        const material = makeMaterial();
        mesh.material = material;
        mesh.userData.fit = fit;
        materials.push(material);
        disposables.push({ geometry: mesh.geometry as THREE.BufferGeometry, material });
        onMaterial(mesh.name || mesh.parent?.name || '', material);
      });
      return { group, loaded, materials };
    };

    const neutralMaterial = (color: THREE.Color) =>
      new THREE.MeshLambertMaterial({ color: color.clone(), side: THREE.DoubleSide });

    /**
     * Recompute the ghost's placement from the latest inputs and drive the base
     * highlight. Emits the transform (or null) so the panel can enable Confirm.
     * Reads inputs via the ref, so the input effect can call it cheaply.
     */
    const applyPreview = () => {
      const { matingPatch: patch, target: hit, rollRad: roll, offset: off } = inputsRef.current;

      // Highlight the picked base patch in PRIMARY blue (target), distinct from
      // the orange ghost (the incoming part).
      basePatchMaterials.forEach((material, name) => {
        material.color.copy(name === hit?.patchName ? primary : neutral);
        material.needsUpdate = true;
      });

      if (!activeHandles) {
        onPreviewRef.current(null);
        requestRender();
        return;
      }

      if (patch && hit) {
        const anchor = anchorFromPatch(activeHandles.loaded, patch);
        if (anchor) {
          const placement = computePlacement(anchor.point, anchor.normal, hit.point, hit.normal, roll, off);
          setMatrix(activeHandles.group, composeMatrix({ ...placement, meshId: '' }));
          activeHandles.group.visible = true;
          onPreviewRef.current({
            meshId: inputsRef.current.active?.meshId ?? '',
            rotation: placement.rotation,
            translation: placement.translation,
          });
          requestRender();
          return;
        }
      }

      // Not ready: rest the ghost at its raw origin and report "no placement yet".
      setMatrix(activeHandles.group, new THREE.Matrix4());
      activeHandles.group.visible = true;
      onPreviewRef.current(null);
      requestRender();
    };
    applyPreviewRef.current = applyPreview;

    const loader = new GLTFLoader();

    (async () => {
      const data = inputsRef.current;
      try {
        // Base first: read its baked flip and put it on the content root for a
        // natural view, then neutralise it on the part itself.
        const baseLoaded = await parseGlb(loader, data.base.geometry);
        if (disposed) return;
        setMatrix(contentRoot, bakedRootTransform(baseLoaded));

        const baseHandles = buildPart(
          baseLoaded,
          () => neutralMaterial(neutral),
          (name, material) => {
            if (name) basePatchMaterials.set(name, material);
          },
          true,
        );
        baseRoot = baseHandles.group;
        contentRoot.add(baseHandles.group);

        // Placed parts, each at its committed transform.
        for (const part of data.placed) {
          const loaded = await parseGlb(loader, part.geometry);
          if (disposed) return;
          const handles = buildPart(loaded, () => neutralMaterial(placedTint), () => {}, true);
          setMatrix(handles.group, composeMatrix(part.transform));
          contentRoot.add(handles.group);
        }

        // The active ghost (semi-transparent orange), if any.
        if (data.active) {
          const loaded = await parseGlb(loader, data.active.geometry);
          if (disposed) return;
          activeHandles = buildPart(
            loaded,
            () =>
              new THREE.MeshLambertMaterial({
                color: accent.clone(),
                side: THREE.DoubleSide,
                transparent: true,
                opacity: PREVIEW_OPACITY,
                depthWrite: false,
              }),
            () => {},
            false,
          );
          contentRoot.add(activeHandles.group);
        }

        fitView();
        applyPreview();
        requestRender();
      } catch {
        if (!disposed) onErrorRef.current?.();
      }
    })();

    // --- interaction: orbit + pick a base face on click only ---
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
      if (!baseRoot) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      // Only the BASE is pickable: you choose a face ON the base to mount onto.
      const hit = raycaster
        .intersectObjects(baseRoot.children, true)
        .find((intersection) => (intersection.object as THREE.Mesh).isMesh && intersection.face);
      if (hit) onPickRef.current(targetFromHit(hit, baseRoot));
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
      disposables.forEach(({ geometry, material }) => {
        geometry.dispose();
        material.dispose();
      });
      requestRenderRef.current = () => {};
      resetViewRef.current = () => {};
      applyPreviewRef.current = () => {};
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // Rebuilt only when the SET of bodies changes; live inputs are applied below
    // (every reactive value the effect uses is read through a ref).
  }, [sceneKey, webglAvailable]);

  // Re-apply the ghost placement + highlight whenever a live input changes.
  useEffect(() => {
    applyPreviewRef.current();
  }, [matingPatch, target, rollRad, offset, active?.meshId]);

  if (!webglAvailable) {
    return (
      <StageMessage
        icon={<MonitorX className="size-6 text-text-secondary" strokeWidth={1.5} aria-hidden="true" />}
        title="3D rendering isn't available"
        body="Your browser doesn't support WebGL, so the assembly can't be shown here."
      />
    );
  }

  return (
    <div className="absolute inset-0" ref={failedRef}>
      {/* Light studio stage (token-driven radial), the WebGL canvas is transparent over it. */}
      <div
        ref={containerRef}
        className="size-full"
        style={{
          background:
            'radial-gradient(120% 120% at 50% 35%, var(--color-surface) 0%, var(--color-bg) 78%)',
        }}
      />

      {/* Pick hint (top-left) - guides the user to the first action. */}
      <div className="pointer-events-none absolute left-3 top-3 flex max-w-[15rem] items-start gap-2 rounded-md border border-border bg-surface/90 px-2.5 py-1.5 text-xs text-text-secondary shadow-sm backdrop-blur-sm">
        {target ? (
          <>
            <Crosshair className="mt-px size-3.5 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
            <span className="min-w-0">
              Mount face:{' '}
              <code className="font-mono text-text" translate="no">
                {target.patchName || 'face'}
              </code>
            </span>
          </>
        ) : (
          <>
            <MousePointerClick className="mt-px size-3.5 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
            <span className="min-w-0">Click a face on the base to set the mount point.</span>
          </>
        )}
      </div>

      <div className="pointer-events-none absolute right-3 top-3">
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

/** A centered icon + message filling the stage (WebGL / error states). */
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
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 py-12 text-center"
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

/** Small standalone error stage (used when a GLB fails to parse). */
export function AssemblyViewerError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6 py-12">
      <div
        role="alert"
        className="flex w-full max-w-md flex-col items-center gap-3 rounded-md border border-danger/40 bg-danger-tint px-5 py-6 text-center"
      >
        <AlertTriangle className="size-6 text-danger" strokeWidth={1.75} aria-hidden="true" />
        <p className="text-base font-semibold text-text">Could not load the 3D geometry.</p>
        <p className="text-sm text-text-secondary">
          A part&rsquo;s preview could not be parsed. Rebuilding may fix it.
        </p>
        <Button type="button" onClick={onRetry} className="mt-1">
          Try again
        </Button>
      </div>
    </div>
  );
}

export default AssemblyViewer;
