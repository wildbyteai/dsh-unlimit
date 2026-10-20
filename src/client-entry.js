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
    let disposed = false;
    const pending = new Set();
    const services = () => {
      try {
        const sessions = ctx.get("sessions");
        const conversation = ctx.get("conversation");
        const workspace = ctx.get("uiWorkspace");
        if (
          typeof sessions?.using !== "function" ||
          typeof conversation?.input?.requestDraftInitialization !== "function" ||
          typeof workspace?.openSession !== "function"
        )
          return null;
        return { sessions, conversation, workspace };
      } catch {
        return null;
      }
    };
    const onBridge = async (event) => {
      if (
        disposed ||
        !frame ||
        event.origin !== location.origin ||
        event.source !== frame.contentWindow
      )
        return;
      const request = event.data;
      if (
        !request ||
        request.type !== "dsh-unlimit:draft-bridge-request" ||
        typeof request.id !== "string" ||
        request.id.length > 100 ||
        !["probe", "restore"].includes(request.operation) ||
        pending.has(request.id)
      )
        return;
      const reply = (result) => {
        if (!disposed && event.source === frame?.contentWindow)
          event.source.postMessage(
            { type: "dsh-unlimit:draft-bridge-response", id: request.id, ...result },
            event.origin,
          );
      };
      const available = services();
      if (request.operation === "probe") {
        reply({ ok: true, ready: Boolean(available) });
        return;
      }
      if (!available) {
        reply({ ok: false, error: "当前宿主没有可验证的草稿恢复接口", draftStatus: "failed" });
        return;
      }
      const { newSessionId, draft } = request.payload || {};
      if (typeof newSessionId !== "string" || !newSessionId || typeof draft !== "string") {
        reply({ ok: false, error: "草稿恢复参数无效", draftStatus: "failed" });
        return;
      }
      pending.add(request.id);
      let restored = false;
      try {
        await available.sessions.using(
          newSessionId,
          { source: "controllerOperation" },
          async (ref) => {
            const binding = await ref.ready;
            if (disposed) throw new Error("工作台已卸载，草稿未恢复");
            const outcome = available.conversation.input.requestDraftInitialization(binding, {
              prompt: draft,
              clearPreviousDraft: false,
            });
            if (outcome !== "applied")
              throw new Error(
                outcome === "preserved"
                  ? "目标会话已有草稿，已保留原草稿；回退草稿未恢复"
                  : "宿主阻止了草稿初始化，回退草稿未恢复",
              );
            restored = true;
            available.workspace.openSession(newSessionId);
          },
        );
        reply({ ok: true, newSessionId, draftStatus: "restored" });
      } catch (error) {
        reply({
          ok: false,
          newSessionId,
          draftStatus: restored ? "restored" : "failed",
          error: restored
            ? "草稿已恢复，但宿主未能打开新会话：" + error.message
            : error.message || "草稿恢复失败",
        });
      } finally {
        pending.delete(request.id);
      }
    };
    const close = () => {
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
      disposed = true;
      document.removeEventListener("keydown", escape);
      window.removeEventListener("message", onBridge);
      overlay?.remove();
      button.remove();
    };
  });
}
