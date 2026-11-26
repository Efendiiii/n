// ==UserScript==
// @name         NULLS JUMP Auto-Player
// @namespace    nulls-jump-bot
// @version      2.7b
// @description  Auto-player for nulls.world/jump — reads live game state, steers with real key events. Trial: 30 runs, no Memory Cards.
// @author       Efendi
// @match        https://nulls.world/jump
// @match        https://nulls.world/jump/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// NULLS JUMP — in-page precision bot v2 (reads live game state per frame, steers with real key events).
// Plays through the REAL game client: the client itself records the input log and submits the run.
// No API calls, no score fabrication, no auth bypass. Works in any browser tab on nulls.world/jump.
// Usage (DevTools console or Playwright evaluate):
//   window.__NULLS_BOT__.start({ maxRuns: 10, localTest: false, useContinue: false })
//
// v2 fixes (perfection pass, 26 Nov 14:55 WITA):
//  - bounce decisions are EDGE-triggered (one clean decision per bounce, not every frame while land>0)
//  - falling past the target now switches to a survival target (was: guard blocked the switch -> steered wrong)
//  - STAGING (v2.1): when no platform above is horizontally reachable, steer toward the
//    lowest landable platform above within one jump's rise so the NEXT bounce starts under it.
//    Without this the bot bounces in place forever on the infinitely-wide ground (score stuck
//    at 23 = one jump height). Stuck recovery is now a 3s repositioning sweep, not a run-ender
//    (steering off cannot kill a run while bouncing on the ground).
//  - DIAG (v2.2): on STUCK, dumps player/target/platforms-above/below so a freeze is diagnosed
//    from the real configuration instead of guessed at.
//  - ENTER (v2.3, root cause of ALL freezes): the game's key handler ignores ArrowLeft/
//    ArrowRight while state.entered is falsy (logic.js key(): `if (!this.state.entered) return;`).
//    The bot called g.play() directly, bypassing the ENTER button, so keys.l/keys.r stayed false,
//    dirQ() returned 0, vx stayed 0 and the player bounced in place at x=210 forever — the
//    23/56/65 "stuck" scores were never a targeting failure. B.start() now calls g.enter()
//    first (entered flips 'out'->true after 800ms; 'out' is already truthy so keys work at once).
//  - DEATH-DRIVEN FIXES (v2.4, from batch #1 deaths 65/842/204/91/54/165):
//    staging is RISING-ONLY (steering at a platform above while falling steals the landing
//    below); survival fallback steers at the nearest platform below instead of dir 0 when no
//    target is reachable while falling; chainAbove is now a HARD preference (unchained high
//    platforms are traps — every batch-#1 death fell into a void after one); emergency
//    direction flips while falling fast (vy<-300) bypass the 80ms min-hold.
//  - LANDING-PREDICTION STEERING (v2.5, from batch #2 deaths: 6 of 10 died 0-10px from the
//    death line, 13-51px above a PERFECTLY ALIGNED platform below — the survival steering
//    worked, the player just ran out of room after missing a platform higher up):
//    steer on the predicted LANDING x (free drift if keys released now) instead of the
//    current offset — releasing at |dx|<6 with vx=500 drifts ~80px past a narrow (w=63-67)
//    platform. landNeed() replaces the full-steer reachability check with a band check
//    (any landing x between free-drift and full-steer is achievable by steer-then-release).
//    `passed` margin 40px -> 5px (switch to survival the moment the player falls below
//    the target's height).
//  - STATE-AWARE LANDING CONTROLLER (v2.6, from a step-by-step replay trace of batch #3
//    run #2): the v2.5 bang-bang controller flipped direction every 80ms (min-hold) because
//    the landing prediction swings with vx — vx oscillated ±300, the player zigzagged and
//    drifted 30-50px during the final fall, missing narrow platforms. steerToLanding()
//    never flips directly +1<->-1 (release first, brake hard only on >50px overshoot) and
//    MIN_HOLD_MS is 50ms — the limit cycle collapses and vx stays small at landing.
//  - POWER-UP ROUTING + MOVER COMMIT + NEVER-NULL TARGET (v2.7, from batch #3 deaths
//    893..4329, 8/10 target-null, 0/10 pu active, blue 16/30 slots above at death):
//    jet/shoes/slow/net platforms get a big v-bonus (jet +400: one jet is ~+300 score and
//    skips ~19 risky bounces); spring +250 (732px rise); a jet platform needs no chain
//    above it (the jet IS the escape); chainAbove is 2-step with exact bounce velocities
//    (spring 1855 / shoes 1431 / normal 1060) and mover positions predicted at the real
//    landing time (movers are a triangle wave — prediction was right, the DECISION gave up);
//    survival never targets a platform below the death line (cam-90+30); the no-target
//    fallback steers at the highest reachable platform below using moverX(t), not the
//    nearest by raw dx; crumble is last-resort (-80); mid-flight upgrades compare
//    v-scores (so a jet target is not abandoned for a higher plain platform);
//    per-bounce decision log (B.decisions) is saved in the run record so a null target
//    can be traced to the exact bounce. dbl/air-jump NEVER spawns (gen() only assigns
//    slow/jet/net/shoes) — the handler is dead code, kept for safety.
//  - BUGFIXES v2.7b (from unit tests + dissection of batch-#3 early deaths 1159/1357/893/1309):
//    moverX right-wall reflection was a NO-OP (`hi-(hi-x)` = x) — mover predictions were
//    wrong whenever a mover touched the right wall; landNeed used wrapped coordinates so
//    its reachable band flipped when the full-steer crossed the world edge (false
//    "unreachable" rejections — likely cause of the run-#2 spring miss and run-#9/#10
//    mover misses); survival could pick a platform above the player with NaN time
//    (dy<0 now excluded); chain preference is tiered (chained non-crumble first, else
//    v-score — a chained crumble no longer beats an unchained green); staging uses the
//    ACTUAL rise R (spring 732 / shoes 436), not just JUMP/shoes; DEAD-END fast-end —
//    2 consecutive null-pick bounces above score 100 end the run at once instead of
//    bouncing in place 25s (run #10 wasted 25s on a dead-end green).
//  - steering hysteresis (engage 14px / release 6px) + unified 50ms min-hold between ANY key change
//  - chain check requires horizontal reachability from the platform, not just height
//  - blue (mover) targets penalised while Feather Fall is active (fall timing differs -> prediction off)
//  - stuck recovery STEERS OFF the platform instead of releasing keys (releasing never ends a bounce loop)
//  - snapshots (seed, input log, revive step, steps, bounty) at death for offline replay verification
(() => {
  'use strict';
  if (window.__NULLS_BOT__) { console.log('[BOT] already installed'); return; }

  const W = 420, G = 2350, JUMP = 1060, MAXVX = 560, WRAP = 472;
  const MIN_HOLD_MS = 50;      // min time between any key-state change (v2.6: 80 -> 50, faster corrections)
  const ENGAGE_PX = 14, RELEASE_PX = 6;  // steering hysteresis band (current-dx, coarse branches)
  const LAND_RELEASE_PX = 10, LAND_BRAKE_PX = 50; // landing-error controller thresholds (v2.6)
  const RISE = vy => (vy * vy) / (2 * G);            // max rise from vertical speed vy
  const wrapDx = dx => { let d = dx % WRAP; if (d > WRAP / 2) d -= WRAP; if (d < -WRAP / 2) d += WRAP; return d; };
  const wrapX = x => ((x + 26) % WRAP + WRAP) % WRAP - 26;
  // time (s) until the player, rising at vy, falls back down to height y (y-current <= rise)
  const tLand = (vy, dy) => { const disc = vy * vy - 2 * G * dy; if (disc < 0) return Infinity; return (vy + Math.sqrt(disc)) / G; };
  // predicted player x after t seconds steering with dir (-1/0/1), from (x0, vx0)
  const predX = (x0, vx0, dir, t) => {
    const tv = dir * MAXVX;
    return wrapX(x0 + tv * t + (vx0 - tv) * (1 - Math.exp(-10 * t)) / 10);
  };
  // predicted player x after t seconds with NO key held (vx decays at 6/s, the game's free rate)
  const predXFree = (x0, vx0, t) => wrapX(x0 + vx0 * (1 - Math.exp(-6 * t)) / 6);
  // Effective landing error for a target at x px, landing at time t: the player can land
  // anywhere between the free-drift landing (release now) and the full-steer landing, so
  // the target is reachable if it lies in that band (plus the platform's tolerance).
  // Returns 0 when reachable, else the full-steer miss distance. (v2.5)
  // v2.7b: the band MUST be computed in UNWRAPPED coordinates. The old code wrapped the
  // full-steer landing (predX wraps x into [-26,446)) and then wrapped the offsets — when
  // the full-steer displacement crossed the world edge, the band flipped direction and a
  // perfectly reachable target was rejected (e.g. player at x=10, target at x=350 via the
  // left wrap: band became [-132,40] instead of the true [-310,50]). That false rejection
  // is a likely cause of the run-#2 spring miss and the run-#9/#10 mover misses.
  function landNeed(p, px, t, tol) {
    const dir = Math.sign(wrapDx(px - p.x)) || 0;
    const xFreeU = p.x + p.vx * (1 - Math.exp(-6 * t)) / 6;
    const tv = dir * MAXVX;
    const xFullU = p.x + tv * t + (p.vx - tv) * (1 - Math.exp(-10 * t)) / 10;
    const lo = Math.min(xFreeU, xFullU) - tol, hi = Math.max(xFreeU, xFullU) + tol;
    // The target's equivalent positions under wrap (px, px±472).
    for (const cand of [px, px + WRAP, px - WRAP]) {
      if (cand >= lo && cand <= hi) return 0;
    }
    let best = Infinity;
    for (const cand of [px, px + WRAP, px - WRAP]) best = Math.min(best, Math.abs(cand - xFullU));
    return best;
  }
  // predicted x of a moving (blue) platform after t seconds, with wall reflections
  // (triangle wave between [w/2+4, W-w/2-4], exactly like the game's own update).
  // v2.7b: the right-wall reflection was `hi - (hi - x)` = x (a NO-OP) — the mover's
  // predicted x was wrong by up to ~130px whenever it touched the right wall during
  // the flight. Correct form is `hi - (x - hi)` = 2*hi - x.
  const moverX = (pl, t) => {
    if (!pl.vx) return pl.x;
    const m = pl.w / 2 + 4, lo = m, hi = W - m;
    let x = pl.x + pl.vx * t;
    let guard = 0;
    while ((x < lo || x > hi) && guard++ < 8) {
      if (x < lo) x = lo + (lo - x);
      else x = hi - (x - hi);
    }
    return x;
  };
  const landable = pl =>
    pl && (pl.type === 'green' || pl.type === 'blue' || pl.type === 'spring' || pl.type === 'crumble') &&
    !pl.broken && !pl.fall && pl.tip == null;

  function findGame() {
    const root = document.getElementById('dc-root');
    if (!root) return null;
    const key = Object.keys(root).find(k => k.startsWith('__reactContainer$'));
    if (!key) return null;
    const seen = new Set();
    const stack = [root[key]];
    let n = 0;
    while (stack.length && n < 20000) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f); n++;
      const sn = f.stateNode;
      if (sn && sn.logic && sn.logic.p && sn.logic.plats && typeof sn.logic.step === 'function') return sn.logic;
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    return null;
  }

  const B = {
    g: null, on: false, maxRuns: 10, runsDone: 0, useContinue: false, localTest: false,
    runs: [], log: [],
    held: 0,            // -1, 0, 1 currently held
    lastFlip: 0,
    target: null,       // committed landing platform
    targetV: 0,         // v-score of the committed target (v2.7: upgrades compare v, not y)
    decisions: [],      // per-bounce decision log for this run (v2.7 diagnostics)
    bounceN: 0,
    deadEndN: 0,        // consecutive null-pick bounces (v2.7b dead-end fast-end)
    prevLand: 0,        // previous frame's p.land (bounce edge detection)
    lastPickAt: 0,
    runStart: 0,
    lastScore: 0, lastScoreTime: 0, stuck: false, giveUp: false, giveUpDir: 1, giveUpAt: 0,
    deathInfo: null, runSnap: null,
    tickCount: 0,
  };
  window.__NULLS_BOT__ = B;

  function say(...a) { const m = '[BOT] ' + a.join(' '); B.log.push(m); console.log(m); }

  function setDir(dir) {
    // dispatch real key events so the game's own listener records the input
    const now = performance.now();
    if (dir === B.held) return;
    if (now - B.lastFlip < MIN_HOLD_MS) return; // one key change at most every 50ms (v2.6)
    const up = (key) => window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    const dn = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    if (B.held === -1) up('ArrowLeft');
    if (B.held === 1) up('ArrowRight');
    if (dir === -1) dn('ArrowLeft');
    if (dir === 1) dn('ArrowRight');
    B.held = dir;
    B.lastFlip = now;
  }
  // hysteresis steering toward a horizontal offset dx (px, wrapped)
  function steerToDx(dx) {
    if (dx > ENGAGE_PX) setDir(1);
    else if (dx < -ENGAGE_PX) setDir(-1);
    else if (Math.abs(dx) < RELEASE_PX) setDir(0);
    // inside the band: keep current hold (no dithering)
  }
  // State-aware landing-error steering (v2.6): dxLand is where the player will LAND if the
  // keys are released now (+ = target is to the right). The v2.5 bang-bang version flipped
  // every 80ms (min-hold) because the prediction swings with vx — vx oscillated ±300 and
  // the player drifted 30-50px during the final fall, missing narrow platforms. This version
  // never flips directly from +1 to -1: it releases first (gentle decay) and only brakes
  // hard on a huge overshoot, so the limit cycle collapses and vx stays small at landing.
  function steerToLanding(dxLand) {
    const s = Math.sign(dxLand) || 0;
    if (Math.abs(dxLand) < LAND_RELEASE_PX) { setDir(0); return; } // will land within 10px
    if (B.held === s) return; // already steering the right way
    if (B.held === 0) { setDir(s); return; } // engage
    // held the wrong way: release gently unless the overshoot is huge (then brake hard)
    if (Math.abs(dxLand) < LAND_BRAKE_PX) setDir(0);
    else setDir(s);
  }
  function releaseKeys() { setDir(0); }

  // Bounce velocity FROM a platform: spring 1855 (JUMP*1.75), shoes 1431 (JUMP*1.35, only
  // when shoes are ALREADY active — a shoes orb on pl itself is collected AFTER this
  // bounce, so it does NOT boost the bounce from pl, only the next one), else 1060.
  // (bounce() in logic.js: shoes apply only if pu.k==='shoes' before the bounce; spring
  // ignores shoes.) rise = vy^2/(2G): spring 732 / shoes 436 / normal 239.
  function bounceVy(g, pl, shoesNext) {
    if (pl.type === 'spring') return JUMP * 1.75;
    if ((g.pu && g.pu.k === 'shoes') || shoesNext) return JUMP * 1.35;
    return JUMP;
  }
  // Is there a landable platform the player can reach FROM pl on the next bounce?
  // 2-step lookahead: the platform above pl must itself have a way up (or be a spring /
  // jet carrier — those escape on their own). Mover positions are predicted at the exact
  // landing time (tLand from the bounce velocity), not read at their current x — a mover
  // at 200px/s moves ~140px during one flight, which is the whole platform width.
  function chainAbove(g, pl, tBase) {
    const vy = bounceVy(g, pl, false);
    const rise = RISE(vy);
    const reach = pl.type === 'spring' ? 600 : vy > JUMP ? 400 : 200;
    for (const q of g.plats) {
      if (q === pl || !landable(q)) continue;
      const dy = q.y - pl.y;
      if (dy <= 25 || dy > rise) continue;
      const tQ = (tBase || 0) + tLand(vy, dy);
      if (!isFinite(tQ)) continue;
      const qx = moverX(q, tQ);
      if (Math.abs(wrapDx(qx - pl.x)) > (q.type === 'blue' ? 260 : reach)) continue;
      if (q.type === 'spring' || q.pu === 'jet') return true; // escapes on its own
      if (chain1(g, q, tQ, pl.pu === 'shoes')) return true;
    }
    return false;
  }
  // Single-level chain from q (depth 2 of the lookahead). shoesFromPl: the player picked
  // up shoes on the platform below, so they ARE active for the bounce from q.
  function chain1(g, pl, tBase, shoesFromPl) {
    const vy = bounceVy(g, pl, shoesFromPl);
    const rise = RISE(vy);
    const reach = pl.type === 'spring' ? 600 : vy > JUMP ? 400 : 200;
    for (const q of g.plats) {
      if (q === pl || !landable(q)) continue;
      const dy = q.y - pl.y;
      if (dy <= 25 || dy > rise) continue;
      const tQ = (tBase || 0) + tLand(vy, dy);
      if (!isFinite(tQ)) continue;
      const qx = moverX(q, tQ);
      if (Math.abs(wrapDx(qx - pl.x)) <= (q.type === 'blue' ? 260 : reach)) return true;
    }
    return false;
  }

  // Pick the best landing target. Cheap enough to run every frame; switching is guarded by the caller.
  function pickTarget(g) {
    const p = g.p;
    const rising = p.vy > 0;
    const R = rising ? RISE(p.vy) : 0;
    const feather = !!(g.pu && g.pu.k === 'slow');
    const cands = [];
    if (rising) {
      for (const pl of g.plats) {
        if (!landable(pl)) continue;
        const dy = pl.y - p.y;
        if (dy < 15 || dy > R - 8) continue;
        const t = tLand(p.vy, dy);
        if (!isFinite(t)) continue;
        const px = moverX(pl, t);
        const need = landNeed(p, px, t, pl.w / 2 + 8);
        if (need > pl.w / 2 + 8) continue; // cannot align in time
        // v2.7: power-up routing — a jet is ~+300 score and skips ~19 risky bounces, so a
        // platform carrying one is worth a big detour. A jet needs no chain above it (the
        // jet itself is the escape); shoes extend the chain to a 436px rise.
        const ch = pl.pu === 'jet' ? true : chainAbove(g, pl, t);
        let v = pl.y;
        if (ch) v += 60;
        if (pl.pu === 'jet') v += 400;
        else if (pl.pu === 'shoes') v += 200;
        else if (pl.pu === 'slow') v += 150;
        else if (pl.pu === 'net') v += 120;
        if (pl.type === 'spring') v += 250; // 732px rise vs 239 — a spring is a shortcut
        if (pl.type === 'blue') v += feather ? -40 : 10; // mover prediction is off under feather gravity
        if (pl.type === 'crumble') v -= 80; // v2.7: crumble is last-resort (tips in 0.5s; run #10 trap)
        v -= need * 0.15;
        cands.push({ pl, v, t, ch });
      }
      if (cands.length) {
        // v2.7b: tiered chain preference (was: hard exclusion of ALL unchained candidates).
        // A chained crumble must NOT beat an unchained green — the crumble tips in 0.5s
        // and its "chain" is worth less than a safe landing. Tier 1: chained, non-crumble.
        // Otherwise every candidate competes on v-score (chain is already a +60 bonus).
        const chainedSafe = cands.filter(c => c.ch && c.pl.type !== 'crumble');
        const pool = chainedSafe.length ? chainedSafe : cands;
        pool.sort((a, b) => b.v - a.v);
        return pool[0];
      }
    }
    // none rising: STAGING — the lowest landable platform above us within one jump's
    // rise, even if horizontally out of reach from here. Steer toward its x so the NEXT
    // bounce (from wherever we land below — usually the infinitely-wide ground) starts
    // closer to it. RISING ONLY: while falling, steering at a platform above is useless
    // and steals the landing below — a falling player must go straight to survival.
    if (rising) {
      // v2.7b: use the ACTUAL current rise R (from p.vy) — a spring bounce rises 732px,
      // shoes 436px. The old code used RISE(JUMP/shoes) and missed platforms a spring
      // bounce could reach, returning null (dead end) when a way up existed.
      const Rstage = R;
      let stage = null;
      for (const pl of g.plats) {
        if (!landable(pl)) continue;
        const dy = pl.y - p.y;
        if (dy < 15 || dy > Rstage) continue;
        const adx = Math.abs(wrapDx(pl.x - p.x));
        if (!stage || dy < stage.dy || (dy === stage.dy && adx < stage.adx)) stage = { pl, dy, adx };
      }
      if (stage) return { pl: stage.pl, v: stage.pl.y, t: 0, staging: true };
    }

    // survival: highest landable platform at or below us we can still reach while falling.
    // v2.7: NEVER target a platform below the death line (cam-90) — run #2 died steering
    // at a green 58px below the line. The camera never moves down, so that platform was
    // already unreachable. Also prefer platforms with a chain up (a dead-end landing is a
    // trap) and platforms carrying power-ups / springs.
    let best = null;
    for (let pass = 0; pass < 2 && !best; pass++) {
      for (const pl of g.plats) {
        if (!landable(pl)) continue;
        const dy = p.y - pl.y; // how far below us
        // v2.7b: dy < 0 (platform above us) is NEVER landable while falling — and it made
        // disc negative -> t = NaN -> a v=NaN candidate could be picked as the target.
        if (dy < 0 || dy > 520) continue;
        if (pl.y < g.cam - 90 + 30) continue; // below the death line + margin: already dead
        if (pass === 0 && dy < 30 && Math.abs(wrapDx(pl.x - p.x)) < pl.w / 2 + 11) continue; // current platform
        const disc = p.vy * p.vy + 2 * G * dy;
        const t = (p.vy + Math.sqrt(disc)) / G;
        const px = moverX(pl, t);
        const need = landNeed(p, px, t, pl.w / 2 + 8);
        if (need > pl.w / 2 + 8) continue;
        let v = pl.y - need * 0.2 + (pl.type === 'blue' && feather ? -40 : 0);
        if (pl.type === 'spring') v += 60;
        if (pl.type === 'crumble') v -= 80;
        if (pl.pu === 'jet') v += 200;
        else if (pl.pu === 'shoes') v += 100;
        else if (pl.pu === 'slow') v += 80;
        else if (pl.pu === 'net') v += 60;
        if (pl.pu === 'jet' || chainAbove(g, pl, t)) v += 40;
        if (!best || v > best.v) best = { pl, v, t };
      }
    }
    return best;
  }

  // Sweep direction for a lost/stuck run: toward the nearest landable platform below
  // (a chance to land and continue) instead of a blind direction. Falls back to
  // steering away from the player's side when there is nothing below.
  function sweepDir(g) {
    const p = g.p;
    let best = null;
    for (const q of g.plats) {
      if (!landable(q) || q.y > p.y || q.y < g.cam - 90 + 30) continue;
      if (!best || Math.abs(wrapDx(q.x - p.x)) < Math.abs(wrapDx(best.x - p.x))) best = q;
    }
    if (best) { const d = Math.sign(wrapDx(best.x - p.x)); if (d) return d; }
    return p.x > 210 ? -1 : 1;
  }

  function steer(g) {
    const p = g.p;
    // stuck recovery: sweep firmly in one direction for 3s (repositions the player across
    // the width — on the ground this is the only way to get under a reachable platform),
    // then expire and let normal steering (staging) take over. NOTE: steering off does NOT
    // kill a run while the player bounces on the infinitely-wide ground, so this is a
    // repositioning aid, not a run-ender.
    if (B.giveUp) {
      if (performance.now() > B.giveUpUntil) { B.giveUp = false; B.stuck = false; B.lastScoreTime = performance.now(); say('sweep done — staging resumes'); }
      else {
        if (performance.now() - B.giveUpAt > 1500) { B.giveUpDir = -B.giveUpDir; B.giveUpAt = performance.now(); }
        // bypass min-hold: force the direction now
        const now = performance.now();
        if (B.held !== B.giveUpDir && now - B.lastFlip >= 0) {
          B.lastFlip = 0;
          setDir(B.giveUpDir);
        }
        return;
      }
    }
    // jetpack: rocket up, aim for the highest landable platform in view
    if (g.pu && g.pu.k === 'jet') {
      let best = null;
      for (const pl of g.plats) {
        if (!landable(pl) || pl.y < p.y) continue;
        if (!best || pl.y > best.y) best = pl;
      }
      if (best) steerToDx(wrapDx(moverX(best, 0.5) - p.x));
      else setDir(0);
      return;
    }
    // double jump: falling with nothing reachable below and death close -> air jump
    if (g.pu && g.pu.k === 'dbl' && g.pu.n > 0 && p.vy < -50 && p.land <= 0) {
      const below = g.plats.filter(q => landable(q) && q.y < p.y && q.y > p.y - 500);
      const near = below.some(q => Math.abs(wrapDx(q.x - p.x)) < q.w / 2 + 40);
      if (!near && p.y < g.cam + 220) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true })), 60);
        say('AIRJUMP at y=' + Math.round(p.y) + ' score=' + g.score);
      }
    }
    // target management: one clean decision per bounce (edge), plus invalid / passed / much-better
    const t = B.target;
    const bounced = B.prevLand <= 0 && p.land > 0;
    // passed: falling and already below the target's height — the target is unreachable
    // this bounce, switch to survival NOW (was: 40px margin, which wasted ~0.1s steering
    // at a dead target while the survival platform below slipped away).
    const passed = t && p.vy < 0 && p.y < t.y - 5;
    const invalid = t && (!g.plats.includes(t) || !landable(t));
    let pick = null;
    if (!t || invalid || bounced || passed) {
      pick = pickTarget(g);
      if (pick) {
        B.target = pick.pl;
        B.targetV = pick.v;
      } else {
        B.target = null;
        B.targetV = 0;
        if (bounced) say('PICK-NULL at bounce score=' + g.score + ' py=' + Math.round(p.y) + ' vy=' + Math.round(p.vy));
      }
    } else {
      // mid-flight upgrade only if clearly better BY V-SCORE (v2.7: the old y-only check
      // could abandon a jet target for a higher plain platform — a jet is worth more
      // than 60px of height). Avoids oscillation.
      const now = performance.now();
      if (now - B.lastPickAt > 500) {
        B.lastPickAt = now;
        pick = pickTarget(g);
        if (pick && pick.v > (B.targetV || 0) + 60) { B.target = pick.pl; B.targetV = pick.v; }
      }
    }
    // v2.7: per-bounce decision log (saved in the run record) so a null target can be
    // traced to the exact bounce instead of guessed from the death snapshot.
    if (bounced) {
      B.bounceN = (B.bounceN || 0) + 1;
      const tg = B.target;
      B.decisions.push({
        b: B.bounceN, s: g.score,
        t: tg ? tg.type : null, ty: tg ? Math.round(tg.y) : null,
        dx: tg ? Math.round(wrapDx(moverX(tg, 0) - p.x)) : null,
        pu: tg && tg.pu ? tg.pu : null,
        vx: Math.round(p.vx), nullPick: !pick && !tg ? 1 : 0,
      });
    }
    // v2.7b DEAD-END fast-end: a null pick at a bounce means no landable platform above
    // within this bounce's rise (staging already checked) — the run cannot progress.
    // End it fast instead of bouncing in place for 25s until the stuck detector fires
    // (run #10 wasted 25s on a dead-end green). Require 2 consecutive null bounces to
    // guard against a one-off glitch. Only above score 100 (the ground zone always has
    // a platform above within reach).
    if (bounced && !B.target && g.score > 100) {
      B.deadEndN = (B.deadEndN || 0) + 1;
      if (B.deadEndN >= 2 && !B.giveUp) {
        say('DEAD-END at score=' + g.score + ' — no platform above within rise, ending run fast');
        B.giveUp = true; B.stuck = true;
        B.giveUpDir = sweepDir(g);
        B.giveUpAt = performance.now();
        B.giveUpUntil = performance.now() + 3000;
        B.target = null; B.targetV = 0;
      }
    } else if (B.target) {
      B.deadEndN = 0;
    }
    const tgt = B.target;
    if (!tgt || !g.plats.includes(tgt)) {
      // No target. While falling, steer toward the HIGHEST reachable platform below
      // (v2.7: the old fallback picked the NEAREST by raw dx using the mover's CURRENT x
      // — for a mover that is wrong by up to ~100px, and it could pick a platform already
      // below the death line). Holding dir 0 while falling is a guaranteed death.
      // While rising, hold still.
      if (p.vy < 0) {
        let best = null;
        for (const q of g.plats) {
          if (!landable(q) || q.y > p.y) continue;
          if (q.y < g.cam - 90 + 30) continue; // below the death line: unreachable
          const dy = p.y - q.y;
          if (dy > 520) continue;
          const tq = (p.vy + Math.sqrt(p.vy * p.vy + 2 * G * dy)) / G;
          const qx = moverX(q, tq);
          const v = q.y - Math.abs(wrapDx(qx - p.x)) * 0.3;
          if (!best || v > best.v) best = { q, v, qx };
        }
        if (best) steerToDx(wrapDx(best.qx - p.x));
        else setDir(0);
      } else setDir(0);
      return;
    }
    // steer toward target's predicted x at landing time
    const dy = tgt.y - p.y;
    let tArr;
    if (p.vy > 0 && dy > 0) tArr = tLand(p.vy, dy);
    else if (dy <= 0) {
      const disc = p.vy * p.vy + 2 * G * (-dy);
      tArr = (p.vy + Math.sqrt(Math.max(0, disc))) / G;
    } else tArr = 0.25;
    if (!isFinite(tArr) || tArr <= 0) tArr = 0.25;
    const tx = moverX(tgt, Math.min(tArr, 1.2));
    // LANDING-PREDICTION steering (v2.5): steer on where the player will LAND if the keys
    // are released now (free drift), not on the current offset. Releasing at |dx|<6 with
    // vx=500 drifts ~80px past the target — that overshoot is what missed narrow platforms
    // (w=63-67 at altitude). The free-drift prediction already contains the drift, so the
    // controller brakes at the right moment instead of oscillating around the target.
    const xLand = predXFree(p.x, p.vx, tArr);
    const dxLand = wrapDx(tx - xLand);
    // emergency correction: falling fast and the target is the other way — bypass the
    // 80ms min-hold, otherwise the flip lands ~100ms late and the run is already over
    // (run #2 died 2px below the line).
    if (p.vy < -300 && B.held !== 0 && Math.sign(dxLand) === -B.held && Math.abs(dxLand) > ENGAGE_PX) B.lastFlip = 0;
    steerToLanding(dxLand);
  }

  // Diagnostic snapshot: player, target, platforms above/below — printed on STUCK so a
  // freeze can be diagnosed from the actual configuration instead of guessed at.
  B.diag = function () {
    const g = B.g;
    if (!g) return null;
    const p = g.p;
    const fmt = q => ({ type: q.type, y: Math.round(q.y), x: Math.round(q.x), w: Math.round(q.w),
      dx: Math.round(wrapDx(q.x - p.x)), tip: q.tip != null, broken: !!q.broken, vx: q.vx ? Math.round(q.vx) : 0 });
    const above = g.plats.filter(q => q.y > p.y - 5).sort((a, b) => a.y - b.y).slice(0, 8).map(fmt);
    const below = g.plats.filter(q => q.y <= p.y - 5).sort((a, b) => b.y - a.y).slice(0, 3).map(fmt);
    return {
      score: g.score, maxY: Math.round(g.maxY), cam: Math.round(g.cam),
      p: { x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), land: +p.land.toFixed(2) },
      pu: g.pu ? g.pu.k : null, held: B.held, giveUp: B.giveUp,
      target: B.target ? fmt(B.target) : null,
      above, below,
    };
  };

  function snapshotDeath(g) {
    const p = g.p;
    const below = g.plats.filter(q => landable(q) && q.y <= p.y + 10)
      .sort((a, b) => b.y - a.y).slice(0, 4)
      .map(q => ({ type: q.type, y: Math.round(q.y), dx: Math.round(wrapDx(q.x - p.x)), w: Math.round(q.w) }));
    const above = g.plats.filter(q => landable(q) && q.y > p.y)
      .sort((a, b) => a.y - b.y).slice(0, 3)
      .map(q => ({ type: q.type, y: Math.round(q.y), dx: Math.round(wrapDx(q.x - p.x)), w: Math.round(q.w) }));
    return {
      score: g.score, maxY: Math.round(g.maxY), py: Math.round(p.y), cam: Math.round(g.cam),
      gapBelowCam: Math.round(p.y - (g.cam - 90)),
      target: B.target ? { type: B.target.type, y: Math.round(B.target.y) } : null,
      pu: g.pu ? g.pu.k : null, steps: g.steps,
      below, above,
    };
  }

  // Snapshot everything needed to replay this run offline (server-side verification equivalent).
  function snapshotRun(g) {
    let items = [], spread = 1;
    try {
      if (g.runBounty && Array.isArray(g.runBounty.items)) items = g.runBounty.items;
      if (typeof g.btySpread === 'function') spread = g.btySpread();
      else if (g.runBounty && typeof g.runBounty.spread === 'number') spread = g.runBounty.spread;
    } catch (e) {}
    return {
      seed: g.runSeed,
      log: g.rec ? g.rec.slice() : null,
      rv: g.recRv == null ? null : g.recRv,
      steps: g.recN,
      items, spread,
      score: g.score, maxY: Math.round(g.maxY),
    };
  }

  let lastPhase = '';
  function tick() {
    if (!B.on) return;
    requestAnimationFrame(tick);
    const g = B.g || (B.g = findGame());
    if (!g) return;
    B.tickCount++;
    const ph = g.state.phase;
    if (ph !== lastPhase) {
      say('phase ' + lastPhase + ' -> ' + ph + ' score=' + g.score);
      if (ph === 'link' && B.localTest) {
        say('START REJECTED: start API answered 401 -> link phase. In localTest the start API must be UNREACHABLE (route.abort) so the client falls back to offline mode. Stopping.');
        B.on = false; releaseKeys();
      }
      if (ph === 'play' && (lastPhase === 'title' || lastPhase === 'over' || lastPhase === 'reboot')) {
        if (!g.state.entered) { g.enter(); say('entered was falsy at run start — enter() called'); }
        B.runStart = performance.now();
        B.target = null;
        B.targetV = 0;
        B.decisions = []; B.bounceN = 0; B.deadEndN = 0;
        B.prevLand = 0; B.lastPickAt = 0;
        B.lastScore = 0; B.lastScoreTime = performance.now(); B.stuck = false; B.giveUp = false;
        B.runSnap = null;
        say('RUN START #' + (B.runsDone + 1) + ' seed=' + g.runSeed + ' token=' + (g.runTok ? 'YES' : 'OFFLINE'));
      }
      if (ph === 'dying' && lastPhase === 'play') {
        B.deathInfo = snapshotDeath(g);
        B.runSnap = snapshotRun(g);
        say('DIED score=' + g.score + ' maxY=' + Math.round(g.maxY) + ' death=' + JSON.stringify(B.deathInfo));
        say('SNAP seed=' + B.runSnap.seed + ' steps=' + B.runSnap.steps + ' logLen=' + (B.runSnap.log ? B.runSnap.log.length : null) + ' rv=' + B.runSnap.rv);
      }
      if (ph === 'over' && lastPhase !== 'over') {
        const run = {
          n: B.runsDone + 1, score: g.score, maxY: Math.round(g.maxY),
          steps: g.steps, durSec: Math.round((performance.now() - B.runStart) / 1000),
          token: !!g.runTok, res: g.state.res ? { rank: g.state.res.rank, best: g.state.res.best, note: g.state.res.note || null } : null,
          death: B.deathInfo, snap: B.runSnap, dec: B.decisions,
        };
        B.runs.push(run);
        B.runsDone++;
        say('RUN #' + run.n + ' DONE score=' + run.score + ' maxY=' + run.maxY + ' dur=' + run.durSec + 's token=' + (run.token ? 'YES' : 'OFFLINE') + ' res=' + JSON.stringify(run.res));
        B.target = null; B.targetV = 0;
        releaseKeys();
        if (B.runsDone < B.maxRuns) {
          setTimeout(() => { if (B.on && B.g && B.g.state.phase === 'over') { say('restarting run #' + (B.runsDone + 1)); B.g.play(); } }, 1500);
        } else {
          B.on = false;
          say('ALL RUNS DONE best=' + Math.max(...B.runs.map(r => r.score)));
        }
      }
      if (ph === 'cont' && lastPhase !== 'cont') {
        const sc = g.score, cards = g.cards ? g.cards() : 0;
        say('CONTINUE OFFER score=' + sc + ' cards=' + cards + ' useContinue=' + B.useContinue);
        setTimeout(() => {
          if (!B.g || B.g.state.phase !== 'cont') return;
          if (B.useContinue && cards > 0 && sc >= 500) {
            say('REBOOT (continue) at score=' + sc);
            window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
            setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true })), 60);
          } else {
            say('GIVE UP continue (cards=' + cards + ', score=' + sc + ')');
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true })), 60);
          }
        }, 800);
      }
      lastPhase = ph;
    }
    if (ph === 'play' && !g.dead) {
      // stuck detection: score frozen 25s -> steer off the platform so the run ends, move on
      const now = performance.now();
      if (g.score > B.lastScore) { B.lastScore = g.score; B.lastScoreTime = now; B.stuck = false; B.giveUp = false; }
      else if (!B.stuck && now - B.lastScoreTime > 25000) {
        B.stuck = true; B.giveUp = true;
        // v2.7: sweep TOWARD the nearest landable platform below (a chance to land and
        // continue) instead of a blind direction — run #10's blind sweep off a dead-end
        // green was a guaranteed death with no platform below.
        B.giveUpDir = sweepDir(g);
        B.giveUpAt = performance.now();
        B.giveUpUntil = performance.now() + 3000; // sweep 3s, then normal steering (staging) resumes
        B.target = null; B.targetV = 0; // force a fresh staging pick
        say('STUCK score=' + g.score + ' frozen 25s — sweeping 3s to reposition, then staging resumes');
        say('DIAG ' + JSON.stringify(B.diag()));
      }
      steer(g);
      B.prevLand = g.p.land;
    } else if (ph !== 'play') {
      if (B.held !== 0) releaseKeys();
      B.prevLand = g.p.land;
    }
  }

  B.start = function (opts) {
    opts = opts || {};
    B.maxRuns = opts.maxRuns || 10;
    B.useContinue = !!opts.useContinue;
    B.localTest = !!opts.localTest;
    B.runsDone = 0; B.runs = []; B.log = [];
    B.g = findGame();
    if (!B.g) { say('ERROR game not found'); return false; }
    say('game found, phase=' + B.g.state.phase + ' handle=' + (B.g.state.handle || '(none)'));
    if (B.localTest && !B.g.state.handle) {
      B.g.setState({ handle: 'LOCALTEST' });
      say('localTest: handle set to LOCALTEST (offline runs, NOT saved)');
    }
    B.on = true;
    lastPhase = B.g.state.phase;
    // ENTER FIRST: the game's key handler ignores ArrowLeft/ArrowRight entirely while
    // state.entered is falsy (logic.js key(): `if (!this.state.entered) return;`).
    // Calling g.play() directly bypasses the ENTER button, so keys stay dead and the
    // player bounces in place at x=210 forever (vx=0) — that was the 23/56/65 freeze.
    if (!B.g.state.entered) {
      B.g.enter();
      say('enter() called (entered was falsy — arrow keys are ignored until entered)');
    }
    requestAnimationFrame(tick);
    setTimeout(() => {
      if (!B.on) return;
      const g = B.g;
      if (g && (g.state.phase === 'title' || g.state.phase === 'over')) {
        say('starting first run via play() (entered=' + g.state.entered + ')');
        g.play();
      }
    }, 1100); // >800ms so entered flips 'out' -> true before the run starts
    return true;
  };
  B.stop = function () { B.on = false; releaseKeys(); say('stopped'); };
  B.status = function () {
    const g = B.g;
    return {
      on: B.on, runsDone: B.runsDone, maxRuns: B.maxRuns,
      phase: g ? g.state.phase : null, score: g ? g.score : null,
      best: B.runs.length ? Math.max(...B.runs.map(r => r.score)) : 0,
      runs: B.runs,
    };
  };
  // Test hook: pure decision functions, for offline unit tests (no gameplay effect).
  B._test = { landNeed, moverX, chainAbove, chain1, pickTarget, tLand, predXFree, predX, bounceVy, RISE, wrapDx, landable };
  console.log('[BOT] v2.7b installed. window.__NULLS_BOT__.start({maxRuns:10, localTest:true})');
})();

// Autostart (trial): wait until the game shows the player as logged in, then start 30 runs once.
(function () {
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    try {
      if (window.__NULLS_BOT__ && !window.__NULLS_BOT__.on && document.body &&
          document.body.innerText.indexOf('PLAYING AS') !== -1) {
        clearInterval(iv);
        window.__NULLS_BOT__.start({ maxRuns: 30, localTest: false, useContinue: false });
        console.log('[BOT] autostarted 30 runs');
      }
    } catch (e) {}
    if (tries > 120) clearInterval(iv);
  }, 1000);
})();
