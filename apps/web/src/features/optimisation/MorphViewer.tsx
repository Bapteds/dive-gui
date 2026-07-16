import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { morphPoint, prepareCenterline, type Centerline } from '@dive/shared';
import { bakedRootTransform } from '@/features/assemble/placement';

/**
 * MorphViewer - the 3D stage of the Optimisation setup: the translucent case mesh, the
 * fitted channel axis, and TWO big rings (hoops) the user drops around the tube. The
 * wall BAND between the two rings is the morph zone: it is highlighted on the surface
 * and grows/shrinks live with the diameter preview.
 *
 * Two ways to move a ring: grab it on the 3D and slide it along the axis, or use the
 * Circle A/B sliders (both drive the same station fractions).
 *
 * Coordinate frame: extractPatches exports points with process=False, so each mesh's
 * LOCAL vertices ARE the raw polyMesh coords. Neutralising the GLB's baked Z-up->Y-up
 * flip (a wrapper group with the inverse of bakedRootTransform, same trick as the
 * Assemble viewer) makes the rendered world frame == raw coords, so a raycast hit is a
 * raw point, the axis/rings live in raw coords, and applying the SHARED morphPoint to
 * the local vertices previews exactly what the server bakes.
 */

type Vec3 = [number, number, number];

interface MorphPreview {
  baselineDiameterM: number;
  diameterM: number;
  stationA: number;
  stationB: number;
  blend: number;
  falloffStartM?: number;
  falloffEndM?: number;
}

interface Arc {
  points: THREE.Vector3[];
  cum: number[];
  total: number;
}

/** A mesh + its pristine positions + each vertex's arc-length fraction along the axis. */
interface Tracked {
  mesh: THREE.Mesh;
  positions: Float32Array;
  fractions: Float32Array | null;
}

const RING_SCALE = 1.28; // ring radius vs local wall radius (a visible hoop AROUND it)
const AXIS_Z = new THREE.Vector3(0, 0, 1);

function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Cumulative arc-length of a raw-coord polyline. */
function buildArc(pts: Vec3[]): Arc {
  const points = pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const cum = [0];
  for (let i = 1; i < points.length; i += 1) cum.push(cum[i - 1] + points[i].distanceTo(points[i - 1]));
  return { points, cum, total: cum[cum.length - 1] ?? 0 };
}

/** Segment index + local t (0..1) at an arc-length fraction of the polyline. */
function locate(arc: Arc, fraction: number): { i: number; t: number } {
  const { cum, total } = arc;
  const s = Math.max(0, Math.min(1, fraction)) * total;
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < s) i += 1;
  const seg = (cum[i + 1] ?? cum[i]) - cum[i] || 1;
  return { i, t: (s - cum[i]) / seg };
}

/** Position + local tangent at an arc-length fraction. */
function frameAt(arc: Arc, fraction: number): { center: THREE.Vector3; tangent: THREE.Vector3 } {
  const { points } = arc;
  if (points.length === 0) return { center: new THREE.Vector3(), tangent: AXIS_Z.clone() };
  const { i, t } = locate(arc, fraction);
  const next = points[i + 1] ?? points[i];
  const center = points[i].clone().lerp(next, t);
  const tangent = next.clone().sub(points[i]);
  if (tangent.lengthSq() === 0) tangent.set(0, 0, 1);
  return { center, tangent: tangent.normalize() };
}

/** Local wall radius (metres) at a fraction, interpolated from the radius profile. */
function radiusAt(arc: Arc, radii: number[] | null, fraction: number, fallback: number): number {
  if (!radii || radii.length === 0) return fallback;
  const { i, t } = locate(arc, fraction);
  const a = radii[Math.min(i, radii.length - 1)];
  const b = radii[Math.min(i + 1, radii.length - 1)];
  const r = a + (b - a) * t;
  return r > 1e-6 ? r : fallback;
}

/** Arc-length fraction of the polyline point nearest a raw point. */
function projectFraction(arc: Arc, point: THREE.Vector3): number {
  const { points, cum, total } = arc;
  if (total <= 0) return 0;
  let bestD2 = Infinity;
  let bestS = 0;
  const ab = new THREE.Vector3();
  const ap = new THREE.Vector3();
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    ab.subVectors(points[i + 1], a);
    const seg2 = ab.dot(ab);
    let t = seg2 > 0 ? ap.subVectors(point, a).dot(ab) / seg2 : 0;
    t = Math.max(0, Math.min(1, t));
    const fx = a.x + ab.x * t;
    const fy = a.y + ab.y * t;
    const fz = a.z + ab.z * t;
    const d2 = (fx - point.x) ** 2 + (fy - point.y) ** 2 + (fz - point.z) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestS = cum[i] + t * Math.sqrt(seg2);
    }
  }
  return bestS / total;
}

