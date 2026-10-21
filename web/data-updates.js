// Keep the browser-only list aligned with core/validation.js (covered by tests).
export const DATA_RECORD_KINDS = Object.freeze([
  "credential",
  "access",
  "webshell",
  "tunnel",
  "screenshot",
  "http",
  "chain",
  "file",
  "score-point",
  "score-hit",
  "stage",
  "session",
]);
const progressKinds = ["stage", "score-point", "score-hit"];
const evidenceKinds = DATA_RECORD_KINDS.filter((kind) => !progressKinds.includes(kind));
const domains = ["assets", "findings", "links", "events", "roles", "files"];
const record = (kind) => `records.${kind}`;
const scoring = ["assets", record("score-point"), record("score-hit")];
const pages = {
  workspaces: ["global.workspaces"],
  knowledge: ["global.knowledge"],
  overview: ["global.workspaces", "assets", "findings", record("stage"), ...scoring],
  assets: ["assets"],
  findings: ["findings", "assets"],
  files: ["files"],
  graph: ["assets", "links", "events"],
  roles: ["roles"],
  reports: [
    "global.workspaces",
    "assets",
    "findings",
    "links",
    "events",
    ...DATA_RECORD_KINDS.map(record),
  ],
};
const globalPage = (page) => page === "workspaces" || page === "knowledge";

function workspaceIdentity(value) {
  if (value === undefined || value === "" || value === null) return null;
  if (typeof value !== "string") throw new TypeError("workspaceId must be a string or null");
  return value;
}
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError("Change versions must be non-negative safe integers");
  return value;
}
function snapshotCopy(value) {
  if (!value || !value.global || !value.workspace || !value.workspace.records)
    throw new TypeError("A data-change snapshot is required");
  const global = Object.freeze({
    workspaces: count(value.global.workspaces),
    knowledge: count(value.global.knowledge),
  });
  const records = Object.freeze(
    Object.fromEntries(
      DATA_RECORD_KINDS.map((kind) => [kind, count(value.workspace.records[kind])]),
    ),
  );
  const workspace = Object.freeze({
    ...Object.fromEntries(domains.map((domain) => [domain, count(value.workspace[domain])])),
    records,
  });
  return Object.freeze({ workspaceId: workspaceIdentity(value.workspaceId), global, workspace });
}
function versions(snapshot) {
  return {
    ...Object.fromEntries(
      Object.entries(snapshot.global).map(([key, value]) => [`global.${key}`, value]),
    ),
    ...Object.fromEntries(domains.map((key) => [key, snapshot.workspace[key]])),
    ...Object.fromEntries(
      DATA_RECORD_KINDS.map((kind) => [record(kind), snapshot.workspace.records[kind]]),
    ),
  };
}
function advance(previous, current) {
  return Object.fromEntries(
    Object.entries(current).map(([key, value]) => [key, Math.max(previous[key], value)]),
  );
}
function dependencies(page, kind) {
  if (page === "evidence") {
    if (!evidenceKinds.includes(kind)) throw new TypeError("Unknown evidence kind");
    return [record(kind), ...(kind === "credential" ? ["assets"] : [])];
  }
  if (page === "progress") {
    if (!progressKinds.includes(kind)) throw new TypeError("Unknown progress kind");
    return [...scoring, record(kind), ...(kind === "stage" ? [] : [record("stage")])];
  }
  return Object.hasOwn(pages, page) ? pages[page] : undefined;
}

/**
 * Panel-memory version receipts, never record counts or per-record read state.
 * observe(raw) returns an immutable copy of THAT response. Capture it before
 * loading page data, then pass it to markRead(scope, receipt) only after the
 * matching page has rendered successfully. Keep failed/abandoned renders unread.
 * Navigation may omit kind in hasUnread; markRead requires the rendered tab.
 */
export class DataUpdates {
  #global = null;
  #workspaces = new Map();

  observe(raw) {
    const snapshot = snapshotCopy(raw);
    const current = versions(snapshot);
    const global = Object.fromEntries(
      Object.entries(current).filter(([key]) => key.startsWith("global.")),
    );
    if (!this.#global) this.#global = { baseline: global, latest: global, seen: new Map() };
    else this.#global.latest = advance(this.#global.latest, global);
    const entry = this.#workspaces.get(snapshot.workspaceId);
    if (!entry)
      this.#workspaces.set(snapshot.workspaceId, {
        baseline: current,
        latest: current,
        seen: new Map(),
      });
    else entry.latest = advance(entry.latest, current);
    return snapshot;
  }

  hasUnread({ workspaceId = null, page, kind } = {}) {
    if (page === "evidence" && kind === undefined)
      return evidenceKinds.some((kind) => this.hasUnread({ workspaceId, page, kind }));
    if (page === "progress" && kind === undefined)
      return progressKinds.some((kind) => this.hasUnread({ workspaceId, page, kind }));
    const fields = dependencies(page, kind);
    if (!fields) return false;
    const entry = globalPage(page)
      ? this.#global
      : this.#workspaces.get(workspaceIdentity(workspaceId));
    if (!entry) return false;
    const seen = entry.seen.get(JSON.stringify([page, kind ?? null])) ?? entry.baseline;
    const latest = { ...entry.latest, ...this.#global.latest };
    return fields.some((field) => latest[field] > seen[field]);
  }

  markRead({ workspaceId = null, page, kind } = {}, capturedSnapshot) {
    const fields = dependencies(page, kind);
    if (!fields) return false;
    const identity = workspaceIdentity(workspaceId);
    const entry = globalPage(page) ? this.#global : this.#workspaces.get(identity);
    if (!entry) return false;
    const snapshot = snapshotCopy(capturedSnapshot);
    if (!globalPage(page) && snapshot.workspaceId !== identity)
      throw new TypeError("Read receipt belongs to another workspace");
    const captured = versions(snapshot);
    const key = JSON.stringify([page, kind ?? null]);
    const previous = entry.seen.get(key) ?? entry.baseline;
    entry.seen.set(
      key,
      Object.fromEntries(
        fields.map((field) => [field, Math.max(previous[field], captured[field])]),
      ),
    );
    return true;
  }
}
