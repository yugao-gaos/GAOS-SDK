# RFC-022: Durable room-agent runs, progress, and continuation

Status: Accepted  
Target: GAOS SDK 1.x additive surface  
Depends on: RFC-021 room agents

## 1 — Summary

Room-agent work is not always one request followed by one response. Research,
tool use, guided experiences, and interpretation may take long enough that the
user needs visible progress, may produce several assistant messages, and may
pause for more user input before the logical task is complete.

This RFC adds a provider-neutral run lifecycle beside the existing
`respond()` contract. A run has a durable identity, ordered event journal,
checkpoint, deadline, cancellation state, and optional continuation request.
The live API exposes each durably appended event immediately so voice, chat,
browser, and native hosts can begin presentation while the task continues.

The existing `RoomAgentRuntime.handleFinalInput()` behavior is unchanged.
`handleRunInput()` and `startRun()` opt into the new lifecycle, and a legacy
`respond()` driver is automatically adapted into one decision plus completion.

## 2 — Ownership boundary

The SDK owns mechanism, not performance style.

| SDK-owned | Product/host-owned |
|---|---|
| Run ID, status, attempt, and deadline | Whether progress is presented at all |
| Structured work-derived progress | UI status, prerecorded cue, text, or audio |
| Ordered journal and replay | Deterministic versus freshly generated filler |
| Assistant output/message boundaries | Voice, caption, animation, and cue providers |
| Checkpoint and recovery input | Checkpoint contents and recovery policy |
| Waiting-for-input continuation token | Prompt wording and conversation policy |
| Cooperative cancellation | Product cancellation controls and rescue copy |

Progress reports public lifecycle facts such as a stable stage key or completed
item count. It is not model chain-of-thought, hidden reasoning, scratchpad,
provider reasoning tokens, or a request to reveal them. Products must not
invent completed work, tool results, or an ETA when presenting a progress
event.

## 3 — Driver contract

A streaming driver implements `run(context)` and yields `RoomAgentRunEvent`:

- `progress` — truthful, structured work state;
- `assistant_output` — a delta in one named assistant message;
- `checkpoint` — opaque product recovery state;
- `input_requested` — a pause with a request ID and continuation token;
- `decision` — normalized utterances, interactions, or one action proposal;
- `completed` — explicit successful termination.

Within one driver invocation, `assistant_output` deltas sharing an `outputId`
form one message and `final: true` closes it. Driver output IDs are logical and
attempt-local. The runtime adds a collision-free attempt namespace before
journaling or live delivery; consumers must treat that qualified ID as opaque.
This lets a continuation reuse the same logical ID for a new message without
joining it to the prior attempt. Journaled outputs also carry runtime-owned
`delivery` metadata with the origin, attempt, and driver-local logical ID.

```ts
const driver = {
  async *run(context) {
    yield { type: 'progress', progress: { stage: 'search', current: 1, total: 3 } };
    yield {
      type: 'assistant_output',
      outputId: 'answer',
      delta: 'I found ',
      purpose: 'answer',
    };
    yield {
      type: 'assistant_output',
      outputId: 'answer',
      delta: 'a useful pattern.',
      purpose: 'answer',
      final: true,
    };
    yield { type: 'completed' };
  },
};
```

The context includes the stable run ID, attempt number, restored checkpoint,
`resumed` flag, continuation metadata, and the ordinary abort signal.

## 4 — Durable state and journal

`RoomAgentRunStore` is deliberately separate from the RFC-021 transcript store
so existing host adapters remain source-compatible. A production host writes:

1. one `RoomAgentRunRecord` per logical task;
2. an ordered, idempotent `RoomAgentRunJournalEntry` for each public run event;
3. the latest full checkpoint on the run record; and
4. an input-to-run index for retry-safe admission.

`admitRunInput()` writes the authenticated input transcript boundary, the new
or continued active run, and its input-to-run index in one transaction. If the
caller or isolate disappears immediately after commit, an exact retry returns
the same recoverable run with `duplicate: true`; a mismatched reuse of the input
ID is rejected. `createRun()` and `saveRun()` are recovery/import seams and are
not used for fresh input admission. `saveRun()` is a compare-and-set operation:
it advances recovery-attempt metadata only while the same input and journal
sequence remain active, and returns `false` rather than overwriting a terminal
or newer run.

Journal sequence is per run and begins at one. `commitRunEvent()` appends an
event and persists its resulting run state (sequence, checkpoint, waiting, or
terminal transition) in one host transaction. Delivery to `runObserver`, the
per-call event callback, and `startRun().events` happens after that commit, so a
live consumer never receives an event whose matching run transition is absent.
Each event records the input attempt that produced it.

