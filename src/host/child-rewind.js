import { fail } from "../core/validation.js";
import { CHILD_INPUT_RECORD } from "./child-origins.js";

const ambiguous = (message) => fail("AMBIGUOUS_REWIND_SOURCE", message);
const substantive = (message) =>
  !["runtime-context", "agent-instructions"].includes(message?.source?.kind);
const sourceKey = (message) => {
  const source = message?.source;
  return JSON.stringify([source?.kind, source?.form, source?.senderSessionId]);
};

export function parentBoundary(source, seq) {
  const own = source.events.slice(source.inheritedEventCount, seq);
  const turn = own.findLast((event) => event.type === "turn/start");
  const step = own.findLast((event) => event.type === "step/start");
  if (
    !turn ||
    !step ||
    step.seq < turn.seq ||
    own.some(
      (event) =>
        (event.type === "turn/end" && event.seq > turn.seq) ||
        (event.type === "step/end" && event.seq > step.seq),
    )
  )
    fail("NO_REWIND_BOUNDARY", "The child origin is not inside an active parent turn and step");
  return { turn, step };
}

/** A selected child's last accepted input; ancestors use only input consumed before the causal call. */
export function latestChildInput(child, beforeSeq) {
  const inputs = new Map();
  for (const event of child.events.slice(child.inheritedEventCount, beforeSeq)) {
    const accepted = event.type === "agent/inbox/spliced" ? event.data?.inserted : [];
    if (!Array.isArray(accepted)) ambiguous("The child inbox has an invalid insertion record");
    const consumed = event.type === "user/message" && event.surfaceOp === "append";
    for (const [kind, message] of [
      ...accepted.map((message) => ["accepted", message]),
      ...(consumed ? [["consumed", event.data]] : []),
    ]) {
      if (!message || typeof message !== "object")
        ambiguous("The child input has no message record");
      if (!substantive(message)) continue;
      const key = message?.id ?? `unidentified:${event.seq}`;
      let input = inputs.get(key);
      if (!input) {
        input = { message, seq: event.seq };
        inputs.set(key, input);
      }
      if (input[kind] !== undefined || sourceKey(input.message) !== sourceKey(message))
        ambiguous("The child message identity has duplicate or conflicting input records");
      input[kind] = event.seq;
    }
  }
  const candidates = [...inputs.values()].filter(
    (input) => beforeSeq === undefined || input.consumed !== undefined,
  );
  candidates.sort((a, b) => (beforeSeq === undefined ? a.seq - b.seq : a.consumed - b.consumed));
  const latest = candidates.at(-1);
  if (!latest) ambiguous("No accepted child input can identify the requested origin");
  if (latest.message.source?.kind === "user") {
    if (candidates.length !== 1)
      ambiguous("A later human input to a child has no proven parent origin");
    return { basis: "creation" };
  }
  if (
    typeof latest.message.id !== "string" ||
    !latest.message.id ||
    latest.message.source?.kind !== "agent-message" ||
    latest.message.source.form !== "relay" ||
    latest.message.source.senderSessionId !== child.meta.parentSession
  )
    ambiguous("The latest child input has no attributable direct parent relay");
  return { basis: "recorded-input", messageId: latest.message.id };
}

export function recordedInputOrigin(parent, child, messageId) {
  const own = parent.events.slice(parent.inheritedEventCount);
  const records = own.filter(
    (event) => event.type === CHILD_INPUT_RECORD && event.data?.messageId === messageId,
  );
  const record = records[0];
  const data = record?.data;
  if (
    records.length !== 1 ||
    record.ignorable !== true ||
    data.version !== 1 ||
    data.parentSessionId !== parent.meta.id ||
    data.parentCreatedAt !== parent.meta.createdAt ||
    data.childSessionId !== child.meta.id ||
    data.childCreatedAt !== child.meta.createdAt ||
    !Number.isSafeInteger(parent.meta.createdAt) ||
    parent.meta.createdAt < 0 ||
    !Number.isSafeInteger(data.callSeq) ||
    data.callSeq < parent.inheritedEventCount ||
    typeof data.callId !== "string" ||
    !data.callId ||
    record.seq <= data.callSeq
  )
    ambiguous(
      "No unique recorded parent delivery matches this child input; historical delivery cannot be inferred",
    );
  const calls = own.filter(
    (event) => event.type === "tool/call" && event.data?.callId === data.callId,
  );
  const call = calls[0];
  let argumentsValue;
  try {
    argumentsValue = JSON.parse(call?.data.arguments);
  } catch {
    /* invalid journal arguments */
  }
  if (
    calls.length !== 1 ||
    call.seq !== data.callSeq ||
    call.data.name !== "send_message" ||
    argumentsValue?.agent_id !== child.meta.id
  )
    ambiguous("The recorded delivery has no matching parent send_message call");
  const { turn, step } = parentBoundary(parent, call.seq);
  const atRecord = parentBoundary(parent, record.seq);
  if (
    turn.seq !== data.turnStartSeq ||
    step.seq !== data.stepStartSeq ||
    atRecord.turn.seq !== turn.seq ||
    atRecord.step.seq !== step.seq ||
    !Number.isSafeInteger(call.data.turn) ||
    call.data.turn < 1 ||
    !Number.isSafeInteger(call.data.step) ||
    call.data.step < 1 ||
    call.data.turn !== turn.data.turn ||
    call.data.turn !== step.data.turn ||
    call.data.step !== step.data.step
  )
    ambiguous("The recorded delivery does not match the parent execution boundary");
  const results = own.filter(
    (event) => event.type === "tool/result" && event.data?.message?.toolCallId === data.callId,
  );
  const result = results[0];
  if (
    results.length !== 1 ||
    result.seq <= call.seq ||
    result.surfaceOp !== "append" ||
    result.data.message.source?.kind !== "tool" ||
    result.data.message.source.callId !== data.callId ||
    result.data.message.isError === true ||
    result.data.error ||
    result.data.turn !== call.data.turn ||
    result.data.step !== call.data.step ||
    result.sourceEventSeqs?.length !== 1 ||
    result.sourceEventSeqs[0] !== call.seq
  )
    ambiguous("The parent delivery has no unique completed successful tool result");
  return {
    basis: "recorded-input",
    childSessionId: child.meta.id,
    parentSessionId: parent.meta.id,
    childCreatedAt: child.meta.createdAt,
    messageId,
    callId: data.callId,
    callSeq: call.seq,
    recordSeq: record.seq,
    turnStartSeq: turn.seq,
    stepStartSeq: step.seq,
  };
}
