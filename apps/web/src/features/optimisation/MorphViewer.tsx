import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { blendWeight, morphPoint, prepareCenterline, type Centerline } from '@dive/shared';
import { bakedRootTransform } from '@/features/assemble/placement';

/**
 * MorphViewer - the 3D stage of the Optimisation setup.
 *
 * NO fitted axis, by design. The engineer drops TWO rings ANYWHERE on the shape: each
 * click is probed across the channel (shoot along the inward wall normal, hit the far
 * wall) to measure that section's CENTRE and RADIUS right where they clicked. The two
 * measured centres are the whole axis: the wall band BETWEEN the two rings is the morph
 * zone, highlighted on the surface and grown live by the diameter preview. Rings are
 * dragged freely across the surface (each move re-probes), never along a rail.
 *
 * Coordinate frame: extractPatches exports points with process=False, so each mesh's
 * LOCAL vertices ARE the raw polyMesh coords. Neutralising the GLB's baked Z-up->Y-up
 * flip (a wrapper group with the inverse of bakedRootTransform, same trick as the
 * Assemble viewer) makes the rendered world frame == raw coords, so a raycast hit, the
 * probed centres and the rings all live in raw coords, and applying the SHARED
 * morphPoint to the local vertices previews exactly what the server bakes.
 */

type Vec3 = [number, number, number];

/** One ring the user dropped on the shape: the section measured at that exact spot. */
export interface RingPlacement {
  /** Centre of the local cross-section (raw coords), from the wall-to-wall probe. */
  center: Vec3;
  /** Local radius (metres) = half the probed wall-to-wall distance. */
  radius: number;
  /** The patch that was clicked (the wall the sweep morphs). */
  patch: string | null;
}

/**
 * Morph-zone shape constants. Exported so the workspace builds the SERVER config from
 * the very same numbers the preview renders with (parity by construction).
 */
export const ZONE_BLEND = 0.15;
export const FALLOFF_START_FACTOR = 1.3;
export const FALLOFF_END_FACTOR = 2.2;

interface MorphPreview {
  baselineDiameterM: number;
  diameterM: number;
  stationA: number;
  stationB: number;
  blend: number;
  falloffStartM?: number;
  falloffEndM?: number;
}

/** A mesh + its pristine positions (raw coords). */
interface Tracked {
  mesh: THREE.Mesh;
  positions: Float32Array;
}

const RING_TUBE = 0.1; // hoop thickness as a fraction of its radius
const RING_SCALE = 1.15; // hoop radius vs the measured wall radius (a visible collar)
const AXIS_Z = new THREE.Vector3(0, 0, 1);

function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function toVector(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v[0], v[1], v[2]);
}

/** Mean radius of the two rings (drives the baseline diameter + the radial falloff). */
export function meanRadius(a: RingPlacement, b: RingPlacement): number {
  return (a.radius + b.radius) / 2;
}

