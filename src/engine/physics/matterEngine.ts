/**
 * Matter.js adapter (2-D position-based rigid bodies). Same scene as the
 * Rapier adapter. Matter works in its own units, so the scene is scaled
 * (1 m = 1000 units) and velocities are converted to Matter's
 * "units per base step" (base step = 1000/60 ms). The rim is the shared
 * smooth-wall constraint; the rotor is a static compound rotated every step,
 * with its drag on the ball supplied by the shared surface-drag force.
 */
import type { SimParams, SimResult } from "@/types/simulation";
import {
  EventTracker,
  GEOM,
  applyRimConstraint,
  ballAcceleration,
  deflectorPoses,
  fretPosesLocal,
  initialBall,
  pocketAt,
  rotorState,
} from "./rouletteScene";

type MatterModule = typeof import("matter-js");
let matterPromise: Promise<MatterModule> | null = null;

async function loadMatter(): Promise<MatterModule> {
  matterPromise ??= import("matter-js").then((m) => ((m as unknown as { default?: MatterModule }).default ?? m) as MatterModule);
  return matterPromise;
}

const S = 1000; // Matter units per metre
const BASE_MS = 1000 / 60; // Matter's base delta

export async function runMatter(p: SimParams): Promise<SimResult> {
  const t0 = performance.now();
  const M = await loadMatter();
  const { Engine, Bodies, Body, Composite, Events } = M;
  const engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
  engine.positionIterations = 12;
  engine.velocityIterations = 10;
  const toU = (v: number) => (v * S * BASE_MS) / 1000; // m/s → units per base step
  const fromU = (v: number) => (v * 1000) / (S * BASE_MS);

  const deflectors = deflectorPoses(p).map((d) =>
    Bodies.rectangle(d.x * S, d.y * S, 2 * GEOM.deflectorHalfLen * S, 2 * GEOM.deflectorHalfWidth * S, {
      isStatic: true,
      angle: d.angle,
      restitution: p.restitution,
      friction: p.contactFriction,
    }),
  );

  // Rotor: turret disc + frets as one static compound, rotated about the centre.
  const rot0 = rotorState(p, 0);
  const rotorParts = [
    Bodies.circle(0, 0, GEOM.turretR * S, { restitution: 0.1, friction: p.contactFriction }, 64),
    ...fretPosesLocal(p).map((f) =>
      Bodies.rectangle(f.x * S, f.y * S, 2 * f.halfLen * S, 2 * GEOM.fretHalfWidth * S, {
        angle: f.angle,
        restitution: p.restitution,
        friction: p.contactFriction,
      }),
    ),
  ];
  const rotor = Body.create({ parts: rotorParts, isStatic: true });
  Body.setPosition(rotor, { x: 0, y: 0 });
  Body.rotate(rotor, rot0.angle); // about its position = wheel centre
  let rotorAngle = rot0.angle;
  // Matter ≥0.20: rotate(body, angle, point, updateVelocity). With updateVelocity the
  // solver sees the rotor surface moving (typings only declare the first two args).
  const rotateRotor = Body.rotate as unknown as (b: typeof rotor, a: number, pt: { x: number; y: number }, upd: boolean) => void;

  const init = initialBall(p);
  const ball = Bodies.circle(init.pos.x * S, init.pos.y * S, GEOM.ballR * S, {
    restitution: p.restitution,
    friction: p.contactFriction,
    frictionStatic: 0,
    frictionAir: 0,
    inertia: Infinity,
    density: 0.001,
  });
  Composite.add(engine.world, [...deflectors, rotor, ball]);
  Body.setVelocity(ball, { x: toU(init.vel.x), y: toU(init.vel.y) });

  let collisions = 0;
  Events.on(engine, "collisionStart", (e) => {
    for (const pair of e.pairs) if (pair.bodyA === ball || pair.bodyB === ball) collisions++;
  });

  const ev = new EventTracker(p);
  const dtMs = p.dt * 1000;
  let ok = false;
  const getVel = (): { x: number; y: number } => Body.getVelocity(ball);

  try {
    for (let t = 0; t <= p.maxTimeS; t += p.dt) {
      const rs = rotorState(p, t + p.dt);
      rotateRotor(rotor, rs.angle - rotorAngle, { x: 0, y: 0 }, true);
      rotorAngle = rs.angle;
      const pos = { x: ball.position.x / S, y: ball.position.y / S };
      const vu = getVel();
      const vel = { x: fromU(vu.x), y: fromU(vu.y) };
      const a = ballAcceleration(p, pos, vel, rs.omega);
      Body.setVelocity(ball, { x: toU(vel.x + a.x * p.dt), y: toU(vel.y + a.y * p.dt) });
      Engine.update(engine, dtMs);
      const c = applyRimConstraint({ x: ball.position.x / S, y: ball.position.y / S }, { x: fromU(getVel().x), y: fromU(getVel().y) });
      if (c.clamped) {
        Body.setPosition(ball, { x: c.pos.x * S, y: c.pos.y * S });
        Body.setVelocity(ball, { x: toU(c.vel.x), y: toU(c.vel.y) });
      }
      const v2 = getVel();
      if (ev.observe(t + p.dt, { x: ball.position.x / S, y: ball.position.y / S }, { x: fromU(v2.x), y: fromU(v2.y) })) {
        ok = true;
        break;
      }
    }
  } finally {
    Events.off(engine, "collisionStart", undefined as never);
    Composite.clear(engine.world, false);
    Engine.clear(engine);
  }

  return {
    engine: "matter",
    params: p,
    ok,
    error: ok ? null : "Ball did not settle within the time limit.",
    samples: ev.samples,
    dropTimeS: ev.dropTimeS,
    rotorContactTimeS: ev.rotorContactTimeS,
    settleTimeS: ev.settleTimeS,
    finalIndex: ev.finalIndex,
    finalPocket: ev.finalIndex === null ? null : pocketAt(p, ev.finalIndex),
    collisions,
    wallMs: performance.now() - t0,
  };
}
