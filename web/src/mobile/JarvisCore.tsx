/**
 * JarvisCore — "JARVIS NEURAL CORE · LIVING INTELLIGENCE"
 *
 * A real Three.js composition, not a spinning texture. One scene, one
 * requestAnimationFrame loop, zero allocations per frame.
 *
 * Layers (back → front)
 *  1. halo            additive radial falloff plane
 *  2. instrument ring fine radial ticks + three orbital brackets
 *  3. bloom           volumetric rays / lens rings / sparkle
 *  4. dust            very faint deep-space points
 *  5. neural field    sharp particles + static connection lines (a network)
 *  6. drifters        particles leaving the shell and fading out (GPU-driven)
 *  7. orbits          three thin inclined ellipses + travelling particles + pulses
 *  8. nucleus         additive luminous centre
 *  9. volume          shaded sphere with flowing filaments + violet bands
 * 10. streams         additive energy bands moving through the volume
 * 11. membrane        thin Fresnel shell, surface detail, touch ripple
 *
 * State honesty: reading/listening/thinking/speaking drive the animation only
 * from the real store/voice-pipeline values. The microphone level is the
 * recogniser's RMS; it is never generated.
 *
 * Performance: delta-time motion, DPR capped per quality tier, adaptive
 * downgrade from measured frame rate, off-screen and backgrounded pause,
 * GPU resource disposal, WebGL context-loss recovery and a CSS fallback.
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

interface Palette {
  deep: number;
  body: number;
  flow: number;
  violet: number;
  rim: number;
  nucleus: number;
  orbit: number;
  dust: number;
}

const PALETTES: Record<"cyan" | "violet", Palette> = {
  cyan: {
    deep: 0x02070e,
    body: 0x0a1d33,
    flow: 0x62d9ff,
    violet: 0x8a74ff,
    rim: 0xc8f2ff,
    nucleus: 0xe6fbff,
    orbit: 0x7dd3fc,
    dust: 0x9fe8ff,
  },
  violet: {
    deep: 0x05040f,
    body: 0x1a1233,
    flow: 0xa78bfa,
    violet: 0x22d3ee,
    rim: 0xe9e0ff,
    nucleus: 0xf4efff,
    orbit: 0xc4b5fd,
    dust: 0xd6ccff,
  },
};

/** Desaturated, dimmed palette for the real offline state. */
const OFFLINE: Palette = {
  deep: 0x04070a,
  body: 0x101a23,
  flow: 0x6d8496,
  violet: 0x4c5a68,
  rim: 0xa8bccb,
  nucleus: 0xb9c9d6,
  orbit: 0x62788f,
  dust: 0x7c92a6,
};

// ── Shared GLSL ────────────────────────────────────────────────────────────

const BASIC_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Three cheap sine layers + one diagonal beat. No hash noise: mobile-safe. */
const FLOW_FN = `
float flowA(vec3 p, float t) {
  return sin(p.x * 3.1 + t * 0.55) * sin(p.y * 3.6 - t * 0.44) * sin(p.z * 4.1 + t * 0.33);
}
float flowB(vec3 p, float t) {
  return sin(p.z * 5.4 - t * 0.82 + p.y * 1.9) * sin(p.x * 4.6 + t * 0.61);
}
float flowC(vec3 p, float t) {
  return sin((p.x + p.y + p.z) * 2.7 + t * 0.4);
}
`;

const CORE_VERTEX = `
uniform float uTime;
uniform float uLevel;
uniform float uEnergy;
varying vec3 vPos;
varying vec3 vNormal;
varying vec3 vView;
varying float vWave;
${FLOW_FN}
void main() {
  vec3 n = normalize(position);
  float w = flowA(n, uTime) * 0.55 + flowC(n * 1.7 + 4.2, uTime * 0.8) * 0.3;
  float amp = 0.014 + uLevel * 0.055 + uEnergy * 0.016;
  vec3 displaced = position * (1.0 + w * amp);
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vPos = n;
  vNormal = normalize(normalMatrix * n);
  vView = normalize(-mv.xyz);
  vWave = w;
  gl_Position = projectionMatrix * mv;
}
`;

const CORE_FRAGMENT = `
uniform vec3 uDeep;
uniform vec3 uBody;
uniform vec3 uFlow;
uniform vec3 uViolet;
uniform vec3 uNucleus;
uniform float uTime;
uniform float uLevel;
uniform float uEnergy;
uniform float uOpacity;
varying vec3 vPos;
varying vec3 vNormal;
varying vec3 vView;
varying float vWave;
${FLOW_FN}

void main() {
  vec3 p = normalize(vPos);
  float t = uTime;

  // Two filament fields, sharpened into ridges, drifting at different rates.
  float a = flowA(p, t);
  float b = flowB(p, t);
  float ridges = smoothstep(0.18, 0.96, abs(a * 0.72 + b * 0.48));
  float threads = pow(max(abs(flowC(p * 1.4, t * 0.7)), 0.0), 9.0);

  // Violet only where the flow is calm, so it reads as a secondary accent.
  float violetBand = smoothstep(0.55, 1.0, sin(p.y * 2.1 - t * 0.33 + p.x * 1.4) * 0.5 + 0.5);

  // Directional shading across the volume: lower hemisphere stays near-black.
  float lambert = dot(vNormal, normalize(vec3(0.32, 0.52, 0.79)));
  float shade = mix(0.28, 1.0, smoothstep(-0.85, 0.85, lambert));
  vec3 color = mix(uDeep, uBody, shade * 0.9);

  // Filaments brighten the "lit" side and stay subtle in shadow.
  float filament = (ridges * 0.7 + threads * 0.6) * (0.42 + shade * 0.58);
  color += uFlow * filament * (0.5 + uEnergy * 0.6 + uLevel * 0.85);
  color += uViolet * violetBand * ridges * 0.3 * (0.45 + uEnergy * 0.7);

  // Fresnel atmosphere on the volume edge.
  float facing = max(dot(vNormal, vView), 0.0);
  float fresnel = pow(1.0 - facing, 2.8);
  color += uFlow * fresnel * 0.95;
  color += uFlow * max(vWave, 0.0) * 0.1;

  // Faint internal light where we look through the shell toward the nucleus.
  color += uNucleus * pow(facing, 3.4) * (0.06 + uLevel * 0.22 + uEnergy * 0.06);

  gl_FragColor = vec4(color, clamp(0.95 + fresnel * 0.05, 0.0, 1.0) * uOpacity);
}
`;