export function MorphViewer({
  geometry,
  centerline,
  ringA,
  ringB,
  pickMode,
  onPlaceRing,
  morphPreview,
}: {
  geometry: ArrayBuffer;
  /** The 2-point axis [ringA.center, ringB.center], or null until both are placed. */
  centerline: Centerline | null;
  ringA: RingPlacement | null;
  ringB: RingPlacement | null;
  /** Which ring the next click drops (null = clicks just orbit). */
  pickMode: 'A' | 'B' | null;
  /** Fired when a ring is dropped or dragged to a new spot on the shape. */
  onPlaceRing: (which: 'A' | 'B', placement: RingPlacement) => void;
  /** When set, deform the surface to this diameter (else show the pristine mesh). */
  morphPreview: MorphPreview | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const onPlaceRingRef = useRef(onPlaceRing);
  const pickModeRef = useRef(pickMode);
  const centerlineRef = useRef<Centerline | null>(centerline);
  const ringARef = useRef<RingPlacement | null>(ringA);
  const ringBRef = useRef<RingPlacement | null>(ringB);
  const previewRef = useRef<MorphPreview | null>(morphPreview);
  onPlaceRingRef.current = onPlaceRing;
  pickModeRef.current = pickMode;
  centerlineRef.current = centerline;
  ringARef.current = ringA;
  ringBRef.current = ringB;
  previewRef.current = morphPreview;

  const resetViewRef = useRef<() => void>(() => {});
  const syncOverlayRef = useRef<() => void>(() => {});
  const applyMorphRef = useRef<() => void>(() => {});

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const primary = new THREE.Color(readToken('--color-primary', '#004a99'));
    const primaryLight = new THREE.Color(readToken('--color-primary-light', '#1e63b5'));
    const accent = new THREE.Color(readToken('--color-accent', '#ee7f00'));
    const neutral = new THREE.Color(readToken('--color-neutral', '#bcbdbf'));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    renderer.domElement.classList.add('block', 'size-full');
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.style.cursor = 'crosshair';

    scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd3da, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 0.6);
    key.position.set(1, 1.4, 1.2);
    scene.add(key);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reduceMotion;
    controls.dampingFactor = 0.12;

    const meshRoot = new THREE.Group(); // raw-coord frame (baked flip neutralised)
    const overlay = new THREE.Group(); // rings, also raw coords
    scene.add(meshRoot);
    scene.add(overlay);

    let disposed = false;
    let frameQueued = false;
    let rafId = 0;
    const renderFrame = () => {
      frameQueued = false;
      if (disposed) return;
      controls.update();
      renderer.render(scene, camera);
    };
    const requestRender = () => {
      if (disposed || frameQueued) return;
      frameQueued = true;
      rafId = requestAnimationFrame(renderFrame);
    };
    controls.addEventListener('change', requestRender);

    // Ring hoops (unit tori scaled to the measured radius) + dot markers for a lone
    // ring, whose section plane is unknown until the second ring gives the direction.
    const ringGeom = new THREE.TorusGeometry(1, RING_TUBE, 12, 48);
    const dotGeom = new THREE.SphereGeometry(1, 16, 12);
    const matA = new THREE.MeshBasicMaterial({ color: primary.clone() });
    const matB = new THREE.MeshBasicMaterial({ color: primaryLight.clone() });
    const hoopA = new THREE.Mesh(ringGeom, matA);
    const hoopB = new THREE.Mesh(ringGeom, matB);
    const dotA = new THREE.Mesh(dotGeom, matA);
    const dotB = new THREE.Mesh(dotGeom, matB);
    [hoopA, hoopB, dotA, dotB].forEach((m) => {
      m.visible = false;
      m.renderOrder = 2;
      overlay.add(m);
    });

    const tracked: Tracked[] = [];
    let modelRadius = 1;

    const fitView = () => {
      const box = new THREE.Box3().setFromObject(meshRoot);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      modelRadius = sphere.radius || 1;
      const distance = modelRadius / Math.sin((camera.fov * Math.PI) / 180 / 2);
      const dir = new THREE.Vector3(0.8, 0.5, 1).normalize();
      camera.position.copy(sphere.center).addScaledVector(dir, distance * 1.3);
      camera.near = modelRadius / 100;
      camera.far = modelRadius * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(sphere.center);
      controls.update();
      requestRender();
    };
    resetViewRef.current = fitView;

    /**
     * Measure the channel section at a surface hit: shoot from just inside the wall
     * along the inward normal (and, failing that, the outward one) until the opposite
     * wall of the SAME patch is hit. Centre = midpoint, radius = half the span. This
     * is what makes free placement work with no fitted axis anywhere.
     */
    const probeRaycaster = new THREE.Raycaster();
    const probeSection = (hit: THREE.Intersection): RingPlacement | null => {
      const object = hit.object as THREE.Mesh;
      if (!hit.face) return null;
      const eps = modelRadius * 1e-4;
      const normal = hit.face.normal.clone().transformDirection(object.matrixWorld).normalize();
      let best: { center: THREE.Vector3; radius: number } | null = null;
      for (const dir of [normal.clone().negate(), normal.clone()]) {
        probeRaycaster.set(hit.point.clone().addScaledVector(dir, eps), dir);
        probeRaycaster.near = 0;
        probeRaycaster.far = modelRadius * 4;
        const far = probeRaycaster.intersectObject(object, false).find((h) => h.distance > eps);
        if (!far) continue;
        const radius = far.distance / 2;
        // Prefer the SHORTER span: on a tube that is the true bore, not a far-away limb.
        if (!best || radius < best.radius) {
          best = { center: hit.point.clone().addScaledVector(dir, radius), radius };
        }
      }
      if (!best || !(best.radius > 0)) return null;
      return {
        center: [best.center.x, best.center.y, best.center.z],
        radius: best.radius,
        patch: object.name || object.parent?.name || null,
      };
    };

    /** Draw the two rings from the given placements (hoops once the axis is known). */
    const drawRings = (a: RingPlacement | null, b: RingPlacement | null) => {
      const axis = a && b ? toVector(b.center).sub(toVector(a.center)) : null;
      const haveAxis = !!axis && axis.lengthSq() > 0;
      if (haveAxis) axis!.normalize();
      const place = (ring: RingPlacement | null, hoop: THREE.Mesh, dot: THREE.Mesh) => {
        if (!ring) {
          hoop.visible = false;
          dot.visible = false;
          return;
        }
        if (haveAxis) {
          hoop.position.copy(toVector(ring.center));
          hoop.quaternion.setFromUnitVectors(AXIS_Z, axis!);
          hoop.scale.setScalar(ring.radius * RING_SCALE);
          hoop.visible = true;
          dot.visible = false;
        } else {
          // Only one ring so far: its section plane is undetermined, show a marker.
          dot.position.copy(toVector(ring.center));
          dot.scale.setScalar(Math.max(ring.radius * 0.22, modelRadius * 1e-3));
          dot.visible = true;
          hoop.visible = false;
        }
      };
      place(a, hoopA, dotA);
      place(b, hoopB, dotB);
    };

    /**
     * Tint exactly what the morph will move: blendWeight > 0 along the 2-point axis
     * AND inside the radial falloff. Cheap (one segment), so it tracks a live drag.
     */
    const recolorZone = (cl: Centerline | null, a: RingPlacement | null, b: RingPlacement | null) => {
      const active = !!cl && cl.points.length >= 2 && !!a && !!b;
      const falloffEnd = active ? meanRadius(a!, b!) * FALLOFF_END_FACTOR : 0;
      const A = active ? toVector(cl!.points[0] as Vec3) : null;
      const B = active ? toVector(cl!.points[1] as Vec3) : null;
      const ab = active ? B!.clone().sub(A!) : null;
      const len2 = ab ? ab.dot(ab) : 0;
      const p = new THREE.Vector3();
      const foot = new THREE.Vector3();
      tracked.forEach((t) => {
        const attr = t.mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
        if (!attr) return;
        const arr = attr.array as Float32Array;
        const n = arr.length / 3;
        for (let i = 0; i < n; i += 1) {
          let inZone = false;
          if (active && len2 > 0) {
            p.set(t.positions[3 * i], t.positions[3 * i + 1], t.positions[3 * i + 2]);
            let s = p.clone().sub(A!).dot(ab!) / len2;
            s = Math.max(0, Math.min(1, s));
            if (blendWeight(s, 0, 1, ZONE_BLEND) > 0) {
              foot.copy(A!).addScaledVector(ab!, s);
              inZone = foot.distanceTo(p) <= falloffEnd;
            }
          }
          const c = inZone ? accent : neutral;
          arr[3 * i] = c.r;
          arr[3 * i + 1] = c.g;
          arr[3 * i + 2] = c.b;
        }
        attr.needsUpdate = true;
      });
    };

    const syncOverlay = () => {
      drawRings(ringARef.current, ringBRef.current);
      recolorZone(centerlineRef.current, ringARef.current, ringBRef.current);
      requestRender();
    };
    syncOverlayRef.current = syncOverlay;

    const applyMorph = () => {
      if (tracked.length === 0) return;
      const preview = previewRef.current;
      const cl = centerlineRef.current;
      const active = preview && cl && cl.points.length >= 2 && preview.baselineDiameterM > 0;
      if (!active) {
        tracked.forEach(({ mesh, positions }) => {
          const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
          (attr.array as Float32Array).set(positions);
          attr.needsUpdate = true;
          mesh.geometry.computeVertexNormals();
        });
        requestRender();
        return;
      }
      const prep = prepareCenterline(cl);
      const ratio = preview.diameterM / preview.baselineDiameterM;
      tracked.forEach(({ mesh, positions }) => {
        const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
        const out = attr.array as Float32Array;
        for (let i = 0; i < positions.length; i += 3) {
          const q = morphPoint(
            [positions[i], positions[i + 1], positions[i + 2]],
            prep,
            preview.stationA,
            preview.stationB,
            preview.blend,
            ratio,
            preview.falloffStartM,
            preview.falloffEndM,
          );
          out[i] = q[0];
          out[i + 1] = q[1];
          out[i + 2] = q[2];
        }
        attr.needsUpdate = true;
        mesh.geometry.computeVertexNormals();
      });
      requestRender();
    };
    applyMorphRef.current = applyMorph;

    const loader = new GLTFLoader();
    const onParsed = (gltf: { scene: THREE.Object3D }) => {
      if (disposed) return;
      const loaded = gltf.scene;
      const meshes: THREE.Mesh[] = [];
      loaded.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
      });
      if (meshes.length === 0) return;

      const baked = bakedRootTransform(loaded);
      const neutralGroup = new THREE.Group();
      neutralGroup.matrixAutoUpdate = false;
      neutralGroup.matrix.copy(baked).invert();
      neutralGroup.matrixWorldNeedsUpdate = true;
      neutralGroup.add(loaded);
      meshRoot.add(neutralGroup);
      meshRoot.updateMatrixWorld(true); // probes need current world matrices

      meshes.forEach((mesh) => {
        if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
        mesh.material = new THREE.MeshLambertMaterial({
          color: 0xffffff, // colour comes from per-vertex colours (neutral + zone tint)
          vertexColors: true,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
        });
        const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
        const colors = new Float32Array(posAttr.count * 3);
        for (let i = 0; i < posAttr.count; i += 1) {
          colors[3 * i] = neutral.r;
          colors[3 * i + 1] = neutral.g;
          colors[3 * i + 2] = neutral.b;
        }
        mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        tracked.push({ mesh, positions: Float32Array.from(posAttr.array as Float32Array) });
      });

      fitView();
      syncOverlay();
      applyMorph();
    };
    try {
      loader.parse(geometry, '', onParsed, () => {});
    } catch {
      /* a bad GLB just leaves an empty canvas here (the setup form still works) */
    }

    // ---- pointer: orbit / drop a ring / grab-and-drag a ring freely ---------------
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downX = 0;
    let downY = 0;
    let dragging: 'A' | 'B' | null = null;
    let dragPlacement: RingPlacement | null = null;

    const toPointer = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    };

    /** The section under the pointer, probed on the surface (null when off-mesh). */
    const sectionUnderPointer = (): RingPlacement | null => {
      const hit = raycaster
        .intersectObjects(meshRoot.children, true)
        .find((i) => (i.object as THREE.Mesh).isMesh);
      return hit ? probeSection(hit) : null;
    };

    const onDown = (event: PointerEvent) => {
      downX = event.clientX;
      downY = event.clientY;
      toPointer(event);
      const grabbable = [hoopA, hoopB, dotA, dotB].filter((m) => m.visible);
      const ringHit = raycaster.intersectObjects(grabbable, false).at(0);
      if (ringHit) {
        dragging = ringHit.object === hoopA || ringHit.object === dotA ? 'A' : 'B';
        dragPlacement = (dragging === 'A' ? ringARef.current : ringBRef.current) ?? null;
        controls.enabled = false;
        renderer.domElement.style.cursor = 'grabbing';
        renderer.domElement.setPointerCapture(event.pointerId);
      }
    };

    const onMove = (event: PointerEvent) => {
      if (!dragging) return;
      toPointer(event);
      const section = sectionUnderPointer();
      if (!section) return; // pointer left the shape: keep the last good spot
      dragPlacement = section;
      const a = dragging === 'A' ? section : ringARef.current;
      const b = dragging === 'B' ? section : ringBRef.current;
      drawRings(a, b);
      const cl = a && b ? { points: [a.center, b.center] } : null;
      recolorZone(cl, a, b);
      requestRender();
    };

    const endDrag = (event: PointerEvent, commit: boolean) => {
      const which = dragging;
      const placement = dragPlacement;
      dragging = null;
      dragPlacement = null;
      controls.enabled = true;
      renderer.domElement.style.cursor = 'crosshair';
      try {
        renderer.domElement.releasePointerCapture(event.pointerId);
      } catch {
        /* capture may already be gone */
      }
      if (commit && which && placement) onPlaceRingRef.current(which, placement);
      else syncOverlay(); // aborted: snap back to the committed placements
    };

    const onUp = (event: PointerEvent) => {
      if (dragging) {
        endDrag(event, true);
        return;
      }
      const dx = event.clientX - downX;
      const dy = event.clientY - downY;
      if (dx * dx + dy * dy > 36) return; // it was an orbit drag
      const mode = pickModeRef.current;
      if (!mode) return;
      toPointer(event);
      const section = sectionUnderPointer();
      if (!section) return;
      onPlaceRingRef.current(mode, section);
    };

    const onCancel = (event: PointerEvent) => {
      if (dragging) endDrag(event, false);
    };

    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointercancel', onCancel);

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
      cancelAnimationFrame(rafId);
      controls.removeEventListener('change', requestRender);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointercancel', onCancel);
      controls.dispose();
      ringGeom.dispose();
      dotGeom.dispose();
      matA.dispose();
      matB.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry?.dispose?.();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
      resetViewRef.current = () => {};
      syncOverlayRef.current = () => {};
      applyMorphRef.current = () => {};
      renderer.dispose();
      // dispose() frees buffers/programs but NOT the GL context; release it so we do
      // not hit the browser's live-context cap after many tab/study remounts.
      try {
        renderer.forceContextLoss();
      } catch {
        /* not supported in every environment (e.g. headless tests) */
      }
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [geometry]);

  // Redraw the rings + zone highlight when a placement changes.
  useEffect(() => {
    syncOverlayRef.current();
  }, [centerline, ringA, ringB]);

  // Re-deform the surface when the preview (diameter or zone) changes.
  useEffect(() => {
    applyMorphRef.current();
  }, [morphPreview, centerline]);

  return (
    <div
      ref={containerRef}
      className="relative size-full min-h-80 overflow-hidden rounded-md border border-border bg-bg"
    />
  );
}
