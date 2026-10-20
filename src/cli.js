#!/usr/bin/env node
import { inspectDesktop } from "./host/desktop.js";

const [command, ...args] = process.argv.slice(2);
if (command !== "doctor" || args.includes("--help")) {
  console.log(
    "dsh-unlimit doctor --app <DeepSeek Harness.app 路径>\n只读检测桌面版本与所需模块；不安装、不读取会话。",
  );
  if (command && command !== "--help" && command !== "doctor") process.exitCode = 2;
} else {
  try {
    const index = args.indexOf("--app");
    const app =
      index < 0 && process.platform === "darwin"
        ? "/Applications/DeepSeek Harness.app"
        : args[index + 1];
    if (!app) throw new Error("请用 --app 指定桌面应用目录");
    console.log(JSON.stringify(inspectDesktop(app), null, 2));
  } catch (error) {
    console.error(`检查失败：${error.message}`);
    process.exitCode = 1;
  }
}
