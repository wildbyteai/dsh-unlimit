const BRIDGE_REQUEST = "dsh-unlimit:draft-bridge-request";
const BRIDGE_RESPONSE = "dsh-unlimit:draft-bridge-response";

/** Uses the official 0.2.1 client faces; never submits a prompt or overwrites an existing draft. */
export function createDraftBridge(ctx, { origin, getFrame, timeoutMs = 14000 }) {
  let disposed = false;
  const pending = new Map();
  const services = () => {
    if (disposed || !origin || origin === "null") return null;
    try {
      const sessions = ctx.get("sessions");
      const conversation = ctx.get("conversation");
      const workspace = ctx.get("uiWorkspace");
      if (
        typeof sessions?.using !== "function" ||
        typeof sessions?.binding !== "function" ||
        typeof conversation?.input?.requestDraftInitialization !== "function" ||
        typeof workspace?.openSession !== "function"
      )
        return null;
      return { sessions, conversation, workspace };
    } catch {
      return null;
    }
  };
  const cancelAll = (message = "草稿恢复已取消") => {
    for (const operation of pending.values()) operation.abort(new Error(message));
  };
  const handleMessage = async (event) => {
    const frame = getFrame();
    if (
      disposed ||
      !frame ||
      !origin ||
      origin === "null" ||
      event.origin !== origin ||
      event.source !== frame.contentWindow
    )
      return;
    const request = event.data;
    if (
      !request ||
      request.type !== BRIDGE_REQUEST ||
      typeof request.id !== "string" ||
      !request.id ||
      request.id.length > 100 ||
      !["probe", "restore", "cancel"].includes(request.operation) ||
      pending.has(request.id)
    )
      return;
    const reply = (result) => {
      if (!disposed && getFrame() === frame && event.source === frame.contentWindow)
        event.source.postMessage({ type: BRIDGE_RESPONSE, id: request.id, ...result }, origin);
    };
    const available = services();
    if (request.operation === "probe") {
      reply({
        ok: true,
        ready: Boolean(available),
        supports: {
          plainText: Boolean(available),
          attachments: false,
          cancellation: true,
          navigationAcknowledgement: false,
        },
        restoreTimeoutMs: timeoutMs,
      });
      return;
    }
    if (request.operation === "cancel") {
      const target = request.payload?.requestId;
      const operation = typeof target === "string" ? pending.get(target) : undefined;
      operation?.abort(new Error("工作台已取消此草稿恢复请求"));
      reply({
        ok: true,
        cancelled: Boolean(operation),
        requestId: typeof target === "string" ? target : null,
      });
      return;
    }
    const expiresAt = request.expiresAt;
    if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)) {
      reply({
        ok: false,
        code: "INVALID_INPUT",
        error: "草稿恢复截止时间无效",
        draftStatus: "failed",
        openStatus: "not-requested",
      });
      return;
    }
    if (expiresAt !== undefined && Date.now() >= expiresAt) {
      reply({
        ok: false,
        code: "CANCELLED",
        error: "草稿恢复请求已过期，未开始恢复",
        newSessionId: request.payload?.newSessionId,
        draftStatus: "cancelled",
        openStatus: "not-requested",
      });
      return;
    }
    if (!available) {
      reply({
        ok: false,
        code: "UNSUPPORTED",
        error: "当前宿主没有可验证的草稿恢复接口",
        draftStatus: "failed",
        openStatus: "not-requested",
      });
      return;
    }
    const payload = request.payload;
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).some((key) => !["newSessionId", "draft"].includes(key)) ||
      typeof payload.newSessionId !== "string" ||
      !payload.newSessionId ||
      typeof payload.draft !== "string"
    ) {
      reply({
        ok: false,
        code: "INVALID_INPUT",
        error: "草稿参数无效；当前仅支持纯文本，不接受附件恢复参数",
        draftStatus: "failed",
        openStatus: "not-requested",
      });
      return;
    }
    const { newSessionId, draft } = payload;
    const controller = new AbortController();
    pending.set(request.id, controller);
    const timer = setTimeout(
      () => controller.abort(new Error("草稿恢复等待超时，已取消；不会晚到写入")),
      expiresAt === undefined
        ? timeoutMs
        : Math.min(timeoutMs, Math.max(0, expiresAt - Date.now())),
    );
    const checkDeadline = () => {
      if (expiresAt !== undefined && Date.now() >= expiresAt)
        controller.abort(new Error("草稿恢复请求已过期，已取消后续写入"));
      controller.signal.throwIfAborted();
    };
    let draftStatus = "failed",
      openStatus = "not-requested";
    try {
      checkDeadline();
      await available.sessions.using(
        newSessionId,
        { source: "controllerOperation", signal: controller.signal },
        async (reference) => {
          const binding = await reference.ready;
          checkDeadline();
          if (
            disposed ||
            getFrame() !== frame ||
            available.sessions.binding(newSessionId) !== binding
          )
            throw new Error("会话绑定已失效，草稿未恢复");
          const outcome = available.conversation.input.requestDraftInitialization(binding, {
            prompt: draft,
            clearPreviousDraft: false,
          });
          if (outcome === "preserved") {
            draftStatus = "preserved";
            throw new Error("目标会话已有草稿或附件，已保留原内容；回退草稿未恢复");
          }
          if (outcome === "blocked") {
            draftStatus = "blocked";
            throw new Error("宿主当前阻止草稿初始化，回退草稿未恢复");
          }
          if (outcome !== "applied") throw new Error("宿主返回未知草稿初始化结果，未确认恢复");
          draftStatus = "restored";
          checkDeadline();
          if (disposed || getFrame() !== frame) throw new Error("工作台已失效，未请求打开会话");
          openStatus = "failed";
          available.workspace.openSession(newSessionId);
          // Official openSession is synchronous and has no rendered-view acknowledgement.
          openStatus = "requested";
        },
      );
      reply({ ok: true, newSessionId, draftStatus, openStatus, navigationConfirmed: false });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      if (cancelled && draftStatus !== "restored") draftStatus = "cancelled";
      reply({
        ok: false,
        code: cancelled
          ? "CANCELLED"
          : draftStatus === "preserved"
            ? "DRAFT_PRESERVED"
            : draftStatus === "blocked"
              ? "DRAFT_BLOCKED"
              : "RESTORE_FAILED",
        newSessionId,
        draftStatus,
        openStatus,
        navigationConfirmed: false,
        error:
          draftStatus === "restored"
            ? `草稿已恢复；打开会话${openStatus === "requested" ? "已请求但后续保留流程失败" : "未完成"}：${error.message || "未知错误"}`
            : error.message || "草稿恢复失败",
      });
    } finally {
      clearTimeout(timer);
      pending.delete(request.id);
    }
  };
  return {
    handleMessage,
    cancelAll,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAll("工作台已卸载，已取消草稿恢复");
    },
  };
}

