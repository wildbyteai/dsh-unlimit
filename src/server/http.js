import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const UI_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));
const ASSETS = new Map([
  ["/dsh-unlimit/ui/", ["index.html", "text/html; charset=utf-8"]],
  ["/dsh-unlimit/ui/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/dsh-unlimit/ui/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/dsh-unlimit/ui/drafts.js", ["drafts.js", "text/javascript; charset=utf-8"]],
  ["/dsh-unlimit/ui/admission.js", ["admission.js", "text/javascript; charset=utf-8"]],
  [
    "/dsh-unlimit/ui/environment-settings.js",
    ["environment-settings.js", "text/javascript; charset=utf-8"],
  ],
  ["/dsh-unlimit/ui/workflow-plans.js", ["workflow-plans.js", "text/javascript; charset=utf-8"]],
  ["/dsh-unlimit/ui/workspace-rules.js", ["workspace-rules.js", "text/javascript; charset=utf-8"]],
  ["/dsh-unlimit/ui/rewind.js", ["rewind.js", "text/javascript; charset=utf-8"]],
  ["/dsh-unlimit/ui/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function respond(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function localAddress(value) {
  return value === "::1" || value === "127.0.0.1" || value === "::ffff:127.0.0.1";
}

export function createHandler(controller, getOrigin, { rejectRequest } = {}) {
  return async (req, res) => {
    try {
      const origin = new URL(getOrigin());
      if (!localAddress(req.socket.remoteAddress) || req.headers.host !== origin.host) {
        respond(res, 403, {
          ok: false,
          error: { code: "LOCAL_ONLY", message: "仅允许当前本机桌面端访问" },
        });
        return;
      }
      const rejection = rejectRequest?.(req);
      if (rejection !== undefined) {
        respond(res, rejection, {
          ok: false,
          error: { code: "UNAUTHENTICATED", message: "需要当前桌面端的有效登录会话" },
        });
        return;
      }
      const path = new URL(req.url, origin).pathname;
      if (req.method === "GET" && ASSETS.has(path)) {
        const [name, type] = ASSETS.get(path);
        res.writeHead(200, {
          "Content-Type": type,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
        });
        res.end(readFileSync(join(UI_ROOT, name)));
        return;
      }
      if (path !== "/dsh-unlimit/api") {
        respond(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "没有此资源" } });
        return;
      }
      if (req.method !== "POST") {
        respond(res, 405, { ok: false, error: { code: "METHOD", message: "API 仅接受 POST" } });
        return;
      }
      if (
        (req.headers.origin && req.headers.origin !== origin.origin) ||
        req.headers["x-dsh-unlimit"] !== "1" ||
        !req.headers["content-type"]?.startsWith("application/json")
      ) {
        respond(res, 403, {
          ok: false,
          error: { code: "ORIGIN", message: "请求来源或内容类型不匹配" },
        });
        return;
      }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 72 * 1024 * 1024)
          throw Object.assign(new Error("请求超过 72 MiB"), { code: "TOO_LARGE" });
        chunks.push(chunk);
      }
      let request;
      try {
        request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw Object.assign(new Error("请求不是有效 JSON"), { code: "INVALID_INPUT" });
      }
      if (
        !request ||
        typeof request.action !== "string" ||
        (request.payload !== undefined &&
          (typeof request.payload !== "object" ||
            request.payload === null ||
            Array.isArray(request.payload)))
      ) {
        throw Object.assign(new Error("需要 action 和对象形式的 payload"), {
          code: "INVALID_INPUT",
        });
      }
      const data = await controller.dispatch(request.action, request.payload ?? {});
      respond(res, 200, { ok: true, data });
    } catch (error) {
      const status = error.code === "CONFLICT" ? 409 : error.code === "UNSUPPORTED" ? 422 : 400;
      respond(res, status, {
        ok: false,
        error: {
          code: error.code ?? "OPERATION_FAILED",
          message: error.message,
          ...([
            "REWIND_PARTIAL",
            "RECOVERY_REQUIRED",
            "WORKFLOW_START_FAILED",
            "WORKFLOW_STOP_FAILED",
            "SETTINGS_APPLIED_PARTIAL",
            "ADMISSION_REVOKED_PARTIAL",
          ].includes(error.code) && error.partial
            ? { partial: error.partial }
            : {}),
        },
      });
    }
  };
}
