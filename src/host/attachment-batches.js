import { randomBytes } from "node:crypto";
import { constants as bufferConstants } from "node:buffer";
import { fail, object, string } from "../core/validation.js";

const TTL_MS = 5 * 60 * 1000;
// Base64 must fit one JS string in the JSON transport; this is a carrier bound,
// not a smaller application-specific attachment admission policy.
const MAX_BYTES = Math.min(
  bufferConstants.MAX_LENGTH,
  Math.floor(bufferConstants.MAX_STRING_LENGTH / 4) * 3,
);

export class AttachmentBatches {
  constructor(services, { now = Date.now, ttlMs = TTL_MS } = {}) {
    this.services = services;
    this.now = now;
    this.ttlMs = ttlMs;
    this.batches = new Map();
    this.closed = false;
  }
  create(sessionId, event, parts) {
    if (this.closed) fail("CANCELLED", "Attachment recovery service is closed");
    const attachments = this.services().attachments;
    const entries = parts.flatMap((part, partIndex) => {
      if (part.type === "text") return [];
      if (!["image", "file"].includes(part.type))
        fail("UNSUPPORTED_CAPABILITY", "This human input contains an unsupported content block");
      const ref = part.attachment;
      if (
        !ref ||
        typeof ref.attachmentId !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId) ||
        !Number.isSafeInteger(ref.bytes) ||
        ref.bytes < 0 ||
        ref.bytes > MAX_BYTES
      )
        fail(
          "INVALID_ATTACHMENT_REF",
          "The original attachment reference is invalid or exceeds the JSON carrier bound",
        );
      if (
        (part.type === "file" && typeof ref.name !== "string") ||
        (ref.name !== undefined && typeof ref.name !== "string")
      )
        fail("INVALID_ATTACHMENT_REF", "The original attachment name is invalid");
      if (
        part.type === "image" &&
        (typeof ref.mediaType !== "string" ||
          !ref.mediaType.startsWith("image/") ||
          !Number.isSafeInteger(ref.width) ||
          ref.width < 1 ||
          !Number.isSafeInteger(ref.height) ||
          ref.height < 1)
      )
        fail("INVALID_ATTACHMENT_REF", "The original image has no image media type");
      if (
        typeof attachments?.[part.type === "image" ? "readImage" : "readFileStream"] !== "function"
      )
        fail("UNSUPPORTED_CAPABILITY", `Official ${part.type} attachment reader is unavailable`);
      return [{ type: part.type, partIndex, ref: structuredClone(ref) }];
    });
    if (!entries.length) return undefined;
    const images = entries.filter((entry) => entry.type === "image");
    const limits = attachments.imageLimits;
    if (
      images.length &&
      (!limits ||
        images.length > limits.maxImagesPerMessage ||
        images.reduce((sum, item) => sum + item.ref.bytes, 0) > limits.maxMessageImageBytes ||
        images.some(
          ({ ref }) =>
            ref.bytes > limits.maxImageBytes ||
            ref.width > limits.maxImageDimension ||
            ref.height > limits.maxImageDimension ||
            ref.width * ref.height > limits.maxImagePixels ||
            !limits.mediaTypes.includes(ref.mediaType),
        ))
    )
      fail(
        "UNSUPPORTED_CAPABILITY",
        "The original images exceed the current official image admission limits",
      );
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    const batch = {
      sessionId,
      eventSeq: event.seq,
      eventId: event.data.id,
      entries,
      expiresAt,
      controller: new AbortController(),
    };
    batch.timer = setTimeout(() => this.release({ token }), this.ttlMs);
    batch.timer.unref?.();
    this.batches.set(token, batch);
    return {
      token,
      expiresAt,
      items: entries.map(({ type, partIndex, ref }, index) => ({
        index,
        partIndex,
        type,
        name: ref.name || (type === "image" ? "image" : "file"),
        bytes: ref.bytes,
        mediaType: type === "image" ? ref.mediaType : "application/octet-stream",
      })),
    };
  }
  bind(token, newSessionId) {
    const batch = this.get(token);
    batch.newSessionId = newSessionId;
  }
  get(token) {
    const batch = this.batches.get(token);
    if (this.closed || !batch || this.now() >= batch.expiresAt || batch.controller.signal.aborted) {
      if (batch) this.release({ token });
      fail(
        "ATTACHMENT_BATCH_EXPIRED",
        "Attachment recovery batch is unavailable, cancelled or expired",
      );
    }
    return batch;
  }
  async read(payload) {
    object(payload);
    if (Object.keys(payload).some((key) => !["token", "index", "newSessionId"].includes(key)))
      fail(
        "INVALID_INPUT",
        "Only a recovery token, index and target session may identify an attachment",
      );
    const token = string(payload.token, "token");
    const batch = this.get(token);
    if (!batch.newSessionId || payload.newSessionId !== batch.newSessionId)
      fail("ATTACHMENT_BATCH_UNBOUND", "Attachment batch is not bound to this completed rewind");
    if (!Number.isSafeInteger(payload.index) || !batch.entries[payload.index])
      fail("INVALID_INPUT", "Attachment index is not in the authorized batch");
    const entry = batch.entries[payload.index];
    const { controller, attachments } = this.services();
    const source = await controller.inspect(batch.sessionId);
    this.get(token);
    const event = source?.events?.[batch.eventSeq];
    if (
      !event ||
      event.type !== "user/message" ||
      event.surfaceOp !== "append" ||
      event.data?.source?.kind !== "user" ||
      event.data.id !== batch.eventId ||
      JSON.stringify(event.data.content?.[entry.partIndex]?.attachment) !==
        JSON.stringify(entry.ref) ||
      event.data.content[entry.partIndex].type !== entry.type
    )
      fail(
        "ATTACHMENT_AUTHORIZATION_CHANGED",
        "The authorized original human attachment is no longer present",
      );
    const signal = batch.controller.signal;
    let data;
    if (entry.type === "image") {
      const result = await attachments.readImage(entry.ref, signal);
      this.get(token);
      if (JSON.stringify(result.ref) !== JSON.stringify(entry.ref))
        fail("INVALID_HOST_RESULT", "Official image reader returned a different reference");
      data = result.data;
    } else {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of attachments.readFileStream(entry.ref, signal)) {
        this.get(token);
        if (!(chunk instanceof Uint8Array) || (bytes += chunk.byteLength) > entry.ref.bytes)
          fail(
            "INVALID_HOST_RESULT",
            "Official file reader exceeded the original reference byte count",
          );
        chunks.push(Buffer.from(chunk));
      }
      data = Buffer.concat(chunks, bytes);
    }
    this.get(token);
    if (!(data instanceof Uint8Array) || data.byteLength !== entry.ref.bytes)
      fail(
        "INVALID_HOST_RESULT",
        "Official attachment bytes do not match the authorized reference",
      );
    return {
      item: {
        index: payload.index,
        type: entry.type,
        name: entry.ref.name || (entry.type === "image" ? "image" : "file"),
        bytes: data.byteLength,
        mediaType: entry.type === "image" ? entry.ref.mediaType : "application/octet-stream",
        contentBase64: Buffer.from(data).toString("base64"),
      },
    };
  }
  release(payload) {
    object(payload);
    const token = string(payload.token, "token");
    const batch = this.batches.get(token);
    if (batch) {
      clearTimeout(batch.timer);
      batch.controller.abort(new Error("Attachment recovery batch released"));
      this.batches.delete(token);
    }
    return { released: Boolean(batch) };
  }
  close() {
    this.closed = true;
    for (const token of this.batches.keys()) this.release({ token });
  }
}
