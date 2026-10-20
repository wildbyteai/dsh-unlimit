function identity({ workspaceId = "", page, objectId }) {
  if (
    typeof workspaceId !== "string" ||
    typeof page !== "string" ||
    !page ||
    typeof objectId !== "string" ||
    !objectId
  )
    throw new TypeError("Draft identity requires workspace, page and object");
  return { workspaceId, page, objectId };
}
function equal(left, right) {
  if (Object.is(left, right)) return true;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  );
}
const keyOf = (scope) => JSON.stringify(Object.values(identity(scope)));

/** Panel-memory only. No browser storage, files, network, or secret logging. */
export class MemoryDrafts {
  #entries = new Map();
  capture(scope, baseline, current, { anchors = [] } = {}) {
    const context = identity(scope);
    const fields = Object.fromEntries(
      Object.entries(current).filter(([key, value]) => !equal(baseline[key], value)),
    );
    if (!Object.keys(fields).length) {
      this.clear(context);
      return null;
    }
    for (const name of anchors)
      if (Object.hasOwn(current, name))
        Object.defineProperty(fields, name, {
          value: current[name],
          enumerable: true,
          writable: true,
          configurable: true,
        });
    this.#entries.set(keyOf(context), { context, fields: structuredClone(fields) });
    return structuredClone(fields);
  }
  read(scope) {
    const entry = this.#entries.get(keyOf(scope));
    return entry ? structuredClone(entry.fields) : null;
  }
  clear(scope) {
    return this.#entries.delete(keyOf(scope));
  }
  clearPage(workspaceId, page) {
    for (const [key, entry] of this.#entries)
      if (entry.context.workspaceId === workspaceId && entry.context.page === page)
        this.#entries.delete(key);
  }
  clearObject({ workspaceId = "", page, objectId, allWorkspaces = false }) {
    identity({ workspaceId, page, objectId });
    for (const [key, entry] of this.#entries)
      if (
        entry.context.page === page &&
        entry.context.objectId === objectId &&
        (allWorkspaces || entry.context.workspaceId === workspaceId)
      )
        this.#entries.delete(key);
  }
  countPage(workspaceId, page) {
    return [...this.#entries.values()].filter(
      (entry) => entry.context.workspaceId === workspaceId && entry.context.page === page,
    ).length;
  }
  get size() {
    return this.#entries.size;
  }
}
