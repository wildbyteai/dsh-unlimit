import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fail, object, string } from "../core/validation.js";
import { normalizeServers } from "../core/servers.js";
import {
  hostSkillResourceInventory,
  normalizeSkillResources,
  selectedHostSkillResources,
  selectedSkillResources,
} from "../core/skill-resources.js";

const ORIGINS = ["host", "project"];
const ENVIRONMENT_KINDS = ["environment-variable", "environment-host", "environment-key"];
const REQUIREMENT_KINDS = ["tool", "toolkit", "directory", "skill", ...ENVIRONMENT_KINDS];

function fields(value, allowed) {
  object(value);
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail("INVALID_INPUT", "Unsupported catalog option");
}
function reference(value) {
  fields(value, ["origin", "id", "requirements", "resources"]);
  if (!ORIGINS.includes(value.origin)) fail("INVALID_INPUT", "origin must be host or project");
  string(value.id, "id");
  const resources = normalizeSkillResources(value.origin, value.resources);
  return { origin: value.origin, id: value.id, ...(resources === undefined ? {} : { resources }) };
}
export function normalizeRequirements(value) {
  if (!Array.isArray(value)) fail("INVALID_INPUT", "requirements must be an array");
  return value.map((item) => {
    fields(item, ["kind", "name", "path", "nonEmpty"]);
    if (!REQUIREMENT_KINDS.includes(item.kind)) fail("INVALID_INPUT", "Unknown requirement kind");
    const key = item.kind === "directory" ? "path" : "name";
    string(item[key], key);
    const allowed =
      item.kind === "environment-variable" ? ["kind", key, "nonEmpty"] : ["kind", key];
    if (Object.keys(item).some((name) => !allowed.includes(name)))
      fail("INVALID_INPUT", `Only ${key} identifies this requirement`);
    if (item.kind === "environment-variable") {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item.name) ||
        (item.nonEmpty !== undefined && typeof item.nonEmpty !== "boolean")
      )
        fail(
          "INVALID_INPUT",
          "Environment variables require a portable name and optional boolean nonEmpty",
        );
      return { kind: item.kind, name: item.name, nonEmpty: item.nonEmpty ?? true };
    }
    if (item.kind === "environment-host") {
      let names;
      try {
        names = normalizeServers([item.name]);
      } catch {
        fail(
          "INVALID_INPUT",
          "Environment host must identify one configured host, without credentials, URLs or ports",
        );
      }
      if (names.length !== 1)
        fail("INVALID_INPUT", "Environment host must identify one configured host");
      return { kind: item.kind, name: names[0] };
    }
    if (item.kind === "environment-key" && !/^[0-9a-f-]{36}$/.test(item.name))
      fail("INVALID_INPUT", "Environment key must identify a registered private-key metadata ID");
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
    return { state: "declared", source, requirements: normalizeRequirements(raw) };
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
    ...(origin === "project" && value.resources !== undefined
      ? { resources: value.resources.map(({ path, bytes }) => ({ path, bytes })) }
      : {}),
    ...(origin === "host" ? hostSkillResourceInventory(value) : {}),
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
  constructor(ctx, { library, toolkit, environment } = {}) {
    this.ctx = ctx;
    this.library = library;
    this.toolkit = toolkit;
    this.environment = environment;
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
        ...(ref.origin === "project"
          ? {
              resources: item.files
                .filter((file) => file.path !== "SKILL.md")
                .map(({ path, bytes }) => ({ path, bytes })),
            }
          : {}),
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
  environmentObservation(cache) {
    if (cache.loaded) return cache;
    cache.loaded = true;
    if (typeof this.environment?.dispatch !== "function") {
      cache.source = {
        state: "unsupported",
        detail: "Local environment configuration is unavailable",
      };
      return cache;
    }
    try {
      const raw = this.environment.dispatch("environment.status");
      if (
        !Number.isSafeInteger(raw?.revision) ||
        raw.revision < 0 ||
        !Array.isArray(raw.variables) ||
        !Array.isArray(raw.hosts) ||
        !Array.isArray(raw.privateKeys)
      )
        throw new Error("Invalid snapshot");
      const variables = new Map();
      for (const item of raw.variables) {
        if (
          typeof item.name !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item.name) ||
          typeof item.configured !== "boolean" ||
          variables.has(item.name)
        )
          throw new Error("Invalid variable status");
        variables.set(item.name, item.configured);
      }
      const hosts = normalizeServers(raw.hosts);
      const keys = new Map();
      for (const item of raw.privateKeys) {
        if (
          typeof item.id !== "string" ||
          !/^[0-9a-f-]{36}$/.test(item.id) ||
          keys.has(item.id) ||
          typeof item.metadata?.available !== "boolean"
        )
          throw new Error("Invalid key status");
        keys.set(item.id, {
          available: item.metadata.available,
          validation: item.metadata.validation,
          reason: item.metadata.reason,
        });
      }
      cache.value = { variables, hosts: new Set(hosts), keys };
      cache.source = {
        state: "available",
        revision: raw.revision,
        detail:
          "Local configuration status only; no secret resolution, key read or connection validation",
      };
    } catch {
      // An environment failure must never echo a provider error or its possibly secret data.
      cache.source = {
        state: "error",
        detail: "Local environment configuration could not be inspected safely",
      };
    }
    return cache;
  }
  environmentCheck(requirement, cache) {
    const observation = this.environmentObservation(cache);
    if (!observation.value)
      return { ...requirement, state: "unknown", detail: observation.source.detail };
    const { variables, hosts, keys } = observation.value;
    if (requirement.kind === "environment-variable") {
      const present = variables.has(requirement.name);
      const nonEmpty = variables.get(requirement.name) === true;
      return {
        ...requirement,
        state: present && (!requirement.nonEmpty || nonEmpty) ? "ready" : "missing",
        detail: !present
          ? "Variable is not configured in this installation"
          : requirement.nonEmpty && !nonEmpty
            ? "Variable is configured with an empty value"
            : requirement.nonEmpty
              ? "Variable is configured and non-empty; value and credential validity are not exposed or tested"
              : "Variable is registered; an empty value is permitted by this declaration",
      };
    }
    if (requirement.kind === "environment-host")
      return {
        ...requirement,
        state: hosts.has(requirement.name) ? "ready" : "missing",
        detail: hosts.has(requirement.name)
          ? "Host is in the local infrastructure inventory; connectivity and target authorization are not tested"
          : "Host is not in the local infrastructure inventory",
      };
    const key = keys.get(requirement.name);
    if (!key)
      return {
        ...requirement,
        state: "missing",
        detail: "Private-key metadata ID is not registered in this installation",
      };
    if (key.available && key.validation === "metadata-only")
      return {
        ...requirement,
        state: "ready",
        detail:
          "Registered path currently identifies an ordinary file; key bytes, format and authentication are not checked",
      };
    const absent = ["NOT_FOUND", "UNSAFE_PATH", "INVALID_PATH"].includes(key.reason);
    return {
      ...requirement,
      state: absent ? "missing" : "unknown",
      detail: absent
        ? "Registered key path is missing or no longer an acceptable ordinary file"
        : "Registered key path metadata cannot currently be verified; no key bytes were read",
    };
  }
  check(requirement, catalog, environment) {
    if (ENVIRONMENT_KINDS.includes(requirement.kind))
      return this.environmentCheck(requirement, environment);
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
  async preflight(payload = {}, { signal, includeContent = false } = {}) {
    fields(payload, ["sessionId", "skills", "requirements"]);
    const selected = payload.skills ?? [];
    if (!Array.isArray(selected)) fail("INVALID_INPUT", "skills must be an array");
    const refs = selected.map(reference);
    const explicit =
      payload.requirements === undefined ? undefined : normalizeRequirements(payload.requirements);
    for (const item of selected)
      if (item.requirements !== undefined) normalizeRequirements(item.requirements);
    const context = this.context(payload.sessionId);
    const catalog = await this.collect(context, signal);
    const environment = { loaded: false };
    const checks = (explicit || []).map((item) => this.check(item, catalog, environment));
    const skills = [];
    const skillBodies = [];
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
        this.check(requirement, catalog, environment),
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
      if (includeContent && item.invocation?.modelInvocable === false)
        ownChecks.push({
          kind: "skill-invocation",
          state: "invalid",
          detail: "This skill disables model invocation; workflow delivery is unavailable",
        });
      let resources;
      if (ref.resources !== undefined) {
        try {
          resources =
            ref.origin === "host"
              ? selectedHostSkillResources(item, ref.resources)
              : selectedSkillResources(item, ref.resources);
          result.resources = resources.map(({ content, ...metadata }) => metadata);
        } catch (error) {
          ownChecks.push({
            kind: "skill-resource",
            state: "invalid",
            code: error.code,
            detail: error.message,
          });
        }
      }
      if (includeContent && result.readStatus === "readable")
        skillBodies.push({
          origin: ref.origin,
          id: ref.id,
          name: item.name,
          content: item.content,
          ...(resources === undefined ? {} : { resources }),
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
      ...(includeContent ? { skillBodies } : {}),
      checks,
      sources: catalog.sources,
      toolkit: catalog.toolkit,
      ...(environment.loaded ? { environment: environment.source } : {}),
      executionAuthorized: false,
      scope:
        "Declared dependencies, local configuration status and directory presence only; no secret resolution, key read, download, execution, network probe or admission grant",
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
