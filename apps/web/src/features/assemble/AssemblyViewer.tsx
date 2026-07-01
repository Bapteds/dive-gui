import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AlertTriangle, Crosshair, Link2, Maximize, MonitorX, Move3d } from 'lucide-react';
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
 * only pickable body), every other added part (opaque blue tint, at its
 * transform - identity = its imported position by default), and the part being
 * worked on (semi-transparent BLUE ghost, DoubleSide). Colours: orange selection
 * (the picked base patch), blue ghost (the part being placed).
 *
 * PLACEMENT IS OPTIONAL. A part stays at its imported world coordinates unless
 * the user opts to reposition it. When they do, a TransformControls gizmo drives
 * the active ghost (translate / rotate), OrbitControls is suspended while a
 * handle is dragged, and every drag emits the ghost's `(position, quaternion)`
 * back out as the SAME `PartTransform` the numeric fields edit and the server
 * receives. Picking a base face never moves the part; it only marks the base
 * patch of the coupling and offers an optional "align to face" starting point.
 *
 * PARITY (the whole point): all placement math runs in RAW polyMesh coordinates.
 * The trimesh/GLTF export bakes a Z-up->Y-up flip on each GLB; we neutralise it
 * by wrapping every loaded part in a group whose matrix is the inverse of that
 * baked transform, so each part's frame == its raw polyMesh frame, and the
 * placement group's LOCAL position/quaternion IS the raw `(t, q)`. The base's
 * baked flip is re-applied ONCE on the shared content root purely for a natural
 * view. The result: the `(q, t)` we preview is exactly the `(q, t)` we POST.
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
/** Opacity of the semi-transparent blue preview ghost. */
const PREVIEW_OPACITY = 0.35;

/** A part with its loaded geometry, as handed to the viewer. */
export interface ViewerPart {
  meshId: string;
  name: string;
  geometry: ArrayBuffer;
}

/** An already-placed part: a part plus its rigid transform (identity = imported). */
export interface PlacedViewerPart extends ViewerPart {
  transform: PartTransform;
}

/** The gizmo interaction mode (a small toggle in the placement panel). */
export type GizmoMode = 'translate' | 'rotate';

export interface AssemblyViewerProps {
  /** The base part (never moved); the only body the user can pick a face on. */
  base: ViewerPart;
  /** Every other added part, rendered opaque at its transform (identity = imported). */
  placed: PlacedViewerPart[];
  /** The part being worked on now (orange ghost), or null when none is active. */
  active: ViewerPart | null;
  /** Where the active ghost renders (and the gizmo attaches). Identity = imported. */
  activeTransform: PartTransform;
  /** The active part's chosen mating patch (its face that couples to the base). */
  matingPatch: string | null;
  /** The picked base face (raw point + normal + patch), or null. */
  target: HitTarget | null;
  /** Whether the user is repositioning the active part (shows + enables the gizmo). */
  reposition: boolean;
  /** Gizmo interaction mode when repositioning. */
  gizmoMode: GizmoMode;
  /** The user clicked a face on the base (sets the coupling's base patch; never moves the part). */
  onPickBaseFace: (target: HitTarget) => void;
  /** The gizmo moved the active ghost: its new raw transform. */
  onTransformChange: (transform: PartTransform) => void;
  /** The one-shot "align to this face" transform for the active part, or null when unavailable. */
  onAlignTransform: (transform: PartTransform | null) => void;
  /** A GLB failed to parse (so the workspace can show an error state). */
  onError?: () => void;
}

