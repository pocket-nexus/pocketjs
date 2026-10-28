// The demo autopilot, ported from GameBlocks' castle-defense
// (https://gb-castle-defense.vercel.app/src/player-ai.js, MIT, xt4d/GameBlocks),
// class AIPlayer. The game calls it every 0.14 s, as the demo does; one call
// repairs, or buys or upgrades, or sets a trap, or fires every ready weapon.
//
// Written for the 3DS interpreter: one native query gathers the attackers
// into flat arrays. Deviation: the firing is spread over the next four
// frames, one weapon a frame in the demo's order (catapult, cannon,
// ballista, arrows), so the splash weapons' cluster counts (all pairs) do
// not land on one frame.

import { ENT } from "@pocketjs/framework/playset";
import { CASTLE_TARGETS, L, WEAPONS, WEAPON_MOUNTS, WEAPON_ORDER, upgradeCost, weaponPower, type CastleDefense, type WeaponKey } from "./game.ts";

const MAX = 64;
/** ENEMY_STATS in ENEMY_TYPES order (game.ts imports this module) */
const DAMAGE = [6, 8, 20, 26, 10, 42];
const ATTACK_RANGE = [1.8, 1.9, 2.9, 3.4, 2.4, 4.6];
const TYPE_BONUS = [0, 0, 48, 70, 0, 130];
const FLYER = 4;
const FIRE_ORDER: readonly WeaponKey[] = ["catapult", "cannon", "ballista", "arrows"];
const BUY_ORDER: readonly WeaponKey[] = ["cannon", "catapult", "arrows"];

export class Autopilot {
  private trapTimer = 0;
  lastAction = "Idle";
  private readonly ex = new Float64Array(MAX);
  private readonly ey = new Float64Array(MAX);
  private readonly ez = new Float64Array(MAX);
  private readonly et = new Int8Array(MAX);
  private readonly es = new Float64Array(MAX);
  private readonly eg = new Int8Array(MAX);
  private n = 0;
  /** the weapon (index in FIRE_ORDER) to aim on the next frame, 4 = none */
  private firing = 4;
  private fired = false;

  reset(): void {
    this.trapTimer = 0;
    this.lastAction = "Idle";
    this.firing = 4;
  }

  /** every 0.14 s: gather, then repair, buy, upgrade or set a trap, or start firing */
  act(g: CastleDefense): void {
    this.trapTimer = Math.max(0, this.trapTimer - 0.14);
    this.gather(g);
    this.firing = 4;
    if (this.tryRepair(g) || this.tryPurchaseOrUpgrade(g) || this.tryTrap(g)) return;
    this.firing = 0;
    this.fired = false;
  }

  /** every frame: aim and fire the next weapon of the round, if one is due */
  step(g: CastleDefense): void {
    if (this.firing >= FIRE_ORDER.length) return;
    this.fireOne(g, FIRE_ORDER[this.firing++]);
    if (this.firing === FIRE_ORDER.length && !this.fired) this.lastAction = this.n > 0 ? "Waiting for cooldown" : "Waiting for enemies";
  }

  private gather(g: CastleDefense): void {
    const play = g.play;
    const ent = play.ent;
    const list = play.list;
    const n = play.near(L.enemy, 0, 0, 400);
    let k = 0;
    for (let i = 0; i < n && k < MAX; i++) {
      const s = list[i];
      const o = s * 16;
      const t = g.enemyIndex[ent[o + ENT.ARCH] - 1];
      if (t < 0) continue;
      this.ex[k] = ent[o];
      this.ey[k] = ent[o + 1];
      this.ez[k] = ent[o + 2];
      this.et[k] = t;
      this.es[k] = ent[o + ENT.SPEED];
      this.eg[k] = play.user[s * 8];
      k++;
    }
    this.n = k;
  }

  private tryRepair(g: CastleDefense): boolean {
    const hud = g.hud;
    const ratio = hud.castleHp / hud.castleMaxHp;
    const urgent = ratio < 0.42;
    const useful = ratio < 0.68 && hud.gold >= 150;
    if (hud.gold >= 80 && (urgent || useful)) {
      this.lastAction = "Repair castle";
      g.repairCastle();
      return true;
    }
    return false;
  }

