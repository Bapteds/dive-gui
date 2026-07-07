import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Box, Loader2, Maximize, MonitorX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getStlBuffer } from '@/lib/api/meshing';
import type { StlFile } from '@/lib/api/types';

/**
 * StlViewer - a client-side three.js preview of a session's uploaded STL
 * surfaces. Unlike the polyMesh viewer this needs NO backend render: the raw STL
 * bytes are fetched and parsed with STLLoader in the browser, so a surface shows
 * instantly (even on a machine with no OpenFOAM toolchain). It shares the
 * Visualize tab's light "studio" stage and token-driven materials so the two
 * viewers read as one system.
 */

/** Read a brand token (a hex color) off the document root. */
function readToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Detect WebGL support once (jsdom / locked-down browsers have none). */
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

export function StlViewer({ sessionId, stls }: { sessionId: string; stls: StlFile[] }) {
  const webglAvailable = useMemo(detectWebgl, []);
  const names = useMemo(() => stls.map((s) => s.name).sort(), [stls]);

  // Fetch every STL's bytes once; keyed by the (sorted) name set so adding or
  // removing a surface refetches. Each buffer is parsed client-side below.
  const buffers = useQuery<{ name: string; buffer: ArrayBuffer }[]>({
    queryKey: ['meshing', sessionId, 'stlBuffers', names.join('|')],
    queryFn: async () =>
      Promise.all(
        names.map(async (name) => ({ name, buffer: await getStlBuffer(sessionId, name) })),
      ),
    enabled: names.length > 0 && webglAvailable,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <section
      aria-label="STL surface preview"
      className="relative flex min-h-[45vh] flex-1 overflow-hidden rounded-md border border-border bg-surface shadow-sm lg:min-h-0"
    >
      {!webglAvailable ? (
        <StageMessage
          icon={<MonitorX className="size-6 text-text-secondary" strokeWidth={1.5} aria-hidden="true" />}
          title="3D rendering isn't available"
          body="Your browser doesn't support WebGL, so the surface can't be shown here."
        />
      ) : names.length === 0 ? (
        <StageMessage
          icon={<Box className="size-6 text-primary" strokeWidth={1.5} aria-hidden="true" />}
          title="No surface yet"
          body="Upload an STL surface to preview it here before meshing."
        />
      ) : buffers.isPending ? (
        <StageMessage
          icon={<Loader2 className="size-6 animate-spin text-primary" strokeWidth={1.75} aria-hidden="true" />}
          title="Loading surface"
          body="Reading the STL geometry."
        />
      ) : buffers.isError || !buffers.data ? (
        <StageMessage
          icon={<MonitorX className="size-6 text-danger" strokeWidth={1.5} aria-hidden="true" />}
          title="Could not read the surface"
          body="The STL file could not be loaded."
        />
      ) : (
        <StlScene surfaces={buffers.data} />
      )}
    </section>
  );
}

function StlScene({ surfaces }: { surfaces: { name: string; buffer: ArrayBuffer }[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resetViewRef = useRef<() => void>(() => {});

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const neutral = new THREE.Color(readToken('--color-neutral', '#bcbdbf'));
    const edgeColor = new THREE.Color(readToken('--color-text', '#1a2230'));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
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

    const root = new THREE.Group();
    scene.add(root);

    // --- on-demand rendering: draw only when something changes ---
    let disposed = false;
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
    controls.addEventListener('change', requestRender);

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

    // Parse every STL and add its surface (neutral fill + subtle feature edges).
    const loader = new STLLoader();
    const disposables: Array<THREE.BufferGeometry | THREE.Material> = [];
    for (const surface of surfaces) {
      let geometry: THREE.BufferGeometry;
      try {
        geometry = loader.parse(surface.buffer);
      } catch {
        continue;
      }
      geometry.computeVertexNormals();
      const material = new THREE.MeshLambertMaterial({
        color: neutral.clone(),
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = surface.name;

      // A light feature-edge overlay reads the surface topology without a full grid.
      const edgeGeometry = new THREE.EdgesGeometry(geometry, 30);
      const edgeMaterial = new THREE.LineBasicMaterial({ color: edgeColor.clone(), transparent: true, opacity: 0.22 });
      mesh.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));

      root.add(mesh);
      disposables.push(geometry, material, edgeGeometry, edgeMaterial);
    }

    fitView();
    requestRender();

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
      controls.dispose();
      disposables.forEach((item) => item.dispose());
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [surfaces]);

  return (
    <div className="absolute inset-0">
      <div
        ref={containerRef}
        className="size-full"
        style={{
          background:
            'radial-gradient(120% 120% at 50% 35%, var(--color-surface) 0%, var(--color-bg) 78%)',
        }}
      />
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

/** A centered icon + message filling the stage (loading / empty / WebGL states). */
function StageMessage({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
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

export default StlViewer;