/** Per-part scene handles kept across renders for cheap live updates. */
interface PartHandles {
  /** The placement group (its local position/quaternion carry the rigid transform). */
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
  activeTransform,
  matingPatch,
  target,
  reposition,
  gizmoMode,
  onPickBaseFace,
  onTransformChange,
  onAlignTransform,
  onError,
}: AssemblyViewerProps) {
  const webglAvailable = useMemo(detectWebgl, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const failedRef = useRef<HTMLDivElement>(null);

  // Latest inputs, read inside imperative handlers without re-binding the scene.
  const inputsRef = useRef({
    base,
    placed,
    active,
    activeTransform,
    matingPatch,
    target,
    reposition,
    gizmoMode,
  });
  inputsRef.current = {
    base,
    placed,
    active,
    activeTransform,
    matingPatch,
    target,
    reposition,
    gizmoMode,
  };
  const onPickRef = useRef(onPickBaseFace);
  onPickRef.current = onPickBaseFace;
  const onTransformRef = useRef(onTransformChange);
  onTransformRef.current = onTransformChange;
  const onAlignRef = useRef(onAlignTransform);
  onAlignRef.current = onAlignTransform;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Imperative hooks wired up inside the scene effect and read by the input effects.
  const requestRenderRef = useRef<() => void>(() => {});
  const resetViewRef = useRef<() => void>(() => {});
  const applyActiveTransformRef = useRef<() => void>(() => {});
  const applyGizmoRef = useRef<() => void>(() => {});
  const applyHighlightAlignRef = useRef<() => void>(() => {});

  // A signature that changes only when the SET of bodies (or a placed transform)
  // changes - so live active-transform / gizmo / highlight tweaks never rebuild.
  const sceneKey = useMemo(() => {
    const placedKey = placed
      .map(
        (p) =>
          `${p.meshId}:${p.geometry.byteLength}:${p.transform.rotation.join(',')}:${p.transform.translation.join(',')}`,
      )
      .join('|');
    return `${base.meshId}:${base.geometry.byteLength}|${placedKey}|${active ? `${active.meshId}:${active.geometry.byteLength}` : ''}`;
  }, [base, placed, active]);

  // A value key for the active transform, so applying it does not fire on every
  // unrelated parent render (only when the numbers actually change).
  const activeTransformKey = `${activeTransform.translation.join(',')}|${activeTransform.rotation.join(',')}`;

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

    // The 6-DOF gizmo. It edits the active ghost's placement group in place; its
    // local position/quaternion IS the raw transform we emit. Attached only while
    // the user is repositioning (see applyGizmo).
    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.setSpace('world');
    gizmo.setSize(0.9);
    gizmo.visible = false;
    gizmo.enabled = false;
    scene.add(gizmo);

    // Handles kept for live updates / disposal.
    const basePatchMaterials = new Map<string, THREE.MeshLambertMaterial>();
    let baseRoot: THREE.Group | null = null;
    let activeHandles: PartHandles | null = null;
    let gizmoDragging = false;
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
     * Place the active ghost at the current transform. Skipped WHILE a gizmo
     * handle is being dragged (the gizmo then owns the group), so the drag never
     * fights the echoed React state.
     */
    const applyActiveTransform = () => {
      if (!activeHandles || gizmoDragging) return;
      const t = inputsRef.current.activeTransform;
      const g = activeHandles.group;
      g.position.set(t.translation[0], t.translation[1], t.translation[2]);
      g.quaternion.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
      requestRender();
    };
    applyActiveTransformRef.current = applyActiveTransform;

    /** Attach / detach the gizmo and set its mode from the current inputs. */
    const applyGizmo = () => {
      const { reposition: on, gizmoMode: mode } = inputsRef.current;
      if (on && activeHandles) {
        gizmo.setMode(mode);
        if (gizmo.object !== activeHandles.group) gizmo.attach(activeHandles.group);
        gizmo.enabled = true;
        gizmo.visible = true;
      } else {
        gizmo.detach();
        gizmo.enabled = false;
        gizmo.visible = false;
      }
      requestRender();
    };
    applyGizmoRef.current = applyGizmo;

    /**
     * Highlight the picked base patch in ACCENT orange and (re)compute the
     * optional "align to this face" transform for the active part, emitting it (or
     * null) so the panel can offer / disable that helper.
     */
    const applyHighlightAlign = () => {
      const { matingPatch: patch, target: hit } = inputsRef.current;
      basePatchMaterials.forEach((material, name) => {
        material.color.copy(name === hit?.patchName ? accent : neutral);
        material.needsUpdate = true;
      });

      if (activeHandles && patch && hit) {
        const anchor = anchorFromPatch(activeHandles.loaded, patch);
        if (anchor) {
          const placement = computePlacement(anchor.point, anchor.normal, hit.point, hit.normal, 0, 0);
          onAlignRef.current({
            meshId: inputsRef.current.active?.meshId ?? '',
            rotation: placement.rotation,
            translation: placement.translation,
          });
          requestRender();
          return;
        }
      }
      onAlignRef.current(null);
      requestRender();
    };
    applyHighlightAlignRef.current = applyHighlightAlign;

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

        // Other added parts, each at its transform (identity = imported position).
        for (const part of data.placed) {
          const loaded = await parseGlb(loader, part.geometry);
          if (disposed) return;
          const handles = buildPart(loaded, () => neutralMaterial(placedTint), () => {}, true);
          setMatrix(handles.group, composeMatrix(part.transform));
          contentRoot.add(handles.group);
        }

        // The active ghost (semi-transparent blue). Its group keeps
        // matrixAutoUpdate ON so the gizmo and the numeric fields can drive it.
        if (data.active) {
          const loaded = await parseGlb(loader, data.active.geometry);
          if (disposed) return;
          activeHandles = buildPart(
            loaded,
            () =>
              new THREE.MeshLambertMaterial({
                color: primary.clone(),
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
        applyActiveTransform();
        applyGizmo();
        applyHighlightAlign();
        requestRender();
      } catch {
        if (!disposed) onErrorRef.current?.();
      }
    })();

    // --- gizmo events: echo the transform, suspend orbit while dragging ---
    const onGizmoChange = () => requestRender();
    const onGizmoDragging = (event: { value: boolean }) => {
      gizmoDragging = event.value;
      controls.enabled = !event.value;
    };
    const onGizmoObjectChange = () => {
      if (!activeHandles) return;
      const g = activeHandles.group;
      onTransformRef.current({
        meshId: inputsRef.current.active?.meshId ?? '',
        translation: [g.position.x, g.position.y, g.position.z],
        rotation: [g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w],
      });
    };
    gizmo.addEventListener('change', onGizmoChange);
    gizmo.addEventListener('dragging-changed', onGizmoDragging as (event: unknown) => void);
    gizmo.addEventListener('objectChange', onGizmoObjectChange);

    // --- interaction: orbit + pick a base face on click only ---
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downX = 0;
    let downY = 0;
    let downOnGizmo = false;

    const onPointerDown = (event: PointerEvent) => {
      downX = event.clientX;
      downY = event.clientY;
      // If the press started on a gizmo handle, it is a reposition drag, not a pick.
      downOnGizmo = inputsRef.current.reposition && !!gizmo.axis;
      renderer.domElement.style.cursor = 'grabbing';
    };
    const onPointerUp = (event: PointerEvent) => {
      renderer.domElement.style.cursor = 'grab';
      if (downOnGizmo || gizmoDragging) {
        downOnGizmo = false;
        return; // the gizmo handled this pointer
      }
      const dx = event.clientX - downX;
      const dy = event.clientY - downY;
      if (dx * dx + dy * dy > CLICK_DRAG_THRESHOLD_SQ) return; // it was an orbit drag
      if (!baseRoot) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      // Only the BASE is pickable: you choose a face ON the base to couple to.
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
      gizmo.removeEventListener('change', onGizmoChange);
      gizmo.removeEventListener('dragging-changed', onGizmoDragging as (event: unknown) => void);
      gizmo.removeEventListener('objectChange', onGizmoObjectChange);
      gizmo.detach();
      scene.remove(gizmo);
      gizmo.dispose();
      controls.dispose();
      disposables.forEach(({ geometry, material }) => {
        geometry.dispose();
        material.dispose();
      });
      requestRenderRef.current = () => {};
      resetViewRef.current = () => {};
      applyActiveTransformRef.current = () => {};
      applyGizmoRef.current = () => {};
      applyHighlightAlignRef.current = () => {};
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // Rebuilt only when the SET of bodies changes; live inputs are applied below
    // (every reactive value the effect uses is read through a ref).
  }, [sceneKey, webglAvailable]);

  // Move the ghost when the transform changes (numeric fields / align / echo).
  useEffect(() => {
    applyActiveTransformRef.current();
  }, [activeTransformKey]);

  // Attach / detach / re-mode the gizmo when repositioning toggles or mode flips.
  useEffect(() => {
    applyGizmoRef.current();
  }, [reposition, gizmoMode, active?.meshId]);

  // Re-highlight the base patch + recompute the align helper on couple changes.
  useEffect(() => {
    applyHighlightAlignRef.current();
  }, [matingPatch, target, active?.meshId]);

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

      {/* Contextual hint (top-left): coupling by default, gizmo help while repositioning. */}
      <div className="pointer-events-none absolute left-3 top-3 flex max-w-[16rem] items-start gap-2 rounded-md border border-border bg-surface/90 px-2.5 py-1.5 text-xs text-text-secondary shadow-sm backdrop-blur-sm">
        {reposition ? (
          <>
            <Move3d className="mt-px size-3.5 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
            <span className="min-w-0">Drag the gizmo to {gizmoMode === 'rotate' ? 'rotate' : 'move'} the part.</span>
          </>
        ) : target ? (
          <>
            <Crosshair className="mt-px size-3.5 shrink-0 text-accent" strokeWidth={1.75} aria-hidden="true" />
            <span className="min-w-0">
              Base patch:{' '}
              <code className="font-mono text-text" translate="no">
                {target.patchName || 'face'}
              </code>
            </span>
          </>
        ) : (
          <>
            <Link2 className="mt-px size-3.5 shrink-0 text-accent" strokeWidth={1.75} aria-hidden="true" />
            <span className="min-w-0">Click a base face to set the patch it couples to.</span>
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
