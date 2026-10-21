import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WorkspaceStore } from "../src/core/store.js";
import { SkillLibrary } from "../src/core/skills.js";
import { Toolkit } from "../src/core/toolkit.js";
import { Templates } from "../src/core/templates.js";
import { Flow } from "../src/core/flow.js";
import { WorkspaceFiles } from "../src/core/files.js";
import { DesktopRuntime } from "../src/host/runtime.js";
import { DesktopProcesses } from "../src/host/processes.js";
import { RetryPolicy } from "../src/host/retry-policy.js";
import { ReadLimits } from "../src/host/read-limits.js";
import { HostCatalog } from "../src/host/catalog.js";
import { DesktopWorkflow } from "../src/host/workflow.js";
import { Continuation } from "../src/host/continuation.js";
import { DrillAdmission } from "../src/core/admission.js";
import { LocalEnvironment } from "../src/core/environment.js";
import { DesktopWorkflowPlan } from "../src/host/workflow-plan.js";
import { Controller } from "../src/server/controller.js";
import { createHandler } from "../src/server/http.js";
import { ConnectionChecks } from "../src/core/connection-checks.js";
import { NetworkScope } from "../src/core/network-scope.js";
import { CountryDatabase } from "../src/core/country-database.js";

const { values } = parseArgs({ options: { port: { type: "string", default: "4177" } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("--port 必须是 0 到 65535 之间的整数");
const temporary = mkdtempSync(join(tmpdir(), "dsh-unlimit-synthetic-preview-"));
let store,
  toolkit,
  flow,
  server,
  origin,
  connectionChecks,
  countryDatabase,
  networkScope,
  processes;
let closing;
async function close() {
  if (closing) return closing;
  closing = (async () => {
    const stopped = server
      ? new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
      : Promise.resolve();
    try {
      await processes?.close();
      await connectionChecks?.close();
      await networkScope?.close();
      countryDatabase?.close();
      await toolkit?.close();
      await stopped;
    } finally {
      flow?.close();
      store?.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  })();
  return closing;
}
try {
  store = new WorkspaceStore(join(temporary, "synthetic.sqlite"));
  const call = (action, payload) => store.dispatch(action, payload);
  const workspace = call("workspaces.save", {
    name: "边界观测 · 合成演练",
    scope: "example.invalid / 192.0.2.0/24，仅本地界面演示",
    authorization: "合成数据演示，不授权访问任何真实系统",
  }).item;
  call("workspaces.activate", { id: workspace.id });
  const portal = call("assets.save", {
    workspaceId: workspace.id,
    name: "示例入口站点",
    address: "https://portal.example.invalid",
    type: "web",
    tags: ["合成", "入口"],
    notes: "文档保留域名，无远程请求。",
  }).item;
  const api = call("assets.save", {
    workspaceId: workspace.id,
    name: "示例接口服务",
    address: "https://api.example.invalid",
    type: "service",
    tags: ["合成", "服务"],
  }).item;
  const host = call("assets.save", {
    workspaceId: workspace.id,
    name: "示例测试主机",
    address: "192.0.2.17",
    type: "host",
    tags: ["合成", "主机"],
  }).item;
  call("assets.link", {
    workspaceId: workspace.id,
    from: portal.id,
    to: api.id,
    relation: "调用服务 · 合成关系",
  });
  call("assets.link", {
    workspaceId: workspace.id,
    from: api.id,
    to: host.id,
    relation: "部署关系 · 合成关系",
  });
  call("findings.save", {
    workspaceId: workspace.id,
    title: "合成发现：接口权限边界待复核",
    assetId: api.id,
    severity: "high",
    status: "open",
    evidence: "此为视觉验收的合成记录，没有执行远程请求，也不代表真实漏洞。",
  });
  call("records.save", {
    workspaceId: workspace.id,
    kind: "stage",
    data: {
      name: "范围登记与证据整理",
      status: "in_progress",
      progress: 60,
      notes: "本地合成演练阶段。",
    },
  });
  const point = call("records.save", {
    workspaceId: workspace.id,
    kind: "score-point",
    data: { name: "建立资产关系", points: 15, condition: "以合成台账建立两条资产关系。" },
  }).item;
  call("records.save", {
    workspaceId: workspace.id,
    kind: "score-hit",
    data: { name: "合成评分命中", pointId: point.id, notes: "仅用于界面演示。" },
  });
  const hostInfo = {
    kind: "synthetic-preview",
    version: "synthetic-preview",
    platform: process.platform,
    supported: false,
  };
  const runtime = new DesktopRuntime({}, store, hostInfo);
  toolkit = new Toolkit(store);
  flow = new Flow(store);
  const skills = new SkillLibrary(join(temporary, "skills"));
  const admission = new DrillAdmission(store, temporary);
  processes = new DesktopProcesses({ get: () => undefined }, store, hostInfo, {
    toolkit,
    admission,
  });
  countryDatabase = new CountryDatabase(realpathSync(temporary));
  networkScope = new NetworkScope(store, { database: countryDatabase, admission });
  connectionChecks = new ConnectionChecks(store, { admission, scope: networkScope });
  const environment = new LocalEnvironment(realpathSync(temporary));
  const catalog = new HostCatalog(
    { get: () => undefined },
    { library: skills, toolkit, environment },
  );
  const workflow = new DesktopWorkflow({ get: () => undefined }, store, flow, { admission });
  const controller = new Controller({
    store,
    runtime,
    skills,
    files: new WorkspaceFiles(join(temporary, "materials"), store),
    retry: new RetryPolicy({}, store),
    readLimits: new ReadLimits({}, store, hostInfo),
    toolkit,
    templates: new Templates(toolkit),
    catalog,
    workflow,
    plans: new DesktopWorkflowPlan(workflow, { catalog }),
    environment,
    continuation: new Continuation({}, store, hostInfo),
    flow,
    sessions: { list: () => [] },
    host: hostInfo,
    admission,
    processes,
    connectionChecks,
    networkScope,
  });
  server = createServer(createHandler(controller, () => origin));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`隔离合成预览：${origin}/dsh-unlimit/ui/`);
  console.log("仅监听 127.0.0.1；使用临时 SQLite、技能目录和合成记录，不读取用户 profile。");
  console.log("运行控制与真实会话不可用。此预览不等同于桌面宿主交互验收。按 Ctrl+C 清理并退出。");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      close().then(
        () => process.exit(0),
        (error) => {
          console.error(error.message);
          process.exit(1);
        },
      );
    });
} catch (error) {
  await close();
  throw error;
}
