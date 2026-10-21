const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );

const states = {
  ready: "可检查",
  denied: "范围拒绝，未检查",
  unsupported: "暂不支持",
  reachable: "连接有响应",
  unreachable: "连接未成功",
  cancelled: "已取消",
};
const reasons = {
  "http-response": "收到 HTTP 响应",
  "tcp-connected": "TCP 监听端口已连接",
  refused: "连接被拒绝",
  timeout: "连接超时",
  "tls-error": "TLS 连接失败",
  "network-error": "网络连接失败",
  "dns-error": "域名解析失败",
  cancelled: "检查已取消",
  "scope-unverified": "目标尚未通过精确自有服务器清单验证",
  "exact-host": "精确自有主机例外允许",
  "resolved-exception": "已刷新解析快照中的派生 IP 例外允许",
  "country-allowed": "本地国家数据库允许",
  "region-pending": "确认后需解析实际地址并判定国家，预览尚未联网",
  "country-denied": "CN / HK / MO 地区无例外，拒绝检查",
  "special-address": "特殊或私网地址无例外，拒绝检查",
  "country-unknown": "国家未知且无例外，拒绝检查",
  "ipv6-unverified": "IPv6 译址发现不明确，未检查此地址",
  "database-unavailable": "本地国家数据库不可用且无例外，拒绝检查",
  "invalid-url": "登记 URL 无效",
  "invalid-listener": "监听地址或端口无效",
  "unsupported-protocol": "暂不支持此协议",
  "record-changed": "记录已变化",
  "scope-changed": "授权范围已变化",
  "admission-changed": "演练确认已变化",
};
export const connectionCheckNotice =
  "仅检查你本次确认的目标：精确自有服务器例外、已刷新的解析快照派生 IP，或本地数据库判定为其他国家的地址。CN / HK / MO 无例外时拒绝；未知国家、私网或特殊地址无例外时拒绝。无例外的 IPv6 会查询 ipv4only.arpa 以识别译址，无法判明时不使用该地址；查询计入本次总时限。此范围判定尚未覆盖通用工具出口。登记 URL 的查询参数会原样发送，不附加凭据、Cookie 或请求正文。HTTP 仅发送 HEAD；收到任意状态码仅证明有响应，不代表 WebShell 可用；TCP 仅检查明确登记的监听端，不证明终端或整条隧道可用。";
const label = (value, labels) => labels[value] || value || "未返回";
export function connectionScopeText(scope) {
  if (!scope) return "";
  const country = scope.country || (scope.matchedHost ? "未查询（精确例外）" : "未知");
  const address = scope.countryAddress
    ? `连接候选 ${scope.address} · 译址目标 ${scope.countryAddress}`
    : `判定地址 ${scope.address || "尚未解析"}`;
  return `${scope.allowed ? "范围允许" : "范围拒绝"} · ${label(scope.reason, reasons)} · 国家 ${country} · ${address}${scope.matchedHost ? ` · 匹配主机 ${scope.matchedHost}` : ""}`;
}
export function connectionResultText(item) {
  const result = item?.lastCheck;
  if (!result) return "尚未检查";
  return `${item.stale ? "已过期 · " : ""}${label(result.state, states)} · ${label(result.reason, reasons)}${result.checkedAt ? ` · ${result.checkedAt}` : ""}${result.scope ? ` · ${connectionScopeText(result.scope)}` : ""}`;
}

export function connectionPreview(prepared) {
  return `<p class="info">预览只读取登记信息，尚未连接目标。确认后将检查以下允许执行的项目。</p><div class="note">${esc(connectionCheckNotice)}</div><div class="tablewrap"><table><thead><tr><th>记录</th><th>本次目标</th><th>类型</th><th>预检状态 / 原因</th></tr></thead><tbody>${prepared.items.map((item) => `<tr><td>${esc(item.name || item.recordId)}</td><td>${esc(item.target)}</td><td>${esc(item.checkType || "无可执行检查")}</td><td>${esc(label(item.state, states))}${item.reason ? `<br>${esc(label(item.reason, reasons))}` : ""}${item.scope ? `<br>${esc(connectionScopeText(item.scope))}` : ""}</td></tr>`).join("")}</tbody></table></div>${prepared.items.some((item) => item.state === "ready") ? "" : '<p class="info">没有可执行项目。请核对以上原因；本次不会发起连接。</p>'}`;
}

