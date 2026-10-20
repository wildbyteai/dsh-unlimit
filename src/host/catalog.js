import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fail, object, string } from "../core/validation.js";

const ORIGINS = ["host", "project"];
const REQUIREMENT_KINDS = ["tool", "toolkit", "directory", "skill"];

function fields(value, allowed) {
  object(value);
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail("INVALID_INPUT", "Unsupported catalog option");
}
function reference(value) {
  fields(value, ["origin", "id", "requirements"]);
  if (!ORIGINS.includes(value.origin)) fail("INVALID_INPUT", "origin must be host or project");
  string(value.id, "id");
  return { origin: value.origin, id: value.id };
}
function requirements(value) {
  if (!Array.isArray(value)) fail("INVALID_INPUT", "requirements must be an array");
  return value.map((item) => {
    fields(item, ["kind", "name", "path"]);
    if (!REQUIREMENT_KINDS.includes(item.kind)) fail("INVALID_INPUT", "Unknown requirement kind");
    const key = item.kind === "directory" ? "path" : "name";
    string(item[key], key);
    if (Object.keys(item).some((name) => !["kind", key].includes(name)))
      fail("INVALID_INPUT", `Only ${key} identifies this requirement`);
    return { kind: item.kind, [key]: item[key] };
  });
}
function declaration(definition, explicit) {
  // This namespace is this plugin's explicit contract, not an official dependency schema.
  const raw =
    explicit !== undefined ? explicit : definition.metadata?.["dsh-unlimit"]?.requirements;
  const source =
    explicit !== undefined
      ? "explicit"
      : raw !== undefined
        ? "metadata:dsh-unlimit.requirements"
        : "undeclared";
  if (raw === undefined)
    return {
      state: "unknown",
      source,
      requirements: [],
      detail: "No dependency declaration; skill prose is not inspected",
    };
  try {
    return { state: "declared", source, requirements: requirements(raw) };
  } catch (error) {
    return { state: "invalid", source, requirements: [], detail: error.message };
  }
}
function summary(value, origin, id) {
  return {
    origin,
    id,
    name: value.name,
    description: value.description,
    ...(value.provider !== undefined ? { provider: value.provider } : {}),
    ...(value.source !== undefined ? { source: value.source } : {}),
    ...(value.path !== undefined ? { path: value.path } : {}),
    ...(value.resourceBase !== undefined
      ? { resourceBase: structuredClone(value.resourceBase) }
      : {}),
    ...(value.invocation !== undefined ? { invocation: { ...value.invocation } } : {}),
    ...(value.whenToUse !== undefined ? { whenToUse: value.whenToUse } : {}),
    exposure: origin === "host" ? "session-registry" : "project-library",
    readStatus: "not-read",
    dependencyStatus: "unknown",
  };
}
function sourceResult(outcome) {
  return outcome.status === "fulfilled"
    ? { state: outcome.value.state, ...outcome.value.source }
    : { state: "error", detail: outcome.reason.message };
}
function combined(checks) {
  if (checks.some((item) => ["missing", "invalid"].includes(item.state))) return "blocked";
  if (checks.some((item) => item.state === "unknown")) return "unknown";
  return "ready";
}

