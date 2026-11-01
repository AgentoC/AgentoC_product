# Frontend Chat Architecture

This document describes the chat frontend under `static/chat/`. Verify the
details against the source and tests for the version in use.

Use it when you need to:

- change the chat UI without re-discovering where state lives
- decide whether logic belongs in the backend, the frontend model, or the render layer
- add a new frontend feature without mixing transport, orchestration, and DOM work again
- review whether a refactor keeps the frontend aligned with the product direction

It complements:

- `docs/architecture.md` — top-down project map
- `static/chat/session-store.js` — the actual reducer/store contract

---

## 1. Frontend thesis

AgentoC should not be a “thin frontend” in the simplistic sense.

The better target is:

- a protocol-light frontend
- with explicit client state
- that projects backend authority clearly
- without hiding orchestration in scattered globals and cross-file side effects

That means the frontend can stay fairly capable, but its capability must live in explicit boundaries.

---

## 2. State ownership

### 2.1 Server-authority projection

These facts are owned by the backend and projected into the browser:

- session records and ordering inputs
- session activity / queue / run state
- archived / pinned outcomes
- message and display-event timelines
- attachment metadata after upload / canonicalization
- share snapshot session payloads

Frontend code may cache or render these, but should converge back to backend HTTP state.

### 2.2 Client-owned coordination state

These are frontend-owned and may be reconstructed locally:

- current attached session id
- whether the current surface is attached yet
- sidebar tab selection
- source filter selection
- archived list loading / loaded flags
- shell-level derived status used by UI controls

This state belongs in the frontend store rather than scattered globals.

### 2.3 View-only ephemeral state

These should stay in render/UI code and should not leak into the shared shell state model:

- collapsed folder UI
- code-copy button state
- lazy body hydration flags
- rendered `runActivity` mirror, operation DOM indexes, and operation expansion state
- local textarea sizing
- attachment preview object URLs
- one-frame layout / scroll / expansion details

---

## 3. Layer contract

### 3.1 Model / state boundary

Files:

- `static/chat/session-store.js`
- `static/chat/composer-store.js`
- `static/chat/session-state-model.js`
- `static/chat/bootstrap.js`

Responsibilities:

- define canonical frontend shell state
- define canonical composer workflow state shared across render files
- perform pure state transitions
- expose one explicit write boundary for store-owned shell state
- keep fallback state synchronization in one place when tests run files without full bootstrap

`bootstrap.js` is the only file that should own the shell-state helper boundary:

- `replaceChatState(...)`
- `replaceActiveChatSessionsState(...)`
- `replaceArchivedChatSessionsState(...)`
- `upsertChatSessionState(...)`
- `removeChatSessionState(...)`
- `setChatCurrentSession(...)`
- `setChatArchivedSessionsLoading(...)`
- `setChatActiveSourceFilter(...)`
- `setChatActiveTab(...)`
- `setChatSessionStatus(...)`

`composer-store.js` owns the dedicated composer-state boundary:

- `setComposerActiveSession(...)`
- `setComposerDraftTextState(...)`
- `replaceComposerAttachmentsState(...)`
- `addComposerAttachmentsState(...)`
- `removeComposerAttachmentState(...)`
- `clearComposerSessionState(...)`
- `setComposerPendingSendState(...)`
- `patchComposerPendingSendState(...)`
- `clearComposerPendingSendState(...)`

### 3.2 Cross-device authentication and remote control

Phone and desktop share one owner identity, but Google sign-in and long-lived
remote control are separate security layers:

- Google is the identity proof. The phone and computer may each sign in to the
  same Google account, but the frontend must never treat a Google ID token as a
  permanent control credential.
- A QR shown by an unbound computer is a short-lived, one-time `account-claim`
  authorization challenge. It must not contain a Google token, an owner session
  cookie, or a permanent bearer credential. Same-account devices use
  `account-join` and do not scan.
- Long-lived control is represented by a trusted-device principal. Android
  keeps its private key in Android Keystore; the instance stores the public key
  and can revoke the device. Normal requests use a short-lived device
  credential renewed through the device challenge flow.
- A Google ID token is used only while binding or re-authenticating the device.
  It must not be written to frontend state, `localStorage`, the pairing QR
  payload, or the durable device record.

The supported user-facing authentication choices are:

1. **Phone and computer sign in to the same Google account.** The phone selects
   the exact discovered computer and completes an `account-join` intent without
   scanning. The server must authorize the target instance and device key;
   account equality must not become an unbounded machine takeover mechanism.
2. **The computer has no Google binding.** Its QR is an `account-claim`
   challenge. A phone already bound to the account authorizes that computer
   once; the computer then receives its own account binding and device
   credential. Later connections do not scan again.
3. **No verified Google identity.** A QR cannot create a long-lived binding or
   ordinary trusted-device connection.

The frontend projects these server-authoritative states instead of inferring
continuity from a successful scan or a locally cached token:

- `google_required`: the phone has no verified Google identity
- `qr_required`: a short-lived computer invitation is needed
- `verifying`: Google identity and device invitation are being checked
- `bound`: the phone has a trusted-device principal and may control the owner
  workbench
- `temporary_connected`: the phone reached the computer through QR without a
  verified Google identity; access expires within 10 minutes and is not bound
- `reconnect_required`: the device key exists but its short-lived access
  credential must be renewed
