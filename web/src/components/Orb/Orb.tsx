import { useEffect, useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Sphere, MeshDistortMaterial } from "@react-three/drei";
import { useStore, type OrbState } from "../../lib/store";
import * as THREE from "three";

const PALETTE: Record<OrbState, {
  color: string;
  distort: number;
  speed: number;
  intensity: number;
}> = {
  idle:      { color: "#22d3ee", distort: 0.1, speed: 1.0, intensity: 0.85 },
  listening: { color: "#5ee9ff", distort: 0.3, speed: 2.0, intensity: 1.10 },
  thinking:  { color: "#9b8cff", distort: 0.5, speed: 3.5, intensity: 1.20 },
  speaking:  { color: "#67e8f9", distort: 0.2, speed: 1.5, intensity: 1.40 },
};

function Core() {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<any>(null);
  const state = useStore((s) => s.orbState);

  const target = PALETTE[state];
  const targetColor = useMemo(() => new THREE.Color(target.color), [target.color]);

  useFrame((state, delta) => {
    if (materialRef.current) {
      materialRef.current.color.lerp(targetColor, delta * 2);
      materialRef.current.distort = THREE.MathUtils.lerp(materialRef.current.distort, target.distort, delta * 2);
      materialRef.current.speed = THREE.MathUtils.lerp(materialRef.current.speed, target.speed, delta * 2);
    }
  });

  return (
    <Sphere ref={meshRef} args={[1.5, 64, 64]}>
      <MeshDistortMaterial
        ref={materialRef}
        color={PALETTE.idle.color}
        envMapIntensity={target.intensity}
        clearcoat={1}
        clearcoatRoughness={0}
        metalness={0.9}
        roughness={0.1}
        distort={PALETTE.idle.distort}
        speed={PALETTE.idle.speed}
        transparent={true}
        opacity={0.8}
      />
    </Sphere>
  );
}

function Particles() {
  const pointsRef = useRef<THREE.Points>(null);
  const state = useStore((s) => s.orbState);

  const target = PALETTE[state];
  const targetColor = useMemo(() => new THREE.Color(target.color), [target.color]);

  const particlesPosition = useMemo(() => {
    const positions = new Float32Array(500 * 3);
    for (let i = 0; i < 500; i++) {
      const radius = 2 + Math.random() * 2;
      const theta = Math.random() * 2 * Math.PI;
      const phi = Math.acos(Math.random() * 2 - 1);

      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = radius * Math.cos(phi);
    }
    return positions;
  }, []);

  useFrame((state, delta) => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y += delta * 0.1 * target.speed;
      pointsRef.current.rotation.x += delta * 0.05 * target.speed;

      // We can update colors per state if needed, here just basic rotation
      const material = pointsRef.current.material as THREE.PointsMaterial;
      material.color.lerp(targetColor, delta * 2);
    }
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={particlesPosition.length / 3}
          array={particlesPosition}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.05}
        color={PALETTE.idle.color}
        transparent
        opacity={0.6}
        sizeAttenuation
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

function Rings() {
  const ringRef1 = useRef<THREE.Mesh>(null);
  const ringRef2 = useRef<THREE.Mesh>(null);
  const ringRef3 = useRef<THREE.Mesh>(null);

  const state = useStore((s) => s.orbState);
  const target = PALETTE[state];
  const targetColor = useMemo(() => new THREE.Color(target.color), [target.color]);

  useFrame((state, delta) => {
    const speed = target.speed;
    if (ringRef1.current) {
      ringRef1.current.rotation.x += delta * 0.5 * speed;
      ringRef1.current.rotation.y += delta * 0.2 * speed;
      (ringRef1.current.material as THREE.MeshBasicMaterial).color.lerp(targetColor, delta * 2);
    }
    if (ringRef2.current) {
      ringRef2.current.rotation.y -= delta * 0.3 * speed;
      ringRef2.current.rotation.z += delta * 0.4 * speed;
      (ringRef2.current.material as THREE.MeshBasicMaterial).color.lerp(targetColor, delta * 2);
    }
    if (ringRef3.current) {
      ringRef3.current.rotation.x -= delta * 0.1 * speed;
      ringRef3.current.rotation.z -= delta * 0.6 * speed;
      (ringRef3.current.material as THREE.MeshBasicMaterial).color.lerp(targetColor, delta * 2);
    }
  });

  const materialProps = {
    color: PALETTE.idle.color,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  };

  return (
    <group>
      <mesh ref={ringRef1}>
        <torusGeometry args={[2.0, 0.02, 16, 100]} />
        <meshBasicMaterial {...materialProps} />
      </mesh>
      <mesh ref={ringRef2}>
        <torusGeometry args={[2.2, 0.02, 16, 100]} />
        <meshBasicMaterial {...materialProps} />
      </mesh>
      <mesh ref={ringRef3}>
        <torusGeometry args={[2.4, 0.05, 16, 100]} />
        <meshBasicMaterial {...materialProps} opacity={0.1} />
      </mesh>
    </group>
  );
}

export default function Orb() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="relative aspect-square w-full max-w-[400px]">
        <Canvas camera={{ position: [0, 0, 5], fov: 45 }}>
          <ambientLight intensity={0.5} />
          <pointLight position={[10, 10, 10]} intensity={1} />
          <pointLight position={[-10, -10, -10]} intensity={0.5} />

          <Core />
          <Particles />
          <Rings />

          <OrbitControls
            enableZoom={false}
            enablePan={false}
            autoRotate
            autoRotateSpeed={0.5}
          />
        </Canvas>

        <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center text-center">
          <div className="text-[var(--orb-glow)] font-mono text-sm tracking-[0.2em] font-bold opacity-80" style={{ textShadow: "0 0 10px var(--orb-glow)" }}>
            J.A.R.V.I.S.
          </div>
          <div className="text-[var(--orb-cyan)] font-mono text-[10px] tracking-widest mt-1 opacity-50">
            MARK · IV
          </div>
        </div>
      </div>
    </div>
  );
}
