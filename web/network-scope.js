const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
const reasons = {
  "dns-error": "本次域名解析失败，原快照保留",
  timeout: "本次解析超时，原快照保留",
  cancelled: "本次解析已取消",
  "scope-changed": "范围清单已变化，本次结果未保存",
  "admission-changed": "演练确认已变化，本次结果未保存",
};
export const networkScopeNotice =
  "此处只显示已保存的自有服务器清单。精确主机例外与显式刷新后保存的派生 IP 可用于连接检查；别名与子域名不继承例外。修改范围清单会清空旧解析快照；解析失败不会替换旧快照。读取状态不发起 DNS 或联网。此范围判定尚未覆盖通用工具出口。";

export function validateCountryFile(file, release) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(release))
    throw new Error("请填写有效的数据月份 YYYY-MM；月份是你的声明，不代表来源真实性已核验。");
  if (!file || !/\.csv(?:\.gz)?$/i.test(file.name || ""))
    throw new Error("请选择本地 .csv 或 .csv.gz 文件。");
  const limit = /\.gz$/i.test(file.name) ? 16 * 1024 * 1024 : 48 * 1024 * 1024;
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > limit)
    throw new Error("文件为空或超过限制：CSV 48 MiB，CSV.GZ 16 MiB；展开后最多 64 MiB。");
  return limit;
}
async function encodeFile(file, limit) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > limit) throw new Error("文件内容为空或超过大小限制。");
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}
export function networkScopePreview(hosts) {
  return `<p class="info">确认后将对以下已保存主机发起 DNS 查询，并保存成功的地址快照。取消不会解析。</p><ul>${hosts.map((hostname) => `<li>${esc(hostname)}</li>`).join("")}</ul><p class="info">仅这 ${hosts.length} 个精确主机；别名与子域名不继承例外。</p>`;
}

/** Only explicit confirmation can resolve; imports read only the user-selected file. */
export function networkScopeFlow({
  api,
  initialStatus = null,
  admissionAccepted = false,
  initialError = "",
  confirm,
  changed = () => {},
  isCurrent = () => true,
}) {
  let status = initialStatus;
  let error = initialError;
  let result = null;
  let busy = false;
  let stopping = false;
  let stage = "";
  let disposed = false;
  let statusEpoch = 0;
  const current = () => !disposed && isCurrent();
  const view = () => ({ status, error, result, busy, stopping, stage, admissionAccepted });
  const emit = () => {
    if (current()) changed(view());
  };
  const adopt = (next, epoch) => {
    if (current() && epoch === statusEpoch) status = next;
  };
  return {
    view,
    dispose() {
      disposed = true;
    },
    async refresh() {
      if (!current() || busy || stopping) return;
      busy = true;
      stage = "refresh";
      error = "";
      const epoch = ++statusEpoch;
      emit();
      try {
        adopt(await api("networkScope.status", {}), epoch);
      } catch (failure) {
        if (current()) error = `范围状态读取失败：${failure.message}`;
      } finally {
        busy = false;
        stage = "";
        emit();
      }
    },
    async resolve(hosts) {
      if (!current() || busy || stopping || status?.active) return;
      busy = true;
      error = "";
      const epoch = ++statusEpoch;
      try {
        if (!admissionAccepted) throw new Error("请先确认演练入口，再刷新域名解析。");
        if (
          !Array.isArray(hosts) ||
          !hosts.length ||
          hosts.length > 32 ||
          new Set(hosts).size !== hosts.length ||
          !hosts.every((hostname) =>
            status?.hosts.some((item) => item.hostname === hostname && item.type === "hostname"),
          )
        )
          throw new Error("每批需选择 1 至 32 个不同的已保存域名；IP 无需解析，超出请分批刷新。");
        const revision = status.revision;
        const selected = [...hosts];
        stage = "confirm";
        emit();
        if (!(await confirm(selected)) || !current()) return;
        stage = "resolve";
        result = null;
        emit();
        const response = await api("networkScope.resolve", {
          hosts: selected,
          revision,
          confirmed: true,
        });
        if (current()) result = response.items;
        adopt(response.status, epoch);
      } catch (failure) {
        if (current()) {
          if (failure.code === "NETWORK_SCOPE_PARTIAL" && failure.partial) {
            result = failure.partial.items;
            adopt(failure.partial.status, epoch);
          }
          error = `${failure.message}；未自动重试，请读取最新状态后重新确认。`;
        }
      } finally {
        busy = false;
        stage = "";
        emit();
      }
    },
    async importFile(file, release) {
      if (!current() || busy || stopping || status?.active) return;
      busy = true;
      stage = "import";
      error = "";
      const epoch = ++statusEpoch;
      try {
        const limit = validateCountryFile(file, release);
        if (!status) throw new Error("请先读取范围状态。");
        const revision = status.database.revision;
        emit();
        const contentBase64 = await encodeFile(file, limit);
        if (!current()) return;
        adopt(
          await api("networkScope.import", {
            filename: file.name,
            release,
            contentBase64,
            revision,
          }),
          epoch,
        );
      } catch (failure) {
        if (current())
          error = `本地数据库导入失败：${failure.message}；未自动重试，既有数据库状态保留。`;
      } finally {
        busy = false;
        stage = "";
        emit();
      }
    },
    async stop() {
      if (!current() || stopping || !(stage === "resolve" || status?.active)) return;
      stopping = true;
      const epoch = ++statusEpoch;
      emit();
      try {
        await api("networkScope.stop", {});
        if (current()) adopt(await api("networkScope.status", {}), epoch);
      } catch (failure) {
        if (current()) error = `停止解析未确认：${failure.message}`;
      } finally {
        stopping = false;
        emit();
      }
    },
  };
}

