import test from "node:test";
import assert from "node:assert/strict";
import { apply, createDraftBridge } from "../src/client-entry.js";

const type = "dsh-unlimit:draft-bridge-request";
const origin = "http://127.0.0.1:4177";
function fixture(t, { outcome = "applied", opening, openError, timeoutMs = 1000 } = {}) {
  const replies = [],
    writes = [],
    opens = [],
    options = [];
  const binding = { sessionId: "synthetic-new" };
  const frame = {
    contentWindow: { postMessage: (value, target) => replies.push({ value, target }) },
  };
  let active = binding;
  const services = {
    sessions: {
      binding: () => active,
      async using(id, opts, operation) {
        options.push(opts);
        const ready = (opening || Promise.resolve()).then(() => binding);
        await Promise.race([
          ready,
          new Promise((_, reject) => {
            if (opts.signal.aborted) reject(opts.signal.reason);
            else
              opts.signal.addEventListener("abort", () => reject(opts.signal.reason), {
                once: true,
              });
          }),
        ]);
        return operation({ ready, binding });
      },
    },
    conversation: {
      input: {
        requestDraftInitialization: (value, opts) => {
          writes.push({ value, opts });
          return outcome;
        },
      },
    },
    uiWorkspace: {
      openSession: (id) => {
        opens.push(id);
        if (openError) throw new Error(openError);
      },
    },
  };
  const bridge = createDraftBridge(
    { get: (name) => services[name] },
    { origin, getFrame: () => frame, timeoutMs },
  );
  t.after(() => bridge.dispose());
  const event = (
    operation = "restore",
    id = "request-one",
    payload = { newSessionId: "synthetic-new", draft: "SYNTHETIC_DRAFT" },
  ) => ({ origin, source: frame.contentWindow, data: { type, operation, id, payload } });
  return {
    bridge,
    event,
    replies,
    writes,
    opens,
    options,
    services,
    frame,
    replaceBinding: () => (active = {}),
  };
}

test("bridge accepts only its exact frame/origin and fixed operations", async (t) => {
  const f = fixture(t);
  for (const event of [
    { ...f.event(), origin: "https://other.invalid" },
    { ...f.event(), source: {} },
    { ...f.event(), data: { type, id: "x", operation: "execute" } },
    { ...f.event(), data: { type, id: "", operation: "restore" } },
  ])
    await f.bridge.handleMessage(event);
  assert.equal(f.writes.length, 0);
  assert.equal(f.replies.length, 0);
  await f.bridge.handleMessage(f.event("probe"));
  assert.equal(f.replies[0].value.ready, true);
  assert.equal(f.replies[0].value.supports.attachments, false);
  assert.equal(f.replies[0].target, origin);
});

test("restore uses a retained binding with cancellation signal, preserves existing content and reports open separately", async (t) => {
  const f = fixture(t);
  await f.bridge.handleMessage(f.event());
  assert.equal(f.options[0].source, "controllerOperation");
  assert.ok(f.options[0].signal instanceof AbortSignal);
  assert.deepEqual(f.writes[0].opts, { prompt: "SYNTHETIC_DRAFT", clearPreviousDraft: false });
  assert.deepEqual(f.opens, ["synthetic-new"]);
  assert.equal(f.replies[0].value.draftStatus, "restored");
  assert.equal(f.replies[0].value.openStatus, "requested");
  assert.equal(f.replies[0].value.navigationConfirmed, false);
});

test("preserved and blocked results never navigate or turn into success", async (t) => {
  for (const outcome of ["preserved", "blocked", "unexpected"]) {
    const f = fixture(t, { outcome });
    await f.bridge.handleMessage(f.event());
    assert.equal(f.opens.length, 0);
    assert.equal(f.replies[0].value.ok, false);
    assert.equal(f.replies[0].value.draftStatus, outcome === "unexpected" ? "failed" : outcome);
    assert.equal(f.replies[0].value.openStatus, "not-requested");
  }
});

test("open failure keeps accurate restored status; no draft rollback or submission is attempted", async (t) => {
  const f = fixture(t, { openError: "Synthetic navigation failure" });
  await f.bridge.handleMessage(f.event());
  assert.equal(f.replies[0].value.ok, false);
  assert.equal(f.replies[0].value.draftStatus, "restored");
  assert.equal(f.replies[0].value.openStatus, "failed");
  assert.match(f.replies[0].value.error, /草稿已恢复/);
  assert.equal(f.writes.length, 1);
});

test("close cancellation and timeout prevent late mutation even when opening later resolves", async (t) => {
  for (const mode of ["close", "timeout", "cancel"]) {
    const ready = Promise.withResolvers();
    const f = fixture(t, { opening: ready.promise, timeoutMs: mode === "timeout" ? 5 : 1000 });
    const pending = f.bridge.handleMessage(f.event());
    await f.bridge.handleMessage(f.event());
    assert.equal(f.options.length, 1, "duplicate in-flight ids must be suppressed");
    if (mode === "close") f.bridge.cancelAll();
    if (mode === "cancel")
      await f.bridge.handleMessage(f.event("cancel", "cancel-one", { requestId: "request-one" }));
    await pending;
    ready.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.writes.length, 0);
    assert.equal(f.opens.length, 0);
    assert.equal(
      f.replies.find((item) => item.value.id === "request-one").value.draftStatus,
      "cancelled",
    );
  }
});

