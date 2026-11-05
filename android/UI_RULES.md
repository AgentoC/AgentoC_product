# Ragent Android UI Rules

> **Implementation reference**: See [the Android module overview](docs/README.md).

These rules are the platform contract for every Android feature Agent.

## Ownership

```text
StateFlow UiState -> Composable -> event -> ViewModel/reducer/repository -> StateFlow
```

Composable functions render immutable state and emit events. They do not parse protocol
payloads, perform network calls, write Room, or invent business status.

## Design system boundary

Feature code consumes `core:designsystem` and `core:agentui`. It must not instantiate
Material buttons, cards, text fields, colors, shapes, spacing, or motion timings directly.
Allowed spacing values are `4 / 8 / 12 / 16 / 24 / 32 / 48dp`. Allowed shapes are the
semantic `extraSmall / small / control / row / sheet / full` meanings exposed by the
design system. Exceptions belong in the component module, not in a screen.

## Timeline boundary

`core:timeline` owns stable sequence ordering, deduplication, stream replacement, scroll
anchor state, and unseen activity count. Feature screens only map timeline items to
`core:agentui`; they do not sort events or infer tool lifecycles from assistant text.

## State and motion

Running, waiting for approval, completed, failed, and disconnected are distinct semantic
states. Color is paired with text and icon. Motion is centralized in `MotionPolicy`, is
interruptible, uses shorter fades for reduced motion, and resolves immediately when motion is
disabled. Do not animate every token, reorder a streaming list, or use an infinite shimmer for
a waiting state.

## Acceptance

Every new screen supplies Preview coverage for compact and expanded windows, light and dark
states, and the main workflow states. Every consequential control has a semantic label,
minimum touch target, disabled/waiting state, and a Compose UI test or a documented reason
why a higher-level journey owns the assertion.