export function networkScopePanel(view) {
  const database = view.status?.database;
  const hosts = view.status?.hosts || [];
  const disabled = view.busy || view.stopping || view.status?.active || !view.status;
  const dnsDisabled = disabled || !view.admissionAccepted;
  const domains = hosts.filter((item) => item.type === "hostname");
  const feedback = `${view.error ? `<div class="error" role="alert">${esc(view.error)}</div>` : ""}<p class="info" role="status">${view.stage === "refresh" ? "正在只读读取状态，未发起解析。" : view.stage === "confirm" ? "等待本次确认，尚未发起 DNS 查询。" : view.stage === "resolve" ? "正在解析，可随时停止。" : view.stage === "import" ? "正在读取你选择的本地文件并导入。" : view.status?.active ? "域名解析正在运行，可停止或稍后刷新状态。" : "本地导入与域名解析由下方明确操作触发。"}</p>`;
  const observed = view.result
    ? `<h3>本次解析结果</h3><div class="tablewrap"><table><thead><tr><th>主机</th><th>本次结果</th><th>保存状态</th></tr></thead><tbody>${view.result.map((item) => `<tr><td>${esc(item.hostname)}</td><td>${esc(item.state === "resolved" ? `解析成功：${(item.addresses || []).join("、")}` : reasons[item.reason] || item.reason || item.state)}${item.resolvedAt ? `<br>${esc(item.resolvedAt)}` : ""}</td><td>${item.persisted ? "已保存" : "本次未保存"}</td></tr>`).join("")}</tbody></table></div>`
    : "";
  return `<section class="panel"><div class="panelheading"><h2>本地网络范围管理</h2><span class="meta">${view.status ? `revision ${esc(view.status.revision)}` : "状态尚未读取"}</span></div><div class="note">${esc(networkScopeNotice)}</div>${feedback}<div class="toolbar"><button type="button" class="small" data-scope-refresh ${view.busy || view.stopping ? "disabled" : ""}>只读刷新状态</button><button type="button" class="small" data-scope-stop ${view.stopping || !(view.stage === "resolve" || view.status?.active) ? "disabled" : ""}>${view.stopping ? "正在停止…" : "停止域名解析"}</button></div><h3>国家数据库</h3><div class="twocoltext"><span>状态 / 数据月份</span><span>${database?.available ? "已导入" : "不可用"} / ${esc(database?.release || "未声明")}</span></div><div class="twocoltext"><span>来源</span><span>${esc(database?.source || "尚未导入本地文件")}</span></div><div class="twocoltext"><span>数据库版本 / 记录</span><span>${esc(database?.revision ?? "—")} / ${esc(database?.records ?? 0)} 条（IPv4 ${esc(database?.ipv4 ?? 0)}，IPv6 ${esc(database?.ipv6 ?? 0)}）</span></div><div class="field"><label>SHA-256</label><pre class="report">${esc(database?.sha256 || "尚无文件校验值")}</pre></div><p class="info">数据来源与归属：<a href="https://db-ip.com/db/download/ip-to-country-lite" target="_blank" rel="noreferrer">DB-IP IP to Country Lite</a> · <a href="https://db-ip.com" target="_blank" rel="noreferrer">DB-IP</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>。本插件不下载或内置数据库。</p>${database?.attribution ? `<p class="info">导入记录归属：${esc(database.attribution.name)} · ${esc(database.attribution.url)} · ${esc(database.attribution.license)} · ${esc(database.attribution.licenseUrl)}</p>` : ""}<form data-scope-import data-draft="off"><div class="fields"><div class="field"><label for="scope-country-file">本地国家数据库文件</label><input id="scope-country-file" name="file" type="file" accept=".csv,.csv.gz" ${disabled ? "disabled" : ""}><small>CSV ≤48 MiB，CSV.GZ ≤16 MiB，展开后 ≤64 MiB；只读取你选择的文件。</small></div><div class="field"><label for="scope-country-release">数据月份</label><input id="scope-country-release" name="release" type="month" required ${disabled ? "disabled" : ""}><small>YYYY-MM 是你的声明，不代表已核验供应商真实性。</small></div></div><button type="submit" class="primary" ${disabled ? "disabled" : ""}>明确导入本地数据库</button></form><h3>已保存的自有服务器</h3><p class="info">IP 本身无需解析。最后解析地址与时间只表示已保存的快照；本次失败见下方结果。${view.admissionAccepted ? "" : "尚未确认演练入口，域名解析按钮已禁用；本地数据库导入仍可使用。"}</p><div class="toolbar"><button type="button" class="small" data-scope-batch ${dnsDisabled || !domains.length ? "disabled" : ""}>确认刷新全部域名（最多 32 个）</button></div>${hosts.length ? `<div class="tablewrap"><table><thead><tr><th>精确主机</th><th>最后解析地址 / 时间</th><th>操作</th></tr></thead><tbody>${hosts.map((host, index) => `<tr><td>${esc(host.hostname)}<br>${host.type === "ip" ? "IP" : "域名"}</td><td>${host.type === "ip" ? "IP 本身无需解析" : host.snapshot ? `${host.snapshot.addresses.map(esc).join("<br>")}<br>${esc(host.snapshot.resolvedAt)}` : "尚无解析快照"}</td><td>${host.type === "hostname" ? `<button type="button" class="small" data-scope-host="${index}" ${dnsDisabled ? "disabled" : ""}>确认刷新解析</button>` : "—"}</td></tr>`).join("")}</tbody></table></div>` : '<p class="info">尚无已保存服务器。请在上方清单编辑后保存配置。</p>'}${observed}</section>`;
}
