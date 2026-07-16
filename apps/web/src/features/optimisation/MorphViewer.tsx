import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { morphPoint, prepareCenterline, type Centerline } from '@dive/shared';
import { bakedRootTransform } from '@/features/assemble/placement';

/**
 * MorphViewer - the 3D stage of the Optimisation setup: the translucent case mesh,
 * the fitted channel axis, TWO cross-section circles the user positions along it, and
 * a LIVE preview of the mesh morph in the zone BETWEEN the two circles.
 *
 * Coordinate frame: extractPatches exports points with process=False, so each mesh's
 * LOCAL geometry vertices ARE the raw polyMesh coords. Neutralising the GLB's baked
 * Z-up->Y-up flip (a wrapper group with the inverse of bakedRootTransform, the same
 * trick as the Assemble viewer) makes the rendered world frame == raw coords, so a
 * raycast hit is a raw point, the axis/circles are placed in raw coords, and applying
 * the SHARED morphPoint to the local vertices previews exactly what the server bakes.
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

/** Position + local tangent at an arc-length fraction of the polyline. */
function frame(arc: Arc, fraction: number): { center: THREE.Vector3; tangent: THREE.Vector3 } {
  const { points, cum, total } = arc;
  if (points.length === 0) return { center: new THREE.Vector3(), tangent: new THREE.Vector3(0, 0, 1) };
  const s = Math.max(0, Math.min(1, fraction)) * total;
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < s) i += 1;
  const next = points[i + 1] ?? points[i];
  const seg = (cum[i + 1] ?? cum[i]) - cum[i] || 1;
  const t = (s - cum[i]) / seg;
  const center = points[i].clone().lerp(next, t);
  const tangent = next.clone().sub(points[i]);
  if (tangent.lengthSq() === 0) tangent.set(0, 0, 1);
  return { center, tangent: tangent.normalize() };
}