  private tryPurchaseOrUpgrade(g: CastleDefense): boolean {
    const hud = g.hud;
    const reserve = hud.castleHp / hud.castleMaxHp < 0.72 ? 80 : 0;
    for (let i = 0; i < BUY_ORDER.length; i++) {
      const key = BUY_ORDER[i];
      if (!g.has(key) && hud.gold >= WEAPONS[key].cost + reserve) {
        this.lastAction = `Buy ${WEAPONS[key].label}`;
        g.buyWeapon(key);
        return true;
      }
    }
    // the owned weapon with the lowest level (the demo's stable sort keeps WEAPON_ORDER on ties)
    let key: WeaponKey | undefined;
    for (let i = 0; i < WEAPON_ORDER.length; i++) {
      const k = WEAPON_ORDER[i];
      if (g.has(k) && (!key || hud.levels[k] < hud.levels[key])) key = k;
    }
    if (!key) return false;
    const cost = upgradeCost(hud.levels, key);
    if (hud.gold >= cost + reserve + 45) {
      this.lastAction = `Upgrade ${WEAPONS[key].label}`;
      g.selectWeapon(key);
      g.upgradeSelected();
      return true;
    }
    return false;
  }

  private tryTrap(g: CastleDefense): boolean {
    if (this.trapTimer > 0 || g.hud.gold < 145) return false;
    let near = false;
    for (let i = 0; i < this.n; i++) {
      const forward = -this.ez[i];
      if (forward > -6 && forward < 24) {
        near = true;
        break;
      }
    }
    if (g.traps.length < 3 && near) {
      this.trapTimer = 2.4;
      this.lastAction = "Place trap";
      g.placeTrap();
      return true;
    }
    return false;
  }

  private fireOne(g: CastleDefense, key: WeaponKey): void {
    const hud = g.hud;
    {
      if (!g.has(key) || hud.cooldowns[key] > 0) return;
      const target = this.targetFor(g, key);
      if (target < 0) return;
      g.selectWeapon(key);
      // getAimPoint: lead along the march, shells aimed at the ground
      const spec = weaponPower(hud.levels, key);
      const m = WEAPON_MOUNTS[key];
      const x = this.ex[target], y = this.ey[target], z = this.ez[target];
      const t = CASTLE_TARGETS[this.eg[target]];
      let dx = t[0] - x, dz = t[2] - z;
      const toCastle = Math.sqrt(dx * dx + dz * dz);
      const travel = Math.sqrt((m[0] - x) ** 2 + (m[2] - z) ** 2) / spec.speed;
      const lead = toCastle > ATTACK_RANGE[this.et[target]] ? this.es[target] * travel * 0.55 : 0;
      let ax = x, ay = y, az = z;
      if (lead > 0 && toCastle > 1e-6) {
        dx /= toCastle;
        dz /= toCastle;
        ax += dx * lead;
        az += dz * lead;
      }
      if (key === "cannon" || key === "catapult") ay -= Math.min(ay, 0.8);
      if (g.fire(key, ax, ay, az)) this.fired = true;
      this.lastAction = `Fire at ${target}`;
    }
  }

  /** findTargetForWeapon: the attacker nearest the castle, the heavy ones and
   *  the clustered ones (for splash) first. */
  private targetFor(g: CastleDefense, key: WeaponKey): number {
    const spec = weaponPower(g.hud.levels, key);
    const m = WEAPON_MOUNTS[key];
    const ex = this.ex, ez = this.ez, et = this.et;
    const range2 = spec.range * spec.range;
    const cluster = spec.splash + 2.5;
    const cluster2 = cluster * cluster;
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < this.n; i++) {
      const x = ex[i], z = ez[i];
      if ((m[0] - x) ** 2 + (m[2] - z) ** 2 > range2) continue;
      const t = CASTLE_TARGETS[this.eg[i]];
      const toCastle = Math.sqrt((x - t[0]) ** 2 + (z - t[2]) ** 2);
      let clusterBonus = 0;
      if (spec.splash > 0) {
        let count = 0;
        for (let k = 0; k < this.n; k++) {
          const dx = ex[k] - x, dz = ez[k] - z;
          if (dx * dx + dz * dz <= cluster2) count++;
        }
        clusterBonus = count * 28;
      }
      const flyingPenalty = et[i] === FLYER && spec.splash > 0 ? -45 : 0;
      const score = 150 - toCastle * 2.5 + clusterBonus + TYPE_BONUS[et[i]] + DAMAGE[et[i]] * 3 + flyingPenalty;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }
}
