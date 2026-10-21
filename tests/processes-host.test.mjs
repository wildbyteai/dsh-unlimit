import test from "node:test";
import assert from "node:assert/strict";
import { eventually, processHostFixture } from "./helpers/process-host-fixture.mjs";

const selectedRoot = process.env.DSH_UNLIMIT_RUNTIME;
const skip = !selectedRoot
  ? "Set DSH_UNLIMIT_RUNTIME for official local subprocess acceptance; no profile is loaded"
  : process.platform !== "darwin" || process.arch !== "arm64"
    ? "Native acceptance is pinned to the supported macOS arm64 runtime"
    : false;

test(
  "official owned processes use real subprocess lifecycle in isolated temporary directories",
  {
    skip,
    timeout: 30000,
  },
  async (t) => {
    const f = await processHostFixture(t, selectedRoot);
    await f.unrelatedStart();
    let stopped;

    await t.test("OFFICIAL-PROCESS-ARGV-OUTPUT-AND-SCOPE", async () => {
      assert.equal(f.adapter.capabilities().start, true);
      const literal = [
        "spaces remain one argument",
        "$(no_command_is_executed)",
        "",
        "--literal;value",
      ];
      stopped = await f.start("explicit-stop", { args: literal });
      assert.equal(stopped.status, "running");
      assert.equal(stopped.mode, "danger-full-access");
      assert.equal(stopped.enforcement, "none");
      const observed = await f.ready(stopped, "explicit-stop");
      const ready = JSON.parse(observed.stdout.text.split("\n")[0]);
      assert.deepEqual(
        ready.args,
        literal,
        "Real child receives exact argv without shell interpolation",
      );
      assert.equal(observed.stdout.lossy, false);
      assert.equal(observed.stderr.lossy, false);
      const suffix = await f.output(stopped, {
        stdoutOffset: observed.stdout.nextOffset,
        stderrOffset: observed.stderr.nextOffset,
      });
      assert.equal(suffix.stderr.text, "");
      assert.equal(suffix.stderr.nextOffset, observed.stderr.nextOffset);
      assert.deepEqual(Object.keys(suffix.stdout).sort(), ["lossy", "nextOffset", "text"]);
      assert.equal((await f.adapter.dispatch("processes.list", {}, f.execution())).items.length, 1);
      assert.deepEqual(
        (await f.adapter.dispatch("processes.list", {}, f.execution(f.peer))).items,
        [],
      );
      await assert.rejects(f.output(stopped, {}, f.peer), { code: "NOT_FOUND" });
      await assert.rejects(
        f.adapter.dispatch("processes.stop", {
          workspaceId: "synthetic-other-workspace",
          id: stopped.id,
        }),
        { code: "NOT_FOUND" },
      );
    });

    await t.test("OFFICIAL-PROCESS-STOP-AND-ACTUAL-EXIT", async () => {
      const result = await f.adapter.dispatch("processes.stop", { id: stopped.id }, f.execution());
      assert.equal(result.stopped, true);
      assert.equal(result.item.status, "stopped");
      assert.equal(result.item.exitCode, 0);
      assert.equal(result.item.exitSignal, null);
      await f.closed("explicit-stop");
      const output = await f.output(stopped);
      assert.ok(output.stdout.text.includes("signal:explicit-stop:SIGTERM\n"));
      assert.equal(
        (await f.adapter.dispatch("processes.stop", { id: stopped.id }, f.execution())).stopped,
        false,
      );
      await f.assertUnrelatedAlive("processes.stop");
    });

    await t.test("OFFICIAL-PROCESS-NONZERO-NATURAL-EXIT", async () => {
      const item = await f.start("natural-exit", { behavior: "exit" });
      const result = await eventually(async () => {
        const result = await f.output(item);
        return result.item.status === "failed" && result;
      }, "Natural child exit did not settle");
      assert.equal(result.item.exitCode, 7);
      assert.equal(result.item.exitSignal, null);
      assert.equal(result.item.error.code, "PROCESS_EXIT_FAILED");
      assert.ok(result.stdout.text.includes('"label":"natural-exit"'));
      assert.equal(result.stderr.text, "stderr:natural-exit\n");
      await f.closed("natural-exit");
    });

    await t.test("OFFICIAL-PROCESS-DEADLINE", async () => {
      const item = await f.start("deadline", { timeoutMs: 350 });
      await f.ready(item, "deadline");
      const result = await eventually(async () => {
        const result = await f.output(item);
        return result.item.status === "timed-out" && result;
      }, "The real process deadline did not terminate its child");
      assert.equal(result.item.exitCode, 0);
      assert.ok(result.stdout.text.includes("signal:deadline:SIGTERM\n"));
      await f.closed("deadline");
    });

    await t.test("OFFICIAL-PROCESS-STOPALL-PRESERVES-UNRELATED-SERVICE-HANDLE", async () => {
      const item = await f.start("stop-all");
      await f.ready(item, "stop-all");
      const result = await f.adapter.stopAll();
      assert.equal(result.stopped, true);
      assert.equal(result.items.find((entry) => entry.id === item.id).status, "stopped");
      await f.closed("stop-all");
      await f.assertUnrelatedAlive("stopAll");
    });

    await t.test("OFFICIAL-PROCESS-CLOSE-PRESERVES-UNRELATED-SERVICE-HANDLE", async () => {
      const item = await f.start("plugin-close");
      await f.ready(item, "plugin-close");
      const result = await f.adapter.close();
      assert.equal(result.stopped, true);
      assert.equal(result.items.find((entry) => entry.id === item.id).status, "stopped");
      await f.closed("plugin-close");
      await f.assertUnrelatedAlive("close");
      await assert.rejects(
        f.adapter.dispatch(
          "processes.start",
          {
            tool: "nmap",
            args: [],
          },
          f.execution(),
        ),
        { code: "CLOSED" },
      );
      assert.equal(f.adapter.capabilities().start, false);
    });

    await f.dispose();
    const evidence = f.evidence();
    assert.equal(evidence.launches.length, 6);
    assert.ok(evidence.launches.every((row) => row.closed));
    assert.equal(evidence.fixtureRootRemoved, true);
    assert.equal(evidence.unrelatedSurvival.length, 3);
    assert.deepEqual(evidence.networkAttempts, []);
    assert.ok(evidence.verifiedOfficialFiles > 20);
    t.diagnostic(JSON.stringify(evidence));
  },
);
