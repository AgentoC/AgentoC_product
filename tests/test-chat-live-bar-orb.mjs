#!/usr/bin/env node
// Focused coverage for the Live Bar orb + Saturn ring visual experiment.
// Asserts: orb/ring CSS + SVG renderer exist; near ring arcs draw in front
// of the sphere while far arcs are sphere-occluded; only running animates
// (others static); collapsed running hides elapsed and keeps a >=44px tap
// target with preserved aria/clickable semantics; prefers-reduced-motion keeps
// a static orb without changing front/back ring color.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const liveStatusCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-live-status.css'), 'utf8');
const liveStatusUi = readFileSync(join(repoRoot, 'static', 'chat', 'live-status-ui.js'), 'utf8');

// --- orb + ring DOM/CSS exist ---
assert.match(liveStatusUi, /function createLiveBarOrb\(\)[\s\S]*?className = "live-bar__orb";[\s\S]*?createLiveBarSvgElement\("svg"/, 'Live Bar should build an SVG orb renderer');
assert.match(liveStatusUi, /live-bar__ring live-bar__ring--back[\s\S]*?live-bar__orb-sphere[\s\S]*?live-bar__ring live-bar__ring--front/, 'orb should render the globe sphere between depth-sorted running ring paths');
assert.doesNotMatch(liveStatusUi, /live-bar__vault-(?:shell|facet|window|core)/, 'the legacy globe orb should not retain Vault geometry');
assert.doesNotMatch(liveStatusUi, /live-bar__orb-raytrace|LIVE_BAR_ORB_RAYTRACE_SRC/, 'the legacy globe orb should not mount the Vault raytrace video');
assert.match(liveStatusCss, /\.live-bar__orb\s*\{[\s\S]*?display:\s*grid;/, 'orb container should be a centered grid');
assert.match(liveStatusUi, /createLiveBarSvgElement\("radialGradient"[\s\S]*?cx:\s*"50%"[\s\S]*?cy:\s*"50%"/, 'sphere should use a centered gradient, not an off-axis highlight');
assert.match(liveStatusCss, /\.live-bar__orb-sphere-stop-main\s*\{[\s\S]*?stop-color:\s*var\(--live-bar-orb-color\)/, 'sphere main color should follow the per-state --live-bar-orb-color token');
assert.match(liveStatusCss, /\.live-bar\s*\{[^}]*--live-bar-orb-color:\s*var\(--status-running(?:,\s*[^)]+)?\)/, 'running orb should stay blue via the default token');
assert.match(liveStatusCss, /\.live-bar\[data-state="done"\][^{]*\{[^}]*--live-bar-orb-color:\s*var\(--status-done(?:,\s*[^)]+)?\)/, 'done orb should adopt the green success token like the legacy breathing light');
assert.match(liveStatusCss, /\.live-bar\[data-state="failed"\][^{]*\{[^}]*--live-bar-orb-color:\s*var\(--status-failed(?:,\s*[^)]+)?\)/, 'failed orb should adopt the red error token like the legacy breathing light');
assert.match(liveStatusCss, /\.live-bar\[data-state="waiting_user"\][^{]*\{[^}]*--live-bar-orb-color:\s*var\(--status-waiting(?:,\s*[^)]+)?\)/, 'waiting orb should adopt the amber warning token like the legacy breathing light');
assert.match(liveStatusCss, /\.live-bar\s*\{[\s\S]*?background:\s*var\(--sys-surface-container-high,[\s\S]*?color:\s*var\(--sys-on-surface-variant,/, 'Live Bar should use one neutral M3 container and foreground in every workflow state');
assert.doesNotMatch(liveStatusCss, /\.live-bar\[data-state="(?:running|queued|waiting_user|done|failed|ready|plan_pending|danger_pending|approval_pending|awaiting_answer)"\]\s*\{[^}]*?(?:background|(?<!-)color|box-shadow)\s*:/, 'state-specific color belongs to the Orb, never the Live Bar shell or label');
assert.match(liveStatusCss, /\.live-bar\s*\{[\s\S]*?touch-action:\s*manipulation;[\s\S]*?-webkit-tap-highlight-color:\s*transparent;/, 'the directly tappable Live Bar should use the standard touch-response treatment');
assert.match(liveStatusCss, /\.live-bar:focus-visible\s*\{[\s\S]*?outline:\s*3px solid var\(--m3-state-focus,[\s\S]*?outline-offset:\s*3px;/, 'the keyboard-reachable Live Bar should retain a visible M3 focus treatment');
assert.doesNotMatch(liveStatusCss, /#dbeeff/i, 'sphere should not use the old near-white glass highlight');
assert.doesNotMatch(liveStatusCss, /radial-gradient\(circle at/, 'sphere should not use an off-axis reflective highlight');
assert.match(liveStatusCss, /\.live-bar__ring\s*\{[\s\S]*?stroke:\s*#fff;[\s\S]*?stroke-width:\s*2\.2;/, 'ring should be a thinner single white SVG stroke');
assert.match(liveStatusCss, /\.live-bar__ring\s*\{[\s\S]*?filter:\s*[\s\S]*?drop-shadow\(0 0 0\.85px rgba\(8,\s*23,\s*56,\s*0\.48\)\)[\s\S]*?drop-shadow\(0 0 2px rgba\(8,\s*23,\s*56,\s*0\.24\)\)/, 'ring should use a shared contrast halo so white remains consistent on light and dark surfaces');
assert.doesNotMatch(liveStatusCss, /(?:prefers-color-scheme|data-theme="dark")[\s\S]*?\.live-bar__ring/, 'ring front/back styling should not diverge by light or dark mode');
assert.doesNotMatch(liveStatusCss, /\.live-bar__ring--back\s*\{[\s\S]*?stroke:/, 'back ring path should inherit the same white stroke as the front path');
assert.doesNotMatch(liveStatusCss, /\.live-bar__ring--front\s*\{[\s\S]*?stroke:/, 'front ring path should not define a different stroke color');
assert.doesNotMatch(liveStatusCss, /\.live-bar__ring--(?:back|front)\s*\{[\s\S]*?opacity:/, 'front/back ring paths should not use opacity to fake depth');
assert.doesNotMatch(liveStatusCss, /\.live-bar__ring[\s\S]*?rgba\(255,\s*255,\s*255,\s*0\.[0-9]+/, 'ring should not use partially transparent white strokes');
assert.doesNotMatch(liveStatusCss, /\.live-bar__ring--(?:back|front)\s*\{[\s\S]*?clip-path:/, 'front/back ring paths should be depth-segmented by the renderer, not hard-clipped to fixed halves');

// --- 3D depth relationship: back < sphere < front ---
const svgAppend = liveStatusUi.match(/orbSvg\.append\(([^)]*)\)/);
assert.ok(svgAppend, 'orb SVG should append its paint layers explicitly');
assert.ok(svgAppend[1].indexOf('backRing') < svgAppend[1].indexOf('sphere'), 'back ring segments should paint before the globe sphere');
assert.ok(svgAppend[1].indexOf('sphere') < svgAppend[1].indexOf('frontRing'), 'front ring segments should paint after the globe sphere');
assert.match(liveStatusUi, /function buildLiveBarOrbRingPaths\(angles\)[\s\S]*?const frontPath = \[\];[\s\S]*?const backPath = \[\];/, 'ring renderer should split one logical ring into front/back paths');
assert.match(liveStatusUi, /const target = \(\(previous\.z \+ next\.z\) \/ 2\) >= 0 \? frontPath : backPath;/, 'ring renderer should classify each sampled segment by 3D depth');
assert.match(liveStatusUi, /LIVE_BAR_ORB_RING_SEGMENTS = 128/, 'ring should be sampled finely enough to avoid fixed half-ring bleed-through');
assert.doesNotMatch(liveStatusCss, /z-index:\s*3;[\s\S]*?sphere is the FINAL occluder/, 'orb should not regress to all ring strokes being hidden by a final sphere layer');

// --- only running animates; other states are static ---
assert.match(liveStatusCss, /\.live-bar\[data-state="running"\] \.live-bar__orb-sphere\s*\{[\s\S]*?animation:\s*live-bar-orb-breathe/, 'running globe sphere should breathe');
assert.match(liveStatusUi, /const LIVE_BAR_ORB_TUMBLE_MS = 6000;/, 'running ring tumble should keep the ~6s cadence');
assert.match(liveStatusUi, /function getLiveBarOrbAngles\(timeMs[\s\S]*?rotateX:[\s\S]*?rotateY:[\s\S]*?rotateZ:/, 'ring tumble should vary rotateX/rotateY/rotateZ in the renderer');
assert.match(liveStatusUi, /const fullTurn = cycle \* 360;/, 'running tumble should define one full turn per cycle');
assert.match(liveStatusUi, /const phase = cycle \* Math\.PI \* 2;/, 'running tumble should use a phase offset so full-axis rotations do not visually cancel');
const tumbleFormula = liveStatusUi.match(/rotateX:\s*(\d+) \+ fullTurn \+ Math\.sin\(phase\) \* (\d+),[\s\S]*?rotateY:\s*(-?\d+) \+ fullTurn \+ Math\.cos\(phase\) \* (\d+),[\s\S]*?rotateZ:\s*(\d+) \+ fullTurn - Math\.sin\(phase\) \* (\d+),/);
assert.ok(tumbleFormula, 'running pitch/yaw/roll should each complete 360° while adding phase-offset flip motion');
assert.match(liveStatusUi, /function shouldAnimateLiveBarOrb\(el, status\)[\s\S]*?status\?\.key === "running"/, 'ring renderer should animate only while the Live Bar state is running');
const sphereBase = liveStatusCss.match(/(?:^|\n)\.live-bar__orb-sphere\s*\{([\s\S]*?)\}/);
const ringBase = liveStatusCss.match(/(?:^|\n)\.live-bar__ring\s*\{([\s\S]*?)\}/);
assert.ok(sphereBase && ringBase, 'globe sphere and ring base styles should exist');
assert.doesNotMatch(sphereBase[1], /animation/, 'globe sphere should be static by default (only running animates)');
assert.doesNotMatch(ringBase[1], /animation/, 'ring should be static by default (only running animates)');
assert.doesNotMatch(ringBase[1], /transform/, 'ring should not rely on a flat CSS transform that cannot depth-sort front/back arcs');

const [
  ,
  rotateXBase,
  rotateXSwing,
  rotateYBase,
  rotateYSwing,
  rotateZBase,
  rotateZSwing,
] = tumbleFormula.map(Number);
const ringRadius = 18.8;
const viewBoxCenter = 22;
const sampleSegments = 128;

function degreesToRadiansForTest(degrees) {
  return (degrees * Math.PI) / 180;
}

function getTestOrbAngles(timeMs) {
  const cycle = ((Number(timeMs) || 0) % 6000) / 6000;
  const fullTurn = cycle * 360;
  const phase = cycle * Math.PI * 2;
  return {
    rotateX: rotateXBase + fullTurn + Math.sin(phase) * rotateXSwing,
    rotateY: rotateYBase + fullTurn + Math.cos(phase) * rotateYSwing,
    rotateZ: rotateZBase + fullTurn - Math.sin(phase) * rotateZSwing,
  };
}

function projectTestRingPoint(theta, angles) {
  const rotateX = degreesToRadiansForTest(angles.rotateX);
  const rotateY = degreesToRadiansForTest(angles.rotateY);
  const rotateZ = degreesToRadiansForTest(angles.rotateZ);
  const cosX = Math.cos(rotateX);
  const sinX = Math.sin(rotateX);
  const cosY = Math.cos(rotateY);
  const sinY = Math.sin(rotateY);
  const cosZ = Math.cos(rotateZ);
  const sinZ = Math.sin(rotateZ);
  const baseX = Math.cos(theta) * ringRadius;
  const baseY = Math.sin(theta) * ringRadius;
  const yAfterX = baseY * cosX;
  const zAfterX = baseY * sinX;
  const xAfterY = baseX * cosY + zAfterX * sinY;
  const zAfterY = -baseX * sinY + zAfterX * cosY;
  const xAfterZ = xAfterY * cosZ - yAfterX * sinZ;
  const yAfterZ = xAfterY * sinZ + yAfterX * cosZ;
  return {
    x: viewBoxCenter + xAfterZ,
    y: viewBoxCenter + yAfterZ,
    z: zAfterY,
  };
}

function getFrontCentroid(timeMs) {
  const angles = getTestOrbAngles(timeMs);
  let previous = projectTestRingPoint(0, angles);
  let xTotal = 0;
  let yTotal = 0;
  let count = 0;
  for (let index = 1; index <= sampleSegments; index += 1) {
    const next = projectTestRingPoint((index / sampleSegments) * Math.PI * 2, angles);
    if (((previous.z + next.z) / 2) >= 0) {
      xTotal += ((previous.x + next.x) / 2) - viewBoxCenter;
      yTotal += ((previous.y + next.y) / 2) - viewBoxCenter;
      count += 1;
    }
    previous = next;
  }
  return { x: xTotal / count, y: yTotal / count };
}

const frontAtStart = getFrontCentroid(0);
const frontAtQuarter = getFrontCentroid(1500);
const frontNearEnd = getFrontCentroid(5250);
assert.ok(
  Math.sign(frontAtStart.y) !== Math.sign(frontAtQuarter.y)
    && Math.abs(frontAtStart.y - frontAtQuarter.y) > 4.5,
  'front ring centroid should visibly flip from one vertical side to the other during the cycle',
);
assert.ok(
  Math.sign(frontAtQuarter.x) !== Math.sign(frontNearEnd.x)
    && Math.abs(frontAtQuarter.x - frontNearEnd.x) > 8,
  'front ring centroid should also exchange horizontal sides before the cycle repeats',
);

// --- collapsed running hides elapsed, keeps >=44px tap target + aria/clickable ---
assert.match(liveStatusCss, /\.live-bar\[data-collapsed="capsule"\]\s*\{[\s\S]*?width:\s*var\(--live-bar-capsule-size\);[\s\S]*?height:\s*var\(--live-bar-capsule-size\);[\s\S]*?min-height:\s*var\(--live-bar-capsule-size\);/, 'collapsed capsule should be a circular tap target matching the Live Bar height');
assert.match(liveStatusCss, /\.live-bar\[data-collapsed="capsule"\] \.live-bar__elapsed\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?flex-basis:\s*0;[\s\S]*?max-width:\s*0;/, 'collapsed running should smoothly hide elapsed seconds, showing only the orb');
assert.doesNotMatch(liveStatusCss, /\.live-bar\[data-collapsed="capsule"\] \.live-bar__elapsed\s*\{[\s\S]*?display:\s*none/, 'elapsed seconds should not disappear with display:none during the capsule transition');
assert.match(liveStatusUi, /function setLiveBarCapsuleA11y\(el, enabled\)/, 'capsule should have an a11y helper');
assert.match(liveStatusUi, /if \(enabled\)\s*\{[\s\S]*?setAttribute\("role", "button"\)[\s\S]*?tabIndex = 0/, 'collapsed capsule should expose button role + focusability');
assert.match(liveStatusUi, /function activateLiveBar\(el\)[\s\S]*?if \(liveBarCapsule\)[\s\S]*?expandLiveBarFromCapsule\(el\)/, 'collapsed capsule should route activation through the shared activator');
assert.match(liveStatusUi, /el\.addEventListener\("keydown"[\s\S]*?if \(event\.key === "Enter"[\s\S]*?activateLiveBar\(el\)/, 'collapsed capsule should be keyboard-activatable');

// --- reduced-motion keeps static orb without recoloring the ring ---
assert.match(liveStatusUi, /function getLiveBarPrefersReducedMotion\(\)[\s\S]*?matchMedia\("\(prefers-reduced-motion: reduce\)"\)[\s\S]*?matches === true/, 'Live Bar should have a shared reduced-motion check');
assert.match(liveStatusUi, /function getLiveBarOrbPrefersReducedMotion\(\)\s*\{[\s\S]*?return getLiveBarPrefersReducedMotion\(\);[\s\S]*?\}/, 'reduced motion should freeze the JS ring renderer through the shared check');
assert.match(liveStatusCss, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.live-bar\[data-state="running"\] \.live-bar__orb-sphere\s*\{\s*animation:\s*none/, 'reduced motion should freeze the running globe');
assert.doesNotMatch(liveStatusCss, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.live-bar__ring--(?:back|front)[\s\S]*?(?:opacity|stroke):/, 'reduced motion should not dim or recolor either ring path');

console.log('test-chat-live-bar-orb: ok');
