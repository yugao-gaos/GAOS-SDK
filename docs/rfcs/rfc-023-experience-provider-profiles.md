# RFC-023 — Replaceable experience-provider profiles

Status: **implemented** · Target: **v1.0.3** · Depends on:
[RFC-021](rfc-021-room-agents.md) and
[RFC-022](rfc-022-durable-agent-runs.md)

## Decision

GAOS exports provider-neutral operational contracts for reasoning, speech
recognition, speech synthesis, live generated worlds, and replay video. Hosts
register concrete implementations and declare ordered candidates in a named
profile.

The SDK owns contract validation and kind-safe resolution. The product owns:

- provider credentials, endpoints, models, geography, and cost;
- health checks, deadlines, fallback timing, and user-facing disclosure;
- turn admission, transcript durability, and interruption;
- deterministic visuals while generated media is unavailable; and
- recording consent, retention, and deletion.

The provider layer is outside reducer state and portable game replay. It does
not move hidden model reasoning into `RoomAgentRunProgress` and does not let a
media provider mutate a room-agent run.

## Why five kinds

Reasoning, STT, and TTS have distinct stream directions and cancellation
points. Live worlds and replay videos are also distinct: a live session may
accept many prompt updates and yield transient media, while replay generation
produces one retained artifact. Treating them as one generic video provider
would obscure ownership and make fallback unsafe.

## Profile rules

Each profile supplies at least one provider ID for every kind. Candidate IDs
are ordered, non-empty, and unique within their slot. Registries reject an
unknown ID and reject a provider whose descriptor kind differs from its slot.
They do not probe health or auto-fallback; those choices remain visible host
policy.

## Network boundary

A local provider is a locality declaration, not a transport bypass. Hosted
Workers cannot call loopback services on the visitor's device. Products must
run the host locally or provide an explicit authenticated bridge. Secrets stay
in the host or companion and never enter the public profile.

