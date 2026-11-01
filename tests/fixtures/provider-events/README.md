# Provider event fixtures

These are sanitized, provider-shaped JSONL traces used by the offline replay
regression. They preserve the adapter input shapes and lifecycle transitions,
but are not byte-exact captures from a live provider session. Secrets and
machine-specific paths must never be added here.

Each fixture is parsed by its provider adapter, receives deterministic test
sequence numbers, and is folded by `buildOperationProjection`.
