// Test-only: load a pinned public tarball without executing a modified installed entry.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire, registerHooks } from "node:module";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TOOL_FS = "@deepseek-ai/dsh-tool-fs";
const SRI =
  "sha512-hd3LmMFiOa4TTFL9+oabTe26CjzGUbflCMm8TcXm9jHN1tIhB8el1cyzaQ2x4A15G/jIlAsGZyuwuf5/FFJIOQ==";
const ENTRY = "b11d3fa50b9042019a91cc38a6abe35d74ed651374278f95e60b42734e079df1";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const within = (root, path) => {
  const p = relative(root, path);
  return p === "" || (!p.startsWith(".." + sep) && p !== ".." && !p.startsWith(sep));
};

function unpack(bytes) {
  assert.equal(
    "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    SRI,
    "pinned npm SRI",
  );
  const tar = gunzipSync(bytes, { maxOutputLength: 4 * 1024 * 1024 });
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const name = text(0, 100),
      prefix = text(345, 500);
    assert.equal(prefix, "", "ordinary short tar paths only");
    assert.match(name, /^package\/(?!\/)[^\\]+$/);
    assert.ok(!name.split("/").some((part) => part === "." || part === ".." || part === ""));
    assert.ok([0, 48].includes(header[156]), "ordinary file only; no links");
    const size = parseInt(text(124, 136).trim(), 8),
      checksum = parseInt(text(148, 156).trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 2 * 1024 * 1024);
    assert.equal(
      [...header].reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0),
      checksum,
    );
    assert.ok(offset + 512 + size <= tar.length);
    assert.ok(!files.has(name) && files.size < 128);
    files.set(name, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(sha(files.get("package/lib/index.js")), ENTRY);
  const pkg = JSON.parse(files.get("package/package.json"));
  assert.equal(pkg.name, TOOL_FS);
  assert.equal(pkg.version, "0.2.1-rc.2");
  return files;
}

/** One isolated runtime per test process; no download, profile, or installed-entry execution. */
export function officialReadRuntime(runtimeRoot, cache) {
  const manifest = JSON.parse(readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"));
  assert.equal(manifest.release.version, "0.2.1-rc.2");
  const rows = new Map(manifest.files.map((row) => [row.path, row]));
  assert.equal(rows.get(`node_modules/${TOOL_FS}/lib/index.js`)?.sha256, ENTRY);
  const files = unpack(readFileSync(join(cache, "dsh-tool-fs-0.2.1-rc.2.tgz")));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-clean-runtime-")));
  const copied = [
    TOOL_FS,
    "@deepseek-ai/cordis",
    "@deepseek-ai/cordis-plugin-loader",
    "@deepseek-ai/dsh-hmr",
  ];
  const put = (path, bytes) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  let hooks;
  const dispose = () => {
    hooks?.deregister();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    for (const [path, bytes] of files)
      put(join(root, "node_modules", TOOL_FS, path.slice(8)), bytes);
    for (const pkg of copied.slice(1)) {
      const prefix = `node_modules/${pkg}/`;
      const members = manifest.files.filter((row) => row.path.startsWith(prefix));
      assert.ok(members.length > 0);
      for (const row of members) {
        const bytes = readFileSync(join(runtimeRoot, row.path));
        assert.equal(sha(bytes), row.sha256, row.path);
        put(join(root, row.path), bytes);
      }
    }
    put(join(root, "package.json"), Buffer.from('{"type":"module"}'));
    put(join(root, "desktop-runtime.json"), Buffer.from(JSON.stringify(manifest)));
    const runtimeURL = pathToFileURL(join(runtimeRoot, "package.json")).href;
    hooks = registerHooks({
      resolve(specifier, context, next) {
        let result;
        try {
          result = next(specifier, context);
        } catch (error) {
          if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":"))
            throw error;
          result = next(specifier, { ...context, parentURL: runtimeURL });
        }
        if (result.url.startsWith("file:")) {
          const path = fileURLToPath(result.url);
          for (const pkg of copied) {
            const original = join(runtimeRoot, "node_modules", pkg);
            if (within(original, path))
              return {
                ...result,
                url: pathToFileURL(join(root, "node_modules", pkg, relative(original, path))).href,
              };
          }
        }
        return result;
      },
      load(url, context, next) {
        if (url.startsWith("file:")) {
          const path = fileURLToPath(url);
          if (within(root, path)) {
            const rel = relative(root, path);
            if (rel.startsWith(`node_modules/${TOOL_FS}/`)) {
              const member = "package/" + relative(join(root, "node_modules", TOOL_FS), path);
              assert.equal(sha(readFileSync(path)), sha(files.get(member)), member);
            } else assert.equal(sha(readFileSync(path)), rows.get(rel)?.sha256, rel);
          } else if (within(runtimeRoot, path)) {
            assert.equal(
              sha(readFileSync(path)),
              rows.get(relative(runtimeRoot, path))?.sha256,
              `official dependency: ${relative(runtimeRoot, path)}`,
            );
          } else throw new Error("Official fixture tried to load outside its approved runtime");
        }
        return next(url, context);
      },
    });
    const require = createRequire(join(runtimeRoot, "package.json"));
    return {
      root,
      dispose,
      load: async (name) => import(pathToFileURL(require.resolve(name)).href),
      host: { kind: "desktop", version: "0.2.1-rc.2", supported: true, runtimeRoot: root },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
