---
name: AgentoC
description: Quiet, state-first Material 3 operational workbench for directing real AI work.
colors:
  primary: "#000000"
  on-primary: "#ffffff"
  primary-container: "#e6e9ef"
  surface: "#ffffff"
  surface-container: "#edf0f5"
  surface-container-high: "#e8ebf0"
  surface-container-highest: "#e2e6ed"
  on-surface: "#1f232a"
  on-surface-variant: "#555e6b"
  outline-variant: "#c8ced8"
  success: "#2f6b3c"
  success-container: "#c9e1cd"
  warning: "#805600"
  warning-container: "#ffdea6"
  error: "#ba1a1a"
  error-container: "#ffdad6"
typography:
  body:
    fontFamily: '"Inter", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", "WenQuanYi Zen Hei", ui-sans-serif, system-ui, sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
  control:
    fontFamily: '"Inter", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", "WenQuanYi Zen Hei", ui-sans-serif, system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 500
  label:
    fontFamily: '"Inter", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", "WenQuanYi Zen Hei", ui-sans-serif, system-ui, sans-serif'
    fontSize: "12px"
    fontWeight: 500
  meta:
    fontFamily: '"Inter", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", "WenQuanYi Zen Hei", ui-sans-serif, system-ui, sans-serif'
    fontSize: "11px"
    fontWeight: 400
  title:
    fontFamily: '"Inter", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", "WenQuanYi Zen Hei", ui-sans-serif, system-ui, sans-serif'
    fontSize: "18px"
    fontWeight: 600
rounded:
  extra-small: "4px"
  small: "8px"
  control: "12px"
  row: "16px"
  sheet: "28px"
  full: "999px"
  button-radius-ratio: "0.5"
spacing:
  grid: "4px"
  compact: "8px"
  standard: "12px"
  gutter: "16px"
  touch-target: "44px"
  decision-target: "52px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.full}"
    height: "44px"
  button-decision:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.full}"
    height: "52px"
  button-secondary:
    backgroundColor: "{colors.surface-container-highest}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.full}"
    height: "44px"
  input:
    backgroundColor: "{colors.surface-container}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.control}"
    height: "44px"
  interactive-row:
    backgroundColor: "{colors.surface-container}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.row}"
    height: "44px"
  sheet:
    backgroundColor: "{colors.surface-container-high}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.sheet}"
---

# Design System: AgentoC

## Overview

**Creative North Star: "The calm control desk."**

AgentoC is a user-facing control surface for real AI work. It helps a person understand what is happening, decide when a decision is needed, and recover safely when something changes. The interface must therefore feel calm and legible under repeated use; it is not a terminal, a dashboard of ornamental cards, or a visual imitation of an Android app.

Material 3 is the system behind that outcome, not a paint treatment. In AgentoC it means: semantic roles instead of local colors, shape as a signal of interaction and containment, tonal surfaces instead of decorative borders, visible state layers, and equal keyboard/touch access. Material's own guidance treats states as distinct interaction feedback and canonical layouts as adaptive scaffolds; this contract adapts those principles to a conversation-first operational workbench rather than copying a platform component library verbatim. [Material 3 states](https://m3.material.io/foundations/interaction/states/overview) and [canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview) are useful external references.

**Key Characteristics:**

- State first: say what changed, whether the person must act, and what happens next before exposing detail.
- Quiet by default: white or deep-neutral canvases, low-chroma containers, restrained elevation, and color reserved for semantics and deliberate action.
- One decision at a time: a task may have many details, but its immediate decision has one obvious place and one explicit action rail.
- Adaptive, not shrunken: desktop gains navigation/context; mobile preserves the same meaning with sheets, layers, safe areas, and thumb-reachable decisions.
- Safe to operate: notification, gesture, focus, disabled, error, success, and recovery states are part of the feature, not finishing polish.

### What the MD3 migration established

The migration happened in deliberate stages. The sequence matters because it records why later agents must not regress to a purely cosmetic interpretation of MD3.

