/**
 * Kinematic reference adapter: integrates the shared force law directly and
 * treats contacts with simple idealised rules (no rigid-body solver):
 *  - rim wall / turret wall: inelastic, frictionless constraint
 *  - deflector: if the ball passes within contact distance, its radial
 *    velocity is reflected (× restitution) and tangential speed reduced
 *  - frets: relative tangential velocity w.r.t. the rotor is reflected
 *    (× restitution) when the ball reaches a fret
 * Fast and deterministic, it is the baseline the physics engines are compared to.
 */
import type { SimParams, SimResult } from "@/types/simulation";
import { pocketCount } from "@/engine/wheel/layout";
import { EventTracker, GEOM, applyRimConstraint, ballAcceleration, deflectorPoses, initialBall, pocketAt, rotorState } from "./rouletteScene";

export function runKinematic(p: SimParams): SimResult {
  const t0 = performance.now();
  const n = pocketCount(p.wheelType);
  const pitch = (2 * Math.PI) / n;
  const defl = deflectorPoses(p).map((d) => Math.atan2(d.y, d.x));
  const deflHalfAngle = (GEOM.deflectorHalfLen + GEOM.ballR) / GEOM.deflectorR;
  const ev = new EventTracker(p);
  let { pos, vel } = initialBall(p);
  let collisions = 0;
  let prevR = Math.hypot(pos.x, pos.y);
  let prevFret: number | null = null;
  const rMax = GEOM.rimR - GEOM.ballR;
  const rMin = GEOM.turretR + GEOM.ballR;

  for (let t = 0; t <= p.maxTimeS; t += p.dt) {
    const rot = rotorState(p, t);
    const a = ballAcceleration(p, pos, vel, rot.omega);
    vel = { x: vel.x + a.x * p.dt, y: vel.y + a.y * p.dt };
    pos = { x: pos.x + vel.x * p.dt, y: pos.y + vel.y * p.dt };
    let r = Math.hypot(pos.x, pos.y);
    let ux = pos.x / r, uy = pos.y / r;

    // Rim wall (shared smooth constraint) and turret wall.
    if (r > rMax) {
      const c = applyRimConstraint(pos, vel);
      pos = c.pos;
      vel = c.vel;
      r = rMax;
      ux = pos.x / r;
      uy = pos.y / r;
    } else if (r < rMin) {
      const target = rMin;
      pos = { x: ux * target, y: uy * target };
      const vr = vel.x * ux + vel.y * uy;
      if (vr < 0) vel = { x: vel.x - vr * ux, y: vel.y - vr * uy };
      r = target;
    }

    // Deflector ring crossing.
    const dR = GEOM.deflectorR;
    if ((prevR - dR) * (r - dR) <= 0 && prevR !== r) {
      const th = Math.atan2(pos.y, pos.x);
      const hit = defl.some((d) => Math.abs(Math.atan2(Math.sin(th - d), Math.cos(th - d))) < deflHalfAngle);
      if (hit) {
        collisions++;
        const vr = vel.x * ux + vel.y * uy;
        const vt = { x: vel.x - vr * ux, y: vel.y - vr * uy };
        const k = 1 - p.contactFriction;
        vel = { x: -p.restitution * vr * ux + k * vt.x, y: -p.restitution * vr * uy + k * vt.y };
      }
    }
    prevR = r;

    // Frets (in the rotor frame).
    if (r < GEOM.fretOuter + GEOM.ballR) {
      const th = Math.atan2(pos.y, pos.x);
      const rel = rot.angle - th; // clockwise index coordinate
      const u = rel / pitch - 0.5; // frets at integer u
      const fret = Math.round(u);
      const dist = Math.abs(u - fret) * pitch * r;
      if (dist < GEOM.ballR + GEOM.fretHalfWidth && fret !== prevFret) {
        // Reflect the ball's tangential velocity relative to the rotor surface.
        collisions++;
        const tx = -uy, ty = ux;
        const vSurf = rot.omega * r;
        const vt = vel.x * tx + vel.y * ty;
        const vRel = vt - vSurf;
        const vtNew = vSurf - p.restitution * vRel;
        vel = { x: vel.x + (vtNew - vt) * tx, y: vel.y + (vtNew - vt) * ty };
        prevFret = fret;
      } else if (dist > GEOM.ballR * 2) {
        prevFret = null;
      }
    }

    if (ev.observe(t, pos, vel)) break;
  }

  return {
    engine: "kinematic",
    params: p,
    ok: ev.finalIndex !== null,
    error: ev.finalIndex === null ? "Ball did not settle within the time limit." : null,
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