const STREAM_FRAGMENT = `
uniform vec3 uFlow;
uniform vec3 uViolet;
uniform float uTime;
uniform float uLevel;
uniform float uEnergy;
uniform float uOpacity;
varying vec3 vPos;
varying vec3 vNormal;
varying vec3 vView;
varying float vWave;
${FLOW_FN}

void main() {
  vec3 p = normalize(vPos);
  float t = uTime;
  // Long, liquid bands circulating inside the volume.
  float band1 = pow(abs(sin(p.y * 6.6 + t * 0.95 + p.x * 2.2)), 14.0);
  float band2 = pow(abs(sin(p.x * 5.8 - t * 0.72 + p.z * 2.6)), 18.0);
  float band3 = pow(abs(sin(p.z * 7.4 + t * 1.15 + p.y * 1.4)), 22.0);
  float facing = max(dot(vNormal, vView), 0.0);
  float body = band1 * 0.55 + band2 * 0.4 + band3 * 0.3;
  float edge = pow(1.0 - facing, 1.6);

  vec3 color = mix(uFlow, uViolet, band2 * 0.5);
  float intensity = body * (0.22 + uEnergy * 0.6 + uLevel * 0.75) + edge * band1 * 0.25;
  gl_FragColor = vec4(color, clamp(intensity * uOpacity, 0.0, 0.85));
}
`;

const MEMBRANE_FRAGMENT = `
uniform vec3 uRim;
uniform float uTime;
uniform float uLevel;
uniform float uEnergy;
uniform float uOpacity;
uniform float uRipple;
uniform vec3 uRipplePoint;
varying vec3 vPos;
varying vec3 vNormal;
varying vec3 vView;

void main() {
  vec3 p = normalize(vPos);
  float facing = max(dot(vNormal, vView), 0.0);
  float fresnel = pow(1.0 - facing, 3.1);

  // Fine latitude/longitude engraving, only near the silhouette.
  float lat = smoothstep(0.982, 1.0, abs(sin(p.y * 34.0 + uTime * 0.12)));
  float lon = smoothstep(0.988, 1.0, abs(sin(atan(p.z, p.x) * 26.0 - uTime * 0.06)));
  float detail = (lat * 0.34 + lon * 0.22) * smoothstep(0.15, 0.85, fresnel);

  // A single soft specular highlight sells the curved glass.
  vec3 lightDir = normalize(vec3(0.35, 0.72, 0.6));
  vec3 reflected = reflect(-vView, vNormal);
  float spec = pow(max(dot(reflected, lightDir), 0.0), 30.0) * 0.5;

  // Touch ripple: a ring travelling away from where the owner touched.
  float dist = distance(p, uRipplePoint);
  float ring = smoothstep(0.085, 0.0, abs(dist - uRipple * 1.55)) * (1.0 - uRipple);
  ring *= step(0.0005, uRipple);

  vec3 color = uRim * (fresnel * 1.35 + detail + spec + ring * 2.4);
  float alpha = fresnel * 0.5 + detail * 0.55 + spec * 0.5 + ring * 0.85
              + uEnergy * 0.04 + uLevel * 0.05;
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0) * uOpacity);
}
`;

const NUCLEUS_FRAGMENT = `
uniform vec3 uNucleus;
uniform vec3 uFlow;
uniform float uTime;
uniform float uLevel;
uniform float uEnergy;
uniform float uOpacity;
varying vec3 vNormal;
varying vec3 vView;

void main() {
  vec3 view = normalize(vView);
  float facing = max(dot(vNormal, view), 0.0);
  float core = pow(facing, 1.35);
  float breath = 0.9 + 0.1 * sin(uTime * 1.35) + 0.35 * uLevel;
  vec3 color = mix(uFlow, uNucleus, core);
  float alpha = core * breath * (0.35 + uEnergy * 0.42 + uLevel * 0.6);
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0) * uOpacity);
}
`;

