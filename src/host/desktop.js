import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const SUPPORTED_HOST = "0.2.1-rc.2";

export function desktopContext(argv = process.argv) {
  const entry = realpathSync(argv[1] ?? "");
  const packageRoot = dirname(dirname(entry));
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== "@deepseek-ai/dsh-desktop-host")
    throw new Error("仅支持官方 DSH 桌面端宿主进程");
  const runtimeRoot = realpathSync(argv[2]);
  const profileRoot = realpathSync(argv[3]);
  const profile = JSON.parse(readFileSync(join(profileRoot, "package.json"), "utf8"));
  if (profile.name !== "dsh-profile-desktop") throw new Error("拒绝在非 desktop profile 中加载");
  const runtime = JSON.parse(readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"));
  if (runtime.release.version !== manifest.version) throw new Error("桌面运行时与宿主版本不一致");
  return {
    kind: "desktop",
    version: manifest.version,
    platform: process.platform,
    supported: manifest.version === SUPPORTED_HOST,
    runtimeRoot,
    profileRoot,
    dataRoot: join(profileRoot, "data", "dsh-unlimit"),
  };
}

export function inspectDesktop(application) {
  const app = resolve(application);
  const candidates =
    process.platform === "darwin"
      ? [join(app, "Contents", "Resources", "app", "dsh")]
      : [join(app, "resources", "app", "dsh")];
  const runtimeRoot = realpathSync(candidates[0]);
  const descriptor = JSON.parse(readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"));
  const names = [
    "dsh-system-prompt",
    "dsh-user-approval",
    "dsh-sandbox-policy",
    "dsh-subagent",
    "dsh-tools",
    "dsh-session",
  ];
  const packages = names.map((name) => {
    const manifest = JSON.parse(
      readFileSync(join(runtimeRoot, "node_modules", "@deepseek-ai", name, "package.json"), "utf8"),
    );
    return { name: manifest.name, version: manifest.version, entry: manifest.main };
  });
  return {
    kind: "desktop",
    version: descriptor.release.version,
    platform: descriptor.platform,
    arch: descriptor.arch,
    supported: descriptor.release.version === SUPPORTED_HOST,
    packages,
  };
}
