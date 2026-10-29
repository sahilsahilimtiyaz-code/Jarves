/**
 * JarvisCore — the real WebGL centrepiece.
 *
 * A single Three.js scene (renderer → scene → meshes) driven by one
 * requestAnimationFrame loop. No geometry, material or listener is allocated
 * inside the loop; it reads live state from refs/store, not React props, so
 * audio levels never trigger React renders.
 *
 * States:
 *  idle      slow rings, drifting particles, sequential energy segments
 *  listening glow/particles/rings react to the real recognizer RMS level
 *  thinking  faster orbital sweep, brighter core, accelerated particles
 *  speaking  reacts to real TTS playback progress events
 *  offline   restrained desaturated dim scene
 *
 * Resource discipline: all GPU resources are disposed on unmount, the loop
 * stops when the page is hidden (and resumes on return), and low-power mode
 * lowers pixel ratio + particle draw range without rebuilding the scene.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useStore, type OrbState } from "../lib/store";
import { voicePipeline } from "../lib/voicePipeline";

export interface JarvisCoreProps {
  state: OrbState;
  offline?: boolean;
  lowPower?: boolean;
  accent?: "cyan" | "violet";
  className?: string;
}

const ACCENTS: Record<"cyan" | "violet", { core: number; ring: number; particle: number }> = {
  cyan: { core: 0xbfefff, ring: 0x7dd3fc, particle: 0xa5f3fc },
  violet: { core: 0xe6dcff, ring: 0xa78bfa, particle: 0xc4b5fd },
};

const OFFLINE = { core: 0x7f93a8, ring: 0x54677c, particle: 0x62788f };

const CORE_VERTEX = `
uniform float uTime;
uniform float uLevel;
uniform float uEnergy;
varying vec3 vNormal;
varying vec3 vView;
varying float vPulse;

float wave(vec3 p, float t) {
  return sin(p.x * 2.7 + t * 1.15) * sin(p.y * 3.1 - t * 0.85) * sin(p.z * 2.4 + t * 1.05);
}

void main() {
  float w = wave(normalize(position), uTime);
  vec3 displaced = position + normal * w * (0.028 + uLevel * 0.10 + uEnergy * 0.045);
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  vPulse = w;
  gl_Position = projectionMatrix * mv;
}
`;

const CORE_FRAGMENT = `
uniform vec3 uColor;
uniform vec3 uGlow;
uniform float uLevel;
uniform float uEnergy;
uniform float uOpacity;
varying vec3 vNormal;
varying vec3 vView;
varying float vPulse;

void main() {
  float facing = max(dot(vNormal, vView), 0.0);
  float fresnel = pow(1.0 - facing, 2.1);
  vec3 color = mix(uColor, uGlow, clamp(fresnel * 1.2, 0.0, 1.0));
  color += uColor * max(vPulse, 0.0) * 0.22;
  float alpha = (0.16 + fresnel * 0.95 + uEnergy * 0.12 + uLevel * 0.18) * uOpacity;
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
`;

const SEGMENT_FRAGMENT = `
uniform float uTime;
uniform float uLevel;
uniform float uEnergy;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float angle = atan(p.y, p.x);
  float index = floor((angle / 6.2831853 + 0.5) * 96.0);
  float pulse = smoothstep(0.72, 1.0, sin(uTime * 1.5 + index * 0.62) * 0.5 + 0.5);
  float band = smoothstep(0.018, 0.0, abs(r - 0.80)) + smoothstep(0.012, 0.0, abs(r - 0.74));
  float intensity = band * (0.16 + pulse * (0.42 + uLevel * 0.9 + uEnergy * 0.5));
  if (band < 0.001) discard;
  gl_FragColor = vec4(uColor, clamp(intensity * uOpacity, 0.0, 1.0));
}
`;

const HALO_FRAGMENT = `
uniform vec3 uColor;
uniform float uLevel;
uniform float uOpacity;
varying vec2 vUv;

void main() {
  float d = length(vUv - 0.5) * 2.0;
  float glow = smoothstep(1.0, 0.0, d);
  float alpha = pow(glow, 2.4) * (0.30 + uLevel * 0.55) * uOpacity;
  gl_FragColor = vec4(uColor, alpha);
}
`;

const BASIC_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PARTICLE_COUNT = 760;
const LOW_POWER_PARTICLES = 280;

export default function JarvisCore({
  state,
  offline = false,
  lowPower = false,
  accent = "cyan",
  className,
}: JarvisCoreProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const reducedMotionRef = useRef(false);

  const live = useRef({ state, offline, lowPower, accent });
  live.current = { state, offline, lowPower, accent };

  useEffect(() => {
    const mq =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    if (!mq) return;
    const apply = () => {
      reducedMotionRef.current = mq.matches;
    };
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch (e) {
      console.warn("[JarvisCore] WebGL unavailable", e);
      setFailed(true);
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 60);
    camera.position.set(0, 0.08, 5.1);

    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, live.current.lowPower ? 1 : 2));
    renderer.domElement.setAttribute("aria-hidden", "true");
    host.appendChild(renderer.domElement);

    // ── Halo (cheap radial glow behind the core) ──────────────────────────
    const haloUniforms = {
      uColor: { value: new THREE.Color(ACCENTS.cyan.ring) },
      uLevel: { value: 0 },
      uOpacity: { value: 1 },
    };
    const haloGeometry = new THREE.PlaneGeometry(6.4, 6.4);
    const haloMaterial = new THREE.ShaderMaterial({
      uniforms: haloUniforms,
      vertexShader: BASIC_VERTEX,
      fragmentShader: HALO_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Mesh(haloGeometry, haloMaterial);
    halo.position.z = -1.1;
    scene.add(halo);

    // ── Core sphere with live displacement/normal glow ────────────────────
    const coreUniforms = {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uEnergy: { value: 0 },
      uOpacity: { value: 1 },
      uColor: { value: new THREE.Color(ACCENTS.cyan.core) },
      uGlow: { value: new THREE.Color(ACCENTS.cyan.ring) },
    };
    const coreGeometry = new THREE.IcosahedronGeometry(0.72, 4);
    const coreMaterial = new THREE.ShaderMaterial({
      uniforms: coreUniforms,
      vertexShader: CORE_VERTEX,
      fragmentShader: CORE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const core = new THREE.Mesh(coreGeometry, coreMaterial);
    scene.add(core);

    const wireGeometry = new THREE.IcosahedronGeometry(0.735, 2);
    const wireMaterial = new THREE.MeshBasicMaterial({
      color: ACCENTS.cyan.ring,
      wireframe: true,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const wire = new THREE.Mesh(wireGeometry, wireMaterial);
    scene.add(wire);

    // ── Orbital rings (different radii / tilts / speeds) ──────────────────
    const ringDefs = [
      { radius: 0.98, tube: 0.0045, tiltX: 0.9, tiltY: 0.12, speed: 0.42, opacity: 0.72 },
      { radius: 1.18, tube: 0.0035, tiltX: -0.52, tiltY: 0.42, speed: -0.31, opacity: 0.55 },
      { radius: 1.34, tube: 0.005, tiltX: 0.2, tiltY: -0.62, speed: 0.22, opacity: 0.4 },
      { radius: 1.52, tube: 0.0025, tiltX: 1.22, tiltY: 0.7, speed: -0.16, opacity: 0.3 },
      { radius: 0.86, tube: 0.003, tiltX: 0.3, tiltY: 0.2, speed: 0.68, opacity: 0.5 },
    ];
    const rings = ringDefs.map((def) => {
      const geometry = new THREE.TorusGeometry(def.radius, def.tube, 6, 220);
      const material = new THREE.MeshBasicMaterial({
        color: ACCENTS.cyan.ring,
        transparent: true,
        opacity: def.opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.x = def.tiltX;
      mesh.rotation.y = def.tiltY;
      scene.add(mesh);
      return { mesh, def };
    });

    // ── Segmented energy ring (single shader plane, 96 segments) ──────────
    const segmentUniforms = {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uEnergy: { value: 0 },
      uOpacity: { value: 1 },
      uColor: { value: new THREE.Color(ACCENTS.cyan.ring) },
    };
    const segmentGeometry = new THREE.PlaneGeometry(4.2, 4.2);
    const segmentMaterial = new THREE.ShaderMaterial({
      uniforms: segmentUniforms,
      vertexShader: BASIC_VERTEX,
      fragmentShader: SEGMENT_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const segments = new THREE.Mesh(segmentGeometry, segmentMaterial);
    segments.position.z = -0.02;
    scene.add(segments);

    // ── Orbiting particles (positions generated once) ─────────────────────
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const seeds = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const radius = 1.05 + Math.random() * 1.55;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi) * 0.72;
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
      seeds[i] = Math.random();
    }
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const particleMaterial = new THREE.PointsMaterial({
      color: ACCENTS.cyan.particle,
      size: 0.021,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
    });
    const particles = new THREE.Points(particleGeometry, particleMaterial);
    particleGeometry.setDrawRange(0, lowPower ? LOW_POWER_PARTICLES : PARTICLE_COUNT);
    scene.add(particles);

    const particleHolder = new THREE.Group();
    particleHolder.add(particles);
    scene.add(particleHolder);

    // ── Render loop ───────────────────────────────────────────────────────
    const clock = new THREE.Clock();
    let raf = 0;
    let running = false;
    let level = 0;
    let energy = 0;
    let opacity = 1;
    const colorCore = new THREE.Color(ACCENTS.cyan.core);
    const colorRing = new THREE.Color(ACCENTS.cyan.ring);
    const colorParticle = new THREE.Color(ACCENTS.cyan.particle);
    const targetCore = new THREE.Color();
    const targetRing = new THREE.Color();
    const targetParticle = new THREE.Color();

    const frame = () => {
      if (!running) return;
      const dt = Math.min(clock.getDelta(), 0.05);
      const elapsed = clock.elapsedTime;
      const { state: orbState, offline: isOffline, lowPower: isLow, accent: accentName } = live.current;

      const liveLevel = Math.max(
        useStore.getState().audioLevel,
        voicePipeline.getSnapshot().level,
      );
      const targetLevel = Math.max(0, Math.min(1, liveLevel));
      level += (targetLevel - level) * Math.min(1, dt * 9);

      const targetEnergy =
        orbState === "thinking" ? 1 : orbState === "speaking" ? 0.72 : orbState === "listening" ? 0.45 : 0.16;
      energy += (targetEnergy - energy) * Math.min(1, dt * 3.2);

      const targetOpacity = isOffline ? 0.34 : 1;
      opacity += (targetOpacity - opacity) * Math.min(1, dt * 2.4);

      const palette = isOffline ? OFFLINE : ACCENTS[accentName] || ACCENTS.cyan;
      targetCore.setHex(palette.core);
      targetRing.setHex(palette.ring);
      targetParticle.setHex(palette.particle);
      const blend = Math.min(1, dt * 4);
      colorCore.lerp(targetCore, blend);
      colorRing.lerp(targetRing, blend);
      colorParticle.lerp(targetParticle, blend);

      coreUniforms.uColor.value.copy(colorCore);
      coreUniforms.uGlow.value.copy(colorRing);
      coreUniforms.uTime.value = elapsed;
      coreUniforms.uLevel.value = level;
      coreUniforms.uEnergy.value = isOffline ? 0.04 : energy;
      coreUniforms.uOpacity.value = opacity;

      wireMaterial.color.copy(colorRing);
      wireMaterial.opacity = (0.08 + energy * 0.14 + level * 0.1) * opacity;

      haloUniforms.uColor.value.copy(colorRing);
      haloUniforms.uLevel.value = level;
      haloUniforms.uOpacity.value = opacity;

      segmentUniforms.uColor.value.copy(colorRing);
      segmentUniforms.uTime.value = elapsed;
      segmentUniforms.uLevel.value = level;
      segmentUniforms.uEnergy.value = isOffline ? 0 : energy;
      segmentUniforms.uOpacity.value = opacity;

      particleMaterial.color.copy(colorParticle);
      particleMaterial.opacity = (0.4 + level * 0.4 + energy * 0.2) * opacity;
      particleGeometry.setDrawRange(
        0,
        isLow ? LOW_POWER_PARTICLES : PARTICLE_COUNT,
      );

      const motion = reducedMotionRef.current ? 0.18 : 1;
      const baseSpeed =
        (orbState === "thinking" ? 2.35 : orbState === "speaking" ? 1.55 : orbState === "listening" ? 1.2 : 0.55) *
        motion;
      for (const { mesh, def } of rings) {
        mesh.rotation.z += dt * def.speed * baseSpeed;
        mesh.rotation.x += dt * 0.035 * baseSpeed;
      }
      core.rotation.y += dt * 0.16 * baseSpeed;
      core.rotation.x = Math.sin(elapsed * 0.24) * 0.09;
      wire.rotation.copy(core.rotation);
      wire.scale.setScalar(1 + level * 0.03);
      core.scale.setScalar(1 + level * 0.055 + energy * 0.02);

      particleHolder.rotation.y += dt * 0.075 * baseSpeed;
      particleHolder.rotation.x = Math.sin(elapsed * 0.14) * 0.16;
      particles.rotation.z += dt * 0.02 * baseSpeed;

      // A slow vertical drift gives the particle shell depth without cost.
      particles.position.y = Math.sin(elapsed * 0.4) * (0.03 + level * 0.05);

      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, live.current.lowPower ? 1 : 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    const start = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      stop();
    };
    const onContextRestored = () => {
      resize();
      start();
    };

    renderer.domElement.addEventListener("webglcontextlost", onContextLost);
    renderer.domElement.addEventListener("webglcontextrestored", onContextRestored);
    document.addEventListener("visibilitychange", onVisibility);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(resize);
      observer.observe(host);
    } else {
      window.addEventListener("resize", resize);
    }

    resize();
    if (document.visibilityState !== "hidden") start();

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      renderer.domElement.removeEventListener("webglcontextrestored", onContextRestored);
      if (observer) observer.disconnect();
      else window.removeEventListener("resize", resize);

      // Deterministic GPU cleanup — no leaks across tab/screen changes.
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = (mesh as any).material;
        if (Array.isArray(material)) material.forEach((m: THREE.Material) => m.dispose());
        else if (material) material.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss?.();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
    // Scene is built once; state/theme/low-power changes flow through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stateLabel =
    failed
      ? "WEBGL UNAVAILABLE"
      : offline
        ? "OFFLINE"
        : state === "listening"
          ? "LISTENING"
          : state === "thinking"
            ? "PROCESSING"
            : state === "speaking"
              ? "SPEAKING"
              : "STANDBY";

  return (
    <div ref={hostRef} className={`m-core ${className ?? ""}`} data-state={state} data-offline={offline}>
      {failed && (
        <div className="m-core-fallback">
          <div className="dial" />
        </div>
      )}
      <div className="m-core-overlay">
        <span className="m-core-state">{stateLabel}</span>
        <span className="m-core-meter" aria-hidden>
          <i data-meter style={{ width: "0%" }} />
        </span>
      </div>
    </div>
  );
}

/**
 * Small hook used by the overlay meter so the bar tracks the live level
 * without re-rendering the whole screen.
 */
export function useCoreMeter(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = 0;
    const tick = (time: number) => {
      const host = ref.current;
      if (host) {
        const bar = host.querySelector<HTMLElement>("[data-meter]");
        if (bar && time - last > 60) {
          last = time;
          const level = Math.max(useStore.getState().audioLevel, voicePipeline.getSnapshot().level);
          bar.style.width = `${Math.round(Math.max(0, Math.min(1, level)) * 100)}%`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ref, active]);
}