/** Fraction of the axis point nearest a camera ray (drag fallback off the mesh). */
function projectRayFraction(arc: Arc, ray: THREE.Ray): number {
  const { points, cum, total } = arc;
  if (total <= 0) return 0;
  let bestD2 = Infinity;
  let bestS = 0;
  const u = new THREE.Vector3();
  const w0 = new THREE.Vector3();
  const pRay = new THREE.Vector3();
  const pSeg = new THREE.Vector3();
  const d = ray.direction; // normalised
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    u.subVectors(points[i + 1], a);
    const b = d.dot(u);
    const c = u.dot(u);
    w0.subVectors(ray.origin, a);
    const dd = d.dot(w0);
    const e = u.dot(w0);
    const denom = c - b * b; // a = d·d = 1
    let s = denom > 1e-9 ? (e - b * dd) / denom : 0;
    s = Math.max(0, Math.min(1, s));
    let tRay = b * s - dd; // param along the ray
    tRay = Math.max(0, tRay);
    pRay.copy(ray.origin).addScaledVector(d, tRay);
    pSeg.copy(a).addScaledVector(u, s);
    const d2 = pRay.distanceToSquared(pSeg);
    if (d2 < bestD2) {
      bestD2 = d2;
      bestS = cum[i] + s * Math.sqrt(c);
    }
  }
  return bestS / total;
}

