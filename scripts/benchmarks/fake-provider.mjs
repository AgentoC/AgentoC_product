#!/usr/bin/env node
// Deterministic fake codex-json provider for the DS-37 benchmark harness.
//
// Emits a codex protocol JSON-lines stream that chat/adapters/codex.mjs maps
// to session events (reasoning / tool_use+tool_result / file_change /
// assistant message / text delta). No real provider, no real history, no
// secrets: every payload is synthetic filler derived from a seeded LCG.
//
// Env contract (all optional):
//   FAKE_PROVIDER_EVENTS           total event lines after turn.started (default 100)
//   FAKE_PROVIDER_DELAY_MS         per-line emit delay (default 100; falls back to FAKE_CODEX_DELAY_MS)
//   FAKE_PROVIDER_BODY_BYTES       synthetic body size for reasoning/command/message/delta lines (default 200)
//   FAKE_PROVIDER_MIX              comma-separated weights: reasoning,command,file_change,message,delta (default 1,1,1,1,1)
//   FAKE_PROVIDER_ATTACHMENT_REFS  synthetic attachment ref entries on the final message item (default 0)
//   FAKE_PROVIDER_SEED             LCG seed for deterministic content (default 42)
//
// The harness copies this file verbatim into the clean instance's localBin as
// `fake-codex`, so the repo copy and the deployed copy are always identical.

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBody(seed, index, size) {
  const prefix = `bench:${seed}:${index}:`;
  if (size <= prefix.length) return prefix;
  return prefix + 'x'.repeat(size - prefix.length);
}

function buildAttachments(seed, count) {
  const refs = [];
  for (let k = 0; k < count; k += 1) {
    refs.push({
      name: `attachment-${k}.bin`,
      size: 1024 * (k + 1),
      ref: `bench://asset/${seed}/${k}`,
    });
  }
  return refs;
}

const env = process.env;
const seed = clampInt(env.FAKE_PROVIDER_SEED, 0, 0x7fffffff, 42);
const total = clampInt(env.FAKE_PROVIDER_EVENTS, 1, 100000, 100);
const delay = clampInt(env.FAKE_PROVIDER_DELAY_MS ?? env.FAKE_CODEX_DELAY_MS, 0, 60000, 100);
const bodyBytes = clampInt(env.FAKE_PROVIDER_BODY_BYTES, 16, 4 * 1024 * 1024, 200);
const attachmentRefs = clampInt(env.FAKE_PROVIDER_ATTACHMENT_REFS, 0, 1000, 0);

const kinds = ['reasoning', 'command', 'file_change', 'message', 'delta'];
const rawWeights = String(env.FAKE_PROVIDER_MIX || '1,1,1,1,1').split(',').map((part) => Number(part));
const weights = kinds.map((kind, index) => Math.max(0, Number.isFinite(rawWeights[index]) ? rawWeights[index] : 1));
const weightTotal = weights.reduce((sum, value) => sum + value, 0) || 1;

const rand = lcg(seed);
let cancelled = false;
process.on('SIGTERM', () => {
  cancelled = true;
  setTimeout(() => process.exit(143), 20);
});

function pickKind() {
  let roll = rand() * weightTotal;
  for (let index = 0; index < kinds.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) return kinds[index];
  }
  return 'delta';
}

function lineFor(kind, index) {
  const body = buildBody(seed, index, bodyBytes);
  switch (kind) {
    case 'reasoning':
      return JSON.stringify({
        type: 'item.completed',
        item: { id: `r${index}`, type: 'reasoning', text: body },
      });
    case 'command':
      return JSON.stringify({
        type: 'item.completed',
        item: {
          id: `c${index}`,
          type: 'command_execution',
          command: 'echo bench',
          aggregated_output: body,
          exit_code: 0,
          status: 'completed',
        },
      });
    case 'file_change':
      return JSON.stringify({
        type: 'item.completed',
        item: {
          id: `f${index}`,
          type: 'file_change',
          changes: [{ path: `/tmp/bench/asset-${index}.txt`, kind: 'edit' }],
          status: 'completed',
        },
      });
    case 'message':
      return JSON.stringify({
        type: 'item.completed',
        item: { id: `m${index}`, type: 'agent_message', text: body },
      });
    case 'delta':
    default:
      return JSON.stringify({
        type: 'output_text_delta',
        content_index: 0,
        delta: body,
      });
  }
}

async function main() {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: `thread-bench-${seed}` }));
  console.log(JSON.stringify({ type: 'turn.started' }));

  for (let index = 0; index < total; index += 1) {
    if (cancelled) return;
    if (delay > 0) await sleep(delay);
    if (cancelled) return;
    console.log(lineFor(pickKind(), index));
  }

  // Final summary message: deterministic large body + optional attachment refs.
  if (cancelled) return;
  if (delay > 0) await sleep(delay);
  if (cancelled) return;
  const finalItem = {
    id: 'm-final',
    type: 'agent_message',
    text: buildBody(seed, total, bodyBytes),
  };
  if (attachmentRefs > 0) {
    finalItem.attachments = buildAttachments(seed, attachmentRefs);
  }
  console.log(JSON.stringify({ type: 'item.completed', item: finalItem }));
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: total, output_tokens: total },
  }));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
