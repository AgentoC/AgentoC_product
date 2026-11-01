# Session-event fixtures (Stage 0)

Contract-shaped fixtures for the client-core extraction. They pin the **mechanics
the core must get right** — seq-cursor progression, delta filtering, the
merged-run reset trigger, and cross-channel dedup — so the same fixtures can feed
both Node core tests (Stage 1+) and a future native client's projection tests.

## What these are (and are not)

- **Are:** hand-authored, internally-consistent event streams keyed to the
  documented contract in `docs/frontend-core-contract.md` §2. The `seq`, `type`,
  cursor, and reset semantics are authoritative.
- **Are not:** byte-exact captures of server output. Payload field names for some
  event types are illustrative. When a test needs exact wire shapes, capture a
  real session via `GET /api/sessions/{id}/events` and add a `*-captured.json`
  sibling; keep these authored fixtures as the stable contract reference.

## Schema

Each fixture is a JSON object:

```jsonc
{
  "id": "stable-kebab-id",
  "description": "what this scenario exercises",
  "sessionId": "sess-…",
  "note": "contract-shaped, not a byte-exact capture",
  "initialRenderedLatestSeq": 0,   // renderedEventState.latestSeq before the stream
  "events": [ /* ordered event objects, ascending seq */ ],
  "expected": {
    "nextRenderedLatestSeq": 7,    // cursor after applying the stream
    "deltaAfterSeq": { "afterSeq": 7, "events": [] } // optional: HTTP delta result
  }
}
```

Event object fields follow `docs/frontend-core-contract.md` §1.3:
`seq`, `type`, plus span fields (`startSeq/endSeq`, `blockStartSeq/blockEndSeq`,
`mergedStartSeq/mergedEndSeq`, `boundarySeq`) and identity fields
(`operationId`, `deliveryKey`, `providerEventId`).

## Fixtures

| File | Scenario | Pins |
|---|---|---|
| `01-streaming-run-complete.json` | user msg → assistant run → text_delta stream → operation → terminal | seq monotonicity, cursor advance on boundary seq, renderKey |
| `02-merged-assistant-run-reset.json` | a merged run message covers the rendered range | `resetRequired=true`, `reason='merged_assistant_run_message'` |
| `03-ws-push-then-http-delta.json` | WS pushes seq 5–6, then HTTP `afterSeq=6` returns empty | cross-channel dedup via shared cursor + WS providerEventId set |

Additional scenarios (waiting-user, approval, cancel, attachment-upload, full
reconnect backfill) will be added alongside the Stage 1 tests that consume them.