The journal is the source of truth for recorded assistant outputs. On resume,
the runtime idempotently reconciles any closed `history: 'record'` output into
the channel transcript before invoking the driver. This repairs an isolate loss
between the journal commit and transcript append without re-speaking or
otherwise re-presenting the output. If the recovery driver re-yields a logical
ID already proven closed for the same input, the runtime suppresses it before
journaling, live delivery, transcript recording, or speech. An incomplete
prior-attempt output remains in the journal as crash evidence but is abandoned:
it is excluded from current completion checks and cannot prefix a freshly
streamed recovery output. A recovery driver uses the same logical ID when
retrying the same message and a new logical ID for genuinely new output.
Suppression relies only on runtime-owned `delivery` metadata, never on parsing
the opaque output ID. Legacy journal rows without that optional metadata remain
replayable but are not suppressed on recovery.

Durability of the ledger does not serialize a JavaScript closure. After an
isolate or process restart, the host calls `resumeRun()`. The driver is invoked
again with `resumed: true`, a higher attempt, and the last checkpoint. A
Cloudflare adapter may map this to a managed fiber, a chat-recovery hook, or a
Workflow; another host may use its own job runner.

## 5 — Progress presentation and history

Every structured `progress` event is observable without speech. A product can
choose independently for each surface:

| Policy | Adapter behavior |
|---|---|
| None | Ignore the event |
| UI-only | Render stage/count from `runObserver` or the live stream |
| Prerecorded | Map a stable stage key to a product cue or clip |
| Deterministic text | Return product-authored text from `progressPresenter` |
| Fresh generated text | Generate a short line from the verified progress snapshot |

The optional `progressPresenter` returns an utterance. Its history mode defaults
to `ephemeral`: it may be journaled and presented, but it does not enter the
durable conversation transcript or later model history. A product must opt in
with `history: 'record'` when progress wording is semantically important to
future turns. Ordinary answers and questions default to `record`.

## 6 — Multi-turn continuation

`input_requested` changes the run to `waiting_for_input` and stores its request
ID and opaque token. The next input on the same channel and agent continues the
sole waiting run automatically. A network client may also echo `{ runId,
token }`; a mismatch is rejected before transcript admission.

Continuation preserves the run ID and root input, increments `attempt`, keeps
the checkpoint and journal, supplies the new final input, and clears the prior
continuation before execution. Completion or cancellation clears it
permanently.

## 7 — Cancellation and deadlines

Cancellation is cooperative. `cancelRun()` aborts in-memory work only when the
active controller belongs to that run ID, then interrupts that run's
interruptible speech and writes a terminal `run_canceled` event. Drivers and
context sources must observe their signal around expensive work and visible
side effects.

A run can use the runtime default deadline or a per-input override. Its active
attempt deadline is persisted as an epoch timestamp so recovery cannot reset
it. The clock is paused in `waiting_for_input`; continuation receives a fresh
active-attempt deadline so normal human response time does not consume the
model/tool budget. Expiry aborts work and records `deadline_exceeded`. Provider errors record the
stable code `run_processing_failed`; raw errors and prompt/model content do not
enter operational metadata.

## 8 — Live streaming API

`handleRunInput()` waits for the run result and can receive a per-call event
callback. `startRun()` returns immediately:

```ts
const execution = runtime.startRun(request);

for await (const entry of execution.events) {
  if (entry.event.type === 'assistant_output') {
    // Forward deltas to a resumable chat stream or voice response queue.
  }
}

const result = await execution.result;
```

The stream is a delivery view over the durable journal, not a second source of
truth. Reconnect uses `replayRun()` and resumes after the last observed
sequence. Hosts decide whether speech begins per delta, at a sentence boundary,
or only when `final` closes the message.

## 9 — Compatibility and security invariants

1. RFC-021 `respond()` and `handleFinalInput()` retain their meaning.
2. A driver must define `respond`, `run`, or both.
3. Legacy decisions use the same audience clamping and action authority checks.
4. Progress never grants authority or mutates reducer state.
5. Ephemeral presentation does not silently become conversation memory.
6. Run events expose public lifecycle state, never hidden chain-of-thought.
7. Every event observed live was first durably appended.
8. Replaying events does not repeat speech, cues, actions, or provider calls.
9. A continuation token correlates a waiting run; it is not authentication.
10. Checkpoints contain only product-approved, serializable recovery state.
