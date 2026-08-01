(function () {
    "use strict";

    var form = document.getElementById("guestbookForm");
    var nicknameInput = document.getElementById("guestbookNickname");
    var contentInput = document.getElementById("guestbookContent");
    var hint = document.getElementById("guestbookHint");
    var latestEl = document.getElementById("guestbookLatest");
    var count = document.getElementById("guestbookCount");

    // CAPTCHA modal
    var overlay = document.getElementById("captchaOverlay");
    var captchaQuestion = document.getElementById("captchaQuestion");
    var captchaInput = document.getElementById("captchaInput");
    var captchaRefresh = document.getElementById("captchaRefresh");
    var captchaCancel = document.getElementById("captchaCancel");
    var captchaConfirm = document.getElementById("captchaConfirm");
    var captchaError = document.getElementById("captchaError");

    var apiBase = "https://ecosilk.cn";
    var avatarUrl = "/static/homepage/ameath/default_img.jpg";

    if (!form) return;

    var captchaToken = null;
    var submitting = false;
    var pendingNickname = "";
    var pendingContent = "";

    function formatTime(value) {
        var date = new Date(value);
        return Number.isNaN(date.getTime()) ? "刚刚" : date.toLocaleString("zh-CN", {
            month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
        });
    }

    function buildMessageEl(message) {
        var article = document.createElement("article");
        article.className = "guestbook-message";
        var row = document.createElement("div");
        row.className = "guestbook-message-row";

        var avatar = document.createElement("img");
        avatar.className = "guestbook-avatar";
        avatar.src = avatarUrl;
        avatar.alt = "";

        var body = document.createElement("div");
        body.className = "guestbook-message-body";

        var meta = document.createElement("div");
        meta.className = "guestbook-message-meta";

        var name = document.createElement("strong");
        name.textContent = message.nickname;

        var time = document.createElement("time");
        time.dateTime = message.created_at;
        time.textContent = formatTime(message.created_at);

        var content = document.createElement("p");
        content.textContent = message.content;

        meta.append(name, time);
        body.append(meta, content);
        row.append(avatar, body);
        article.appendChild(row);
        return article;
    }

    function renderMessages(messages) {
        latestEl.replaceChildren();
        count.textContent = messages.length ? messages.length + " 条" : "";
        if (!messages.length) {
            var empty = document.createElement("p");
            empty.className = "guestbook-empty";
            empty.textContent = "还没有留言，来做第一个留下痕迹的人吧。";
            latestEl.appendChild(empty);
            return;
        }
        messages.forEach(function (m) {
            latestEl.appendChild(buildMessageEl(m));
        });
    }

    function loadCaptcha() {
        captchaQuestion.textContent = "加载中…";
        captchaInput.value = "";
        captchaError.textContent = "";
        captchaToken = null;
        fetch(apiBase + "/api/guestbook/captcha")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                captchaToken = data.token;
                captchaQuestion.textContent = data.question;
            })
            .catch(function () {
                captchaQuestion.textContent = "获取失败，点击 ↻ 刷新";
            });
    }

    function loadMessages() {
        fetch(apiBase + "/api/guestbook")
            .then(function (r) { return r.json(); })
            .then(function (data) { renderMessages(data.messages || []); })
            .catch(function () { renderMessages([]); });
    }

    function showCaptchaModal() {
        overlay.classList.add("show");
        overlay.setAttribute("aria-hidden", "false");
        loadCaptcha();
        captchaInput.focus();
    }

    function hideCaptchaModal() {
        overlay.classList.remove("show");
        overlay.setAttribute("aria-hidden", "true");
        captchaInput.value = "";
        captchaError.textContent = "";
        captchaToken = null;
    }

    function doSubmit() {
        var answer = captchaInput.value.trim();
        if (!answer) {
            captchaError.textContent = "请输入验证码答案";
            return;
        }
        var answerNum = parseInt(answer, 10);
        if (isNaN(answerNum)) {
            captchaError.textContent = "请输入数字";
            return;
        }

        submitting = true;
        captchaConfirm.disabled = true;
        captchaError.textContent = "";

        fetch(apiBase + "/api/guestbook", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                nickname: pendingNickname,
                content: pendingContent,
                captcha_token: captchaToken,
                captcha_answer: answerNum
            })
        }).then(function (response) {
            return response.json().then(function (data) {
                if (!response.ok) throw new Error(data.detail || "发送失败");
                return data;
            });
        }).then(function () {
            contentInput.value = "";
            hint.textContent = "留言已送达";
            hideCaptchaModal();
            loadMessages();
        }).catch(function (error) {
            captchaError.textContent = error.message || "发送失败，请稍后重试";
            loadCaptcha();
        }).finally(function () {
            submitting = false;
            captchaConfirm.disabled = false;
        });
    }

    // Form submit → show CAPTCHA modal
    form.addEventListener("submit", function (event) {
        event.preventDefault();
        if (submitting) return;

        pendingNickname = nicknameInput.value.trim();
        pendingContent = contentInput.value.trim();
        if (!pendingNickname || !pendingContent) return;

        hint.textContent = "";
        showCaptchaModal();
    });

    // CAPTCHA modal buttons
    captchaRefresh.addEventListener("click", loadCaptcha);

    captchaCancel.addEventListener("click", function () {
        hideCaptchaModal();
    });

    captchaConfirm.addEventListener("click", doSubmit);

    captchaInput.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
            event.preventDefault();
            doSubmit();
        }
    });

    // Click overlay backdrop → close
    overlay.addEventListener("click", function (event) {
        if (event.target === overlay) {
            hideCaptchaModal();
        }
    });

    loadMessages();
})();