test("dispose suppresses both late mutations and replies; replaced bindings are refused", async (t) => {
  const ready = Promise.withResolvers();
  const f = fixture(t, { opening: ready.promise });
  const pending = f.bridge.handleMessage(f.event());
  f.bridge.dispose();
  await pending;
  ready.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.writes.length, 0);
  assert.equal(f.replies.length, 0);
  const stale = fixture(t);
  stale.replaceBinding();
  await stale.bridge.handleMessage(stale.event());
  assert.equal(stale.writes.length, 0);
  assert.equal(stale.replies[0].value.ok, false);
});

test("attachment payloads are rejected explicitly, and missing services do not produce readiness", async (t) => {
  const f = fixture(t);
  await f.bridge.handleMessage(
    f.event("restore", "attachment", {
      newSessionId: "synthetic-new",
      draft: "text",
      attachments: [],
    }),
  );
  assert.equal(f.replies[0].value.code, "INVALID_INPUT");
  assert.equal(f.writes.length, 0);
  delete f.services.conversation;
  await f.bridge.handleMessage(f.event("probe", "probe-missing"));
  assert.equal(f.replies[1].value.ready, false);
});

test("expired and invalid deadlines are refused before retaining a session", async (t) => {
  const f = fixture(t);
  const expired = f.event();
  expired.data.expiresAt = Date.now() - 1;
  await f.bridge.handleMessage(expired);
  assert.equal(f.options.length, 0);
  assert.equal(f.replies[0].value.draftStatus, "cancelled");
  assert.equal(f.replies[0].value.openStatus, "not-requested");
  const invalid = f.event("restore", "invalid-deadline");
  invalid.data.expiresAt = "tomorrow";
  await f.bridge.handleMessage(invalid);
  assert.equal(f.options.length, 0);
  assert.equal(f.replies[1].value.code, "INVALID_INPUT");
});

test("caller deadline shortens waiting and is rechecked before a ready microtask writes", async (t) => {
  const opening = Promise.withResolvers();
  const held = fixture(t, { opening: opening.promise, timeoutMs: 1000 });
  const event = held.event();
  event.data.expiresAt = Date.now() + 5;
  await held.bridge.handleMessage(event);
  assert.equal(held.replies[0].value.draftStatus, "cancelled");
  opening.resolve();
  assert.equal(held.writes.length, 0);
  const immediate = fixture(t);
  const queued = immediate.event();
  queued.data.expiresAt = Date.now() + 5;
  const operation = immediate.bridge.handleMessage(queued);
  // A delayed event loop runs Promise callbacks before overdue timers. The explicit
  // wall-clock guard must refuse this, rather than relying only on setTimeout.
  const until = Date.now() + 12;
  while (Date.now() < until) {}
  await operation;
  assert.equal(immediate.writes.length, 0);
  assert.equal(immediate.replies[0].value.draftStatus, "cancelled");
});

test("actual apply hides its frame from the bridge while closed and reuses it when reopened", async (t) => {
  const f = fixture(t);
  const created = [],
    listeners = new Map();
  const element = (tag) => {
    const events = new Map();
    const value = {
      tagName: tag,
      style: {},
      children: [],
      contentWindow: tag === "iframe" ? f.frame.contentWindow : undefined,
      setAttribute() {},
      append(...nodes) {
        this.children.push(...nodes);
      },
      addEventListener(name, callback) {
        events.set(name, callback);
      },
      remove() {},
      focus() {},
      querySelector() {
        return this.children
          .flatMap((node) => node.children || [])
          .find((node) => node.tagName === "button");
      },
      events,
    };
    created.push(value);
    return value;
  };
  const originals = Object.fromEntries(
    ["document", "window", "location"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  let dispose;
  Object.defineProperties(globalThis, {
    document: {
      configurable: true,
      value: {
        createElement: element,
        body: element("body"),
        addEventListener() {},
        removeEventListener() {},
      },
    },
    window: {
      configurable: true,
      value: {
        addEventListener: (name, callback) => listeners.set(name, callback),
        removeEventListener: (name) => listeners.delete(name),
      },
    },
    location: { configurable: true, value: { origin } },
  });
  t.after(() => {
    dispose?.();
    for (const [name, descriptor] of Object.entries(originals))
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
  });
  apply({
    get: (name) => f.services[name],
    effect: (callback) => {
      dispose = callback();
    },
  });
  const button = created.find((node) => node.tagName === "button");
  button.events.get("click")();
  const frame = created.find((node) => node.tagName === "iframe");
  const close = created.filter((node) => node.tagName === "button")[1];
  close.events.get("click")();
  listeners.get("message")({ ...f.event(), source: frame.contentWindow });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.options.length, 0, "an old queued message must not start work after close");
  button.events.get("click")();
  listeners.get("message")({ ...f.event("restore", "reopened"), source: frame.contentWindow });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.writes.length, 1);
  assert.equal(
    created.filter((node) => node.tagName === "iframe").length,
    1,
    "reopening keeps panel form state",
  );
});