const HALO_FRAGMENT = `
uniform vec3 uColor;
uniform float uLevel;
uniform float uEnergy;
uniform float uOpacity;
varying vec2 vUv;

void main() {
  float d = length(vUv - 0.5) * 2.0;
  float glow = smoothstep(1.0, 0.0, d);
  float alpha = pow(glow, 2.6) * (0.26 + uLevel * 0.3 + uEnergy * 0.12) * uOpacity;
  gl_FragColor = vec4(uColor, alpha);
}
`;

const BLOOM_FRAGMENT = `
uniform vec3 uColor;
uniform float uTime;
uniform float uLevel;
uniform float uEnergy;
uniform float uOpacity;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float angle = atan(p.y, p.x);
  float rays = pow(max(0.0, sin(angle * 8.0 + uTime * 0.28)), 10.0);
  float lens = smoothstep(0.012, 0.0, abs(r - 0.86));
  float glow = exp(-r * 3.1) * 0.5 + rays * smoothstep(0.92, 0.2, r) * 0.2 + lens * 0.32;
  float sparkle = hash(floor(p * 24.0) + floor(uTime * 1.6)) * 0.035;
  float alpha = (glow + sparkle) * (0.3 + uLevel * 0.4 + uEnergy * 0.35);
  alpha *= 1.0 - smoothstep(0.84, 1.0, r);
  gl_FragColor = vec4(uColor, clamp(alpha, 0.0, 0.85) * uOpacity);
}
`;

const TICKS_FRAGMENT = `
uniform vec3 uColor;
uniform float uTime;
uniform float uOpacity;
varying vec2 vUv;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float angle = atan(p.y, p.x) / 6.2831853 + 0.5;

  float ticks = step(0.88, fract(angle * 132.0));
  float ring = smoothstep(0.012, 0.0, abs(r - 0.965)) * ticks;

  float majorTicks = step(0.972, fract(angle * 12.0));
  float outer = smoothstep(0.016, 0.0, abs(r - 0.99)) * majorTicks;

  // Three slow brackets that sweep the instrument ring.
  float sweep = fract(angle - uTime * 0.013);
  float bracket = smoothstep(0.02, 0.0, abs(sweep - 0.5) - 0.012)
                * smoothstep(0.03, 0.0, abs(r - 0.945));

  float alpha = (ring * 0.16 + outer * 0.3 + bracket * 0.12) * uOpacity;
  alpha *= 1.0 - smoothstep(0.985, 1.0, r);
  gl_FragColor = vec4(uColor, clamp(alpha, 0.0, 0.7));
}
`;

const NEURAL_VERTEX = `
uniform float uTime;
uniform float uLevel;
uniform float uEnergy;
uniform float uPull;
uniform float uPointScale;
attribute float aSize;
attribute float aSeed;
varying float vAlpha;

void main() {
  vec3 p = position;
  // Thinking pulls the field gently inward; listening lets it breathe outward.
  float radius = mix(1.0, 0.82, uPull) + sin(uTime * (0.5 + aSeed) + aSeed * 21.0) * 0.02;
  p *= radius;
  p.y += sin(uTime * 0.55 + aSeed * 12.0) * 0.012;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float twinkle = 0.55 + 0.45 * sin(uTime * (0.7 + aSeed * 1.6) + aSeed * 31.0);
  gl_PointSize = clamp(aSize * uPointScale / max(-mv.z, 0.25), 1.0, 9.0);
  vAlpha = twinkle * (0.34 + uLevel * 0.45 + uEnergy * 0.18);
  gl_Position = projectionMatrix * mv;
}
`;

const NEURAL_FRAGMENT = `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;

void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d = length(q);
  if (d > 0.5) discard;
  float glow = smoothstep(0.5, 0.05, d);
  float centre = smoothstep(0.16, 0.0, d);
  gl_FragColor = vec4(uColor, (glow * 0.7 + centre * 0.55) * vAlpha * uOpacity);
}
`;

const DRIFT_VERTEX = `
uniform float uTime;
uniform float uPointScale;
uniform float uLevel;
attribute vec3 aDir;
attribute float aPhase;
attribute float aSpeed;
attribute float aSize;
varying float vAlpha;

void main() {
  float life = fract(uTime * aSpeed + aPhase);
  float radius = mix(0.95, 2.15, life);
  vec3 p = aDir * radius;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(aSize * uPointScale / max(-mv.z, 0.25), 1.0, 6.0);
  // Soft in, soft out — no popping at either end of the drift.
  vAlpha = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.6, 1.0, life)) * (0.4 + uLevel * 0.4);
  gl_Position = projectionMatrix * mv;
}
`;

const DRIFT_FRAGMENT = `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;

void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d = length(q);
  if (d > 0.5) discard;
  gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, d) * vAlpha * uOpacity);
}
`;

// ── Geometry helpers ──────────────────────────────────────────────────────

/** One shared soft dot sprite for every Points layer (disposed once). */
function makeDotTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.28, "rgba(255,255,255,0.62)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function randomOnSphere(minRadius: number, maxRadius: number): [number, number, number] {
  const u = Math.random() * 2 - 1;
  const theta = Math.random() * Math.PI * 2;
  const r = minRadius + Math.random() * (maxRadius - minRadius);
  const s = Math.sqrt(Math.max(0, 1 - u * u));
  return [r * s * Math.cos(theta), r * u * 0.86, r * s * Math.sin(theta)];
}