export function connectionResults(result) {
  if (!result) return "";
  return `${result.cancelled ? '<p class="info">检查已取消。下表保留已观察的结果。</p>' : ""}<div class="tablewrap"><table><thead><tr><th>记录 / 本次目标</th><th>观察结果</th><th>时间 / 耗时</th><th>保存状态</th></tr></thead><tbody>${result.items.map((item) => `<tr><td>${esc(item.name || item.recordId)}<br>${esc(item.target)}</td><td>${esc(label(item.state, states))}<br>${esc(label(item.reason, reasons))}${item.scope ? `<br>${esc(connectionScopeText(item.scope))}` : ""}${item.transport ? `<br>${esc(item.transport.type)} · ${esc(item.transport.address)} · ${esc(item.transport.family)}${item.transport.httpStatus !== undefined ? ` · HTTP ${esc(item.transport.httpStatus)}` : ""}` : ""}</td><td>${esc(item.checkedAt)}<br>${esc(item.latencyMs)} ms</td><td>${item.persisted ? "已保存" : "已观察，未保存"}${item.discardReason ? `<br>${esc(label(item.discardReason, reasons))}` : ""}</td></tr>`).join("")}</tbody></table></div>`;
}

/** A single page's explicit attempts. No network is started before prepare and confirmation. */
export function connectionCheckFlow({
  api,
  workspaceId,
  initialStatus,
  confirm,
  changed = () => {},
  isCurrent = () => true,
}) {
  let disposed = false;
  let busy = false;
  let stopping = false;
  let refreshing = false;
  let stage = "";
  let status = initialStatus;
  let result = null;
  let error = "";
  const current = () => !disposed && isCurrent();
  const emit = () => {
    if (current()) changed(view());
  };
  const view = () => ({ busy, stopping, refreshing, stage, status, result, error });
  async function readStatus() {
    const next = await api("connectionChecks.status", { workspaceId });
    if (current()) status = next;
  }
  return {
    view,
    dispose() {
      disposed = true;
    },
    async refresh() {
      if (refreshing || busy || stopping || !current()) return;
      refreshing = true;
      emit();
      try {
        await readStatus();
      } catch (failure) {
        if (current()) error = `检查状态读取失败：${failure.message}`;
      } finally {
        refreshing = false;
        emit();
      }
    },
    async start(recordIds) {
      if (busy || refreshing || status?.active || !current()) return;
      busy = true;
      error = "";
      try {
        if (
          !recordIds.length ||
          recordIds.length > 32 ||
          new Set(recordIds).size !== recordIds.length
        )
          throw new Error("每批需选择 1 至 32 条不同记录；超过 32 条请分批检查。");
        stage = "prepare";
        emit();
        const prepared = await api("connectionChecks.prepare", { workspaceId, recordIds });
        if (!current()) return;
        stage = "confirm";
        emit();
        const accepted = await confirm(prepared);
        if (!accepted || !current() || !prepared.items.some((item) => item.state === "ready"))
          return;
        stage = "run";
        result = null;
        emit();
        try {
          const observed = await api("connectionChecks.run", {
            workspaceId,
            recordIds,
            snapshot: prepared.snapshot,
            confirmed: true,
          });
          if (current()) result = observed;
        } catch (failure) {
          if (current()) {
            result = failure.partial || null;
            error = `${failure.message || "检查失败"}；未自动重试。`;
          }
        } finally {
          try {
            await readStatus();
          } catch (failure) {
            if (current()) error += `${error ? " " : ""}上次检查状态读取失败：${failure.message}`;
          }
        }
      } catch (failure) {
        if (current()) error = failure.message;
      } finally {
        busy = false;
        stage = "";
        emit();
      }
    },
    async stop() {
      if (stopping || refreshing || !current() || !(stage === "run" || status?.active)) return;
      stopping = true;
      emit();
      try {
        await api("connectionChecks.stop", { workspaceId });
        await readStatus();
      } catch (failure) {
        if (current()) error = `停止未确认：${failure.message}`;
      } finally {
        stopping = false;
        emit();
      }
    },
  };
}

export function connectionCheckPanel(view) {
  return `<section class="panel"><div class="panelheading"><h2>连接检查</h2></div><div class="note">${esc(connectionCheckNotice)}</div><div class="toolbar"><button type="button" class="small" data-connection-batch ${view.busy || view.refreshing || view.status?.active ? "disabled" : ""}>检查本类型（最多 32 条）</button><button type="button" class="small" data-connection-stop ${view.stopping || view.refreshing || !(view.stage === "run" || view.status?.active) ? "disabled" : ""}>${view.stopping ? "正在停止…" : "停止连接检查"}</button><button type="button" class="small" data-connection-refresh ${view.busy || view.stopping || view.refreshing ? "disabled" : ""}>${view.refreshing ? "正在读取…" : "刷新检查状态"}</button></div><p class="info" role="status">${view.stage === "prepare" ? "正在读取检查预览，尚未连接目标。" : view.stage === "confirm" ? "等待本次确认，尚未连接目标。" : view.stage === "run" ? "正在检查，可随时停止。" : view.status?.active ? `本项目检查正在运行 · ${esc(view.status.completed)} / ${esc(view.status.total)}` : "检查仅由你确认后发起。表格的上次结果为只读记录；已过期结果不能证明当前状态。"}</p>${view.error ? `<div class="error" role="alert">${esc(view.error)}</div>` : ""}${view.result ? `<h3>本次观察结果</h3>${connectionResults(view.result)}` : ""}</section>`;
}
