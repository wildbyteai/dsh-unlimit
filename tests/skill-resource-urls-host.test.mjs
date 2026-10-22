import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { HostCatalog } from "../src/host/catalog.js";
import { DesktopWorkflowPlan } from "../src/host/workflow-plan.js";
import { fixture, optionalHost, runtimeRoot, waitFor } from "./helpers/workflow-host-fixture.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function officialSkills() {
  const manifestBytes = readFileSync(join(runtimeRoot, "desktop-runtime.json"));
  assert.equal(
    sha(manifestBytes),
    "3b264f1d9d4d3dc01e37aa382b2575a9dda6e34480af04982921b7d7720f0ef0",
    "The official inventory must match the desktop evidence before module inspection",
  );
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.release.version, "0.2.1-rc.2");
  const filename = createRequire(join(runtimeRoot, "package.json")).resolve(
    "@deepseek-ai/dsh-skill",
  );
  const entry = manifest.files.find((item) => item.path === relative(runtimeRoot, filename));
  assert.ok(entry, "Official inventory must include SkillRegistry");
  assert.equal(sha(readFileSync(filename)), entry.sha256);
  return import(pathToFileURL(filename).href);
}

test(
  "official scoped directory and file URL resources reach planning, exact task requests and reopened JSONL",
  optionalHost,
  async (t) => {
    const directoryRef = {
      origin: "host",
      id: "host-directory-evidence",
      resources: ["references/count.md"],
    };
    const urlRef = {
      origin: "host",
      id: "host-url-evidence",
      resources: ["references/count.md"],
    };
    const generated = [
      {
        id: "directory",
        role: "analyst",
        task: "Count the supplied synthetic directory records.",
        requirements: [],
        skills: [directoryRef],
      },
      {
        id: "local-url",
        role: "analyst",
        task: "Count the supplied synthetic local URL records.",
        requirements: [],
        skills: [urlRef],
      },
    ];
    let urlPath;
    const currentURLText = "\uFEFFSCOPED_URL_RESOURCE_CURRENT: original synthetic A/B.\r\n  \n";
    const outputs = [
      JSON.stringify({ tasks: generated }),
      "Synthetic evidence result from the first task.",
      "Synthetic evidence result from the second task.",
      "Synthetic unverified summary of the two task receipts.",
    ];
    let requests = 0;
    const f = await fixture(t, {
      textOutput: () => {
        if (requests === 0) writeFileSync(urlPath, currentURLText);
        return outputs[requests++];
      },
    });
    const skills = await officialSkills();
    const owner = f.ctx.plugin({
      name: "synthetic-resource-registry",
      apply: (scope) => {
        new skills.SkillRegistry(scope);
      },
    });
    f.onDispose(() => owner.dispose());
    await owner.await();
    assert.equal(owner.state, 2);
    const parent = await f.create();
    const root = (name, text) => {
      const directory = join(f.directory, name);
      mkdirSync(join(directory, "references"), { recursive: true });
      writeFileSync(join(directory, "references/count.md"), text);
      writeFileSync(join(directory, "references/unused.md"), "UNSELECTED_HOST_RESOURCE");
      writeFileSync(join(directory, "unselected.js"), "throw new Error('MUST_NOT_EXECUTE')");
      return directory;
    };
    const directoryText = "DIRECTORY_HOST_RESOURCE: original synthetic 1/2/3.\r\n";
    const directory = root("directory-resources", directoryText);
    const globalURL = root("global-url-resources", "SHADOWED_GLOBAL_URL_RESOURCE");
    const scopedURL = root("URL 技能 100% #", "SCOPED_URL_RESOURCE_AT_PLANNING");
    urlPath = join(scopedURL, "references/count.md");
    const definition = (name, content, resourceBase) => ({
      name,
      description: "Original synthetic resource evidence procedure",
      content,
      provider: "runtime",
      source: "runtime",
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase,
      metadata: { "dsh-unlimit": { requirements: [] } },
    });
    f.ctx
      .get("skills")
      .register(
        definition(directoryRef.id, "DIRECTORY_SKILL_BODY", { kind: "directory", path: directory }),
      );
    f.ctx.get("skills").register(
      definition(urlRef.id, "SHADOWED_GLOBAL_SKILL_BODY", {
        kind: "url",
        url: pathToFileURL(`${globalURL}/`).href,
      }),
    );
    const resourceBase = { kind: "url", url: pathToFileURL(`${scopedURL}/`).href };
    parent.ctx.get("skills").register(definition(urlRef.id, "SCOPED_URL_SKILL_BODY", resourceBase));
    const catalog = new HostCatalog(f.ctx, {
      library: { dispatch: () => ({ items: [] }) },
      toolkit: { status: () => ({ tools: [] }) },
    });
    const listed = await catalog.list({ sessionId: parent.id });
    assert.deepEqual(
      listed.skills.find((item) => item.id === urlRef.id).resourceBase,
      resourceBase,
    );
    assert.equal(
      listed.skills.find((item) => item.id === urlRef.id).resourceStatus.state,
      "available",
    );
    assert.doesNotMatch(
      JSON.stringify(listed),
      /SKILL_BODY|RESOURCE_AT_PLANNING|UNSELECTED_HOST_RESOURCE/,
    );
    const plans = new DesktopWorkflowPlan(f.workflow, { catalog });
    try {
      const binding = { workspaceId: f.workspaceId, parentSessionId: parent.id };
      const { item } = await plans.dispatch("workflow.plan.run", {
        ...binding,
        goal: "Inspect only the supplied synthetic resource records and cite their source.",
        summarize: true,
      });
      const { item: done } = await waitFor(
        () => plans.dispatch("workflow.plan.status", { ...binding, id: item.id }),
        (result) => ["completed", "finished-with-errors"].includes(result.item.state),
      );
      assert.equal(done.state, "completed", JSON.stringify(done));
      assert.equal(f.requests.length, 4);
      assert.deepEqual(
        done.proposal.tasks.map((task) => task.skills[0]),
        [directoryRef, urlRef],
      );
      const plannerInput = JSON.stringify(f.requests[0].messages);
      assert.ok(plannerInput.includes("references/count.md"));
      assert.ok(plannerInput.includes(directoryRef.id));
      assert.ok(plannerInput.includes(urlRef.id));
      assert.doesNotMatch(
        plannerInput,
        /SKILL_BODY|RESOURCE_AT_PLANNING|RESOURCE_CURRENT|DIRECTORY_HOST_RESOURCE/,
      );
      for (const task of done.tasks) {
        const request = f.requests.find((value) => value.sessionId === task.receipt.sessionId);
        assert.ok(request);
        const serialized = JSON.stringify(request.messages);
        assert.equal(serialized.includes("DIRECTORY_HOST_RESOURCE"), task.id === "directory");
        assert.equal(serialized.includes("SCOPED_URL_RESOURCE_CURRENT"), task.id === "local-url");
        assert.doesNotMatch(
          serialized,
          /SHADOWED_GLOBAL|RESOURCE_AT_PLANNING|UNSELECTED_HOST_RESOURCE|MUST_NOT_EXECUTE/,
        );
        assert.equal(task.receipt.disposed, true);
        assert.equal(task.receipt.slotReleased, true);
        if (task.id === "directory" || task.id === "local-url") {
          const text = task.id === "directory" ? directoryText : currentURLText;
          const ref = task.id === "directory" ? directoryRef : urlRef;
          assert.deepEqual(task.skillContext[0], {
            origin: "host",
            id: ref.id,
            name: ref.id,
            content: task.id === "directory" ? "DIRECTORY_SKILL_BODY" : "SCOPED_URL_SKILL_BODY",
            resources: [
              {
                path: "references/count.md",
                bytes: Buffer.byteLength(text),
                sha256: sha(text),
                content: text,
              },
            ],
          });
        }
      }
      assert.deepEqual(
        done.tasks.at(-1).sources.map((source) => source.taskId),
        ["directory", "local-url"],
      );
      await f.ctx.sessionPersistence.flush();
      for (const task of done.tasks) {
        const reader = await f.ctx.sessionPersistence.open(task.receipt.sessionId, "read");
        try {
          const events = (await reader.read()).events;
          assert.ok(
            events.some(
              (event) => event.type === "turn/end" && event.data.reason.kind === "completed",
            ),
          );
          const journal = JSON.stringify(events);
          assert.equal(journal.includes("DIRECTORY_HOST_RESOURCE"), task.id === "directory");
          assert.equal(journal.includes("SCOPED_URL_RESOURCE_CURRENT"), task.id === "local-url");
          assert.doesNotMatch(journal, /SHADOWED_GLOBAL|UNSELECTED_HOST_RESOURCE|MUST_NOT_EXECUTE/);
          assert.ok(
            events.some(
              (event) =>
                event.type === "assistant/message" &&
                JSON.stringify(event.data.message.content) ===
                  JSON.stringify(task.receipt.result.output),
            ),
          );
        } finally {
          await reader.close();
        }
      }
      assert.equal(f.flow.status(f.workspaceId).active.length, 0);
    } finally {
      await plans.close();
    }
  },
);
