import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 0.2.1 assembles once per step, outside its retry loop. Refresh only a repeated
 * request in that step, before the host projects and journals its system message.
 * The provider request and the durable journal therefore use the same text.
 */
export function connectPromptRefresh(ctx, runtime) {
  const projections = new Map();
  let renderer;
  const loadRenderer = async () => {
    renderer ??= import(
      pathToFileURL(
        createRequire(join(runtime.host.runtimeRoot, "package.json")).resolve(
          "@deepseek-ai/dsh-system-prompt",
        ),
      ).href
    );
    return (await renderer).renderPrompt;
  };
  const detach = (agent) => {
    const entry = projections.get(agent);
    if (!entry) return;
    projections.delete(agent);
    if (Object.getOwnPropertyDescriptor(entry.target, "project")?.value !== entry.wrapper) {
      throw new Error("系统消息投影已被其他插件修改，未覆盖该修改");
    }
    if (entry.descriptor) Object.defineProperty(entry.target, "project", entry.descriptor);
    else delete entry.target.project;
  };
  const disposeRequest = ctx.on("agent/request", async ({ agent, turn, step, signal }, next) => {
    const config = await next();
    signal?.throwIfAborted();
    if (!runtime.settings().enabled) return config;
    let entry = projections.get(agent);
    if (!entry) {
      const target = agent.systemPrompt;
      if (typeof target?.project !== "function")
        throw new Error("当前代理没有已适配的系统消息投影接口");
      const descriptor = Object.getOwnPropertyDescriptor(target, "project");
      const original = target.project;
      entry = { target, descriptor, turn, step, text: undefined };
      entry.wrapper = function (text, ...args) {
        return original.call(
          this,
          runtime.settings().enabled && entry.text !== undefined ? entry.text : text,
          ...args,
        );
      };
      Object.defineProperty(target, "project", {
        configurable: true,
        writable: true,
        value: entry.wrapper,
      });
      projections.set(agent, entry);
      return config;
    }
    if (entry.turn === turn && entry.step === step) {
      const render = await loadRenderer();
      const assembly = await runtime
        .service("systemPrompt")
        .assemble({ agent, scope: agent, signal, model: config.model });
      signal?.throwIfAborted();
      entry.text = render(assembly);
    } else {
      entry.turn = turn;
      entry.step = step;
      entry.text = undefined;
    }
    return config;
  });
  const disposeAgent = ctx.on("agent/disposed", ({ agent }) => detach(agent));
  return () => {
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