export function MorphViewer({
  geometry,
  centerline,
  radii,
  station1,
  station2,
  ringRadiusM,
  pickMode,
  onPick,
  onPickStation,
  morphPreview,
}: {
  geometry: ArrayBuffer;
  centerline: Centerline | null;
  /** Wall radius (metres) at each centerline point (sizes the rings locally). */
  radii?: number[];
  /** The two ring positions as arc-length fractions (0..1), or null. */
  station1: number | null;
  station2: number | null;
  /** Mean wall radius (metres) - ring-size fallback when `radii` is absent. */
  ringRadiusM: number;
  /** What a mesh click does: pick the wall patch, place a ring, or orbit. */
  pickMode: 'patch' | 'c1' | 'c2' | null;
  /** Fired on a mesh click in 'patch' mode: the raw point + the clicked patch name. */
  onPick: (point: Vec3, patch: string | null) => void;
  /** Fired when a ring is placed/dragged: which ring + its arc-length fraction. */
  onPickStation: (which: 'c1' | 'c2', fraction: number) => void;
  /** When set, deform the surface to this diameter (else show the pristine mesh). */
  morphPreview: MorphPreview | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const onPickRef = useRef(onPick);
  const onPickStationRef = useRef(onPickStation);
  const pickModeRef = useRef(pickMode);
  const centerlineRef = useRef<Centerline | null>(centerline);
  const radiiRef = useRef<number[] | null>(radii ?? null);
  const station1Ref = useRef<number | null>(station1);
  const station2Ref = useRef<number | null>(station2);
  const ringRadiusRef = useRef(ringRadiusM);
  const previewRef = useRef<MorphPreview | null>(morphPreview);
  onPickRef.current = onPick;
  onPickStationRef.current = onPickStation;
  pickModeRef.current = pickMode;
  centerlineRef.current = centerline;
  radiiRef.current = radii ?? null;
  station1Ref.current = station1;
  station2Ref.current = station2;
  ringRadiusRef.current = ringRadiusM;
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
    renderer.domElement.style.cursor = 'grab';

    scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd3da, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 0.6);
    key.position.set(1, 1.4, 1.2);
    scene.add(key);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reduceMotion;
    controls.dampingFactor = 0.12;

    const meshRoot = new THREE.Group(); // raw-coord frame (baked flip neutralised)
    const overlay = new THREE.Group(); // axis + rings, also raw coords
    scene.add(meshRoot);
    scene.add(overlay);

    let disposed = false;
    let frameQueued = false;
    let rafId = 0;
    const renderFrame = () => {
      frameQueued = false;
      if (disposed) return; // a frame queued just before teardown must not render
      controls.update();
      renderer.render(scene, camera);
    };
    const requestRender = () => {
      if (disposed || frameQueued) return;
      frameQueued = true;
      rafId = requestAnimationFrame(renderFrame);
    };
    controls.addEventListener('change', requestRender);

    // Axis line + the two ring hoops (unit tori, scaled to the local wall radius).
    let axisLine: THREE.Line | null = null;
    // Rings are BLUE (deep A / light B) so they stand out from the ORANGE grow zone.
    const ringGeom = new THREE.TorusGeometry(1, 0.12, 12, 48);
    const ring1 = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({ color: primary.clone() }));
    const ring2 = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({ color: primaryLight.clone() }));
    ring1.visible = false;
    ring2.visible = false;
    ring1.renderOrder = 2;
    ring2.renderOrder = 2;
    overlay.add(ring1);
    overlay.add(ring2);

    const zoneColor = accent.clone();
    const tracked: Tracked[] = [];
    let arc: Arc | null = null;
    let fractionsFor: Centerline['points'] | null = null; // which points the fractions are for

    const fitView = () => {
      const box = new THREE.Box3().setFromObject(meshRoot);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const radius = sphere.radius || 1;
      const distance = radius / Math.sin((camera.fov * Math.PI) / 180 / 2);
      const dir = new THREE.Vector3(0.8, 0.5, 1).normalize();
      camera.position.copy(sphere.center).addScaledVector(dir, distance * 1.3);
      camera.near = radius / 100;
      camera.far = radius * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(sphere.center);
      controls.update();
      requestRender();
    };
    resetViewRef.current = fitView;

    /** Recompute each vertex's arc-length fraction (only when the axis changes). */
    const computeFractions = () => {
      const tmp = new THREE.Vector3();
      tracked.forEach((t) => {
        if (!arc) {
          t.fractions = null;
          return;
        }
        const n = t.positions.length / 3;
        const fr = new Float32Array(n);
        for (let i = 0; i < n; i += 1) {
          tmp.set(t.positions[3 * i], t.positions[3 * i + 1], t.positions[3 * i + 2]);
          fr[i] = projectFraction(arc, tmp);
        }
        t.fractions = fr;
      });
    };

    /** Tint the wall band between two fractions; the rest stays neutral. */
    const recolorZone = (lo: number | null, hi: number | null) => {
      const active = lo !== null && hi !== null && hi > lo;
      tracked.forEach((t) => {
        const attr = t.mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
        if (!attr) return;
        const arr = attr.array as Float32Array;
        const n = arr.length / 3;
        for (let i = 0; i < n; i += 1) {
          const inZone = active && t.fractions ? t.fractions[i] >= lo! && t.fractions[i] <= hi! : false;
          const c = inZone ? zoneColor : neutral;
          arr[3 * i] = c.r;
          arr[3 * i + 1] = c.g;
          arr[3 * i + 2] = c.b;
        }
        attr.needsUpdate = true;
      });
    };

    /** Move a ring to a fraction (position + orient + scale to the local wall). */
    const placeRing = (mesh: THREE.Mesh, fraction: number | null) => {
      if (!arc || fraction === null) {
        mesh.visible = false;
        return;
      }
      const f = frameAt(arc, fraction);
      const r =
        radiusAt(arc, radiiRef.current, fraction, Math.max(ringRadiusRef.current, 1e-4)) * RING_SCALE;
      mesh.position.copy(f.center);
      mesh.quaternion.setFromUnitVectors(AXIS_Z, f.tangent);
      mesh.scale.setScalar(r);
      mesh.visible = true;
    };

    /** Rebuild the axis line + reposition both rings + recolor the zone. */
    const syncOverlay = () => {
      const cl = centerlineRef.current;
      if (axisLine) {
        overlay.remove(axisLine);
        axisLine.geometry.dispose();
        (axisLine.material as THREE.Material).dispose();
        axisLine = null;
      }
      arc = cl && cl.points.length >= 2 ? buildArc(cl.points as Vec3[]) : null;
      if (arc && cl) {
        axisLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(arc.points),
          new THREE.LineBasicMaterial({ color: neutral.clone() }),
        );
        overlay.add(axisLine);
        // Recompute per-vertex fractions only when the axis itself changes (keyed on
        // the points array identity, not the wrapper object the parent recreates).
        if (cl.points !== fractionsFor) {
          computeFractions();
          fractionsFor = cl.points;
        }
      } else {
        fractionsFor = null;
      }
      placeRing(ring1, station1Ref.current);
      placeRing(ring2, station2Ref.current);
      const bothSet = station1Ref.current !== null && station2Ref.current !== null;
      recolorZone(
        bothSet ? Math.min(station1Ref.current!, station2Ref.current!) : null,
        bothSet ? Math.max(station1Ref.current!, station2Ref.current!) : null,
      );
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
          const p = morphPoint(
            [positions[i], positions[i + 1], positions[i + 2]],
            prep,
            preview.stationA,
            preview.stationB,
            preview.blend,
            ratio,
            preview.falloffStartM,
            preview.falloffEndM,
          );
          out[i] = p[0];
          out[i + 1] = p[1];
          out[i + 2] = p[2];
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
        const count = posAttr.count;
        const colors = new Float32Array(count * 3);
        for (let i = 0; i < count; i += 1) {
          colors[3 * i] = neutral.r;
          colors[3 * i + 1] = neutral.g;
          colors[3 * i + 2] = neutral.b;
        }
        mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        tracked.push({ mesh, positions: Float32Array.from(posAttr.array as Float32Array), fractions: null });
      });

      fitView();
      syncOverlay(); // computes the vertex fractions once the axis is known
      applyMorph();
    };
    try {
      loader.parse(geometry, '', onParsed, () => {});
    } catch {
      /* a bad GLB just leaves an empty canvas here (the setup form still works) */
    }

    // ---- pointer: orbit / click-to-place / grab-and-drag a ring -----------------
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downX = 0;
    let downY = 0;
    let dragging: 'c1' | 'c2' | null = null;
    let dragFraction = 0;

    const toPointer = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    };

    /** Fraction under the pointer: the mesh hit projected to the axis, else ray-nearest. */
    const fractionUnderPointer = (): number | null => {
      if (!arc) return null;
      const hit = raycaster
        .intersectObjects(meshRoot.children, true)
        .find((i) => (i.object as THREE.Mesh).isMesh);
      return hit ? projectFraction(arc, hit.point) : projectRayFraction(arc, raycaster.ray);
    };

    const onDown = (event: PointerEvent) => {
      downX = event.clientX;
      downY = event.clientY;
      toPointer(event);
      // Grab a ring? (takes priority over orbit / click-to-place)
      const ringHit = raycaster
        .intersectObjects([ring1, ring2].filter((r) => r.visible), false)
        .at(0);
      if (ringHit) {
        dragging = ringHit.object === ring1 ? 'c1' : 'c2';
        dragFraction = (dragging === 'c1' ? station1Ref.current : station2Ref.current) ?? 0;
        controls.enabled = false;
        renderer.domElement.style.cursor = 'grabbing';
        renderer.domElement.setPointerCapture(event.pointerId);
        return;
      }
      renderer.domElement.style.cursor = 'grabbing';
    };

    const onMove = (event: PointerEvent) => {
      if (!dragging) return;
      toPointer(event);
      const f = fractionUnderPointer();
      if (f === null) return;
      dragFraction = f;
      const mesh = dragging === 'c1' ? ring1 : ring2;
      placeRing(mesh, f);
      const other = (dragging === 'c1' ? station2Ref.current : station1Ref.current) ?? f;
      recolorZone(Math.min(f, other), Math.max(f, other));
      requestRender();
    };

    const onUp = (event: PointerEvent) => {
      if (dragging) {
        const which = dragging;
        dragging = null;
        controls.enabled = true;
        renderer.domElement.style.cursor = 'grab';
        try {
          renderer.domElement.releasePointerCapture(event.pointerId);
        } catch {
          /* pointer capture may already be gone */
        }
        onPickStationRef.current(which, dragFraction); // commit on release
        return;
      }
      renderer.domElement.style.cursor = 'grab';
      const dx = event.clientX - downX;
      const dy = event.clientY - downY;
      if (dx * dx + dy * dy > 36) return; // it was an orbit drag
      const mode = pickModeRef.current;
      if (!mode) return;
      toPointer(event);
      const hit = raycaster
        .intersectObjects(meshRoot.children, true)
        .find((i) => (i.object as THREE.Mesh).isMesh);
      if (!hit) return;
      if (mode === 'patch') {
        const patch = hit.object.name || hit.object.parent?.name || null;
        onPickRef.current([hit.point.x, hit.point.y, hit.point.z], patch);
        return;
      }
      if (!arc) return;
      onPickStationRef.current(mode, projectFraction(arc, hit.point));
    };

    // If the OS reclaims the pointer mid-drag (touch/pen), pointerup never fires:
    // abort the drag, re-enable orbit, and snap the ring back to its committed spot.
    const onCancel = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = null;
      controls.enabled = true;
      renderer.domElement.style.cursor = 'grab';
      try {
        renderer.domElement.releasePointerCapture(event.pointerId);
      } catch {
        /* capture may already be gone */
      }
      syncOverlay(); // discard the in-flight move
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
      (ring1.material as THREE.Material).dispose();
      (ring2.material as THREE.Material).dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        const line = object as THREE.Line;
        if (mesh.isMesh || line.isLine) mesh.geometry?.dispose?.();
        const material = (object as THREE.Mesh).material;
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

  // Redraw the axis + rings + zone highlight when the trace or ring positions change.
  useEffect(() => {
    syncOverlayRef.current();
  }, [centerline, radii, station1, station2, ringRadiusM]);

  // Re-deform the surface when the preview (diameter or committed zone) changes.
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