| Stage | Established change | Lasting lesson |
| --- | --- | --- |
| Token foundation | `19439cf` introduced M3 theme presets, role mapping, and the Monet bridge. | Components consume roles; a theme palette must never make a component invent its own color system. |
| First semantic surfaces | `320747a`, then `53533f1` and `eff447e`, moved approvals and the broader frontend onto a late-loaded M3 component layer. | Keep stable DOM/event contracts while migrating appearance; tokenization is safer than a framework rewrite. |
| Surface convergence | `46395e1`, `118f88c`, `23d9b18`, `545c28c`, `20a77f5`, and `0478c55` covered composer, sidebar, messages, live state, reader, chrome, goal, and touch spacing. | M3 is a whole-workflow contract; styling one button or one modal is not completion. |
| Corrections from real use | `8ddf83f`, `3af3176`, `b476cb2`, `5047d35`, `55d57c9`, `cfdf747`, and `1c19847` restored useful material behavior, aligned control geometry, and clarified L1/L2 hierarchy. | Do not flatten functional context, nor make every rounded thing the same shape. Repeated-use ergonomics decide the rule. |
| Quiet semantic finish | `c72bb6d`, `8380e6c`, `9af64dc`, `020ed6d`, and `4835bec` neutralized light canvases and message bubbles, preserved workflow/status semantics across themes, unified success and warning roles, and made approvals/completions compact and intentional. | Personalization may change tone; it must not change workflow meaning or turn every status into an interruption. |

The normative implementation sources are `static/chat/chat-m3-tokens.css` (roles, themes, shape, elevation, compatibility aliases) and `static/chat/chat-m3-components.css` (late migration layer). Existing base styles remain compatibility layers. New frontend work must extend the semantic system there rather than creating a second token vocabulary or fighting the cascade with copied local values.

**The semantic-before-theme rule.** Theme color may identify an action or personalization, but completion, failure, waiting, unread, and action-required states keep their own workflow semantics. A monochrome, blue, purple, green, teal, rose, or Monet theme must not make a running state unreadable or a warning look like a normal primary action.

## Colors

AgentoC uses a restrained neutral foundation with Material role pairs. The light canvas is pure white; containers are cool neutral steps; dark themes use the corresponding deep-neutral steps. The default light values in the frontmatter are an inspection aid, not a second source of truth: explicit theme values live in the M3 token file.

### Role assignment

| Need | Use | Never substitute with |
| --- | --- | --- |
| Main affirmative action | `--sys-primary` and `--sys-on-primary` | An arbitrary theme hex or a status green |
| Selected/tonal action or user message surface | `--sys-primary-container` pair, or the neutral message tokens where supplied | Blur or saturated theme wash |
| Standard elevated/contained UI | the `--sys-surface-container-*` ladder | A new white card with a permanent heavy border |
| Secondary copy, timestamps, explanatory text | `--sys-on-surface-variant` | Reduced opacity on primary text when a semantic role exists |
| Error and destructive action | the `--sys-error*` family | Primary color, red text without a semantic container, or success/warning tokens |
| Success | the `--sys-success*` family | Theme primary or legacy `--success` literals |
| Caution / action needed | the `--sys-warning*` family | Generic yellow, a success green, or a broad page background tint |
| Live workflow state | `--status-running`, `--status-queued`, `--status-waiting`, `--status-done`, `--status-failed`, `--status-unread`, `--status-needs-action` | Any theme-derived primary/secondary role |

New component CSS should normally consume `--sys-*` semantic aliases. The lower-level `--m3-*` palette and older aliases exist to bridge the established stylesheet; they are not permission to add raw values to a component. Add a complete role pair/container family when a genuinely new meaning is required, and provide light, dark, and preset coverage before using it.

### State layers and contrast

Interactive feedback is an overlay/state treatment on the same semantic role, not a new random color: hover, focus-visible, pressed, selected, disabled, waiting, and error must stay recognizable in both light and dark themes. Use the existing M3 state tokens and focus treatment. Never rely on color alone: pair a workflow state with a clear label, icon, position, or text when the action is consequential.

**The quiet-canvas rule.** Do not flood the canvas, transcript, or all message bubbles with the selected theme color. Light themes remain white with faint neutral containers; dark themes remain deep neutral. User message bubbles are quiet tonal surfaces with no backdrop blur, not stronger glass panels.

## Typography

The local UI stack is intentional: Inter serves Latin copy, controls, and numerals, followed by explicit CJK fallbacks. Do not add a remote font dependency or replace the stack to chase a generic MD3 look.

| Role | Token/value | Use |
| --- | --- | --- |
| Body | 16px / 400 / 1.65 | Readable conversation, explanatory prose, and normal content. |
| Control | 14px / 500 | Buttons, fields, and compact operational controls. |
| Label | 12px / 500 | Short labels, section cues, and compact status context. |
| Meta | 11px / 400 | Timestamps and supporting metadata only; never a critical decision. |
| Title | 18px / 600 | Panel, sheet, or local task title. |
| Mono | local `--font-mono` stack | Commands, paths, code, and machine output only. |