const CORE_PARTICLES = 240;
const LOW_PARTICLES = 96;

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
        stencil: false,
      });
    } catch (e) {
      console.warn("[JarvisCore] WebGL unavailable", e);
      setFailed(true);
      return;
    }

    const scene = new THREE.Scene();
    const FOV = 40;
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 60);
    camera.position.set(0, 0.04, 5.4);

    renderer.setClearColor(0x000000, 0);
    const dotTexture = makeDotTexture();
    host.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-hidden", "true");

    // ── Tiering ───────────────────────────────────────────────────────────
    // 2 = high, 1 = medium, 0 = low. Starts from the owner's low-power pref and
    // adapts down (and back up with a long hysteresis) from measured FPS.
    let tier = lowPower ? 0 : 2;
    const dprFor = (value: number) =>
      Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, value === 2 ? 2 : value === 1 ? 1.5 : 1);

    // ── Palette ───────────────────────────────────────────────────────────
    const palette = PALETTES[accent] || PALETTES.cyan;
    const colorKey = new THREE.Color(palette.flow);
    const colorRim = new THREE.Color(palette.rim);
    const colorDust = new THREE.Color(palette.dust);
    const colorOrbit = new THREE.Color(palette.orbit);
    const colorNucleus = new THREE.Color(palette.nucleus);
    const targetKey = new THREE.Color();
    const targetRim = new THREE.Color();
    const targetDust = new THREE.Color();
    const targetOrbit = new THREE.Color();
    const targetNucleus = new THREE.Color();

    // ── 1. Halo ───────────────────────────────────────────────────────────
    const haloUniforms = {
      uColor: { value: colorRim.clone() },
      uLevel: { value: 0 },
      uEnergy: { value: 0 },
      uOpacity: { value: 1 },
    };
    const haloGeometry = new THREE.PlaneGeometry(6.2, 6.2);
    const haloMaterial = new THREE.ShaderMaterial({
      uniforms: haloUniforms,
      vertexShader: BASIC_VERTEX,
      fragmentShader: HALO_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Mesh(haloGeometry, haloMaterial);
    halo.position.z = -1.6;
    halo.renderOrder = 0;
    scene.add(halo);

    // ── 2. Instrument ring (ticks + brackets) ─────────────────────────────
    const tickUniforms = {
      uColor: { value: colorRim.clone() },
      uTime: { value: 0 },
      uOpacity: { value: 1 },
    };
    const tickGeometry = new THREE.PlaneGeometry(2.7, 2.7);
    const tickMaterial = new THREE.ShaderMaterial({
      uniforms: tickUniforms,
      vertexShader: BASIC_VERTEX,
      fragmentShader: TICKS_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const ticks = new THREE.Mesh(tickGeometry, tickMaterial);
    ticks.position.z = -1.2;
    ticks.renderOrder = 1;
    scene.add(ticks);

    // ── 3. Volumetric bloom ───────────────────────────────────────────────
    const bloomUniforms = {
      uColor: { value: colorKey.clone() },
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uEnergy: { value: 0 },
      uOpacity: { value: 1 },
    };
    const bloomGeometry = new THREE.PlaneGeometry(5.2, 5.2);
    const bloomMaterial = new THREE.ShaderMaterial({
      uniforms: bloomUniforms,
      vertexShader: BASIC_VERTEX,
      fragmentShader: BLOOM_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const bloom = new THREE.Mesh(bloomGeometry, bloomMaterial);
    bloom.position.z = -0.9;
    bloom.renderOrder = 2;
    scene.add(bloom);

    // ── 4. Deep-space dust ────────────────────────────────────────────────
    const dustCount = 170;
    const dustPositions = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i++) {
      const [x, y, z] = randomOnSphere(2.3, 4.4);
      dustPositions[i * 3] = x;
      dustPositions[i * 3 + 1] = y;
      dustPositions[i * 3 + 2] = z;
    }
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
    const dustMaterial = new THREE.PointsMaterial({
      color: colorDust.clone(),
      size: 0.05,
      map: dotTexture,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
    });
    const dust = new THREE.Points(dustGeometry, dustMaterial);
    dust.renderOrder = 3;
    scene.add(dust);

    // ── 5. Neural field: sharp particles + real connection lines ──────────
    const neuralGeometry = new THREE.BufferGeometry();
    const neuralPositions = new Float32Array(CORE_PARTICLES * 3);
    const neuralSizes = new Float32Array(CORE_PARTICLES);
    const neuralSeeds = new Float32Array(CORE_PARTICLES);
    for (let i = 0; i < CORE_PARTICLES; i++) {
      const [x, y, z] = randomOnSphere(1.02, 1.55);
      neuralPositions[i * 3] = x;
      neuralPositions[i * 3 + 1] = y;
      neuralPositions[i * 3 + 2] = z;
      neuralSizes[i] = 0.7 + Math.random() * 1.5;
      neuralSeeds[i] = Math.random();
    }
    neuralGeometry.setAttribute("position", new THREE.BufferAttribute(neuralPositions, 3));
    neuralGeometry.setAttribute("aSize", new THREE.BufferAttribute(neuralSizes, 1));
    neuralGeometry.setAttribute("aSeed", new THREE.BufferAttribute(neuralSeeds, 1));
    const neuralUniforms = {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uEnergy: { value: 0 },
      uPull: { value: 0 },
      uPointScale: { value: 600 },
      uColor: { value: colorKey.clone() },
      uOpacity: { value: 1 },
    };
    const neuralMaterial = new THREE.ShaderMaterial({
      uniforms: neuralUniforms,
      vertexShader: NEURAL_VERTEX,
      fragmentShader: NEURAL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const neuralPoints = new THREE.Points(neuralGeometry, neuralMaterial);
    neuralPoints.renderOrder = 4;

    // Connect particles that are genuinely close to one another.
    const linkPositions: number[] = [];
    const maxLinks = 190;
    for (let i = 0; i < CORE_PARTICLES && linkPositions.length < maxLinks * 6; i++) {
      for (let j = i + 1; j < CORE_PARTICLES && linkPositions.length < maxLinks * 6; j++) {
        const dx = neuralPositions[i * 3] - neuralPositions[j * 3];
        const dy = neuralPositions[i * 3 + 1] - neuralPositions[j * 3 + 1];
        const dz = neuralPositions[i * 3 + 2] - neuralPositions[j * 3 + 2];
        if (dx * dx + dy * dy + dz * dz < 0.055) {
          linkPositions.push(
            neuralPositions[i * 3], neuralPositions[i * 3 + 1], neuralPositions[i * 3 + 2],
            neuralPositions[j * 3], neuralPositions[j * 3 + 1], neuralPositions[j * 3 + 2],
          );
        }
      }
    }
    const linkGeometry = new THREE.BufferGeometry();
    linkGeometry.setAttribute("position", new THREE.Float32BufferAttribute(linkPositions, 3));
    const linkMaterial = new THREE.LineBasicMaterial({
      color: colorKey.clone(),
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const links = new THREE.LineSegments(linkGeometry, linkMaterial);
    links.renderOrder = 4;

    const neuralGroup = new THREE.Group();
    neuralGroup.add(neuralPoints);
    neuralGroup.add(links);
    scene.add(neuralGroup);

    // ── 6. Outward drifters (fully GPU-animated, one draw call) ───────────
    const driftCount = 42;
    const driftPositions = new Float32Array(driftCount * 3);
    const driftDirs = new Float32Array(driftCount * 3);
    const driftPhase = new Float32Array(driftCount);
    const driftSpeed = new Float32Array(driftCount);
    const driftSizes = new Float32Array(driftCount);
    for (let i = 0; i < driftCount; i++) {
      const [x, y, z] = randomOnSphere(1, 1);
      const length = Math.hypot(x, y, z) || 1;
      driftDirs[i * 3] = x / length;
      driftDirs[i * 3 + 1] = y / length;
      driftDirs[i * 3 + 2] = z / length;
      driftPhase[i] = Math.random();
      driftSpeed[i] = 0.02 + Math.random() * 0.035;
      driftSizes[i] = 0.8 + Math.random() * 1.4;
    }
    const driftGeometry = new THREE.BufferGeometry();
    driftGeometry.setAttribute("position", new THREE.BufferAttribute(driftPositions, 3));
    driftGeometry.setAttribute("aDir", new THREE.BufferAttribute(driftDirs, 3));
    driftGeometry.setAttribute("aPhase", new THREE.BufferAttribute(driftPhase, 1));
    driftGeometry.setAttribute("aSpeed", new THREE.BufferAttribute(driftSpeed, 1));
    driftGeometry.setAttribute("aSize", new THREE.BufferAttribute(driftSizes, 1));
    const driftUniforms = {
      uTime: { value: 0 },
      uPointScale: { value: 600 },
      uLevel: { value: 0 },
      uColor: { value: colorKey.clone() },
      uOpacity: { value: 0.55 },
    };
    const driftMaterial = new THREE.ShaderMaterial({
      uniforms: driftUniforms,
      vertexShader: DRIFT_VERTEX,
      fragmentShader: DRIFT_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const drifters = new THREE.Points(driftGeometry, driftMaterial);
    drifters.frustumCulled = false;
    drifters.renderOrder = 4;
    scene.add(drifters);

    // ── 7. Orbital system ─────────────────────────────────────────────────
    const orbitDefs = [
      { radius: 1.06, tiltX: 1.06, tiltY: 0.14, speed: 0.3, opacity: 0.5, particles: 26 },
      { radius: 1.26, tiltX: -0.55, tiltY: 0.5, speed: -0.22, opacity: 0.38, particles: 20 },
      { radius: 1.46, tiltX: 0.22, tiltY: -0.72, speed: 0.15, opacity: 0.26, particles: 16 },
    ];
    const orbits = orbitDefs.map((def, index) => {
      const group = new THREE.Group();
      group.rotation.set(def.tiltX, def.tiltY, index * 0.7);
      group.renderOrder = 5;

      const ringGeometry = new THREE.TorusGeometry(def.radius, 0.0035, 3, 200);
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: colorOrbit.clone(),
        transparent: true,
        opacity: def.opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      group.add(ring);

      // Particles already on the path; the group's rotation carries them.
      const pathGeometry = new THREE.BufferGeometry();
      const pathPositions = new Float32Array(def.particles * 3);
      for (let i = 0; i < def.particles; i++) {
        const angle = (i / def.particles) * Math.PI * 2 + Math.random() * 0.12;
        pathPositions[i * 3] = Math.cos(angle) * def.radius;
        pathPositions[i * 3 + 1] = Math.sin(angle) * def.radius;
        pathPositions[i * 3 + 2] = 0;
      }
      pathGeometry.setAttribute("position", new THREE.BufferAttribute(pathPositions, 3));
      const pathMaterial = new THREE.PointsMaterial({
        color: colorOrbit.clone(),
        size: 0.032,
        map: dotTexture,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
      });
      const pathPoints = new THREE.Points(pathGeometry, pathMaterial);
      group.add(pathPoints);

      // One brighter pulse travelling the orbit.
      const pulseGeometry = new THREE.BufferGeometry();
      pulseGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
      const pulseMaterial = new THREE.PointsMaterial({
        color: colorRim.clone(),
        size: 0.11,
        map: dotTexture,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
      });
      const pulse = new THREE.Points(pulseGeometry, pulseMaterial);
      pulse.frustumCulled = false;
      group.add(pulse);

      scene.add(group);
      return { group, def, ringMaterial, pathMaterial, pulse, pulseMaterial, pulseGeometry, phase: index * 1.9 };
    });

    // ── 8. Nucleus ────────────────────────────────────────────────────────
    const nucleusUniforms = {
      uNucleus: { value: colorNucleus.clone() },
      uFlow: { value: colorKey.clone() },
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uEnergy: { value: 0 },
      uOpacity: { value: 1 },
    };
    const nucleusGeometry = new THREE.IcosahedronGeometry(0.3, 3);
    const nucleusMaterial = new THREE.ShaderMaterial({
      uniforms: nucleusUniforms,
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: NUCLEUS_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const nucleus = new THREE.Mesh(nucleusGeometry, nucleusMaterial);
    nucleus.renderOrder = 6;
    scene.add(nucleus);

    // ── 9. Volume (the dominant sphere) ───────────────────────────────────
    const coreUniforms = {
      uDeep: { value: new THREE.Color(palette.deep) },
      uBody: { value: new THREE.Color(palette.body) },
      uFlow: { value: colorKey.clone() },
      uViolet: { value: new THREE.Color(palette.violet) },
      uNucleus: { value: colorNucleus.clone() },
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uEnergy: { value: 0 },
      uOpacity: { value: 1 },
    };
    const coreGeometry = new THREE.SphereGeometry(0.78, 96, 72);
    const coreMaterial = new THREE.ShaderMaterial({
      uniforms: coreUniforms,
      vertexShader: CORE_VERTEX,
      fragmentShader: CORE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const core = new THREE.Mesh(coreGeometry, coreMaterial);
    core.renderOrder = 7;
    scene.add(core);

    // ── 10. Internal energy streams ───────────────────────────────────────
    const streamUniforms = {
      uFlow: { value: colorKey.clone() },
      uViolet: { value: new THREE.Color(palette.violet) },
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uEnergy: { value: 0 },
      uOpacity: { value: 1 },
    };
    const streamGeometry = new THREE.SphereGeometry(0.74, 72, 54);
    const streamMaterial = new THREE.ShaderMaterial({
      uniforms: streamUniforms,
      vertexShader: CORE_VERTEX,
      fragmentShader: STREAM_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const streams = new THREE.Mesh(streamGeometry, streamMaterial);
    streams.renderOrder = 8;
    scene.add(streams);

    // ── 11. Membrane shell ────────────────────────────────────────────────
    const membraneUniforms = {
      uRim: { value: colorRim.clone() },
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uEnergy: { value: 0 },
      uOpacity: { value: 1 },
      uRipple: { value: 0 },
      uRipplePoint: { value: new THREE.Vector3(0, 0, 1) },
    };
    const membraneGeometry = new THREE.SphereGeometry(0.9, 80, 60);
    const membraneMaterial = new THREE.ShaderMaterial({
      uniforms: membraneUniforms,
      vertexShader: CORE_VERTEX,
      fragmentShader: MEMBRANE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const membrane = new THREE.Mesh(membraneGeometry, membraneMaterial);
    membrane.renderOrder = 9;
    scene.add(membrane);

    // ── Quality + resize ──────────────────────────────────────────────────
    const applyQuality = () => {
      renderer.setPixelRatio(dprFor(tier));
      neuralGeometry.setDrawRange(0, tier === 2 ? CORE_PARTICLES : tier === 1 ? 150 : LOW_PARTICLES);
      dustGeometry.setDrawRange(0, tier === 2 ? dustCount : tier === 1 ? 120 : 64);
      links.visible = tier >= 1;
      bloom.visible = tier >= 1;
      ticks.visible = tier >= 0;
      drifters.visible = tier >= 1;
      resize();
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();

      // Convert world-space point sizes into device pixels for this viewport.
      const bufferHeight = height * renderer.getPixelRatio();
      const pointScale = (bufferHeight * 0.5) / Math.tan((FOV * Math.PI) / 360);
      neuralUniforms.uPointScale.value = pointScale;
      driftUniforms.uPointScale.value = pointScale;
    };

    applyQuality();

    // ── Live state ────────────────────────────────────────────────────────
    const clock = new THREE.Clock();
    let raf = 0;
    let running = false;
    let level = 0;
    let energy = 0.18;
    let opacity = 1;
    let pull = 0;
    let rippleStart = -10;
    let frames = 0;
    let windowTime = 0;
    let goodWindows = 0;
    let cooldown = 0;

    // Touch ripple + a gentle camera parallax toward the finger.
    const pointer = { x: 0, y: 0, active: false };
    const onPointerDown = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      const nx = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      const ny = -(((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
      membraneUniforms.uRipplePoint.value.set(nx * 0.85, ny * 0.75, 0.55).normalize();
      rippleStart = clock.elapsedTime;
      pointer.x = nx;
      pointer.y = ny;
      pointer.active = true;
    };
    const onPointerUp = () => {
      pointer.active = false;
    };
    // Passive: never blocks page scrolling on the home screen.
    host.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerUp, { passive: true });

    const frame = () => {
      if (!running) return;
      const dt = Math.min(clock.getDelta(), 0.05);
      const elapsed = clock.elapsedTime;
      const { state: orbState, offline: isOffline, accent: accentName } = live.current;

      // ── Real input level (recogniser RMS or TTS analyser) ──────────────
      const rawLevel = Math.max(useStore.getState().audioLevel, voicePipeline.getSnapshot().level);
      const targetLevel = Math.max(0, Math.min(1, rawLevel));
      level += (targetLevel - level) * Math.min(1, dt * 8.5);

      const targetEnergy =
        orbState === "thinking" ? 1 : orbState === "speaking" ? 0.76 : orbState === "listening" ? 0.5 : 0.18;
      const targetPull = orbState === "thinking" ? 1 : 0;
      energy += (targetEnergy - energy) * Math.min(1, dt * 2.8);
      pull += (targetPull - pull) * Math.min(1, dt * 1.9);

      const targetOpacity = isOffline ? 0.4 : 1;
      opacity += (targetOpacity - opacity) * Math.min(1, dt * 2.2);

      const paletteNow = isOffline ? OFFLINE : PALETTES[accentName] || PALETTES.cyan;
      targetKey.setHex(paletteNow.flow);
      targetRim.setHex(paletteNow.rim);
      targetDust.setHex(paletteNow.dust);
      targetOrbit.setHex(paletteNow.orbit);
      targetNucleus.setHex(paletteNow.nucleus);
      const blend = Math.min(1, dt * 3.4);
      colorKey.lerp(targetKey, blend);
      colorRim.lerp(targetRim, blend);
      colorDust.lerp(targetDust, blend);
      colorOrbit.lerp(targetOrbit, blend);
      colorNucleus.lerp(targetNucleus, blend);

      const motion = reducedMotionRef.current ? 0.22 : 1;
      const speed =
        (orbState === "thinking" ? 2.1 : orbState === "speaking" ? 1.4 : orbState === "listening" ? 1.1 : 0.45) * motion;
      const ripple = Math.min(1, Math.max(0, (elapsed - rippleStart) / 1.5));

      // ── Uniforms ──────────────────────────────────────────────────────
      coreUniforms.uTime.value = elapsed;
      coreUniforms.uLevel.value = level;
      coreUniforms.uEnergy.value = isOffline ? 0.03 : energy;
      coreUniforms.uOpacity.value = opacity;
      coreUniforms.uFlow.value.copy(colorKey);
      coreUniforms.uNucleus.value.copy(colorNucleus);

      streamUniforms.uTime.value = elapsed * (1 + pull * 0.35);
      streamUniforms.uLevel.value = level;
      streamUniforms.uEnergy.value = isOffline ? 0 : energy;
      streamUniforms.uOpacity.value = opacity;
      streamUniforms.uFlow.value.copy(colorKey);

      membraneUniforms.uTime.value = elapsed;
      membraneUniforms.uLevel.value = level;
      membraneUniforms.uEnergy.value = isOffline ? 0 : energy;
      membraneUniforms.uOpacity.value = opacity;
      membraneUniforms.uRim.value.copy(colorRim);
      membraneUniforms.uRipple.value = ripple;

      nucleusUniforms.uTime.value = elapsed;
      nucleusUniforms.uLevel.value = level;
      nucleusUniforms.uEnergy.value = isOffline ? 0 : energy;
      nucleusUniforms.uOpacity.value = opacity;
      nucleusUniforms.uNucleus.value.copy(colorNucleus);
      nucleusUniforms.uFlow.value.copy(colorKey);

      neuralUniforms.uTime.value = elapsed;
      neuralUniforms.uLevel.value = level;
      neuralUniforms.uEnergy.value = isOffline ? 0 : energy;
      neuralUniforms.uPull.value = pull;
      neuralUniforms.uColor.value.copy(colorKey);
      neuralUniforms.uOpacity.value = opacity;
      linkMaterial.color.copy(colorKey);
      linkMaterial.opacity = (0.07 + energy * 0.16 + level * 0.1) * opacity;

      driftUniforms.uTime.value = elapsed;
      driftUniforms.uLevel.value = level;
      driftUniforms.uColor.value.copy(colorKey);
      driftUniforms.uOpacity.value = 0.5 * opacity;

      haloUniforms.uColor.value.copy(colorRim);
      haloUniforms.uLevel.value = level;
      haloUniforms.uEnergy.value = isOffline ? 0 : energy;
      haloUniforms.uOpacity.value = opacity;

      tickUniforms.uColor.value.copy(colorRim);
      tickUniforms.uTime.value = elapsed;
      tickUniforms.uOpacity.value = (isOffline ? 0.6 : 1) * opacity;

      bloomUniforms.uColor.value.copy(colorKey);
      bloomUniforms.uTime.value = elapsed;
      bloomUniforms.uLevel.value = level;
      bloomUniforms.uEnergy.value = isOffline ? 0 : energy;
      bloomUniforms.uOpacity.value = opacity;

      dustMaterial.color.copy(colorDust);
      dustMaterial.opacity = (0.2 + energy * 0.12) * opacity;

      // ── Orbital motion + travelling pulses ────────────────────────────
      for (const orbit of orbits) {
        orbit.group.rotation.z += dt * orbit.def.speed * speed;
        orbit.group.rotation.x += dt * 0.006 * speed;
        orbit.ringMaterial.color.copy(colorOrbit);
        orbit.ringMaterial.opacity =
          orbit.def.opacity * (0.55 + energy * 0.5) * (isOffline ? 0.7 : 1) * opacity;
        orbit.pathMaterial.color.copy(colorOrbit);
        orbit.pathMaterial.opacity = (0.45 + level * 0.35) * opacity;
        orbit.phase += dt * (0.5 + orbit.def.speed * 2.4) * speed;
        const pulseAngle = orbit.phase;
        const point = orbit.pulseGeometry.getAttribute("position") as THREE.BufferAttribute;
        point.setXYZ(
          0,
          Math.cos(pulseAngle) * orbit.def.radius,
          Math.sin(pulseAngle) * orbit.def.radius,
          0,
        );
        point.needsUpdate = true;
        orbit.pulseMaterial.color.copy(colorRim);
        orbit.pulseMaterial.opacity = (0.55 + energy * 0.4) * opacity;
      }

      // ── Sphere motion ─────────────────────────────────────────────────
      const breath = 1 + Math.sin(elapsed * 1.05) * 0.006 * motion + level * 0.045 + energy * 0.012;
      core.rotation.y += dt * 0.11 * speed;
      core.rotation.x = Math.sin(elapsed * 0.21) * 0.07 * motion;
      core.scale.setScalar(breath);
      streams.rotation.y -= dt * 0.16 * speed;
      streams.rotation.z += dt * 0.05 * motion;
      streams.scale.setScalar(breath * 0.995);
      membrane.rotation.y += dt * 0.045 * speed;
      nucleus.rotation.y += dt * 0.5 * speed;
      nucleus.scale.setScalar(0.92 + level * 0.22 + energy * 0.06 + Math.sin(elapsed * 1.6) * 0.015);

      neuralGroup.rotation.y += dt * 0.05 * speed;
      neuralGroup.rotation.x = Math.sin(elapsed * 0.13) * 0.1 * motion;
      dust.rotation.y -= dt * 0.014 * motion;
      dust.rotation.z += dt * 0.005 * motion;

      // ── Controlled parallax (never moves the visual centre) ────────────
      if (!reducedMotionRef.current) {
        const targetX = pointer.active ? pointer.x * 0.12 : 0;
        const targetY = pointer.active ? -pointer.y * 0.08 : 0;
        camera.position.x += (targetX - camera.position.x) * Math.min(1, dt * 2.4);
        camera.position.y += (0.04 + targetY - camera.position.y) * Math.min(1, dt * 2.4);
        camera.lookAt(0, 0, 0);
      }

      renderer.render(scene, camera);

      // ── Adaptive quality from measured frame rate (no up/down flapping) ──
      frames++;
      windowTime += dt;
      cooldown -= dt;
      if (windowTime >= 1) {
        const fps = frames / windowTime;
        frames = 0;
        windowTime = 0;
        if (cooldown <= 0) {
          if (fps < 45 && tier > 0) {
            tier--;
            cooldown = 2.5;
            goodWindows = 0;
            applyQuality();
          } else if (fps > 57 && tier < 2 && !lowPower) {
            goodWindows++;
            if (goodWindows >= 4) {
              tier++;
              goodWindows = 0;
              cooldown = 4;
              applyQuality();
            }
          } else {
            goodWindows = 0;
          }
        }
      }

      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      clock.getDelta();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        if (!observer || observerVisible) start();
      } else {
        stop();
      }
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

    let observer: IntersectionObserver | null = null;
    let observerVisible = true;
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(
        (entries) => {
          observerVisible = entries.some((entry) => entry.isIntersecting);
          if (observerVisible) start();
          else stop();
        },
        { threshold: 0.01 },
      );
      observer.observe(host);
    }

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
    } else {
      window.addEventListener("resize", resize);
    }

    resize();
    start();

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      renderer.domElement.removeEventListener("webglcontextrestored", onContextRestored);
      host.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      observer?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);

      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else if (material) material.dispose();
      });
      dotTexture.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
    // The scene is built once; live state/theme/tier flow through refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stateLabel = failed
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
    <div
      ref={hostRef}
      className={`m-core ${className ?? ""}`}
      data-state={state}
      data-offline={offline}
      role="img"
      aria-label={`JARVIS neural core — ${stateLabel.toLowerCase()}`}
    >
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
 * Keeps the thin meter under the core in sync with the same real level the
 * shaders use, without re-rendering the screen.
 */
export function useCoreMeter(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = 0;
    const tick = (time: number) => {
      const host = ref.current;
      if (host && time - last > 60) {
        last = time;
        const bar = host.querySelector<HTMLElement>("[data-meter]");
        if (bar) {
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
