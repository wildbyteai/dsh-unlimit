export async function admissionPage({ api, esc, panel, accepted, later }) {
  const challenge = await api("admission.begin");
  const { notice } = challenge;
  let timer,
    alive = false,
    read = false,
    reading = false,
    saving = false;
  const deadline = performance.now() + Math.max(0, challenge.readyAt - challenge.serverNow);
  return {
    html: `<div class="admission-card"><div class="eyebrow">LOCAL WORKSPACE</div><h1>${esc(notice.title)}</h1><p class="info">这份确认只对当前本地数据安装生效。普通聊天、规则配置和运行控制可以继续使用。</p>${panel(
      "使用前请阅读",
      `<div class="admission-notice" tabindex="0" aria-label="演练工作区说明">${notice.paragraphs.map((text) => `<p>${esc(text)}</p>`).join("")}<p class="info">— 说明结束 —</p></div><button type="button" id="admission-read" disabled>阅读至末尾后确认已读</button>`,
    )}<form id="admission-confirm" data-draft="off">${notice.checks.map((check) => `<label class="admission-check"><input type="checkbox" name="${esc(check.id)}"><span>${esc(check.text)}</span></label>`).join("")}<p id="admission-error" class="inlineerror" role="alert"></p><div class="toolbar"><button type="submit" class="primary" disabled>请完成阅读与逐项确认</button><button type="button" id="admission-later">稍后再说</button><span id="admission-countdown" class="info" aria-live="polite"></span></div></form></div>`,
    bind() {
      alive = true;
      const form = document.querySelector("#admission-confirm");
      const noticeElement = document.querySelector(".admission-notice");
      const readButton = document.querySelector("#admission-read");
      const submit = form.querySelector('[type="submit"]');
      const errorBox = form.querySelector("#admission-error");
      function update() {
        if (!alive) return;
        const seconds = Math.ceil(Math.max(0, deadline - performance.now()) / 1000);
        const checked = notice.checks.every(({ id }) => form.elements.namedItem(id).checked);
        const reachedEnd =
          noticeElement.scrollTop + noticeElement.clientHeight >= noticeElement.scrollHeight - 4;
        readButton.disabled = read || reading || !reachedEnd;
        submit.disabled = saving || !read || !checked || seconds > 0;
        submit.textContent = saving ? "正在记录确认…" : "确认并进入演练区";
        document.querySelector("#admission-countdown").textContent = seconds
          ? `请阅读说明 · ${seconds} 秒`
          : read
            ? "已确认阅读"
            : "请阅读至末尾并确认已读";
      }
      noticeElement.onscroll = update;
      form.onchange = update;
      readButton.onclick = async () => {
        reading = true;
        errorBox.textContent = "";
        update();
        try {
          await api("admission.read", { challengeId: challenge.challengeId });
          read = true;
          if (alive) readButton.textContent = "已确认阅读";
        } catch (error) {
          if (alive) errorBox.textContent = error.message;
        } finally {
          reading = false;
          update();
        }
      };
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (submit.disabled || saving) return;
        saving = true;
        errorBox.textContent = "";
        update();
        try {
          await api("admission.confirm", {
            challengeId: challenge.challengeId,
            checks: Object.fromEntries(
              notice.checks.map(({ id }) => [id, form.elements.namedItem(id).checked]),
            ),
          });
          if (alive) await accepted();
        } catch (error) {
          if (alive) errorBox.textContent = error.message;
        } finally {
          saving = false;
          update();
        }
      };
      document.querySelector("#admission-later").onclick = () => {
        if (!saving) later();
      };
      timer = setInterval(update, 250);
      update();
    },
    dispose() {
      alive = false;
      clearInterval(timer);
    },
  };
}