Use sentence case, normal letter spacing, and natural Chinese line wrapping. Do not use all-caps micro-labels, negative tracking, tiny dense prose, or monospace for ordinary UI labels. Long CJK text, long English titles, paths, identifiers, code, and file lists must wrap or scroll inside their own content region rather than create horizontal page scrolling.

**The read-before-act rule.** A person must be able to understand the action and its consequence at normal body/control size before being asked to tap it. Do not hide consequential meaning in a tooltip, a hover-only detail, or 11px metadata.

## Layout

The conversation canvas is the primary work surface at every breakpoint. Desktop uses a list-detail scaffold: session navigation supports the selected conversation, and task detail opens as a focused Run Sheet or sheet when needed. Mobile uses one active surface at a time, with navigation and detail layered above it rather than squeezed into persistent columns. The retired Workbench Inspector is not a current destination; Run Sheet is the current run-detail surface.

### Spatial rules

- Use a 4px rhythm. Prefer 8px for compact gaps, 12px for control/content grouping, and 16px for normal gutters and local surface padding. Increase only when it reveals a meaningful hierarchy.
- Treat a transcript as content, not a stack of cards. Do not wrap each section in floating containers or nest cards simply to create separation.
- Preserve an explicit primary reading/action column. On desktop, supporting navigation may be adjacent; it must not visually compete with the active conversation.
- On mobile, primary decisions belong near the composer/bottom thumb zone when practical. Sheets use the viewport, dynamic viewport, safe-area inset, keyboard, and scroll state deliberately.
- Use sheets or portaled menus for contextual detail that would otherwise cover the transcript incorrectly. A portaled surface must stay anchored to its trigger after resize, keyboard change, orientation change, and scrolling.
- Do not use side-by-side diffs on mobile. Let code, tool output, and long details use an internal scroll region or a dedicated detail surface.
- Do not duplicate the same approval, retry, or execute action across Live Bar, a toast, a sheet, and message controls. Choose one primary entry point; other surfaces may disclose or navigate to it.

Representative visual checks are 360x800, 390x844, 430x932, 1024x768, and 1440x900 CSS pixels. Review light and dark themes when the surface supports both, and stress it with idle, running, waiting, approval, completed, empty, and error states plus Chinese, long English, paths, code, files, safe areas, keyboard, open sheet, menu, sidebar, and reader.

**The adaptive-not-shrunk rule.** Mobile is not a narrow desktop. Preserve the same state semantics while changing the arrangement to one-handed, one-surface-at-a-time operation.

## Elevation & Depth

Depth is primarily tonal: the surface/container ladder communicates hierarchy before shadow does. Use `--sys-surface`, then the low, container, high, and highest steps to distinguish canvas, local grouping, raised control, and transient surface. Reserve `--m3-elevation-1`, `-2`, and `-3` for a clear material relationship:

| Elevation | Use | Not for |
| --- | --- | --- |
| 1 | A contained message, plan, or small locally raised element | Every list row or text block |
| 2 | A toast or active floating utility | Simulating importance with a large shadow |
| 3 | A sheet, contextual menu, or attention/approval notification | A permanently elevated page section |

Borders are functional separators, not decoration. Inputs, explicit delimiters, and selected/error states may use a quiet semantic outline. Do not compensate for weak hierarchy with an inset hairline around every control or a dark frame around each card.

Functional glass is an explicit exception, not a global visual effect. The established composer and selected overlay/header contexts may use restrained translucency/blur when background context is genuinely useful. Most M3 cards, user message bubbles, code/tool surfaces, menus, Run Sheet, and notifications are tonal opaque surfaces with no backdrop blur. Diagnose stacking/portal problems instead of making a broken glass surface opaque by accident.

**The depth-earns-its-place rule.** A surface lifts only when it is transient, has its own interaction scope, or materially separates a decision from the transcript. It does not lift merely because it is a card.

## Shapes

Shape is a hierarchy of meanings. It is not a request to set one global border radius, and it is not permission to make every element a pill. The token scale is normative:

| Shape | Value | Meaning and use |
| --- | --- | --- |
| Extra-small | 4px | Small code/technical details only when the established component needs it. |
| Small | 8px | Small nested/local details where a softer control shape is too prominent. |
| Control | 12px | Inputs, select-like fields, option cards, compact action rows, code/tool blocks. |
| Row | 16px | Session/list rows, plan cards, content containers, and medium interactive groups. |
| Sheet | 28px | Bottom-sheet top corners, attention card, menus, and major floating surfaces. |
| Full | 999px | Icon circles, chips, and text-bearing command buttons whose radius is derived from height. |

