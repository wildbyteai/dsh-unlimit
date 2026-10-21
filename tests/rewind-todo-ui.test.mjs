import test from "node:test";
import assert from "node:assert/strict";
import { rewindNotice, rewindSummary } from "../web/rewind.js";

const restored = {
  archived: true,
  newSessionId: "synthetic-fork",
  draftStatus: "restored",
};

test("rewind notice explains the bounded task reset on the new branch", () => {
  assert.match(rewindNotice, /保留任务中在被切除的同一轮内完成的任务恢复为待开始/);
  assert.match(rewindNotice, /原会话的任务不变/);
});

test("verified rewind task reset reports the observed count without changing draft success", () => {
  const html = rewindSummary({
    ...restored,
    todoReset: { requested: true, plannedCount: 2, verified: true, resetCount: 2 },
  });
  assert.match(html, /新分支有 2 项待办已恢复为待开始。/);
  assert.match(html, /class="note"/);
  assert.match(html, /回退分支已创建，草稿已恢复到新会话/);
  assert.match(html, /文字草稿已恢复，没有自动发送/);
});

test("an unverified task reset does not claim its planned count was restored", () => {
  for (const verified of [false, undefined, "true"]) {
    const html = rewindSummary({
      ...restored,
      todoReset: { requested: true, plannedCount: 9, verified, resetCount: 0 },
    });
    assert.match(html, /待办恢复未确认，请检查新分支。/);
    assert.doesNotMatch(html, /新分支有 \d+ 项待办已恢复/);
  }
});

test("a tool policy failure after the task write still reports an incomplete rewind", () => {
  for (const draftStatus of ["host-partial", "restored"]) {
    const html = rewindSummary({
      ...restored,
      archived: false,
      draftStatus,
      failedAt: "reset-todos",
      todoReset: { requested: true, plannedCount: 1, verified: true, resetCount: 1 },
      error: "<policy rejected after write>",
    });
    assert.match(html, /新分支有 1 项待办已恢复为待开始。/);
    assert.match(html, /宿主回退尚未完成/);
    assert.match(html, /class="error"/);
    assert.match(html, /原会话归档未确认/);
    assert.match(html, /&lt;policy rejected after write&gt;/);
    assert.doesNotMatch(html, /回退分支已创建，草稿已恢复到新会话/);
  }
});

test("task reset counts preserve numbers and escape untrusted values", () => {
  for (const resetCount of [0, 12]) {
    const html = rewindSummary({
      ...restored,
      todoReset: { requested: true, plannedCount: resetCount, verified: true, resetCount },
    });
    assert.ok(html.includes(`新分支有 ${resetCount} 项待办已恢复为待开始。`));
  }
  const html = rewindSummary({
    ...restored,
    todoReset: {
      requested: true,
      plannedCount: "<unused-planned-count>",
      verified: true,
      resetCount: `<img src=x onerror="alert('x')">&`,
    },
  });
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(&#39;x&#39;\)&quot;&gt;&amp;/);
  assert.doesNotMatch(html, /<img|<unused-planned-count>/);
});

test("a rewind without task-reset evidence keeps the previous summary text", () => {
  const html = rewindSummary(restored);
  assert.equal(
    html,
    '<div class="note"><strong>回退分支已创建，草稿已恢复到新会话</strong><br>原记录已保留并归档。新会话：<span class="mono">synthetic-fork</span><br>文字草稿已恢复，没有自动发送。</div>',
  );
});