export function apply(ctx) {
  ctx.effect(() => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "U · 工作台";
    button.setAttribute("aria-label", "打开 DSH Unlimit 工作台");
    button.setAttribute("aria-expanded", "false");
    Object.assign(button.style, {
      position: "fixed",
      right: "24px",
      bottom: "24px",
      zIndex: "2147483000",
      border: "1px solid #3c6346",
      borderRadius: "9px",
      padding: "11px 17px",
      background: "#2e4f39",
      color: "#edf3e6",
      cursor: "pointer",
      font: "12px -apple-system, sans-serif",
      boxShadow: "0 3px 18px #17271c33",
    });
    let overlay, frame;
    const bridge = createDraftBridge(ctx, {
      origin: location.origin,
      getFrame: () => (overlay && overlay.style.display !== "none" ? frame : null),
    });
    const onBridge = (event) => {
      void bridge.handleMessage(event);
    };
    const close = () => {
      bridge.cancelAll("工作台已关闭，已取消尚未完成的草稿恢复");
      if (overlay) overlay.style.display = "none";
      button.setAttribute("aria-expanded", "false");
      button.focus();
    };
    const escape = (event) => {
      if (event.key === "Escape" && overlay && overlay.style.display !== "none") close();
    };
    button.addEventListener("click", () => {
      if (overlay) {
        if (overlay.style.display === "none") {
          overlay.style.display = "flex";
          button.setAttribute("aria-expanded", "true");
          overlay.querySelector("button")?.focus();
        } else close();
        return;
      }
      overlay = document.createElement("div");
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-label", "DSH Unlimit 桌面工作台");
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "24px",
        zIndex: "2147483001",
        border: "1px solid #aab6a2",
        borderRadius: "11px",
        background: "#f5f4ee",
        boxShadow: "0 18px 90px #17271c66",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      });
      const header = document.createElement("div");
      Object.assign(header.style, {
        padding: "9px 15px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        background: "#25342b",
        color: "#dce8d7",
        font: "11px -apple-system,sans-serif",
      });
      const label = document.createElement("span");
      label.textContent = "UNLIMIT / 独立桌面工作台";
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.textContent = "关闭 ×";
      Object.assign(closeButton.style, {
        border: "0",
        background: "transparent",
        color: "#dce8d7",
        padding: "5px 8px",
        cursor: "pointer",
      });
      closeButton.addEventListener("click", close);
      header.append(label, closeButton);
      frame = document.createElement("iframe");
      frame.addEventListener("load", () =>
        bridge.cancelAll("工作台页面已重新加载，已取消旧页面的草稿恢复"),
      );
      frame.src = "/dsh-unlimit/ui/";
      frame.title = "DSH Unlimit 工作台";
      Object.assign(frame.style, { width: "100%", flex: "1", border: "0", minHeight: "0" });
      overlay.append(header, frame);
      document.body.append(overlay);
      button.setAttribute("aria-expanded", "true");
      closeButton.focus();
    });
    document.addEventListener("keydown", escape);
    window.addEventListener("message", onBridge);
    document.body.append(button);
    return () => {
      bridge.dispose();
      document.removeEventListener("keydown", escape);
      window.removeEventListener("message", onBridge);
      overlay?.remove();
      button.remove();
    };
  });
}
