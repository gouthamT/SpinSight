/**
 * Rapier.js adapter (rigid bodies with a proper contact solver and CCD).
 * Scene: fixed deflectors (rim = shared smooth-wall constraint); kinematic rotor (turret disc +
 * frets) driven at the rotor's angular velocity; dynamic ball. Non-contact
 * forces come from the shared force law (rouletteScene.ballAcceleration).
 */
import type { SimParams, SimResult } from "@/types/simulation";
import {
  EventTracker,
  GEOM,
  ballAcceleration,
  deflectorPoses,
  fretPosesLocal,
  initialBall,
  pocketAt,
  applyRimConstraint,
  rotorState,
} from "./rouletteScene";

type RapierModule = typeof import("@dimforge/rapier2d-compat");
let rapierPromise: Promise<RapierModule> | null = null;

async function loadRapier(): Promise<RapierModule> {
  rapierPromise ??= import("@dimforge/rapier2d-compat").then(async (m) => {
    const R = ((m as unknown as { default?: RapierModule }).default ?? m) as RapierModule;
    await R.init();
    return R;
  });
  return rapierPromise;
}

export async function runRapier(p: SimParams): Promise<SimResult> {
  const t0 = performance.now();
  const R = await loadRapier();
  const world = new R.World({ x: 0, y: 0 });
  world.timestep = p.dt;
  const events = new R.EventQueue(true);

  // Stationary bowl: deflectors (the smooth rim wall is a shared constraint, see applyRimConstraint).
  const fixed = world.createRigidBody(R.RigidBodyDesc.fixed());
  for (const d of deflectorPoses(p)) {
    world.createCollider(
      R.ColliderDesc.cuboid(GEOM.deflectorHalfLen, GEOM.deflectorHalfWidth)
        .setTranslation(d.x, d.y)
        .setRotation(d.angle)
        .setRestitution(p.restitution)
        .setFriction(p.contactFriction),
      fixed,
    );
  }

  // Rotor: kinematic body at the centre carrying the turret wall and the frets.
  const rot0 = rotorState(p, 0);
  const rotor = world.createRigidBody(R.RigidBodyDesc.kinematicVelocityBased().setTranslation(0, 0).setRotation(rot0.angle));
  world.createCollider(R.ColliderDesc.ball(GEOM.turretR).setRestitution(0.1).setFriction(p.contactFriction), rotor);
  for (const f of fretPosesLocal(p)) {
    world.createCollider(
      R.ColliderDesc.cuboid(f.halfLen, GEOM.fretHalfWidth)
        .setTranslation(f.x, f.y)
        .setRotation(f.angle)
        .setRestitution(p.restitution)
        .setFriction(p.contactFriction),
      rotor,
    );
  }

  // Ball.
  const init = initialBall(p);
  const ball = world.createRigidBody(
    R.RigidBodyDesc.dynamic()
      .setTranslation(init.pos.x, init.pos.y)
      .setLinvel(init.vel.x, init.vel.y)
      .setCcdEnabled(true)
      .lockRotations(),
  );
  world.createCollider(
    R.ColliderDesc.ball(GEOM.ballR)
      .setDensity(1000)
      .setRestitution(p.restitution)
      .setFriction(p.contactFriction)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
    ball,
  );
  const mass = ball.mass();

  const ev = new EventTracker(p);
  let collisions = 0;
  let ok = false;
  try {
    for (let t = 0; t <= p.maxTimeS; t += p.dt) {
      const rs = rotorState(p, t);
      rotor.setAngvel(rs.omega, true);
      const pos = ball.translation();
      const vel = ball.linvel();
      const a = ballAcceleration(p, pos, vel, rs.omega);
      ball.resetForces(true);
      ball.addForce({ x: a.x * mass, y: a.y * mass }, true);
      world.step(events);
      const c = applyRimConstraint(ball.translation(), ball.linvel());
      if (c.clamped) {
        ball.setTranslation(c.pos, true);
        ball.setLinvel(c.vel, true);
      }
      events.drainCollisionEvents((_h1: number, _h2: number, started: boolean) => {
        if (started) collisions++;
      });
      if (ev.observe(t + p.dt, ball.translation(), ball.linvel())) {
        ok = true;
        break;
      }
    }
  } finally {
    events.free();
    world.free();
  }

  return {
    engine: "rapier",
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
