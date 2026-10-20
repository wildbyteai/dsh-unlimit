let instance = 0;

/** Independent local environment editor. Actual secrets live only in password inputs/in-flight requests. */
export async function environmentSettings({ api, esc, panel, toast, run }) {
  const id = `environment-settings-${++instance}`;
  let state = null;
  let error = "";
  let notice = "";
  let selectedVariable = null;
  let selectedKey = null;
  let host = null;
  let listeners = null;
  let busy = false;
  let disposed = false;

  function adopt(value) {
    if (
      !Number.isSafeInteger(value?.revision) ||
      !Array.isArray(value.variables) ||
      !Array.isArray(value.hosts) ||
      !Array.isArray(value.privateKeys) ||
      !value.onboarding
    )
      throw new Error("环境状态响应无效，请重新读取。");
    // Drop unexpected server fields, especially any actual value beside secret:true.
    state = {
      revision: value.revision,
      variables: value.variables.map((item) => ({
        name: item.name,
        secret: item.secret,
        configured: item.configured,
        updatedAt: item.updatedAt,
        ...(item.secret ? {} : { value: item.value }),
      })),
      hosts: value.hosts,
      privateKeys: value.privateKeys.map((item) => ({
        id: item.id,
        label: item.label,
        path: item.path,
        metadata: item.metadata,
      })),
      onboarding: value.onboarding,
    };
  }
  function message(value, secret = "") {
    const text = String(value?.message || "操作失败，请重新读取状态后重试。");
    return secret ? text.split(secret).join("[秘密已隐藏]") : text;
  }
  async function load() {
    adopt(await api("environment.status"));
  }
  try {
    await load();
  } catch (failure) {
    error = message(failure);
  }

  function variableTable() {
    return state.variables.length
      ? `<div class="tablewrap"><table><thead><tr><th>变量名</th><th>类型 / 当前值</th><th>操作</th></tr></thead><tbody>${state.variables.map((item, index) => `<tr><td class="mono">${esc(item.name)}</td><td>${item.secret ? `<span class="tag gray">秘密 · ${item.configured ? "已设置，值不读回" : "空值"}</span>` : `<span class="tag">普通</span> <span class="mono">${esc(item.value || "（空值）")}</span>`}</td><td><button type="button" class="small" data-env-action="edit-variable" data-env-index="${index}">编辑</button> <button type="button" class="small danger" data-env-action="delete-variable" data-env-index="${index}">删除</button></td></tr>`).join("")}</tbody></table></div>`
      : '<p class="info">尚未登记环境变量。</p>';
  }
  function variableEditor() {
    const current = state.variables.find((item) => item.name === selectedVariable);
    const secret = current ? current.secret : true;
    return `<form method="post" data-env-form="variable" data-draft="off" autocomplete="off"><div class="fields"><div class="field"><label for="${id}-variable-name">变量名</label><input id="${id}-variable-name" name="name" required pattern="[A-Za-z_][A-Za-z0-9_]{0,127}" maxlength="128" value="${esc(current?.name || "")}" ${current ? "readonly" : ""} autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="例如 EXAMPLE_TOKEN"></div><div class="field"><label for="${id}-variable-kind">变量类型</label><select id="${id}-variable-kind" name="kind" ${current ? "disabled" : ""}><option value="secret" ${secret ? "selected" : ""}>秘密 · 不读回正文</option><option value="plain" ${secret ? "" : "selected"}>普通 · 可读回正文</option></select><small>已有变量类型不可直接转换，需删除后明确重建。</small></div><div class="field wide"><label for="${id}-variable-value">${secret ? "秘密值" : "普通值"}</label><input id="${id}-variable-value" name="value" type="${secret ? "password" : "text"}" ${secret ? 'autocomplete="new-password"' : 'autocomplete="off"'} autocapitalize="off" spellcheck="false" value="${secret ? "" : esc(current?.value || "")}" placeholder="${current && secret ? "留空保留已存秘密；输入新值则替换" : "填写本地变量值"}"><small>单值最多 32 KiB。秘密不进入本页面草稿；保存后清空输入，不显示已存值。</small></div>${current && secret ? `<div class="field wide"><label><input type="checkbox" name="clearValue"> 显式清空已存秘密值</label><small>勾选后提交空值；未勾选时，秘密输入留空表示保留。</small></div>` : ""}</div><div class="toolbar"><button class="primary" type="submit">${current ? "保存变量修改" : "新增变量"}</button>${current ? '<button type="button" class="quiet" data-env-action="new-variable">取消编辑 / 新增</button>' : ""}</div></form>`;
  }
  function keyTable() {
    return state.privateKeys.length
      ? `<div class="tablewrap"><table><thead><tr><th>标签 / 路径</th><th>元信息</th><th>操作</th></tr></thead><tbody>${state.privateKeys.map((item, index) => `<tr><td><strong>${esc(item.label)}</strong><div class="mono">${esc(item.path)}</div></td><td>${item.metadata?.available ? `普通文件 · ${esc(item.metadata.bytes)} 字节<br>权限 ${esc(item.metadata.mode)} · 仅元信息检查` : `<span class="tag orange">路径当前不可用</span><br>${esc(item.metadata?.reason || "未提供元信息")}`}</td><td><button class="small" type="button" data-env-action="edit-key" data-env-index="${index}">编辑</button> <button class="small danger" type="button" data-env-action="delete-key" data-env-index="${index}">删除登记</button></td></tr>`).join("")}</tbody></table></div>`
      : '<p class="info">尚未登记私钥路径。</p>';
  }
  function keyEditor() {
    const current = state.privateKeys.find((item) => item.id === selectedKey);
    return `<form method="post" data-env-form="key" data-draft="off" autocomplete="off"><div class="field"><label for="${id}-key-label">路径标签</label><input id="${id}-key-label" name="label" required maxlength="128" value="${esc(current?.label || "")}" placeholder="便于识别的本地标签"></div><div class="field"><label for="${id}-key-path">私钥文件的绝对路径</label><input id="${id}-key-path" name="path" required value="${esc(current?.path || "")}" placeholder="/绝对路径/私钥文件" autocomplete="off" spellcheck="false"><small>只接受现有普通文件，拒绝符号链接。只检查路径和元信息，不读取密钥字节、不验证格式或可用性。</small></div><div class="toolbar"><button class="primary" type="submit">${current ? "保存路径修改" : "登记私钥路径"}</button>${current ? '<button type="button" class="quiet" data-env-action="new-key">取消编辑 / 新增</button>' : ""}</div></form>`;
  }
  function body() {
    const feedback = `${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}${notice ? `<p class="info" role="status">${esc(notice)}</p>` : ""}`;
    if (!state)
      return panel(
        "本地环境配置",
        `${feedback}<button type="button" data-env-action="refresh">重新读取环境配置</button>`,
      );
    const onboarding =
      { pending: "尚未配置", configured: "已有配置记录", skipped: "已明确暂不配置" }[
        state.onboarding.state
      ] || "状态未知";
    return `${panel("本地环境配置", `${feedback}<p class="info">此配置属于当前本地安装实例。环境状态与任务/目标授权独立，不阻塞普通聊天。配置记录不代表凭据有效、工具就绪或连接成功。</p><div class="toolbar"><span class="tag ${state.onboarding.state === "pending" ? "orange" : "gray"}">${esc(onboarding)}</span><button type="button" data-env-action="configured" ${state.onboarding.configured ? "" : "disabled"}>标记配置完成</button><button type="button" data-env-action="skip">暂不配置，继续使用</button><button type="button" data-env-action="refresh">刷新脱敏状态</button></div><p class="info">配置文件使用本机文件权限保护，未加密。此面板不提供秘密导出，也不会执行命令或连接主机。</p>`, `revision ${state.revision}`)}<div class="grid2"><div>${panel("环境变量", `${variableTable()}${variableEditor()}`)}</div><div>${panel("基础设施 / 连接主机", `<form method="post" data-env-form="hosts" data-draft="off" autocomplete="off"><div class="field"><label for="${id}-hosts">主机清单 · 每行一个</label><textarea id="${id}-hosts" name="items" rows="5" spellcheck="false">${esc(state.hosts.join("\n"))}</textarea><small>可填 IP、完整主机名或 user@host。不要填写密码、私钥正文、URL、端口、网段或通配符。清空后保存会清除本清单。</small></div><p class="info">这是连接主机清单，与控制页的目标例外名单分开，不授予访问或目标许可。</p><button class="primary" type="submit">保存主机清单</button></form>`)}${panel("私钥路径登记", `${keyTable()}${keyEditor()}<p class="info">删除只移除本插件登记，保留原私钥文件。</p>`)}</div></div>`;
  }
  function wipePasswords() {
    host?.querySelectorAll('input[type="password"]').forEach((input) => {
      input.value = "";
    });
  }
  function redraw() {
    if (disposed || !host) return;
    wipePasswords();
    listeners?.abort();
    host.innerHTML = body();
    attach();
  }
  function disableControls() {
    host?.querySelectorAll("input,textarea,select,button").forEach((input) => {
      input.disabled = true;
    });
  }
  async function mutate(action, payload, success, secret = "") {
    if (busy || !state || disposed) return;
    busy = true;
    disableControls();
    try {
      const result = await api(action, { ...payload, revision: state.revision });
      if (disposed) return;
      adopt(result);
      error = "";
      notice = success;
      if (action === "environment.variables.save") selectedVariable = payload.name;
      if (action === "environment.variables.delete") selectedVariable = null;
      if (action === "environment.keys.delete" || action === "environment.keys.save")
        selectedKey = null;
      toast(success);
    } catch (failure) {
      if (disposed) return;
      notice = "";
      if (failure.code === "CONFLICT") {
        try {
          await load();
          error =
            "配置已被其他窗口修改，本页已刷新。请检查当前状态，重新输入需要变更的内容后保存；未自动覆盖。";
        } catch (refreshFailure) {
          state = null;
          error = `配置版本冲突，且刷新失败：${message(refreshFailure, secret)}。请重新读取后再操作。`;
        }
      } else error = message(failure, secret);
      if (secret) error += " 秘密输入已清空，需要替换时请重新输入。";
      toast(error);
    } finally {
      // Only this request temporarily holds the submitted secret; no module draft retains it.
      if (secret && Object.hasOwn(payload, "value")) delete payload.value;
      secret = "";
      busy = false;
      redraw();
    }
  }
  function invoke(button, work) {
    if (busy || disposed) return;
    run(button, async () => {
      try {
        await work();
      } catch (failure) {
        if (!disposed) {
          error = message(failure);
          notice = "";
          redraw();
        }
      }
    });
  }
  function attach() {
    listeners = new AbortController();
    const on = (element, event, handler) =>
      element?.addEventListener(event, handler, { signal: listeners.signal });
    for (const button of host.querySelectorAll("[data-env-action]"))
      on(button, "click", () => {
        const action = button.dataset.envAction;
        const index = Number(button.dataset.envIndex);
        if (action === "edit-variable") {
          selectedVariable = state.variables[index]?.name ?? null;
          error = "";
          notice = "";
          redraw();
        } else if (action === "new-variable") {
          selectedVariable = null;
          redraw();
        } else if (action === "edit-key") {
          selectedKey = state.privateKeys[index]?.id ?? null;
          error = "";
          notice = "";
          redraw();
        } else if (action === "new-key") {
          selectedKey = null;
          redraw();
        } else if (action === "delete-variable")
          invoke(button, () =>
            mutate(
              "environment.variables.delete",
              { name: state.variables[index].name },
              "变量已删除；实际值不读回。",
            ),
          );
        else if (action === "delete-key")
          invoke(button, () =>
            mutate(
              "environment.keys.delete",
              { id: state.privateKeys[index].id },
              "私钥路径登记已删除，原文件保留。",
            ),
          );
        else if (action === "configured" || action === "skip")
          invoke(button, () =>
            mutate(
              "environment.onboarding",
              { decision: action === "skip" ? "skip" : "configured" },
              action === "skip"
                ? "已记录暂不配置，不授予任务或目标授权。"
                : "已记录配置完成；未验证凭据或连接。",
            ),
          );
        else if (action === "refresh")
          invoke(button, async () => {
            busy = true;
            disableControls();
            try {
              await load();
              error = "";
              notice = "已重新读取脱敏状态。";
            } catch (failure) {
              error = message(failure);
              notice = "";
            } finally {
              busy = false;
              redraw();
            }
          });
      });
    const variableForm = host.querySelector('[data-env-form="variable"]');
    on(variableForm, "submit", (event) => {
      event.preventDefault();
      const current = state.variables.find((item) => item.name === selectedVariable);
      const secret = current ? current.secret : variableForm.elements.kind.value === "secret";
      const value = variableForm.elements.value.value;
      const payload = {
        name: current?.name || variableForm.elements.name.value,
        ...(current ? {} : { secret }),
      };
      if (current && secret) {
        if (variableForm.elements.clearValue.checked) payload.value = "";
        else if (value !== "") payload.value = value;
      } else payload.value = value;
      invoke(variableForm.querySelector('[type="submit"]'), () =>
        mutate(
          "environment.variables.save",
          payload,
          current ? "变量修改已保存，当前显示为脱敏状态。" : "变量已新增，当前显示为脱敏状态。",
          secret ? value : "",
        ),
      );
    });
    on(variableForm?.elements.kind, "change", () => {
      const input = variableForm.elements.value;
      input.value = "";
      input.type = variableForm.elements.kind.value === "secret" ? "password" : "text";
      input.autocomplete = input.type === "password" ? "new-password" : "off";
      host.querySelector(`label[for="${id}-variable-value"]`).textContent =
        input.type === "password" ? "秘密值" : "普通值";
    });
    on(variableForm?.elements.clearValue, "change", () => {
      variableForm.elements.value.value = "";
      variableForm.elements.value.disabled = variableForm.elements.clearValue.checked;
    });
    const hostsForm = host.querySelector('[data-env-form="hosts"]');
    on(hostsForm, "submit", (event) => {
      event.preventDefault();
      const items = hostsForm.elements.items.value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      invoke(hostsForm.querySelector('[type="submit"]'), () =>
        mutate("environment.hosts.save", { items }, "主机清单已保存；未建立连接或授予目标权限。"),
      );
    });
    const keyForm = host.querySelector('[data-env-form="key"]');
    on(keyForm, "submit", (event) => {
      event.preventDefault();
      const payload = {
        ...(selectedKey ? { id: selectedKey } : {}),
        label: keyForm.elements.label.value,
        path: keyForm.elements.path.value,
      };
      invoke(keyForm.querySelector('[type="submit"]'), () =>
        mutate("environment.keys.save", payload, "私钥路径元信息已登记；未读取密钥或验证连接。"),
      );
    });
  }
  return {
    html: `<div id="${id}" data-environment-settings>${body()}</div>`,
    bind(element) {
      if (disposed) return;
      listeners?.abort();
      host = element
        ? element.id === id
          ? element
          : element.querySelector(`#${id}`)
        : document.getElementById(id);
      if (!host) throw new Error("环境配置模块容器不存在。");
      attach();
    },
    dispose() {
      disposed = true;
      wipePasswords();
      listeners?.abort();
      host = null;
      state = null;
    },
  };
}

export default environmentSettings;
