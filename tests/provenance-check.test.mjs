import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectProvenance } from "../scripts/provenance-check.mjs";
import { inspectSelfAudit } from "../scripts/self-audit.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "unlimit-checks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, text) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  };
  put(
    "package.json",
    JSON.stringify({ name: "dsh-unlimit", bin: { "dsh-unlimit": "./src/cli.js" } }),
  );
  for (const record of ["NOTICE.md", "docs/provenance.md", "docs/parity.md"])
    put(record, "合成来源记录");
  put("src/cli.js", "export {};\n");
  put("src/host/plugin.js", "export {};\n");
  put("src/host/desktop.js", 'export const SUPPORTED_HOST = "synthetic";\n');
  return { root, put };
}

test("有限来源检查允许如实引用来源、版权、许可与署名", (t) => {
  const { root, put } = fixture(t);
  put(
    "NOTICE.md",
    "Copyright (c) 2026 Example. Permission is hereby granted, free of charge. 需署名。",
  );
  put("docs/provenance.md", "参考 https://github.com/example/dsh-purge ，仅记录实际接触历史。");
  put("src/host/reference.js", "// 历史来源 dsh-purge 的事实引用。\nexport {};\n");
  assert.deepEqual(inspectProvenance(root).problems, []);
});

test("来源记录缺失/为空及错误包命名给出具体失败", (t) => {
  const { root, put } = fixture(t);
  rmSync(join(root, "docs/provenance.md"));
  put("NOTICE.md", " ");
  put("package.json", JSON.stringify({ name: "other", bin: { other: "./src/cli.js" } }));
  const problems = inspectProvenance(root).problems.join("\n");
  assert.match(problems, /provenance\.md 来源记录缺失/);
  assert.match(problems, /NOTICE\.md 来源记录为空/);
  assert.match(problems, /包名应为/);
  assert.match(problems, /命令入口应为/);
});

test("复合 .orig 后缀不再漏检，也不把后缀当作来源证明", (t) => {
  const { root, put } = fixture(t);
  put("web/icon.png.orig", "synthetic backup");
  put("src/shape.JPEG.orig", "synthetic backup");
  put("web/original.png", "synthetic original");
  const problems = inspectProvenance(root).problems;
  assert.equal(problems.length, 2);
  for (const problem of problems) assert.match(problem, /不判断来源/);
});

test("core 同层、Node内建与 host 官方动态解析不被误报", (t) => {
  const { root, put } = fixture(t);
  put(
    "src/core/nested/local.js",
    "import { a } from '../shared.js';\nexport { b } from './peer.js';\nimport 'node:fs';\nconst c = import('node:path');\n",
  );
  put("src/host/runtime.js", "const runtime = await import('@deepseek-ai/example');\n");
  assert.deepEqual(inspectSelfAudit(root).problems, []);
});

test("core 相对路径跨层、前缀相似目录和各种字面量引用被检测", (t) => {
  const { root, put } = fixture(t);
  const forms = [
    "import { value } from '../host/runtime.js';",
    'import "../server/api.js";',
    "export { value } from '../host/runtime.js';",
    "const value = import('../host/runtime.js');",
    "const value = require('../host/runtime.js');",
    "import { value } from '../core-other/runtime.js';",
    "import { value } from '@deepseek-ai/example';",
  ];
  forms.forEach((text, index) => put(`src/core/bad-${index}.js`, text));
  const problems = inspectSelfAudit(root).problems;
  for (let index = 0; index < forms.length; index++) {
    assert.ok(
      problems.some((problem) => problem.includes(`bad-${index}.js`)),
      forms[index],
    );
  }
  assert.ok(problems.some((problem) => problem.includes("静态导入官方包")));
});

test("sha256 字样不作为完整性判据，缺失入口仍可被检测", (t) => {
  const { root, put } = fixture(t);
  put("src/host/runtime.js", "// sha256\nconst runtime = await import('@deepseek-ai/example');\n");
  rmSync(join(root, "src/cli.js"));
  assert.deepEqual(inspectSelfAudit(root).problems, ["src/cli.js 入口文件缺失"]);
});