/** Read-only catalog. Never executes tools, inspects skill prose for dependencies, or fetches MCP directories. */
export class HostCatalog {
  constructor(ctx, { library, toolkit } = {}) {
    this.ctx = ctx;
    this.library = library;
    this.toolkit = toolkit;
  }
  service(name) {
    return this.ctx.get(name);
  }
  context(sessionId) {
    if (sessionId === undefined)
      return { view: { sessionId: null, scope: "host", cwd: null }, lookup: {} };
    string(sessionId, "sessionId");
    const agent = this.service("agents")?.get(sessionId);
    if (!agent || agent.session?.id !== sessionId)
      fail("NOT_FOUND", "A live session scope is required; host-wide fallback is not allowed");
    const directory = this.service("workingDirectory");
    // ensure() may append recovery state to a session. Only get() is permitted here.
    const cwd = directory?.get ? directory.get(agent.session) : agent.session.header?.cwd;
    if (cwd !== undefined && (typeof cwd !== "string" || !isAbsolute(cwd)))
      fail("INVALID_CONTEXT", "Session working directory must be absolute");
    return {
      agent,
      view: {
        sessionId,
        scope: "session",
        cwd: cwd ?? null,
        cwdSource: directory?.get ? "workingDirectory.get" : "session-header",
      },
      lookup: { scope: agent, ...(cwd !== undefined ? { cwd } : {}) },
    };
  }
  async collect(context, signal) {
    signal?.throwIfAborted();
    const registry = this.service("skills");
    const tools = this.service("tools");
    const outcomes = await Promise.allSettled([
      (async () => {
        if (!registry?.snapshot)
          return {
            state: "unsupported",
            items: [],
            source: { complete: false, detail: "SkillRegistry.snapshot is unavailable" },
          };
        const snapshot = await registry.snapshot({ ...context.lookup, signal });
        return {
          state: "available",
          items: snapshot.skills.map((item) => summary(item, "host", item.name)),
          source: { complete: snapshot.complete },
        };
      })(),
      (async () => {
        if (!this.library)
          return {
            state: "unsupported",
            items: [],
            source: { detail: "Project skill library is unavailable" },
          };
        const { items } = await this.library.dispatch("skills.list");
        return {
          state: "available",
          items: items.map((item) =>
            summary({ ...item, provider: "dsh-unlimit", source: "user" }, "project", item.id),
          ),
          source: { complete: true },
        };
      })(),
      (async () => {
        if (!tools?.schemas)
          return {
            state: "unsupported",
            items: [],
            source: { detail: "ToolRuntime.schemas is unavailable" },
          };
        const mode = tools.modeFor?.(context.agent) ?? "unknown";
        const schemas = tools.schemas(context.agent);
        return {
          state: "available",
          items: schemas.map((schema) => ({
            ...structuredClone(schema),
            availability: "registered",
            mode,
            modelDirect: mode === "unknown" ? null : mode !== "ptc" || schema.name === "run_code",
            source: {
              registry: "ToolRuntime",
              publicName: schema.name,
              attribution: "public-name-only",
              ...(schema.name.startsWith("mcp__") ? { namespace: "mcp" } : {}),
            },
          })),
          source: {
            complete: true,
            detail: "Visible registered schemas only; no execution, approval or connection probe",
          },
        };
      })(),
      (async () => {
        if (!this.toolkit)
          return { state: "unsupported", source: { detail: "Local Toolkit is unavailable" } };
        return {
          state: "available",
          value: await this.toolkit.status(),
          source: { complete: true },
        };
      })(),
    ]);
    signal?.throwIfAborted();
    const data = (index) => (outcomes[index].status === "fulfilled" ? outcomes[index].value : null);
    return {
      context: context.view,
      skills: [...(data(0)?.items || []), ...(data(1)?.items || [])],
      tools: data(2)?.items || [],
      toolkit: data(3)?.value ?? null,
      sources: {
        skills: sourceResult(outcomes[0]),
        project: sourceResult(outcomes[1]),
        tools: sourceResult(outcomes[2]),
        toolkit: sourceResult(outcomes[3]),
      },
    };
  }
  async list(payload = {}, { signal } = {}) {
    fields(payload, ["sessionId"]);
    return this.collect(this.context(payload.sessionId), signal);
  }
  async load(ref, context, signal) {
    signal?.throwIfAborted();
    if (ref.origin === "project") {
      if (!this.library) fail("UNSUPPORTED", "Project skill library is unavailable");
      return (await this.library.dispatch("skills.read", { id: ref.id })).item;
    }
    const registry = this.service("skills");
    if (!registry?.get) fail("UNSUPPORTED", "SkillRegistry.get is unavailable");
    const item = await registry.get(ref.id, { ...context.lookup, signal });
    if (!item) fail("NOT_FOUND", "Skill is not available in this session's registry");
    return item;
  }
  async read(payload, { signal } = {}) {
    fields(payload, ["sessionId", "origin", "id"]);
    const ref = reference({ origin: payload.origin, id: payload.id });
    const context = this.context(payload.sessionId);
    const item = await this.load(ref, context, signal);
    signal?.throwIfAborted();
    if (typeof item.content !== "string")
      fail("INVALID_DATA", "Skill provider returned no text body");
    return {
      context: context.view,
      item: {
        ...summary(item, ref.origin, ref.id),
        content: item.content,
        readStatus: "readable",
        dependency: declaration(item),
        dependencyStatus: "unknown",
      },
    };
  }
  directory(path, cwd) {
    if (!isAbsolute(path) && !cwd)
      return {
        state: "unknown",
        detail: "Relative directory requires a session working directory",
      };
    const target = isAbsolute(path) ? path : resolve(cwd, path);
    try {
      return statSync(target).isDirectory()
        ? { state: "available", path: target }
        : { state: "missing", path: target, detail: "Path is not a directory" };
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code))
        return { state: "missing", path: target, detail: "Directory does not exist" };
      return {
        state: "unknown",
        path: target,
        detail: `Directory inspection failed (${error.code || "UNKNOWN"})`,
      };
    }
  }
  check(requirement, catalog) {
    switch (requirement.kind) {
      case "directory":
        return { ...requirement, ...this.directory(requirement.path, catalog.context.cwd) };
      case "tool": {
        const tool = catalog.tools.find((item) => item.name === requirement.name);
        return {
          ...requirement,
          state: tool
            ? "available"
            : catalog.sources.tools.state === "available"
              ? "missing"
              : "unknown",
          detail: tool
            ? "Registered and visible; execution and connection health are not tested"
            : "Required tool is not in the visible catalog",
          ...(tool ? { source: tool.source, modelDirect: tool.modelDirect } : {}),
        };
      }
      case "toolkit": {
        const tool = catalog.toolkit?.tools.find((item) => item.id === requirement.name);
        return {
          ...requirement,
          state: tool?.available
            ? "available"
            : tool?.path
              ? "unknown"
              : catalog.sources.toolkit.state === "available"
                ? "missing"
                : "unknown",
          detail: tool?.detail || "Required executable is not available in the configured Toolkit",
          ...(tool ? { path: tool.path, identity: tool.identity } : {}),
        };
      }
      case "skill": {
        const skill = catalog.skills.find(
          (item) => item.origin === "host" && item.name === requirement.name,
        );
        return {
          ...requirement,
          state: skill
            ? "available"
            : catalog.sources.skills.state === "available" && catalog.sources.skills.complete
              ? "missing"
              : "unknown",
          detail: skill
            ? "Visible registry entry; body and its dependencies are not recursively checked"
            : "Required skill is not in the current registry observation",
        };
      }
    }
  }
  async preflight(payload = {}, { signal } = {}) {
    fields(payload, ["sessionId", "skills", "requirements"]);
    const selected = payload.skills ?? [];
    if (!Array.isArray(selected)) fail("INVALID_INPUT", "skills must be an array");
    const refs = selected.map(reference);
    const explicit =
      payload.requirements === undefined ? undefined : requirements(payload.requirements);
    for (const item of selected)
      if (item.requirements !== undefined) requirements(item.requirements);
    const context = this.context(payload.sessionId);
    const catalog = await this.collect(context, signal);
    const checks = (explicit || []).map((item) => this.check(item, catalog));
    const skills = [];
    for (let index = 0; index < refs.length; index++) {
      signal?.throwIfAborted();
      const ref = refs[index];
      let item;
      try {
        item = await this.load(ref, context, signal);
      } catch (error) {
        signal?.throwIfAborted();
        const state = error.code === "NOT_FOUND" ? "missing" : "unknown";
        const check = { kind: "skill-body", ...ref, state, detail: error.message };
        skills.push({ ...ref, readStatus: "unreadable", dependencyStatus: state, checks: [check] });
        checks.push(check);
        continue;
      }
      const dependency = declaration(item, selected[index].requirements);
      const ownChecks = dependency.requirements.map((requirement) =>
        this.check(requirement, catalog),
      );
      if (dependency.state !== "declared")
        ownChecks.push({ kind: "declaration", state: dependency.state, detail: dependency.detail });
      const result = {
        ...ref,
        name: item.name,
        readStatus: typeof item.content === "string" ? "readable" : "unreadable",
        declaration: dependency,
        dependencyStatus: combined(ownChecks),
        checks: ownChecks,
      };
      if (result.readStatus === "unreadable")
        ownChecks.push({
          kind: "skill-body",
          state: "invalid",
          detail: "Skill provider returned no text body",
        });
      result.dependencyStatus = combined(ownChecks);
      skills.push(result);
      checks.push(...ownChecks.map((check) => ({ ...check, skill: ref })));
    }
    if (!selected.length && explicit === undefined)
      checks.push({
        kind: "declaration",
        state: "unknown",
        detail: "No selected skills or explicit dependency declaration",
      });
    // An incomplete registry can hide a dependency. Never turn a partial observation into ready.
    for (const [name, source] of Object.entries(catalog.sources))
      if (source.state !== "available" || source.complete === false)
        checks.push({
          kind: "catalog",
          name,
          state: "unknown",
          detail: source.detail || "Catalog observation is incomplete",
        });
    const directories = [
      ...(catalog.toolkit?.root ? [{ purpose: "toolkit-root", path: catalog.toolkit.root }] : []),
      ...(catalog.toolkit?.searchDirs || []).map((path) => ({ purpose: "toolkit-search", path })),
      ...(catalog.toolkit?.templateDir
        ? [{ purpose: "toolkit-templates", path: catalog.toolkit.templateDir }]
        : []),
    ].map((item) => ({
      kind: "directory",
      ...item,
      ...this.directory(item.path, context.view.cwd),
    }));
    checks.push(...directories);
    signal?.throwIfAborted();
    return {
      context: context.view,
      status: combined(checks),
      skills,
      checks,
      sources: catalog.sources,
      toolkit: catalog.toolkit,
      executionAuthorized: false,
      scope:
        "Declared dependencies and local directory presence only; no download, execution, network probe or admission grant",
    };
  }
  dispatch(action, payload = {}, options = {}) {
    switch (action) {
      case "catalog.list":
        return this.list(payload, options);
      case "catalog.read":
        return this.read(payload, options);
      case "catalog.preflight":
        return this.preflight(payload, options);
      default:
        fail("UNKNOWN_ACTION", `Unsupported catalog action: ${action}`);
    }
  }
}

export default HostCatalog;
