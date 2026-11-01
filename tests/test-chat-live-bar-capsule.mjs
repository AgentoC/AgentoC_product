#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const liveStatusCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-live-status.css'), 'utf8');
const liveStatusUi = readFileSync(join(repoRoot, 'static', 'chat', 'live-status-ui.js'), 'utf8');
const chatMessagesCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');
const decisionSheetCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-decision-sheet.css'), 'utf8');

assert.match(liveStatusUi, /const LIVE_BAR_VISIBLE_MS = 10000;/, 'running Live Bar should keep a 10s full-width window');
assert.match(liveStatusUi, /const LIVE_BAR_CAPSULE_ANIMATION_MS = 320;/, 'capsule fold/expand should have a compact motion duration');
assert.match(liveStatusUi, /let liveBarCapsule = false;/, 'Live Bar should track capsule state separately from hidden state');
assert.match(liveStatusUi, /let liveBarCapsuleMotionTimer = null;/, 'capsule motion should track its own cleanup timer');
assert.doesNotMatch(liveStatusUi, /syncLiveBarCollapseOrbTravel/, 'the orb is carried to the capsule center by the shell width/padding transition, so no bespoke orb-travel measurement should remain');
assert.doesNotMatch(liveStatusUi, /--live-bar-orb-collapse-x/, 'the orb no longer uses a measured translateX; removing it kills both the collapse fling-and-clip and the expand label overlap');
assert.match(liveStatusUi, /function collapseLiveBarToCapsule\(el\)[\s\S]*?liveBarCapsule = true;[\s\S]*?setLiveBarCapsuleMotion\(el, "collapsing"\);[\s\S]*?el\.dataset\.collapsed = "capsule";/, 'capsule collapse should commit the real state immediately and let the base transition animate width/height/padding/roundness down, mirroring expand');
assert.doesNotMatch(liveStatusUi, /liveBarCapsuleMotionTimer = setTimeout\(\(\) => \{[\s\S]*?if \(!liveBarCapsule \|\| el\.hidden \|\| el\.dataset\.capsuleMotion !== "collapsing"\)/, 'capsule collapse must not use a deferred timer with conditional checks; the new implementation commits the state immediately');
assert.match(liveStatusUi, /if \(getLiveBarPrefersReducedMotion\(\)\) \{[\s\S]*?el\.dataset\.collapsed = "capsule";[\s\S]*?delete el\.dataset\.capsuleMotion;[\s\S]*?return;/, 'reduced-motion users should get an immediate capsule state without a delayed no-op animation');
assert.match(liveStatusUi, /setTimeout\(\(\) => collapseLiveBarToCapsule\(el\), LIVE_BAR_VISIBLE_MS\)/, 'running Live Bar auto timer should target the capsule state');
assert.match(liveStatusUi, /function scheduleLiveBarAutoHide\(el, status\)[\s\S]*?if \(hasLiveBarProgress\(status\)\) return;[\s\S]*?setTimeout\(\(\) => collapseLiveBarToCapsule\(el\), LIVE_BAR_VISIBLE_MS\)/, 'Live Bar should not schedule capsule collapse while it is showing execution progress');
assert.match(liveStatusUi, /if \(progressActive\) \{[\s\S]*?clearLiveBarAutoHideTimer\(\);[\s\S]*?\} else if \(progressModeChanged\) \{[\s\S]*?scheduleLiveBarAutoHide\(el, status\);/, 'Live Bar should restore the ten-second capsule timer only after progress disappears');
assert.match(liveStatusUi, /if \(liveBarCapsule\) \{[\s\S]*?setLiveBarCapsuleMotion\(el, "expanding"\);[\s\S]*?clearLiveBarCapsule\(el\);[\s\S]*?\}/, 'progress appearing while the Live Bar is a capsule should expand it back to the full bar');
assert.match(liveStatusUi, /function expandLiveBarFromCapsule\(el\)[\s\S]*?setLiveBarCapsuleMotion\(el, "expanding"\);[\s\S]*?clearLiveBarCapsule\(el\);[\s\S]*?scheduleLiveBarAutoHide\(el, status\);/, 'click expansion should animate back into the full bar and schedule another capsule collapse');
assert.match(liveStatusUi, /function activateLiveBar\(el\)[\s\S]*?if \(liveBarCapsule\)[\s\S]*?expandLiveBarFromCapsule\(el\)/, 'capsule should expand through the shared click activator');
assert.match(liveStatusUi, /el\.addEventListener\("click", \(\) => activateLiveBar\(el\)\);/, 'clicks should route through the shared Live Bar activator');
assert.match(liveStatusUi, /if \(\(liveBarAutoHidden \|\| liveBarCapsule\) && !enteredSession && !visualStatusChanged\) \{[\s\S]*?if \(contentChanged\) updateLiveBarStatusLabel\(el, status\);[\s\S]*?return;/, 'steady capsule updates should preserve the compact view while allowing label refreshes');
assert.match(liveStatusUi, /function transitionLiveBarCapsuleToStatus\(el, status, key\)[\s\S]*?classList\.add\("is-capsule-exiting"\)[\s\S]*?clearLiveBarCapsule\(el\);[\s\S]*?renderLiveBarStatusContent\(el, status\);[\s\S]*?revealLiveBar\(el\);/, 'running capsule should retract to the composer before the next non-running Live Bar reveals');
assert.match(liveStatusUi, /if \(liveBarCapsule && visualStatusChanged && !enteredSession && key !== "running"\) \{[\s\S]*?transitionLiveBarCapsuleToStatus\(el, status, key\);[\s\S]*?return;/, 'status changes out of running capsule should use the two-step exit/reveal motion');
assert.doesNotMatch(liveStatusUi, /\u0000/, 'Live Bar status signature should avoid NUL-like separators in source text');

assert.match(liveStatusCss, /\.live-bar\s*\{[\s\S]*?--live-bar-capsule-size:\s*var\(--touch-min,\s*44px\);[\s\S]*?width:\s*calc\(100% - \(var\(--chat-gutter\) \* 2\)\);[\s\S]*?max-width:\s*calc\(100% - \(var\(--chat-gutter\) \* 2\)\);/, 'full Live Bar should have explicit width and max-width so width can transition smoothly in both collapse and expand');
assert.match(liveStatusCss, /\.live-bar\[data-collapsed="capsule"\]\s*\{[\s\S]*?margin-left:\s*auto;[\s\S]*?margin-right:\s*auto;[\s\S]*?width:\s*var\(--live-bar-capsule-size\);[\s\S]*?height:\s*var\(--live-bar-capsule-size\);[\s\S]*?border-radius:\s*999px;[\s\S]*?cursor:\s*pointer;/, 'capsule should render as a centered circular button matching Live Bar height');
assert.match(liveStatusCss, /\.live-bar\[data-collapsed="capsule"\] \.live-bar__label\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?flex:\s*0 0 0;/, 'capsule should hide the label (elapsed is hidden separately; orb stays) and keep a 44px tap target');
assert.match(liveStatusCss, /\.live-bar\s*\{[\s\S]*?transition:[\s\S]*?width 320ms cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\),[\s\S]*?max-width 320ms cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\),[\s\S]*?height 320ms cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\),[\s\S]*?border-radius 320ms cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\),/, 'capsule should smoothly animate width, max-width, height and roundness in both directions');
assert.match(liveStatusCss, /\.live-bar\[data-collapsed="capsule"\]\s*\{[\s\S]*?padding:\s*calc\(\(var\(--live-bar-capsule-size\) - 22px\) \/ 2\);/, 'capsule should center the versioned 22px orb with padding (border-box) so the orb stays a normal in-flow flex item instead of being absolutely positioned');
assert.doesNotMatch(liveStatusCss, /\.live-bar\[data-collapsed="capsule"\]\s*\{[^}]*justify-content:\s*center/, 'capsule must not flip justify-content to center — that instant baseline jump is what flung the orb out of the shrinking shell during collapse');
assert.doesNotMatch(liveStatusCss, /\.live-bar\[data-capsule-motion[^{]*\]\s*\.live-bar__orb\s*\{[\s\S]*?position:\s*absolute/, 'orb must stay in flex flow during capsule motion so the label always reserves its space beside the orb (absolute positioning made the label overlap the orb on expand)');
assert.doesNotMatch(liveStatusCss, /@keyframes live-bar-orb-slide-(to|from)-capsule/, 'orb slide keyframes are removed; the shell width/padding transition carries the orb from the left slot to the capsule center in both directions');
assert.doesNotMatch(liveStatusCss, /--live-bar-orb-collapse-x/, 'no measured orb translateX remains in the CSS; collapse and expand are the same shell transition reversed');
assert.match(liveStatusCss, /\.live-bar\[data-capsule-motion="collapsing"\]\s*\{[\s\S]*?pointer-events:\s*none;/, 'collapse should block pointer-events during the motion');
assert.doesNotMatch(liveStatusCss, /\.live-bar\[data-capsule-motion="collapsing"\]\[data-collapsed="capsule"\]\s*\{[\s\S]*?transition:\s*none;/, 'collapse must not disable transitions; the base .live-bar transition should animate the real width/height/roundness');
assert.doesNotMatch(liveStatusCss, /@keyframes live-bar-shell-fold-to-capsule/, 'the old clip-path shell-fold animation has been removed; collapse now uses real property transitions');
assert.match(liveStatusCss, /\.live-bar-slot\.is-capsule-exiting \.live-bar\s*\{[\s\S]*?animation:\s*live-bar-capsule-exit-to-composer/, 'capsule should have a dedicated retract-to-composer animation');
assert.match(liveStatusCss, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.live-bar\[data-capsule-motion="collapsing"\],[\s\S]*?\.live-bar\[data-capsule-motion\] \.live-bar__orb,[\s\S]*?\.live-bar\[data-state="danger_pending"\] \{ animation:\s*none; \}/, 'capsule transitions and the danger attention pulse should respect reduced motion');

// Regression guard (2026-08-05): the capsule fold/expand animates via the base
// `.live-bar` transition (width/height/border-radius/padding at 320ms). A bare
// `#liveBar { transition: ... }` shorthand in another stylesheet outranks
// `.live-bar` by ID specificity (1,0,0 > 0,1,0) AND the shorthand replaces the
// whole transition list — so it silently wipes the capsule transitions and the
// fold/expand snaps instead of animating. The decision-sheet opacity fade must
// ride the base `.live-bar` transition (which lists `opacity 160ms ease`), never
// a competing ID-selector shorthand.
assert.doesNotMatch(decisionSheetCss, /#liveBar[^{]*\{[^}]*\btransition\s*:/, 'no #liveBar rule may declare a transition shorthand — ID specificity would replace the whole .live-bar transition list and snap the capsule fold/expand');
assert.match(liveStatusCss, /\.live-bar\s*\{[\s\S]*?transition:[\s\S]*?opacity\s+160ms\s+ease;/, 'the decision-sheet opacity fade should be carried by the base .live-bar transition (opacity 160ms ease) so it does not need a clobbering #liveBar shorthand');

// 2026-08-06: the running-thinking text shimmer was removed by the calm
// persistent status motion pass — persistent status text stays still and
// readable, and only the orb/icon breathes. The global guard lives in
// test-chat-operation-reduced-motion.mjs; this file only ensures the sweep
// keyframes are gone so no future rule can silently resurrect the timing.
assert.doesNotMatch(chatMessagesCss, /@keyframes thinking-sweep/, 'the thinking text sweep keyframes are gone — persistent status text stays still');
assert.doesNotMatch(chatMessagesCss, /\.thinking-label[^}]*animation:\s*thinking-sweep/, 'thinking labels should not sweep');

console.log('test-chat-live-bar-capsule: ok');
