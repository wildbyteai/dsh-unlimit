// Read-only inventory inspection, never imports/executes host or third-party plugins.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_HOST } from "../src/host/desktop.js";

if (process.argv.length !== 3)
  throw new Error("Usage: node scripts/inspect-hook-memory.mjs <runtime-root>");
const root = realpathSync(process.argv[2]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifestBytes = readFileSync(join(root, "desktop-runtime.json"));
const inventory = JSON.parse(manifestBytes);
if (inventory.release?.version !== SUPPORTED_HOST)
  throw new Error("Reassess the new host version before using this inspection.");
const expressions = {
  historicalHookProducer: /["']hooks-(?:codex|claude-code)["']/,
  hookAuditVocabulary: /["']hook\/(?:invoked|result)["']/,
  hookPolicyOrCallback:
    /Hook(?:Service|Policy|Config)|PreToolUse|PostToolUse|UserPromptSubmit|hooksDeny/,
  memoryIntegration: /mnemon|memoryPolicy|MemoryService|memory_settings/i,
};
const verified = [],
  mismatched = [],
  matches = [];
const packages = [];
for (const row of inventory.files) {
  // Only exact inventory-owned official package entry/manifest/declaration paths.
  // No directory walk, backup files, profile, caches or external plugin installs.
  if (
    !/^node_modules\/@deepseek-ai\/[a-z0-9-]+\/(?:package\.json|lib\/index\.js|(?:[a-zA-Z0-9_./-]+\.d\.ts)|(?:[a-zA-Z0-9_./-]+\.yml))$/.test(
      row.path,
    ) ||
    row.path.split("/").includes("..")
  )
    continue;
  const bytes = readFileSync(join(root, row.path));
  const actual = digest(bytes);
  if (actual !== row.sha256) {
    mismatched.push({
      path: row.path,
      expectedSha256: row.sha256,
      actualSha256: actual,
      contentScanned: false,
    });
    continue;
  }
  verified.push({ path: row.path, sha256: actual });
  if (row.path.endsWith("/package.json")) {
    const manifest = JSON.parse(bytes);
    packages.push({ name: manifest.name, version: manifest.version });
    continue;
  }
  const lines = bytes.toString("utf8").split("\n");
  for (const [kind, expression] of Object.entries(expressions)) {
    const positions = lines.flatMap((line, index) => (expression.test(line) ? [index + 1] : []));
    if (positions.length) matches.push({ path: row.path, sha256: actual, kind, lines: positions });
  }
}
const keyPackages = new Set([
  "dsh-mcp-client",
  "dsh-system-prompt",
  "dsh-scope",
  "dsh-agent-loop",
  "dsh-tools",
  "dsh-session",
  "dsh-session-format-v0-to-v1",
  "dsh-session-format-v3-to-v4",
  "dsh-app-boot",
]);
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      result: "static-inventory-inspection-only",
      target: { version: SUPPORTED_HOST, platform: inventory.platform, arch: inventory.arch },
      inventorySha256: digest(manifestBytes),
      verifiedPackageCount: packages.length,
      verifiedEntryCount: verified.filter((row) => row.path.endsWith("/lib/index.js")).length,
      verifiedDeclarationAndPatchCount: verified.filter((row) => /\.d\.ts$|\.yml$/.test(row.path))
        .length,
      verifiedPathsAndHashesSha256: digest(JSON.stringify(verified)),
      providerNameMatches: packages.filter((item) => /hook|mnemon|memory/i.test(item.name)),
      searches: Object.fromEntries(
        Object.entries(expressions).map(([kind, pattern]) => [
          kind,
          {
            pattern: pattern.source,
            matchedFiles: matches.filter((row) => row.kind === kind).length,
          },
        ]),
      ),
      matches,
      keyEntries: verified.filter(
        (row) => row.path.endsWith("/lib/index.js") && keyPackages.has(row.path.split("/")[2]),
      ),
      mismatched,
      boundaries: {
        hostCodeExecuted: false,
        realProfileRead: false,
        realProfileModified: false,
        realSessionsRead: false,
        thirdPartyInstallationsInspected: false,
        networkRequests: false,
        contentOfMismatchedFilesScanned: false,
        absenceOfMatchesProvesEcosystemAbsence: false,
      },
    },
    null,
    2,
  ),
);