### Button-radius contract

All text-bearing command buttons use the shared half-height ratio (`--mx-button-radius-ratio: 0.5`) rather than a copied pixel value. A 44px button resolves to a 22px radius; a 52px decision button resolves to a 26px radius. This keeps visual curvature coherent as a component changes height, while circular icon-only controls remain truly circular.

| Control type | Minimum target | Shape | Examples |
| --- | --- | --- |
| Icon-only action | 40px desktop; 44px mobile when primary/repeated | Circle/full | Header, composer, and concise message actions. |
| Standard labeled command | 44px | Half-height capsule | Normal affirmative, secondary, retry, or quiet commands. |
| Decision/approval/destructive rail | 52px | Half-height capsule | Approve, deny, execute, or a decisive mobile menu action. |
| Choice field/option | 44px | 12px control | A selectable answer, text field, or compact local option. |
| Content/list row | 44px or more as content requires | 16px row | A session, plan item, or contextual action row. |
| Sheet/menu/attention container | viewport/content driven | 28px sheet | A distinct temporary interaction scope. |

Do not make a content row a 999px capsule to look "more MD3." Do not make a 44px actionable row visually indistinguishable from plain static prose. Do not add one-off 10px, 14px, 18px, or 20px radii when a semantic token already applies.

**The geometry-explains-intent rule.** Full rounded shapes say "tap this command"; 12px says "edit or choose here"; 16px says "this is an item/group"; 28px says "you have entered a temporary interaction surface." If changing the radius changes that meaning, the component is using the wrong shape.

## Components

### Buttons and icon actions

Buttons represent an explicit command. Use a semantic HTML button unless a native control has a stronger accessible meaning. Primary commands use the primary pair; secondary/quiet commands use appropriate container roles; destructive commands use the error family only when the action itself is destructive. A disabled control must explain unavailable progress through visible state/copy where needed, not merely dim itself.

Every interactive button must have enabled, hover, focus-visible, pressed, disabled, and waiting/loading treatment. Use the existing M3 state overlays; focus-visible is never removed to achieve a borderless look. Icon-only controls use the shared 24px outline language from `static/chat/icons.js`, explicit flex centering, an accessible name, and a tooltip whenever the action is not universally obvious. Do not use Unicode symbols, text arrows, mixed filled glyphs, or one-off SVG styles.

### Composer and inputs

The composer is an ongoing work surface, not just a text box. Keep its established functional glass/material behavior only within the composer; preserve keyboard opening, dynamic viewport, safe area, scroll position, attachment state, sending, queued, failed, retry, and disabled states. The send action is singular and visually distinct. Supplementary composer controls stay compact but meet the target-size contract on mobile.

Fields and choice controls use the 12px control shape, semantic surface role, clear label/placeholder, visible focus ring, and explicit error/help text. Never use color alone for validation. `touch-action: manipulation` is appropriate for direct controls; do not suppress browser zoom, scrolling, or text selection without a concrete interaction reason.

### Messages, plans, code, and Run Sheet

Assistant content is primarily read, then acted on; user messages are quiet neutral/tonal acknowledgement surfaces with M3 elevation and no blur. Code, tool output, plans, and diffs must separate readable content from actions without nesting decorative cards. Keep message actions discoverable without covering selectable content; the touch action menu is a 28px temporary surface with 12px action rows.

Live Bar answers "what is happening now." Run Sheet answers "what happened and what can I do next." Do not invent a third competing run-detail destination. Use observable plans, files, tool events, and results; never claim hidden chain of thought.

### Notifications, approvals, and feedback

Notifications are an attention contract, not a generic banner system.

- Show an attention notification for a meaningful background-session decision or completion. Do not interrupt the foreground/open session for ordinary progress, a plan still progressing, or an action-required flag with no concrete request.
- Use `aria-live="assertive"` only for a real approval/decision that needs timely attention. Use `aria-live="polite"` and `role="status"` for completion or non-blocking system feedback. Never announce every streaming update.
- A decision notification may be keyboard focusable; a completion status is not an extra keyboard stop. Do not steal the user's original focus merely because a notification appeared.
- A tap/click on notification content discloses context; it must not execute. Approval, denial, retry, and destructive operations remain separate, plainly labeled buttons in the action rail.
- Decision actions are 52px full buttons. Completion feedback has one compact open/navigation action rather than duplicated generic actions.
- Escape dismisses the notification and restores the origin focus. Keyboard use has an equivalent for every pointer action.
- Swipe dismissal is permitted only as visible direct manipulation: start on the defined header/handle, follow the finger, cross a deliberate threshold, and snap back on a short/cancelled gesture. It must never be the only way to dismiss or reveal an action.
- System toast is brief, dismissible status feedback: one 52px capsule surface, semantic role-based colors, no legacy colored banner treatment, no text clipping, and reduced-motion support.

