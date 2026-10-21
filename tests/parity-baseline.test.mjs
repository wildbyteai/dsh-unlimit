import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const baseline = JSON.parse(
  readFileSync(new URL("./fixtures/desktop-parity-baseline.json", import.meta.url), "utf8"),
);
const current = readFileSync(new URL("../docs/parity.md", import.meta.url), "utf8");

function behaviorRows(markdown) {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => ["保留", "兼容", "排除"].includes(cells[1]))
    .map((cells) => cells.slice(0, 5));
}

function verifyBaseline(markdown) {
  assert.equal(baseline.sourceCommit, "0bc13d239890bfa89a241b5aa35236651af842b8");
  assert.equal(baseline.rows.length, 117);
  const rows = behaviorRows(markdown);
  assert.equal(rows.length, 117, "既定验收必须保留117行");
  assert.equal(new Set(rows.map(([id]) => id)).size, 117, "行为ID不可重复");
  assert.deepEqual(rows, baseline.rows, "既定117项前5列不得改变；仅第6列状态可更新");
}

test("117项验收前5列保持固定已验提交基线", () => {
  verifyBaseline(current);
});

test("状态更新允许，改弱前5列、缺行或重复ID会失败", () => {
  const markdown = baseline.rows.map((row) => `| ${row.join(" | ")} | 合成状态 |`).join("\n");
  assert.doesNotThrow(() => verifyBaseline(markdown.replaceAll("合成状态", "更新后的状态")));
  assert.throws(() => verifyBaseline(markdown.replace(baseline.rows[0][3], "改弱后的结果")));
  assert.throws(() => verifyBaseline(markdown.split("\n").slice(1).join("\n")));
  assert.throws(() => verifyBaseline(markdown.replace(baseline.rows[1][0], baseline.rows[0][0])));
});