/** A circle (as a closed line) perpendicular to `tangent`, centred at `center`. */
function circleGeometry(center: THREE.Vector3, tangent: THREE.Vector3, radius: number): THREE.BufferGeometry {
  const up = Math.abs(tangent.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const e1 = new THREE.Vector3().crossVectors(tangent, up).normalize();
  const e2 = new THREE.Vector3().crossVectors(tangent, e1).normalize();
  const pts: THREE.Vector3[] = [];
  const R = radius * 1.12; // a touch larger than the wall so the ring reads clearly
  for (let k = 0; k <= 48; k += 1) {
    const th = (k / 48) * Math.PI * 2;
    pts.push(center.clone().addScaledVector(e1, R * Math.cos(th)).addScaledVector(e2, R * Math.sin(th)));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

/** Arc-length fraction of the polyline point nearest `point`. */
function projectFraction(arc: Arc, point: THREE.Vector3): number {
  const { points, cum, total } = arc;
  if (total <= 0) return 0;
  let bestD2 = Infinity;
  let bestS = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const d = points[i + 1].clone().sub(a);
    const seg2 = d.dot(d);
    let t = seg2 > 0 ? point.clone().sub(a).dot(d) / seg2 : 0;
    t = Math.max(0, Math.min(1, t));
    const foot = a.clone().addScaledVector(d, t);
    const d2 = foot.distanceToSquared(point);
    if (d2 < bestD2) {
      bestD2 = d2;
      bestS = cum[i] + t * Math.sqrt(seg2);
    }
  }
  return bestS / total;
}

export function MorphViewer({
  geometry,
  centerline,
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
  /** Cross-section circle positions as arc-length fractions (0..1), or null. */
  station1: number | null;
  station2: number | null;
  /** Radius (metres) to draw the circles at. */
  ringRadiusM: number;
  /** What the next mesh click does: pick the wall patch, or place a circle, or orbit. */
  pickMode: 'patch' | 'c1' | 'c2' | null;
  /** Fired on a mesh click in 'patch' mode: the raw point + the clicked patch name. */
  onPick: (point: Vec3, patch: string | null) => void;
  /** Fired on a mesh click in 'c1'/'c2' mode: the arc-length fraction of the click. */
  onPickStation: (which: 'c1' | 'c2', fraction: number) => void;
  /** When set, deform the surface to this diameter (else show the pristine mesh). */
  morphPreview: MorphPreview | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const onPickRef = useRef(onPick);
  const onPickStationRef = useRef(onPickStation);
  const pickModeRef = useRef(pickMode);
  const centerlineRef = useRef<Centerline | null>(centerline);
  const station1Ref = useRef<number | null>(station1);
  const station2Ref = useRef<number | null>(station2);
  const ringRadiusRef = useRef(ringRadiusM);
  const previewRef = useRef<MorphPreview | null>(morphPreview);
  onPickRef.current = onPick;
  onPickStationRef.current = onPickStation;
  pickModeRef.current = pickMode;
  centerlineRef.current = centerline;
  station1Ref.current = station1;
  station2Ref.current = station2;
  ringRadiusRef.current = ringRadiusM;
  previewRef.current = morphPreview;

  const requestRenderRef = useRef<() => void>(() => {});
  const resetViewRef = useRef<() => void>(() => {});
  const syncOverlayRef = useRef<() => void>(() => {});
  const applyMorphRef = useRef<() => void>(() => {});

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const primary = new THREE.Color(readToken('--color-primary', '#004a99'));
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
    const overlay = new THREE.Group(); // axis + circles, also raw coords
    scene.add(meshRoot);
    scene.add(overlay);

    let disposed = false;
    let frameQueued = false;
    const renderFrame = () => {
      frameQueued = false;
      controls.update();
      renderer.render(scene, camera);
    };
    const requestRender = () => {
      if (disposed || frameQueued) return;
      frameQueued = true;
      requestAnimationFrame(renderFrame);
    };
    requestRenderRef.current = requestRender;
    controls.addEventListener('change', requestRender);

    let axisLine: THREE.Line | null = null;
    const ring1 = new THREE.Group();
    const ring2 = new THREE.Group();
    overlay.add(ring1);
    overlay.add(ring2);
    const ring1Mat = new THREE.LineBasicMaterial({ color: accent.clone() });
    const ring2Mat = new THREE.LineBasicMaterial({ color: primary.clone() });
    const pristine: { mesh: THREE.Mesh; positions: Float32Array }[] = [];

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

    const disposeGroup = (g: THREE.Group) => {
      g.children.forEach((c) => (c as THREE.Line).geometry?.dispose?.());
      g.clear();
    };

    const syncOverlay = () => {
      const cl = centerlineRef.current;
      // axis polyline
      if (axisLine) {
        overlay.remove(axisLine);
        axisLine.geometry.dispose();
        (axisLine.material as THREE.Material).dispose();
        axisLine = null;
      }
      disposeGroup(ring1);
      disposeGroup(ring2);
      if (cl && cl.points.length >= 2) {
        const arc = buildArc(cl.points as Vec3[]);
        axisLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(arc.points),
          new THREE.LineBasicMaterial({ color: neutral.clone() }),
        );
        overlay.add(axisLine);
        const r = Math.max(ringRadiusRef.current || 0, 1e-6);
        const draw = (group: THREE.Group, station: number | null, mat: THREE.LineBasicMaterial) => {
          if (station === null) return;
          const f = frame(arc, station);
          group.add(new THREE.Line(circleGeometry(f.center, f.tangent, r), mat));
        };
        draw(ring1, station1Ref.current, ring1Mat);
        draw(ring2, station2Ref.current, ring2Mat);
      }
      requestRender();
    };
    syncOverlayRef.current = syncOverlay;

    const applyMorph = () => {
      if (pristine.length === 0) return;
      const preview = previewRef.current;
      const cl = centerlineRef.current;
      const active = preview && cl && cl.points.length >= 2 && preview.baselineDiameterM > 0;
      if (!active) {
        pristine.forEach(({ mesh, positions }) => {
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
      pristine.forEach(({ mesh, positions }) => {
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
          color: neutral.clone(),
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
        });
        const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
        pristine.push({ mesh, positions: Float32Array.from(attr.array as Float32Array) });
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

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downX = 0;
    let downY = 0;
    const onDown = (event: PointerEvent) => {
      downX = event.clientX;
      downY = event.clientY;
      renderer.domElement.style.cursor = 'grabbing';
    };
    const onUp = (event: PointerEvent) => {
      renderer.domElement.style.cursor = 'grab';
      const dx = event.clientX - downX;
      const dy = event.clientY - downY;
      if (dx * dx + dy * dy > 36) return; // it was an orbit drag
      const mode = pickModeRef.current;
      if (!mode) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster
        .intersectObjects(meshRoot.children, true)
        .find((i) => (i.object as THREE.Mesh).isMesh);
      if (!hit) return;
      if (mode === 'patch') {
        const patch = hit.object.name || hit.object.parent?.name || null;
        onPickRef.current([hit.point.x, hit.point.y, hit.point.z], patch);
        return;
      }
      // c1 / c2: project the click onto the axis and report its fraction.
      const cl = centerlineRef.current;
      if (!cl || cl.points.length < 2) return;
      const fraction = projectFraction(buildArc(cl.points as Vec3[]), hit.point);
      onPickStationRef.current(mode, fraction);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

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
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      controls.dispose();
      ring1Mat.dispose();
      ring2Mat.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        const line = object as THREE.Line;
        if (mesh.isMesh || line.isLine) mesh.geometry?.dispose?.();
        const material = (object as THREE.Mesh).material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
      requestRenderRef.current = () => {};
      resetViewRef.current = () => {};
      syncOverlayRef.current = () => {};
      applyMorphRef.current = () => {};
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [geometry]);

  // Redraw the axis + circles when the trace or the circle positions change.
  useEffect(() => {
    syncOverlayRef.current();
  }, [centerline, station1, station2, ringRadiusM]);

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
