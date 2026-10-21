import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SUPPORTED_HOST } from "../src/host/desktop.js";
import { resolveOfficialPackage } from "../src/host/official-package.js";

const name = "@deepseek-ai/dsh-test-entry";
const source = 'throw new Error("Synthetic resolver fixture must never execute");';
const sha = (text) => createHash("sha256").update(text).digest("hex");

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-official-package-")));
  const root = join(directory, "runtime");
  const packageRoot = join(root, "node_modules", name);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(packageRoot, "package.json"), '{"type":"module","main":"index.js"}');
  const entry = join(packageRoot, "index.js");
  writeFileSync(entry, source);
  const manifest = {
    release: { version: SUPPORTED_HOST },
    files: [{ path: `node_modules/${name}/index.js`, sha256: sha(source) }],
  };
  const manifestPath = join(root, "desktop-runtime.json");
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest));
  save();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, root, entry, manifest, manifestPath, save };
}

test("resolver returns a listed entry without executing it", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await resolveOfficialPackage(f.root, name), {
    url: pathToFileURL(f.entry).href,
    path: f.entry,
  });
});

test("version, malformed inventory and missing file entries have explicit failures", async (t) => {
  const f = fixture(t);
  f.manifest.release.version = "unsupported";
  f.save();
  assert.match((await resolveOfficialPackage(f.root, name)).reason, /发行版本与适配版本不一致/);
  f.manifest.release.version = SUPPORTED_HOST;
  delete f.manifest.files;
  f.save();
  assert.match((await resolveOfficialPackage(f.root, name)).reason, /发行清单缺少文件条目/);
  writeFileSync(f.manifestPath, "{");
  assert.match((await resolveOfficialPackage(f.root, name)).reason, /不可用/);
  rmSync(f.manifestPath);
  assert.match((await resolveOfficialPackage(f.root, name)).reason, /不可用/);
});

test("an unlisted or changed entry is rejected, and every later resolution rechecks it", async (t) => {
  const f = fixture(t);
  assert.ok((await resolveOfficialPackage(f.root, name)).url);
  writeFileSync(f.entry, `${source}\n// Changed synthetic entry`);
  assert.match((await resolveOfficialPackage(f.root, name)).reason, /摘要不一致/);
  writeFileSync(f.entry, source);
  assert.ok((await resolveOfficialPackage(f.root, name)).url, "failed results are not retained");
  f.manifest.files = [];
  f.save();
  assert.match((await resolveOfficialPackage(f.root, name)).reason, /摘要不一致/);
  f.manifest.release.version = "unsupported";
  f.save();
  assert.match((await resolveOfficialPackage(f.root, name)).reason, /发行版本与适配版本不一致/);
});

test("runtime containment and official package names cannot be replaced by manifest claims", async (t) => {
  const f = fixture(t);
  const outside = join(f.directory, "outside.js");
  writeFileSync(outside, source);
  rmSync(f.entry);
  symlinkSync(outside, f.entry);
  f.manifest.files = [{ path: "../outside.js", sha256: sha(source) }];
  f.save();
  assert.match((await resolveOfficialPackage(f.root, name)).reason, /指定运行时之外/);
  assert.match((await resolveOfficialPackage("relative/runtime", name)).reason, /运行时根/);
  for (const invalid of ["node:fs", "../entry", `${name}/index.js`, "other-package"]) {
    assert.match((await resolveOfficialPackage(f.root, invalid)).reason, /官方包入口解析/);
  }
});
