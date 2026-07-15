import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { morphPoint, prepareCenterline, type Centerline } from '@dive/shared';
import { bakedRootTransform } from '@/features/assemble/placement';

/**
 * MorphViewer - a 3D view of the case mesh for the Optimisation setup: shows where
 * the two diameter endpoints sit, the traced centerline, and a LIVE preview of the
 * mesh morph at a candidate diameter.
 *
 * Coordinate frame: the GLB carries a baked Z-up->Y-up flip, but extractPatches
 * exports points with process=False, so each mesh's LOCAL geometry vertices ARE the
 * raw polyMesh coords. Neutralising the flip (a wrapper group with the inverse of
 * bakedRootTransform, the same trick as the Assemble viewer) makes the rendered world
 * frame == raw coords, so a raycast hit is a raw endpoint, overlaid markers/centerline
 * are placed in raw coords, and applying the SHARED morphPoint to the local vertices
 * previews exactly what the server bakes. No dependency on react-three-fiber.
 */

type Vec3 = [number, number, number];

interface MorphPreview {
  baselineDiameterM: number;
  diameterM: number;
  stationA: number;
  stationB: number;
  blend: number;
}

function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function MorphViewer({
  geometry,
  endpointA,
  endpointB,
  pickMode,
  onPick,
  centerline,
  morphPreview,
}: {
  geometry: ArrayBuffer;
  endpointA: Vec3;
  endpointB: Vec3;
  /** Which endpoint the next mesh click sets, or null (orbit only). */
  pickMode: 'A' | 'B' | null;
  onPick: (which: 'A' | 'B', point: Vec3) => void;
  centerline: Centerline | null;
  /** When set, deform the surface to this diameter (else show the pristine mesh). */
  morphPreview: MorphPreview | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Latest props read inside imperative handlers / stored callbacks without rebuilding.
  const onPickRef = useRef(onPick);
  const pickModeRef = useRef(pickMode);
  const aRef = useRef(endpointA);
  const bRef = useRef(endpointB);
  const centerlineRef = useRef<Centerline | null>(centerline);
  const previewRef = useRef<MorphPreview | null>(morphPreview);
  onPickRef.current = onPick;
  pickModeRef.current = pickMode;
  aRef.current = endpointA;
  bRef.current = endpointB;
  centerlineRef.current = centerline;
  previewRef.current = morphPreview;

  // Imperative hooks wired up inside the scene effect, called from prop effects.
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
    const key = new THREE.DirectionalLight(0xffffff, 0.6);
    key.position.set(1, 1.4, 1.2);
    scene.add(key);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reduceMotion;
    controls.dampingFactor = 0.12;

    const meshRoot = new THREE.Group(); // raw-coord frame (baked flip neutralised)
    const overlay = new THREE.Group(); // markers + centerline, also raw coords
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

    // Persistent scene handles.
    let markerA: THREE.Mesh | null = null;
    let markerB: THREE.Mesh | null = null;
    let centerlineLine: THREE.Line | null = null;
    const pristine: { mesh: THREE.Mesh; positions: Float32Array }[] = [];
    let markerRadius = 1;

    const fitView = () => {
      const box = new THREE.Box3().setFromObject(meshRoot);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const radius = sphere.radius || 1;
      markerRadius = radius * 0.02;
      const distance = radius / Math.sin((camera.fov * Math.PI) / 180 / 2);
      const dir = new THREE.Vector3(0.8, 0.5, 1).normalize();
      camera.position.copy(sphere.center).addScaledVector(dir, distance * 1.3);
      camera.near = radius / 100;
      camera.far = radius * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(sphere.center);
      controls.update();
      markerA?.scale.setScalar(markerRadius);
      markerB?.scale.setScalar(markerRadius);
      requestRender();
    };
    resetViewRef.current = fitView;

    const syncOverlay = () => {
      if (markerA) markerA.position.set(...aRef.current);
      if (markerB) markerB.position.set(...bRef.current);
      if (centerlineLine) {
        overlay.remove(centerlineLine);
        centerlineLine.geometry.dispose();
        (centerlineLine.material as THREE.Material).dispose();
        centerlineLine = null;
      }
      const cl = centerlineRef.current;
      if (cl && cl.points.length >= 2) {
        const geom = new THREE.BufferGeometry().setFromPoints(
          cl.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
        );
        centerlineLine = new THREE.Line(
          geom,
          new THREE.LineBasicMaterial({ color: accent.clone() }),
        );
        overlay.add(centerlineLine);
      }
      requestRender();
    };
    syncOverlayRef.current = syncOverlay;

    const applyMorph = () => {
      if (pristine.length === 0) return;
      const preview = previewRef.current;
      const cl = centerlineRef.current;
      const active =
        preview && cl && cl.points.length >= 2 && preview.baselineDiameterM > 0;
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

      // Neutralise the baked flip -> meshRoot's world frame == raw polyMesh coords.
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
          opacity: 0.4,
          depthWrite: false,
        });
        const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
        pristine.push({ mesh, positions: Float32Array.from(attr.array as Float32Array) });
      });

      const sphereGeom = new THREE.SphereGeometry(1, 20, 16);
      markerA = new THREE.Mesh(sphereGeom, new THREE.MeshBasicMaterial({ color: accent.clone() }));
      markerB = new THREE.Mesh(sphereGeom, new THREE.MeshBasicMaterial({ color: primary.clone() }));
      overlay.add(markerA);
      overlay.add(markerB);

      fitView();
      syncOverlay();
      applyMorph();
    };
    try {
      loader.parse(geometry, '', onParsed, () => {});
    } catch {
      /* a bad GLB just leaves an empty canvas here (the setup form still works) */
    }

    // Pick: a click (not a drag) on the mesh sets the active endpoint in raw coords.
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
      onPickRef.current(mode, [hit.point.x, hit.point.y, hit.point.z]);
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

  // Move the markers + redraw the centerline when the endpoints or trace change.
  useEffect(() => {
    syncOverlayRef.current();
  }, [endpointA, endpointB, centerline]);

  // Re-deform the surface when the preview diameter (or the trace) changes.
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