- `revoked`: the computer rejected the device; the user must pair again

Account, pairing, and device APIs remain adapter concerns. Their responses must
flow through the explicit shell-state boundary. Device names, QR rendering,
scan animation, and one-frame connection details remain view-only. After a
Google callback or QR redemption, the UI must perform a fresh server status
read before showing the phone as durably connected.

### 3.3 Adapter layer

Files:

- `static/chat/session-http.js`
- `static/chat/session-http-list-state.js`
- `static/chat/realtime.js`

Responsibilities:

- fetch backend resources
- decode transport responses / invalidation signals
- normalize payloads into frontend state transitions
- call the shell-state helper boundary instead of mutating shell globals directly

Rules:

- adapter files do not own shell state
- adapter files do not dispatch shell action types directly
- adapter files do not decide long-lived DOM state outside explicit render hooks

### 3.4 Catalog / selector layer

Files:

- `static/chat/bootstrap-session-catalog.js`

Responsibilities:

- derive filtered / grouped / sorted session views
- persist navigation/filter preferences
- bridge between shell state and UI-specific list decisions

This layer may keep small local mirrors for UI convenience, but shared shell state still flows through the store boundary.

### 3.5 Render layer

Files:

- `static/chat/session-list-ui.js`
- `static/chat/session-surface-ui.js`
- `static/chat/realtime-render.js`
- `static/chat/ui.js`
- `static/chat/sidebar-ui.js`
- `static/chat/compose.js`
- `static/chat/settings-ui.js`

Responsibilities:

- render current state
- capture user intent
- call adapter actions / shell helpers / composer helpers
- keep DOM-only behavior local

Render files should not become the hidden owner of cross-file shell state or composer workflow state.

---

## 4. Current file map

### 4.1 Good current anchors

- `static/chat/session-store.js` — explicit shell reducer/store
- `static/chat/composer-store.js` — explicit composer draft / attachment / pending-send reducer/store
- `static/chat/session-state-model.js` — reusable session activity/status semantics
- `static/chat/realtime-render.js` — mostly render-oriented timeline work
- `static/chat/session-surface-ui.js` — attached-session presentation helpers

### 4.2 Files that still mix concerns, but are now bounded better

- `static/chat/session-http.js` — still large, but shell-state writes now go through shared helpers
- `static/chat/realtime.js` — still mixes transport and command flow, but shell-state writes are narrowed
- `static/chat/bootstrap-session-catalog.js` — still bridges selectors and persistence, but now points at explicit shell state
- `static/chat/compose.js` — still combines send workflow and UI, but shared draft / attachment / pending-send state now routes through `static/chat/composer-store.js`
- `static/chat/sidebar-ui.js` — still owns attachment-picker DOM behavior, but no longer owns the attachment state container directly

---

## 5. Non-drift rules

When adding or refactoring frontend behavior:

1. If the state is shared across files, define its owner first.
2. If adapter code needs to change shell state, route it through the `bootstrap.js` helper boundary.
3. If a new feature adds durable or shared client state, extend the store/model before adding more globals.
4. If the state is purely presentational, keep it in render/UI code and do not promote it into shell state casually.
5. If a file starts doing transport + state mutation + DOM work together, split the responsibility before adding more logic.

---

## 6. What this round completes

This refactor round completes the shell-state boundary for the existing session/navigation surface:

- session list replacement
- archived list replacement
- session upsert / removal
- current-session attachment state
- sidebar tab and source filter state
- archived loading flags
- shell session status

It also completes a dedicated composer workflow slice for frontend-only shared state:

- per-session draft text mirror
- per-session queued attachment state
- pending send lifecycle state
- attachment add / remove / send / clear transitions

The composer send file still owns upload orchestration and DOM timing, but it no longer owns the shared composer state container itself.

---

## 7. Enforcement

The repo now carries a focused frontend boundary test:

- `tests/test-chat-frontend-state-boundary.mjs`
- `tests/test-chat-composer-store.mjs`
- `tests/test-chat-compose-draft.mjs`
- `tests/test-chat-sidebar-attachments.mjs`

These tests do not try to prove every UI detail. Their job is to make architectural drift visible when adapter files bypass the shared shell-state boundary again or when composer workflow state starts leaking back into ad hoc globals.

---

## 8. Live timeline projection

Live provider activity follows the same server-authority rule as the rest of the transcript:

- adapters preserve provider correlation IDs on durable events
- the server derives stable `operation` display events and one complete `runActivity`
- full and delta HTTP responses are canonical
- the browser indexes rendered operations by `operationId` and updates the existing node
- session snapshots cache `runActivity` and operation expansion state as reconstructible view state

The frontend must not infer command start/result pairing from tool names or DOM order. `operationUpdates` are complete replacements for already-rendered operations; they are applied in place before newly visible delta events are appended.

ActivityStrip is a current-state control surface, not transcript history. Its stop action reuses the existing cancel flow, and its target action locates the projected operation or pending approval. Motion is view-only and must pause in hidden tabs and under reduced-motion preferences.

Focused enforcement lives in:

- `tests/test-chat-operation-rendering.mjs`
- `tests/test-chat-run-activity-strip.mjs`
- `tests/test-chat-operation-reduced-motion.mjs`
- `tests/test-session-http-running-refresh.mjs`
- `tests/test-chat-live-activity-visual.mjs`