Approvals and decision sheets are attached near the composer/bottom decision zone on mobile because that is where the person can safely finish the next action. They do not duplicate commands already present elsewhere. For destructive or privileged paths, preserve the existing confirmation, explanation, and audit behavior; a visually quiet control is not permission to make a high-impact action casual.

### Sheets, menus, navigation, and focus

Sheets and menus form temporary interaction scopes. They use 28px top/outer geometry, tonal raised surfaces, appropriate elevation, Escape behavior, outside-pointer behavior where safe, focus containment when modal, and focus restoration when dismissed. On mobile, a bottom sheet has rounded top corners and a flush lower edge; do not make it a floating desktop dialog with all four corners and unsafe bottom spacing.

Session navigation uses item/row geometry, clear selection, unread/action-required state, and touch targets large enough for repeated use. Long press, context menu, swipe, and sidebar gestures are enhancements only: keep an equivalent visible/keyboard route, do not begin edge gestures from the composer, and never let gesture handling create accidental destructive actions.

### Responsive, motion, and accessibility release rules

Use `prefers-reduced-motion`: reduce nonessential opacity/transform animation, preserve state clarity, and never encode progress only in motion. Transitions should acknowledge a state change, not provide decoration. Verify semantic buttons, labels, roles, focus order, visible focus, Escape, Enter/Space, and touch behavior in the actual changed flow.

The current visual test matrix is part of component quality. For material changes, use the project visual-review skill and the focused test suites for M3 component roles, themes, send states, attention notifications, system toast, Live Bar, Run Sheet, messages, and responsive surfaces. Report source-tested, packaged/installed, and live-verified separately; a CSS screenshot passing does not claim deployment.

## Do's and Don'ts

### Do:

- **Do** begin a frontend change by finding the existing semantic role, shape, state model, and representative component. Extend those before adding a token, class, or new visual language.
- **Do** use `--sys-*` role pairs and the M3 shape/elevation tokens for new component styling; keep legacy aliases only as migration compatibility.
- **Do** derive a text button's radius from its resolved height through the shared half-height ratio. Use 44px minimum for ordinary primary touch targets and 52px for a decision rail.
- **Do** use 12px for fields/options, 16px for rows/content groups, and 28px for sheets/temporary scopes. Make icon-only buttons circular.
- **Do** place immediate choices close to the current work and give a person one unmistakable primary path, plus an explicit safe alternative where the workflow requires it.
- **Do** make completion quiet and decisions salient. Preserve focus, screen-reader priority, keyboard access, reduced motion, and gesture fallback as part of the component definition.
- **Do** review light/dark, mobile/desktop, state, long-content, safe-area, keyboard, and portal conditions before accepting a material UI change.
- **Do** preserve vanilla JS, local fonts, the existing DOM/event contracts, and source ordering. A visual migration must not silently change backend or interaction semantics.

### Don't:

- **Don't** use raw hex/rgb values, generic `--accent`, or a theme palette to convey workflow status when a semantic role exists.
- **Don't** make every component a card, every card glass, every surface blur, every text action a chip, or every rounded rectangle a pill.
- **Don't** restore the obsolete "strong sent-message glass" rule, the retired Workbench Inspector, or duplicated approval/action destinations.
- **Don't** turn a toast into a modal, a completion into an assertive announcement, or a notification-content tap into immediate execution.
- **Don't** remove `:focus-visible`, keyboard equivalents, labels, focus restoration, safe-area handling, or reduced-motion support in pursuit of a cleaner screenshot.
- **Don't** add decorative gradients, bokeh, hero-card composition, remote fonts, React/Vue/Tailwind, external UI frameworks, or a frontend build pipeline.
- **Don't** use a gesture for a destructive operation without a visible alternative and a deliberate confirmation/recovery path.
- **Don't** report a visual source change as deployed. Keep source-tested, hot-mounted, packaged/installed, and live-verified states distinct.
