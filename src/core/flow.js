import { fail, object, string } from "./validation.js";

/** Local admission bookkeeping only; this class never starts agents or network jobs. */
export class Flow {
  constructor(store) {
    this.store = store;
    this.slots = new Map();
    this.closed = false;
  }
  open() {
    if (this.closed) fail("CLOSED", "Flow has been closed");
  }
  workspace(workspaceId) {
    string(workspaceId, "workspaceId");
    return this.store.get("workspaces", workspaceId).id;
  }
  config(workspaceId) {
    return this.store.meta(`flowConfig:${workspaceId}`, { limit: 3, assignments: {} });
  }
  saveConfig(workspaceId, config) {
    this.store.setMeta(`flowConfig:${workspaceId}`, config);
  }
  bound(workspaceId, sessionId) {
    string(sessionId, "sessionId");
    const item = this.store.dispatch("workspaces.forSession", { sessionId }).item;
    if (!item || item.id !== workspaceId)
      fail("WORKSPACE_MISMATCH", "The session must be explicitly bound to this workspace");
  }
  active(workspaceId) {
    let slots = this.slots.get(workspaceId);
    if (!slots) {
      slots = new Map();
      this.slots.set(workspaceId, slots);
    }
    for (const sessionId of slots.keys()) {
      const workspace = this.store.dispatch("workspaces.forSession", { sessionId }).item;
      if (!workspace || workspace.id !== workspaceId) slots.delete(sessionId);
    }
    return slots;
  }
  status(workspaceId) {
    const config = this.config(workspaceId);
    const active = [...this.active(workspaceId).values()].map((item) => ({ ...item }));
    const assignments = Object.entries(config.assignments)
      .filter(
        ([sessionId]) =>
          this.store.dispatch("workspaces.forSession", { sessionId }).item?.id === workspaceId,
      )
      .map(([sessionId, role]) => ({ sessionId, role }));
    return {
      workspaceId,
      limit: config.limit,
      available: config.limit - active.length,
      active,
      assignments,
    };
  }
  dispatch(action, payload = {}) {
    this.open();
    object(payload);
    if (
      !["flow.status", "flow.configure", "flow.assign", "flow.acquire", "flow.release"].includes(
        action,
      )
    )
      fail("UNKNOWN_ACTION", `Unsupported local flow action: ${action}`);
    const workspaceId = this.workspace(payload.workspaceId);
    const config = this.config(workspaceId);
    const slots = this.active(workspaceId);
    switch (action) {
      case "flow.status":
        return this.status(workspaceId);
      case "flow.configure": {
        if (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 10)
          fail("INVALID_INPUT", "Flow limit must be an integer from 1 to 10");
        if (payload.limit < slots.size)
          fail("CONFLICT", "Release active slots before lowering the limit below current usage");
        this.saveConfig(workspaceId, { ...config, limit: payload.limit });
        return this.status(workspaceId);
      }
      case "flow.assign": {
        const sessionId = string(payload.sessionId, "sessionId");
        this.bound(workspaceId, sessionId);
        const assignments = { ...config.assignments };
        if (payload.role === null) delete assignments[sessionId];
        else {
          const role = string(payload.role, "role");
          const roles = this.store.dispatch("roles.list", { workspaceId }).items;
          if (!roles.some((item) => item.role === role))
            fail("INVALID_INPUT", "Unknown workspace role");
          // Define an own data property even for special JavaScript property names.
          Object.defineProperty(assignments, sessionId, {
            value: role,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        this.saveConfig(workspaceId, { ...config, assignments });
        if (payload.role === null) slots.delete(sessionId);
        else if (slots.has(sessionId))
          slots.set(sessionId, { ...slots.get(sessionId), role: payload.role });
        return { item: { sessionId, role: payload.role }, ...this.status(workspaceId) };
      }
      case "flow.acquire": {
        const sessionId = string(payload.sessionId, "sessionId");
        this.bound(workspaceId, sessionId);
        const role = Object.hasOwn(config.assignments, sessionId)
          ? config.assignments[sessionId]
          : null;
        if (!role)
          fail("ROLE_REQUIRED", "Explicitly assign a role before acquiring a local execution slot");
        if (payload.role !== undefined && payload.role !== role)
          fail("ROLE_MISMATCH", "Requested role differs from the explicit session assignment");
        if (slots.has(sessionId))
          return {
            item: { ...slots.get(sessionId) },
            acquired: false,
            ...this.status(workspaceId),
          };
        if (slots.size >= config.limit)
          fail("SLOTS_FULL", "All local execution slots for this workspace are in use");
        const item = { sessionId, role, acquiredAt: new Date().toISOString() };
        slots.set(sessionId, item);
        return { item: { ...item }, acquired: true, ...this.status(workspaceId) };
      }
      case "flow.release": {
        const sessionId = string(payload.sessionId, "sessionId");
        this.bound(workspaceId, sessionId);
        return { released: slots.delete(sessionId), ...this.status(workspaceId) };
      }
    }
  }
  rolePrompt(sessionId) {
    this.open();
    string(sessionId, "sessionId");
    const workspace = this.store.dispatch("workspaces.forSession", { sessionId }).item;
    if (!workspace) return null;
    const config = this.config(workspace.id);
    const role = Object.hasOwn(config.assignments, sessionId)
      ? config.assignments[sessionId]
      : null;
    if (!role) return null;
    return (
      this.store
        .dispatch("roles.list", { workspaceId: workspace.id })
        .items.find((item) => item.role === role)?.content ?? null
    );
  }
  close() {
    this.slots.clear();
    this.closed = true;
  }
}

export default Flow;
