(function () {
  "use strict";

  const config = window.PULS_CONFIG || {};
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const initData = tg ? tg.initData || "" : "";
  const INVITE_KEY = "puls-sily-owner-invite-v1";
  const fileInput = document.getElementById("post-media");
  const mediaPreview = document.getElementById("post-media-preview");
  const tabs = Array.from(document.querySelectorAll(".nav-item[data-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-tab-panel]"));
  let activeFilter = "all";
  let currentProfile = null;
  let currentClub = null;
  let clubRole = "member";
  let clubExists = false;
  let friends = { friends: [], incoming: [], outgoing: [] };
  let feedPosts = [];
  let previewUrl = "";
  let toastTimer = 0;
  let workoutSyncTimer = 0;
  let searchTimer = 0;
  let apiReady = false;
  let uploadClient = null;

  function byId(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
    });
  }
  function initials(name) {
    return String(name || "Т").trim().split(/\s+/).slice(0, 2).map(function (part) { return part.charAt(0); }).join("").toLocaleUpperCase("ru") || "Т";
  }
  function toast(message, type) {
    const el = byId("app-toast");
    if (!el) return;
    window.clearTimeout(toastTimer);
    el.textContent = message;
    el.dataset.type = type || "success";
    el.classList.remove("visible");
    window.requestAnimationFrame(function () { el.classList.add("visible"); });
    toastTimer = window.setTimeout(function () { el.classList.remove("visible"); }, 2700);
  }
  window.showPulsToast = toast;

  function hasConfig() {
    return Boolean(config.supabaseUrl && config.publishableKey && config.functionUrl &&
      config.supabaseUrl.indexOf("YOUR_") === -1 && config.publishableKey.indexOf("YOUR_") === -1 &&
      config.functionUrl.indexOf("YOUR_") === -1);
  }
  async function callApi(action, payload) {
    if (!hasConfig()) throw new Error("Сначала укажи адрес и ключ Supabase в файле config.js.");
    if (!initData) throw new Error("Открой приложение через меню бота @PulseSilyTrackerBot в Telegram.");
    let response;
    try {
      response = await fetch(config.functionUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "apikey": config.publishableKey,
          "x-telegram-init-data": initData
        },
        body: JSON.stringify(Object.assign({ action: action }, payload || {}))
      });
    } catch (error) {
      throw new Error("Не удалось связаться с сервером. Проверь интернет и настройки приложения.");
    }
    let result = {};
    try { result = await response.json(); } catch (error) {}
    if (!response.ok || !result.ok) throw new Error(result.error || "Не удалось выполнить действие.");
    return result.data;
  }

  function normalizeProfile(raw) {
    raw = raw || {};
    return {
      telegramId: Number(raw.telegram_id || raw.telegramId || 0),
      nickname: raw.nickname || raw.telegram_first_name || raw.telegram_username || "",
      age: raw.age == null ? "" : String(raw.age),
      weight: raw.weight_kg == null && raw.weightKg == null ? "" : String(raw.weight_kg == null ? raw.weightKg : raw.weight_kg),
      experience: raw.training_experience || raw.experience || "",
      category: raw.category || "",
      privateStats: raw.hide_personal_stats !== false && raw.hidePersonalStats !== false,
      theme: raw.theme || "red"
    };
  }
  function profilePayload() {
    return {
      nickname: byId("profile-nickname").value.trim(),
      age: byId("profile-age").value,
      weightKg: byId("profile-weight").value,
      experience: byId("profile-experience").value.trim(),
      category: byId("profile-category").value,
      hidePersonalStats: byId("profile-private-stats").checked,
      theme: byId("theme-select").value
    };
  }
  function applyTheme(theme) {
    const allowed = ["red", "blue", "purple", "light"];
    const value = allowed.indexOf(theme) >= 0 ? theme : "red";
    document.documentElement.dataset.theme = value;
    byId("theme-select").value = value;
    localStorage.setItem("gym-tracker-theme", value);
  }
  function applyProfile() {
    if (!currentProfile) return;
    byId("profile-nickname").value = currentProfile.nickname || "";
    byId("profile-age").value = currentProfile.age || "";
    byId("profile-weight").value = currentProfile.weight || "";
    byId("profile-experience").value = currentProfile.experience || "";
    byId("profile-category").value = currentProfile.category || "";
    byId("profile-private-stats").checked = currentProfile.privateStats !== false;
    const name = currentProfile.nickname || "Твой профиль";
    byId("profile-display-name").textContent = name;
    byId("profile-avatar").textContent = initials(name);
    byId("composer-avatar").textContent = initials(name);
    byId("composer-name").textContent = currentProfile.nickname ? currentProfile.nickname : "Твоя публикация";
    const meta = [];
    if (!currentProfile.privateStats && currentProfile.age) meta.push(currentProfile.age + " лет");
    if (!currentProfile.privateStats && currentProfile.weight) meta.push(currentProfile.weight + " кг");
    if (!currentProfile.privateStats && currentProfile.category) {
      meta.push({ men: "Мужская категория", women: "Женская категория", open: "Открытая категория" }[currentProfile.category] || "");
    }
    if (currentProfile.experience) meta.push("Стаж " + currentProfile.experience);
    byId("profile-meta").textContent = meta.filter(Boolean).join(" · ") || "Участник закрытой группы";
    byId("dashboard-nickname").textContent = currentProfile.nickname || "атлет";
  }

  function showSetup(title, message, options) {
    options = options || {};
    const box = byId("club-setup");
    box.hidden = false;
    byId("club-setup-title").textContent = title;
    byId("club-setup-message").textContent = message;
    byId("club-create-area").hidden = !options.create;
    byId("club-join-area").hidden = !options.join;
    byId("club-setup-status").textContent = options.status || "";
  }
  function setCommunityLocked(message) {
    const notice = byId("community-notice");
    notice.hidden = false;
    notice.textContent = message;
    const controls = document.querySelectorAll("#post-form input, #post-form textarea, #post-form button, #friend-form input, #friend-form button, #profile-form input, #profile-form select, #profile-form button, #invite-copy");
    controls.forEach(function (el) { el.disabled = true; });
    byId("feed-list").innerHTML = '<div class="empty">Лента откроется после подключения к клубу.</div>';
    byId("friends-list").innerHTML = '<div class="empty">Список друзей появится после вступления.</div>';
    byId("leaderboard-list").innerHTML = '<div class="empty">Рейтинг появится после вступления.</div>';
    byId("member-search-results").innerHTML = "";
  }
  function setCommunityReady() {
    byId("community-notice").hidden = true;
    const controls = document.querySelectorAll("#post-form input, #post-form textarea, #post-form button, #friend-form input, #friend-form button, #profile-form input, #profile-form select, #profile-form button, #invite-copy");
    controls.forEach(function (el) { el.disabled = false; });
  }
  function currentWorkoutData() {
    return window.PulsWorkoutApp ? window.PulsWorkoutApp.getWorkouts() : [];
  }
  function currentProgramData() {
    return window.PulsWorkoutApp ? window.PulsWorkoutApp.getProgram() : null;
  }
  async function syncInitialData() {
    const cloud = await callApi("get_data");
    const localWorkouts = currentWorkoutData();
    if (cloud.workouts && cloud.workouts.length) {
      window.PulsWorkoutApp.setWorkouts(cloud.workouts);
    } else if (localWorkouts.length) {
      await callApi("save_workouts", { workouts: localWorkouts });
    }
    const localProgram = currentProgramData();
    if (cloud.program) {
      window.PulsWorkoutApp.setProgram(cloud.program);
    } else if (localProgram) {
      await callApi("save_program", { program: localProgram, theme: cloud.theme || "red" });
    }
    applyTheme(cloud.theme || (currentProfile && currentProfile.theme) || "red");
  }
  async function scheduleWorkoutSync(eventWorkout) {
    if (!apiReady || !eventWorkout) return;
    try {
      await callApi("save_workouts", { workouts: [eventWorkout] });
      updateDashboard();
      await refreshLeaderboard();
    } catch (error) { toast(error.message, "error"); }
  }
  async function saveProgramToCloud(program) {
    if (!apiReady) return;
    try {
      await callApi("save_program", { program: program, theme: byId("theme-select").value });
    } catch (error) { toast(error.message, "error"); }
  }
  function updateDashboard() {
    const workouts = currentWorkoutData();
    const program = currentProgramData();
    const count = workouts.length;
    const volume = workouts.reduce(function (sum, workout) {
      return sum + (Array.isArray(workout.exercises) ? workout.exercises.reduce(function (subtotal, exercise) {
        return subtotal + (Number(exercise.weight) || 0) * (Number(exercise.reps) || 0) * (Number(exercise.sets) || 0);
      }, 0) : 0);
    }, 0);
    byId("dashboard-workouts").textContent = String(count);
    byId("dashboard-streak").textContent = String(count);
    byId("dashboard-volume").innerHTML = Math.round(volume).toLocaleString("ru-RU") + " <em>кг</em>";
    byId("profile-workout-count").textContent = String(count);
    if (!program || !Array.isArray(program.weeks)) return;
    const savedWeek = Number(localStorage.getItem("puls-sily-current-week")) || 1;
    const week = Math.max(1, Math.min(16, savedWeek));
    const planWeek = program.weeks[week - 1];
    byId("dashboard-title").textContent = "Неделя " + week + " · " + (planWeek ? planWeek.stage.toLocaleLowerCase("ru") : "твой силовой цикл");
    byId("dashboard-description").textContent = "Присед " + program.maxes.squat + " кг · жим " + program.maxes.bench + " кг · тяга " + program.maxes.deadlift + " кг. План уже ждёт.";
    byId("dashboard-progress-label").textContent = week + " из 16 · " + Math.round(week / 16 * 100) + "%";
    byId("dashboard-progress-bar").style.width = (week / 16 * 100) + "%";
  }

  function setInviteUi() {
    const card = byId("invite-card");
    const code = localStorage.getItem(INVITE_KEY) || "";
    if (!currentClub || clubRole !== "owner") {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    byId("invite-title").textContent = "Приглашение в " + currentClub.name;
    byId("invite-description").textContent = code ? "Нажми, чтобы скопировать код и отправить его ребятам." : "Кода нет на этом устройстве. Нажми, чтобы выпустить новый.";
    byId("invite-code-label").textContent = code || "создать новый";
  }
  function setLoggedOut() {
    byId("group-chip").innerHTML = '<span class="online-dot"></span> Только Telegram';
    showSetup("Открой через Telegram", "Для общей ленты и профилей нужно открыть приложение из Telegram Mini App.");
    setCommunityLocked("Открой приложение через меню бота @PulseSilyTrackerBot, чтобы войти в закрытый клуб и пользоваться общей лентой.");
    byId("club-setup-message").innerHTML = 'В Telegram открой чат с <a href="https://t.me/PulseSilyTrackerBot" target="_blank" rel="noopener">ботом @PulseSilyTrackerBot</a> и нажми кнопку приложения.';
  }

  async function start() {
    if (tg) {
      tg.ready();
      tg.expand();
      if (tg.setHeaderColor) tg.setHeaderColor("#08090b");
      if (tg.setBackgroundColor) tg.setBackgroundColor("#08090b");
    }
    if (!hasConfig()) {
      byId("group-chip").innerHTML = '<span class="online-dot"></span> Нужна настройка';
      showSetup("Подключение ещё не настроено", "Заполни config.js адресом проекта Supabase и публичным ключом. Подробная инструкция лежит в README.");
      setCommunityLocked("Сначала владелец приложения подключает сервер. После этого здесь появятся клуб, профили, друзья и лента.");
      return;
    }
    if (!initData) { setLoggedOut(); return; }
    byId("group-chip").innerHTML = '<span class="online-dot"></span> Подключаемся…';
    try {
      const result = await callApi("me");
      clubExists = Boolean(result.hasClub);
      currentProfile = normalizeProfile(result.profile);
      currentClub = result.club || null;
      clubRole = currentClub ? currentClub.role : "member";
      applyProfile();
      applyTheme(currentProfile.theme || "red");
      if (!currentClub) {
        byId("group-chip").innerHTML = '<span class="online-dot"></span> Без клуба';
        showSetup(clubExists ? "Вступи в клуб" : "Создай клуб своего зала",
          clubExists ? "Попроси у владельца код приглашения. После вступления откроются лента и профили участников." : "Ты первый: задай название зала и введи код владельца, который хранится в настройках сервера.",
          { create: !clubExists, join: clubExists });
        setCommunityLocked("Для публикаций, поиска друзей и общего профиля сначала вступи в клуб.");
        return;
      }
      byId("club-setup").hidden = true;
      byId("group-chip").innerHTML = '<span class="online-dot"></span> ' + escapeHtml(currentClub.name);
      setCommunityReady();
      setInviteUi();
      apiReady = true;
      await syncInitialData();
      applyProfile();
      updateDashboard();
      await Promise.all([refreshFriends(), refreshFeed(), refreshLeaderboard()]);
      toast("Ты в клубе. Добро пожаловать!");
    } catch (error) {
      byId("group-chip").innerHTML = '<span class="online-dot"></span> Нет связи';
      showSetup("Не удалось подключиться", error.message);
      setCommunityLocked(error.message);
    }
  }

  async function saveProfile(showMessage) {
    const data = profilePayload();
    const result = await callApi("save_profile", data);
    currentProfile = normalizeProfile(result.profile);
    applyProfile();
    applyTheme(data.theme);
    if (showMessage !== false) toast("Профиль сохранён");
    return result;
  }
  byId("profile-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    if (!apiReady) { toast("Вступи в клуб, чтобы сохранить профиль.", "error"); return; }
    const button = event.submitter;
    if (button) button.disabled = true;
    try { await saveProfile(true); }
    catch (error) { toast(error.message, "error"); }
    finally { if (button) button.disabled = false; }
  });
  byId("profile-private-stats").addEventListener("change", async function () {
    if (!apiReady || !currentProfile) return;
    currentProfile.privateStats = this.checked;
    applyProfile();
    try { await saveProfile(false); toast("Настройки приватности сохранены"); }
    catch (error) { toast(error.message, "error"); }
  });
  byId("theme-select").addEventListener("change", async function () {
    applyTheme(this.value);
    if (!apiReady) { toast("Тема изменена на этом устройстве"); return; }
    try { await saveProfile(false); toast("Тема сохранена"); }
    catch (error) { toast(error.message, "error"); }
  });
  window.addEventListener("puls:theme-changed", function () {
    if (apiReady) saveProfile(false).catch(function (error) { toast(error.message, "error"); });
  });
  window.addEventListener("puls:workout-saved", function (event) { scheduleWorkoutSync(event.detail); });
  window.addEventListener("puls:workout-deleted", async function (event) {
    if (!apiReady) return;
    try { await callApi("delete_workouts", { ids: [String(event.detail)] }); }
    catch (error) { toast(error.message, "error"); }
  });
  window.addEventListener("puls:workouts-cleared", async function () {
    if (!apiReady) return;
    try { await callApi("clear_workouts"); }
    catch (error) { toast(error.message, "error"); }
  });
  window.addEventListener("puls:workouts-replaced", async function (event) {
    if (!apiReady) return;
    try { await callApi("replace_workouts", { workouts: event.detail || [] }); toast("История синхронизирована"); }
    catch (error) { toast(error.message, "error"); }
  });
  window.addEventListener("puls:program-changed", function (event) { saveProgramToCloud(event.detail); });

  async function refreshFriends() {
    if (!apiReady) return;
    friends = await callApi("friends");
    renderFriends();
    updateDashboard();
  }
  async function refreshLeaderboard() {
    if (!apiReady) return;
    const result = await callApi("leaderboard");
    const entries = result.entries || [];
    const max = Math.max(1, ...entries.map(function (item) { return Number(item.count) || 0; }));
    byId("leaderboard-list").innerHTML = entries.length ? entries.map(function (item, index) {
      const count = Number(item.count) || 0;
      const width = Math.max(count ? 8 : 0, Math.round(count / max * 100));
      return '<div class="leaderboard-row' + (item.me ? " leaderboard-me" : "") + '"><span class="leaderboard-rank">' + (index + 1) + '</span><div class="leaderboard-person"><strong>' + escapeHtml(item.nickname) + (item.me ? " · ты" : "") + '</strong><span class="leaderboard-bar"><i style="width:' + width + '%"></i></span></div><b>' + count + '<small> тр.</small></b></div>';
    }).join("") : '<div class="empty">Пока в клубе нет сохранённых тренировок.</div>';
  }

  function profileName(item) { return item && item.nickname ? item.nickname : "Участник"; }
  function renderMemberRow(member, actionMarkup, note) {
    return '<div class="friend-row"><div class="avatar">' + escapeHtml(initials(profileName(member))) + '</div><div class="friend-info"><strong>' + escapeHtml(profileName(member)) + '</strong><small>' + escapeHtml(note || "Участник закрытого клуба") + '</small></div>' + (actionMarkup || "") + '</div>';
  }
  function renderFriends() {
    const target = byId("friends-list");
    const accepted = friends.friends || [];
    const incoming = friends.incoming || [];
    const outgoing = friends.outgoing || [];
    byId("friends-count-title").textContent = String(accepted.length);
    byId("profile-friend-count").textContent = String(accepted.length);
    let html = "";
    if (incoming.length) {
      html += '<div class="list-subheading">Заявки тебе</div>' + incoming.map(function (item) {
        return renderMemberRow(item.profile,
          '<div class="friend-actions"><button type="button" class="secondary compact-action" data-respond="' + escapeHtml(item.id) + '" data-accept="true">Принять</button><button type="button" class="delete compact-action" data-respond="' + escapeHtml(item.id) + '" data-accept="false">Отклонить</button></div>',
          "Хочет добавить тебя");
      }).join("");
    }
    if (accepted.length) {
      html += '<div class="list-subheading">Друзья</div>' + accepted.map(function (item) {
        return renderMemberRow(item,
          '<button type="button" class="secondary compact-action" data-unfriend="' + Number(item.telegramId) + '">Удалить</button>',
          item.experience ? "Стаж " + item.experience : "Участник закрытого клуба");
      }).join("");
    }
    if (outgoing.length) {
      html += '<div class="list-subheading">Заявки отправлены</div>' + outgoing.map(function (item) {
        return renderMemberRow(item.profile, '<span class="pending-tag">Ожидает ответа</span>', "Заявка отправлена");
      }).join("");
    }
    target.innerHTML = html || '<div class="empty">Пока нет друзей. Найди знакомых по никнейму выше.</div>';
    byId("profile-friend-count").textContent = String(accepted.length);
  }
  function statusFor(id) {
    if ((friends.friends || []).some(function (item) { return Number(item.telegramId) === Number(id); })) return "friend";
    if ((friends.outgoing || []).some(function (item) { return Number(item.profile.telegramId) === Number(id); })) return "pending";
    if ((friends.incoming || []).some(function (item) { return Number(item.profile.telegramId) === Number(id); })) return "incoming";
    return "none";
  }
  function renderSearchResults(members) {
    const target = byId("member-search-results");
    if (!members || !members.length) { target.innerHTML = ""; return; }
    target.innerHTML = members.map(function (member) {
      const status = statusFor(member.telegramId);
      let action = "";
      if (status === "none") action = '<button type="button" class="secondary compact-action" data-addfriend="' + Number(member.telegramId) + '">Добавить</button>';
      else if (status === "pending") action = '<span class="pending-tag">Заявка отправлена</span>';
      else if (status === "incoming") action = '<button type="button" class="secondary compact-action" data-addfriend="' + Number(member.telegramId) + '">Принять заявку</button>';
      else action = '<span class="pending-tag">Уже друзья</span>';
      return renderMemberRow(member, action, member.experience ? "Стаж " + member.experience : "Участник клуба");
    }).join("");
  }
  byId("friend-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    const query = byId("friend-nickname").value.trim();
    if (query.length < 2) { toast("Введи хотя бы 2 символа никнейма.", "error"); return; }
    try {
      const result = await callApi("search_members", { query: query });
      renderSearchResults(result.members || []);
      if (!result.members.length) toast("Никого не нашли. Проверь никнейм.");
    } catch (error) { toast(error.message, "error"); }
  });
  byId("friend-nickname").addEventListener("input", function () {
    window.clearTimeout(searchTimer);
    const query = this.value.trim();
    if (query.length < 2) { byId("member-search-results").innerHTML = ""; return; }
    searchTimer = window.setTimeout(async function () {
      try {
        const result = await callApi("search_members", { query: query });
        renderSearchResults(result.members || []);
      } catch (error) { byId("member-search-results").innerHTML = ""; }
    }, 350);
  });
  byId("friends-list").addEventListener("click", async function (event) {
    const target = event.target.closest("[data-respond],[data-unfriend]");
    if (!target) return;
    try {
      if (target.dataset.respond) {
        await callApi("respond_friend", { requestId: target.dataset.respond, accept: target.dataset.accept === "true" });
        toast(target.dataset.accept === "true" ? "Заявка принята" : "Заявка отклонена");
      } else if (target.dataset.unfriend) {
        if (!window.confirm("Удалить этого человека из друзей?")) return;
        await callApi("remove_friend", { targetId: Number(target.dataset.unfriend) });
        toast("Участник удалён из друзей");
      }
      await refreshFriends();
      const query = byId("friend-nickname").value.trim();
      if (query.length >= 2) {
        const result = await callApi("search_members", { query: query });
        renderSearchResults(result.members || []);
      }
    } catch (error) { toast(error.message, "error"); }
  });
  byId("member-search-results").addEventListener("click", async function (event) {
    const button = event.target.closest("[data-addfriend]");
    if (!button) return;
    try {
      const result = await callApi("friend_request", { targetId: Number(button.dataset.addfriend) });
      toast(result.status === "accepted" ? "Вы теперь друзья" : "Заявка отправлена");
      await refreshFriends();
      const query = byId("friend-nickname").value.trim();
      if (query.length >= 2) {
        const search = await callApi("search_members", { query: query });
        renderSearchResults(search.members || []);
      }
    } catch (error) { toast(error.message, "error"); }
  });

  function timeAgo(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Только что";
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return "Только что";
    if (seconds < 3600) return Math.floor(seconds / 60) + " мин. назад";
    if (seconds < 86400) return Math.floor(seconds / 3600) + " ч. назад";
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  }
  function renderMedia(post) {
    if (!post.mediaUrl) return "";
    const url = escapeHtml(post.mediaUrl);
    if (post.mediaType === "video") return '<div class="uploaded-media"><video controls playsinline preload="metadata" src="' + url + '"></video></div>';
    return '<div class="uploaded-media"><img loading="lazy" alt="Фото из тренировки" src="' + url + '"></div>';
  }
  function renderPost(post) {
    const author = post.author || {};
    const comments = Array.isArray(post.comments) ? post.comments : [];
    const isOwner = Number(post.authorId) === Number(currentProfile && currentProfile.telegramId);
    const canDelete = isOwner || clubRole === "owner";
    const commentsHtml = comments.map(function (comment) {
      return '<div class="comment-item"><strong>' + escapeHtml(comment.author) + '</strong> ' + escapeHtml(comment.body) + '</div>';
    }).join("");
    const workoutHtml = post.workout ? '<div class="post-workout"><div><small>Тренировка</small><strong>Запись из дневника</strong></div><b>' + escapeHtml(post.workout.summary || "") + '</b></div>' : "";
    const deleteHtml = canDelete ? '<button type="button" class="post-menu" data-action="delete" aria-label="Удалить публикацию">···</button>' : "";
    return '<article class="post-card" data-post="' + escapeHtml(post.id) + '">' +
      '<div class="post-head"><div class="avatar">' + escapeHtml(initials(author.nickname)) + '</div><div class="post-author"><strong>' + escapeHtml(author.nickname || "Участник") + '</strong><small>' + escapeHtml(timeAgo(post.createdAt)) + (isOwner ? "" : ' · <span class="friend-label">УЧАСТНИК</span>') + '</small></div>' + deleteHtml + '</div>' +
      (post.caption ? '<p class="post-caption">' + escapeHtml(post.caption) + '</p>' : "") + renderMedia(post) + workoutHtml +
      '<div class="post-actions"><button type="button" class="post-action ' + (post.liked ? "liked" : "") + '" data-action="like" aria-pressed="' + Boolean(post.liked) + '"><strong>♥</strong> <span>' + Number(post.likes || 0) + '</span></button><button type="button" class="post-action" data-action="comment"><strong>○</strong> <span>' + comments.length + ' ответов</span></button></div>' +
      '<div class="post-comments"><details><summary>Обсудить тренировку</summary><div class="comment-list">' + commentsHtml + '</div><form class="comment-form" data-post-id="' + escapeHtml(post.id) + '"><label class="visually-hidden">Комментарий<input type="text" maxlength="180" placeholder="Написать комментарий…" required /></label><button type="submit" class="secondary">Отправить</button></form></details></div>' +
      '</article>';
  }
  async function refreshFeed() {
    if (!apiReady) return;
    const result = await callApi("feed", { filter: activeFilter });
    feedPosts = result.posts || [];
    byId("feed-list").innerHTML = feedPosts.length ? feedPosts.map(renderPost).join("") : '<div class="empty">Пока нет записей. Поделись первой тренировкой.</div>';
    byId("profile-post-count").textContent = String(feedPosts.filter(function (post) { return Number(post.authorId) === Number(currentProfile.telegramId); }).length);
    updateDashboard();
  }
  document.querySelectorAll("[data-feed-filter]").forEach(function (button) {
    button.addEventListener("click", async function () {
      activeFilter = button.dataset.feedFilter;
      document.querySelectorAll("[data-feed-filter]").forEach(function (item) { item.classList.toggle("active", item === button); });
      try { await refreshFeed(); } catch (error) { toast(error.message, "error"); }
    });
  });
  byId("refresh-leaderboard").addEventListener("click", async function () {
    try { await refreshLeaderboard(); toast("Рейтинг обновлён"); }
    catch (error) { toast(error.message, "error"); }
  });
  byId("feed-list").addEventListener("click", async function (event) {
    const button = event.target.closest("[data-action]");
    const card = event.target.closest("[data-post]");
    if (!button || !card) return;
    if (button.dataset.action === "comment") {
      const details = card.querySelector("details");
      details.open = true;
      const input = card.querySelector(".comment-form input");
      if (input) input.focus();
      return;
    }
    try {
      if (button.dataset.action === "like") {
        await callApi("toggle_like", { postId: card.dataset.post });
        toast(button.classList.contains("liked") ? "Лайк убран" : "Лайк поставлен");
        await refreshFeed();
      } else if (button.dataset.action === "delete") {
        if (!window.confirm("Удалить эту публикацию?")) return;
        await callApi("delete_post", { postId: card.dataset.post });
        toast("Публикация удалена");
        await refreshFeed();
      }
    } catch (error) { toast(error.message, "error"); }
  });
  byId("feed-list").addEventListener("submit", async function (event) {
    const form = event.target.closest(".comment-form");
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector("input");
    const text = input.value.trim();
    if (!text) return;
    try {
      await callApi("comment", { postId: form.dataset.postId, body: text });
      await refreshFeed();
      const details = document.querySelector('[data-post="' + CSS.escape(form.dataset.postId) + '"] details');
      if (details) details.open = true;
      toast("Комментарий сохранён");
    } catch (error) { toast(error.message, "error"); }
  });

  fileInput.accept = "image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/webm";
  fileInput.addEventListener("change", function () {
    const file = fileInput.files && fileInput.files[0];
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = "";
    if (!file) { mediaPreview.hidden = true; mediaPreview.textContent = ""; return; }
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "video/mp4", "video/quicktime", "video/webm"];
    if (allowed.indexOf(file.type) < 0 || file.size > 25 * 1024 * 1024) {
      fileInput.value = "";
      mediaPreview.hidden = false;
      mediaPreview.textContent = "Выбери JPG, PNG, WebP, HEIC, MP4, MOV или WebM до 25 МБ.";
      toast("Формат или размер файла не поддерживается.", "error");
      return;
    }
    previewUrl = URL.createObjectURL(file);
    mediaPreview.hidden = false;
    mediaPreview.textContent = (file.type.indexOf("video/") === 0 ? "Видео" : "Фото") + " выбрано · " + file.name;
  });
  function getUploadClient() {
    if (uploadClient) return uploadClient;
    if (!window.supabase || !window.supabase.createClient) throw new Error("Не загрузился модуль для фото. Обнови страницу и попробуй снова.");
    uploadClient = window.supabase.createClient(config.supabaseUrl, config.publishableKey);
    return uploadClient;
  }
  async function uploadMedia(file) {
    const grant = await callApi("upload_url", { mimeType: file.type, size: file.size });
    const client = getUploadClient();
    const result = await client.storage.from("club-media").uploadToSignedUrl(grant.path, grant.token, file, {
      contentType: file.type,
      cacheControl: "3600"
    });
    if (result.error) throw new Error(result.error.message || "Не удалось загрузить файл.");
    return { path: grant.path, kind: grant.mediaKind };
  }
  byId("post-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    const button = event.submitter;
    const caption = byId("post-caption").value.trim();
    const file = fileInput.files && fileInput.files[0];
    if (!caption && !file) { toast("Добавь текст или выбери фото/видео.", "error"); return; }
    if (button) { button.disabled = true; button.innerHTML = "Публикуем…"; }
    try {
      let media = null;
      if (file) media = await uploadMedia(file);
      await callApi("create_post", { caption: caption, mediaPath: media ? media.path : null, mediaKind: media ? media.kind : null });
      byId("post-caption").value = "";
      fileInput.value = "";
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = "";
      mediaPreview.hidden = true;
      mediaPreview.textContent = "";
      activeFilter = "all";
      document.querySelectorAll("[data-feed-filter]").forEach(function (item) { item.classList.toggle("active", item.dataset.feedFilter === "all"); });
      toast("Публикация добавлена в ленту");
      await refreshFeed();
    } catch (error) { toast(error.message, "error"); }
    finally { if (button) { button.disabled = false; button.innerHTML = 'Опубликовать <span>↗</span>'; } }
  });

  async function refreshAfterClubChange(result, inviteCode) {
    currentClub = result.club;
    clubRole = result.role || "member";
    clubExists = true;
    byId("club-setup").hidden = true;
    byId("group-chip").innerHTML = '<span class="online-dot"></span> ' + escapeHtml(currentClub.name);
    if (inviteCode) localStorage.setItem(INVITE_KEY, inviteCode);
    apiReady = true;
    setCommunityReady();
    setInviteUi();
    await syncInitialData();
    applyProfile();
    await Promise.all([refreshFriends(), refreshFeed(), refreshLeaderboard()]);
  }
  byId("club-create-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    const code = byId("owner-bootstrap-code").value;
    const name = byId("club-name").value.trim();
    const button = event.submitter;
    if (button) button.disabled = true;
    try {
      const result = await callApi("create_club", { name: name, bootstrapCode: code });
      result.role = "owner";
      currentProfile = normalizeProfile(result.profile);
      await refreshAfterClubChange(result, result.inviteCode);
      byId("owner-bootstrap-code").value = "";
      toast("Клуб создан. Сохрани код приглашения и отправь его ребятам.");
    } catch (error) {
      byId("club-setup-status").textContent = error.message;
      toast(error.message, "error");
    } finally { if (button) button.disabled = false; }
  });
  byId("club-join-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    const inviteCode = byId("club-invite-code").value.trim();
    const button = event.submitter;
    if (button) button.disabled = true;
    try {
      const result = await callApi("join_club", { inviteCode: inviteCode });
      currentProfile = normalizeProfile(result.profile || currentProfile);
      await refreshAfterClubChange(result);
      byId("club-invite-code").value = "";
      toast("Ты вступил в клуб");
    } catch (error) {
      byId("club-setup-status").textContent = error.message;
      toast(error.message, "error");
    } finally { if (button) button.disabled = false; }
  });

  byId("invite-copy").addEventListener("click", async function () {
    if (!currentClub || clubRole !== "owner") return;
    let code = localStorage.getItem(INVITE_KEY) || "";
    try {
      if (!code) {
        const result = await callApi("rotate_invite");
        code = result.inviteCode;
        localStorage.setItem(INVITE_KEY, code);
        setInviteUi();
        toast("Создан новый код приглашения");
      }
      await navigator.clipboard.writeText(code);
      toast("Код приглашения скопирован");
    } catch (error) {
      if (error && error.name === "NotAllowedError") {
        toast("Код: " + code);
      } else {
        toast(error.message, "error");
      }
    }
  });

  function switchTab(tab) {
    if (!panels.some(function (panel) { return panel.dataset.tabPanel === tab; })) tab = "today";
    panels.forEach(function (panel) { panel.hidden = panel.dataset.tabPanel !== tab; });
    tabs.forEach(function (button) {
      const active = button.dataset.tab === tab;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (tab === "today") updateDashboard();
    if (tab === "feed" && apiReady) refreshFeed().catch(function (error) { toast(error.message, "error"); });
    if (tab === "profile" && apiReady) refreshFriends().catch(function (error) { toast(error.message, "error"); });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  tabs.forEach(function (button) { button.addEventListener("click", function () { switchTab(button.dataset.tab); }); });
  document.querySelectorAll("[data-go-tab]").forEach(function (button) { button.addEventListener("click", function () { switchTab(button.dataset.goTab); }); });
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./service-worker.js").catch(function () {});
  }

  byId("group-chip").innerHTML = '<span class="online-dot"></span> Проверяем вход…';
  applyTheme(localStorage.getItem("gym-tracker-theme") || "red");
  setInviteUi();
  start();
})();