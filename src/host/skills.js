import { join } from "node:path";

export function connectSkills(ctx, library) {
  let invalidate = () => {};
  const provider = "dsh-unlimit";
  const definition = (item) => ({
    name: item.name,
    description: item.description,
    invocation: item.invocation ?? { userInvocable: true, modelInvocable: true },
    source: "user",
    provider,
    path: join(library.root, item.id, "SKILL.md"),
    resourceBase: { kind: "directory", path: join(library.root, item.id) },
    ...(item.content === undefined
      ? {}
      : { content: item.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim() }),
  });
  const dispose = ctx.skills.registerProvider((control) => {
    invalidate = () => control.invalidate();
    return {
      name: provider,
      async list() {
        return library
          .dispatch("skills.list")
          .items.filter((item) => !item.error)
          .map((item) => ({
            ...definition(item),
            rank: 1,
            locator: item.id,
          }));
      },
      async get(candidate) {
        return definition(library.dispatch("skills.read", { id: candidate.locator }).item);
      },
    };
  });
  return { changed: () => invalidate(), dispose };
}
