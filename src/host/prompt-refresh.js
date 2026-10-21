import { resolveOfficialPackage } from "./official-package.js";

function retainsPrompt(agent, message) {
  return (
    message !== undefined &&
    agent.session.surface.nodes.some((seq) => {
      const event = agent.session.eventAt(seq);
      return event.type === "system/message" && JSON.stringify(event.data.message) === message;
    })
  );
}

// A system/message is legal only inside an open step. Let the next real host
// step restore its own prompt; never append fake steps or rewrite an idle log.
function restoreOnNextStep(agent, message) {
  if (!retainsPrompt(agent, message)) return;
  let removeStep, removeEvent;
  const done = () => {
    removeStep?.();
    removeEvent?.();
  };
  removeStep = agent.ctx.on("agent/pre-step", async (event, next) => {
    const decision = await next();
    if (event.agent !== agent) return decision;
    if (!retainsPrompt(agent, message)) {
      done();
      return decision;
    }
    return decision.kind === "enter" ? { ...decision, startsRequestSeries: true } : decision;
  });
  removeEvent = agent.ctx.on("session/event", (session, event) => {
    if (
      session === agent.session &&
      event.type === "system/message" &&
      !retainsPrompt(agent, message)
    )
      done();
  });
}

/**
 * 0.2.1 assembles once per step, outside its retry loop. Refresh only a repeated
 * request in that step, before the host projects and journals its system message.
 * Project each managed assembly as the current full prompt, including for models
 * that otherwise append prompt updates in history. Native replacement events
 * preserve the journal without sending superseded instructions again.
 */
export function connectPromptRefresh(ctx, runtime) {
  const projections = new Map();
  let active = true;
  let renderer;
  const loadRenderer = async () => {
    if (!renderer) {
      const projection = await resolveOfficialPackage(
        runtime.host.runtimeRoot,
        "@deepseek-ai/dsh-agent-loop",
      );
      if (!projection.url) throw new Error(`官方系统提示投影接口不可用：${projection.reason}`);
      const resolved = await resolveOfficialPackage(
        runtime.host.runtimeRoot,
        "@deepseek-ai/dsh-system-prompt",
      );
      if (!resolved.url) throw new Error(`官方系统提示渲染接口不可用：${resolved.reason}`);
      renderer = (await import(resolved.url)).renderPrompt;
    }
    return renderer;
  };
  const detach = (agent, restore = true) => {
    const entry = projections.get(agent);
    if (!entry) return;
    projections.delete(agent);
    if (Object.getOwnPropertyDescriptor(entry.target, "project")?.value !== entry.wrapper) {
      throw new Error("系统消息投影已被其他插件修改，未覆盖该修改");
    }
    if (entry.descriptor) Object.defineProperty(entry.target, "project", entry.descriptor);
    else delete entry.target.project;
    if (restore) restoreOnNextStep(agent, entry.lastMessage);
  };
  const disposeRequest = ctx.on("agent/request", async ({ agent, turn, step, signal }, next) => {
    const config = await next();
    signal?.throwIfAborted();
    if (!active || !runtime.settings().enabled) return config;
    let entry = projections.get(agent);
    if (!entry) {
      const target = agent.systemPrompt;
      if (typeof target?.project !== "function")
        throw new Error("当前代理没有已适配的系统消息投影接口");
      const descriptor = Object.getOwnPropertyDescriptor(target, "project");
      const original = target.project;
      entry = { target, descriptor, turn, step, text: undefined };
      entry.wrapper = function (text, ...args) {
        const managed = active && runtime.settings().enabled;
        if (managed && args.length) args[0] = { ...args[0], inHistory: false };
        const commits = original.call(
          this,
          managed && entry.text !== undefined ? entry.text : text,
          ...args,
        );
        if (managed && agent.session) {
          const current = commits.findLast(({ message }) => message.content.length > 0);
          if (current) entry.lastMessage = JSON.stringify(current.message);
        }
        return commits;
      };
      Object.defineProperty(target, "project", {
        configurable: true,
        writable: true,
        value: entry.wrapper,
      });
      projections.set(agent, entry);
    } else if (entry.turn === turn && entry.step === step) {
      const render = await loadRenderer();
      if (!active) return config;
      const assembly = await runtime
        .service("systemPrompt")
        .assemble({ agent, scope: agent, signal, model: config.model });
      signal?.throwIfAborted();
      if (!active) return config;
      entry.text = render(assembly);
    } else {
      entry.turn = turn;
      entry.step = step;
      entry.text = undefined;
    }
    return config;
  });
  const disposeAgent = ctx.on("agent/disposed", ({ agent }) => detach(agent, false));
  return () => {
    active = false;
    disposeRequest();
    disposeAgent();
    const errors = [];
    for (const agent of projections.keys()) {
      try {
        detach(agent);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "部分系统消息投影已被其他插件修改");
  };
}
