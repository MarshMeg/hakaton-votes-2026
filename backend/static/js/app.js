// ядро приложения на клиенте: вход, сохранение прогресса, словарь, статистика и мост во Flutter
// страницы и /content.json берутся из офлайн-снимка, поэтому после первого входа всё работает без сети
//
// прогресс — одно «сохранение» на аккаунт (формат v2, см. play/api.py)
// оно лежит в localStorage (SAVE_KEY) и копируется во Flutter, чтобы пережить очистку WebView
// при синхронизации побеждает сохранение с большим полем updated
// настройки входят в сохранение, а SETTINGS_KEY — их локальный кэш
// аккаунт (AUTH_KEY) лежит отдельно
//
// синтаксис старый (var, function): приложение должно работать на Android 8
(function () {
  'use strict';

  var SAVE_VERSION = 2;
  var SAVE_KEY = 'zb.save.v2';
  var AUTH_KEY = 'zb.auth.v1';
  var SETTINGS_KEY = 'zb.settings.v1';
  var GEO_DEVICE_KEY = 'zb.geo.device'; // на этом устройстве геолокация уже разрешена
  var THEME_KEY = 'zb.theme'; // тот же ключ читает скрипт в base.html
  var OLD_STATE_KEY = 'zb.state.v1'; // журнал событий старых версий
  var BOOTED_KEY = 'zb.booted'; // sessionStorage: при запуске синхронизация уже была
  var SETTINGS_DEFAULTS = { sound: true, notifications: false, geo: false };
  var AVATARS = ['🦊', '🐻', '🐰', '🐿️', '🦔', '🐺', '🐱', '🐶', '🦉', '🐝'];

  var XP_PER_CORRECT = 10;
  var HARD_CLEARED_AFTER = 3; // столько верных ответов подряд — и слово больше не «трудное»
  var HARD_MIN = 3; // меньше трудных слов — играть в «Трудные слова» нельзя
  var HARD_SHOWN = 5; // сколько трудных слов показывает профиль
  var LEARNED_MIN_OK = 2; // «выучено» — не меньше стольких верных ответов
  var CHART_DAYS = 7;

  var MINUTE_MS = 60000;
  var DAY_MS = 86400000;
  var BRIDGE_WAIT_MS = 1500;
  var SYNC_TIMEOUT_MS = 5000;
  var KEEPALIVE_LIMIT = 60000; // fetch с keepalive не отправит тело больше 64 КБ
  var NO_NETWORK = 'Для первого входа нужен интернет';

  // ---------- утилиты ----------

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  // день по местному времени, например '2026-10-20'
  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // не вычитаем DAY_MS: при переводе часов день получился бы не тот
  function daysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    return d.getTime();
  }

  function shuffle(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function sample(list, n) { return shuffle(list).slice(0, n); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // параметр из адресной строки, например param('topic') для ?topic=numbers
  function param(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function percent(part, total) {
    return total ? Math.round(100 * part / total) : 0;
  }

  // в localStorage может не быть доступа или лежать мусор, тогда возвращаем null
  function readJSON(storage, key) {
    try {
      var raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { console.warn('read', key, e); return null; }
  }

  // null удаляет ключ
  function writeJSON(storage, key, value) {
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(value));
    } catch (e) { console.warn('write', key, e); }
  }

  // ---------- мост во Flutter ----------

  // в приложении есть window.flutter_inappwebview и слово VotesApp в User-Agent
  var inApp = !!window.flutter_inappwebview || /VotesApp/.test(navigator.userAgent);

  var Bridge = {
    // Promise<boolean>: поднялся ли мост
    // callHandler появляется не сразу, ждём не дольше BRIDGE_WAIT_MS, чтобы старт не завис
    ready: new Promise(function (resolve) {
      if (!inApp) return resolve(false);
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) return resolve(true);
      window.addEventListener('flutterInAppWebViewPlatformReady', function () { resolve(true); });
      setTimeout(function () { resolve(false); }, BRIDGE_WAIT_MS);
    }),

    available: function () {
      return !!(window.flutter_inappwebview && window.flutter_inappwebview.callHandler);
    },

    // без моста (в браузере) возвращает undefined
    call: function (name) {
      var args = Array.prototype.slice.call(arguments, 1);
      return Bridge.ready.then(function () {
        if (!Bridge.available()) return undefined;
        var h = window.flutter_inappwebview;
        return h.callHandler.apply(h, [name].concat(args));
      }).catch(function (e) { console.warn('bridge', name, e); return undefined; });
    },
  };

  // ---------- сервер ----------

  function networkError() {
    var err = new Error(NO_NETWORK);
    err.network = true;
    return err;
  }

  // у fetch нет тайм-аута, поэтому считаем долгий запрос отсутствием сети
  function withTimeout(promise, ms) {
    if (!ms) return promise;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(networkError()); }, ms);
      promise.then(
        function (v) { clearTimeout(timer); resolve(v); },
        function (e) { clearTimeout(timer); reject(e); }
      );
    });
  }

  // запрос к /api/
  // нет сети — ошибка с network, ответ не 2xx — ошибка со status и data
  function api(method, path, body, opts) {
    opts = opts || {};
    var init = { method: method, headers: {} };
    if (opts.token) init.headers.Authorization = 'Bearer ' + opts.token;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
      if (opts.keepalive && init.body.length < KEEPALIVE_LIMIT) init.keepalive = true;
    }
    var request = fetch(path, init)
      .catch(function () { throw networkError(); })
      .then(readResponse);
    return withTimeout(request, opts.timeout);
  }

  function readResponse(r) {
    return r.json().catch(function () { return {}; }).then(function (data) {
      if (r.ok) return data;
      var err = new Error(data.error || 'Ошибка сервера (' + r.status + ')');
      err.status = r.status;
      err.data = data;
      throw err;
    });
  }

  // ---------- настройки ----------

  // оставляем только известные булевы ключи, остальное берём из fallback
  // так же чистит настройки сервер (clean_settings в play/api.py)
  function cleanSettings(raw, fallback) {
    var out = {};
    raw = raw && typeof raw === 'object' ? raw : {};
    fallback = fallback || SETTINGS_DEFAULTS;
    for (var k in SETTINGS_DEFAULTS) {
      out[k] = typeof raw[k] === 'boolean' ? raw[k] : fallback[k];
    }
    return out;
  }

  var Settings = {
    values: cleanSettings(readJSON(window.localStorage, SETTINGS_KEY)),

    geoAllowed: function () { return !!readJSON(window.localStorage, GEO_DEVICE_KEY); },

    // geo=true, пришедшее с другого телефона, не должно молча запрашивать разрешение
    geoEnabled: function () { return this.values.geo && this.geoAllowed(); },

    // изменение игроком: уходит в сохранение через Save.commit
    set: function (key, value) {
      if (key === 'geo' && value) writeJSON(window.localStorage, GEO_DEVICE_KEY, true);
      this.values[key] = value;
      writeJSON(window.localStorage, SETTINGS_KEY, this.values);
      var changed = Save.data && Save.data.settings[key] !== value;
      if (!changed || !Save.commit(function (s) { s.settings[key] = value; })) notify();
    },

    // настройки из пришедшего сохранения
    // если напоминание на этом телефоне стало другим, переключаем его через мост
    apply: function (settings) {
      var prev = this.values;
      this.values = cleanSettings(settings, prev);
      writeJSON(window.localStorage, SETTINGS_KEY, this.values);
      if (this.values.notifications !== prev.notifications) {
        Bridge.call('setNotifications', this.values.notifications);
      }
    },
  };

  // ---------- аккаунт ----------

  // {username, token, synced}
  // после 401 токен стирается, а имя остаётся: так видно, что сохранение на телефоне чужое
  var Auth = {
    get: function () { return readJSON(window.localStorage, AUTH_KEY); },
    token: function () { var a = this.get(); return a && a.token; },
    set: function (auth) { writeJSON(window.localStorage, AUTH_KEY, auth); backup(); notify(); },
    patch: function (fields) {
      var a = this.get();
      if (!a) return;
      for (var k in fields) a[k] = fields[k];
      this.set(a);
    },
  };

  // ---------- сохранение ----------

  function emptySave(name, avatar) {
    return {
      v: SAVE_VERSION, updated: 0, profile: { name: name || '', avatar: avatar || '' },
      words: {}, days: {}, games: {}, settings: cleanSettings(Settings.values),
    };
  }

  // приводит сохранение (из localStorage, с сервера, из Flutter) к полному виду v2
  // чужая версия или не объект — null
  function normalizeSave(s) {
    if (!s || typeof s !== 'object' || s.v !== SAVE_VERSION) return null;
    var base = emptySave();
    base.updated = typeof s.updated === 'number' ? s.updated : 0;
    ['profile', 'words', 'days', 'games'].forEach(function (k) {
      if (s[k] && typeof s[k] === 'object') base[k] = s[k];
    });
    // в старых сохранениях настроек нет, берём то, что было на этом устройстве
    base.settings = cleanSettings(s.settings, Settings.values);
    return base;
  }

  function isNewer(save, than) {
    return !than || save.updated > than.updated;
  }

  function wordEntry(save, id) {
    save.words[id] = save.words[id] || { ok: 0, bad: 0, seen: 0, last: 0 };
    return save.words[id];
  }

  function dayEntry(save, ts) {
    var key = dayKey(ts);
    save.days[key] = save.days[key] || { ok: 0, bad: 0, seen: 0 };
    return save.days[key];
  }

  function gameEntry(save, slug) {
    save.games[slug] = save.games[slug] || { ok: 0, bad: 0, played: 0, best: 0 };
    return save.games[slug];
  }

  function hasProgress(save) {
    return !!save && (Object.keys(save.words).length > 0 || Object.keys(save.days).length > 0);
  }

  // журнал событий старой версии (zb.state.v1) → сохранение v2 активного профиля
  function fromEvents(state) {
    var profile = state.profiles && state.profiles[state.active];
    if (!profile) return null;
    var save = emptySave(profile.name, profile.avatar);
    save.updated = profile.updated || 0;
    (state.events || []).forEach(function (event) {
      if (event.p === state.active) addEvent(save, event);
    });
    return { save: save, account: profile.account || null };
  }

  // событие журнала: {w: слово, t: время, c: верно или нет, g: игра}
  // если c нет, то это просмотр карточки, а не ответ
  function addEvent(save, event) {
    save.updated = Math.max(save.updated, event.t);
    var word = wordEntry(save, event.w);
    var day = dayEntry(save, event.t);
    word.last = Math.max(word.last, event.t);
    if (event.c === null || event.c === undefined) {
      word.seen++;
      day.seen++;
      return;
    }
    var field = event.c ? 'ok' : 'bad';
    word[field]++;
    day[field]++;
    gameEntry(save, event.g)[field]++;
  }

  function migrateOldState(state) {
    // не через Settings.set: commit поднял бы updated, и прогресс из журнала проиграл бы
    if (state && state.settings && !readJSON(window.localStorage, SETTINGS_KEY)) {
      if (state.settings.geo) writeJSON(window.localStorage, GEO_DEVICE_KEY, true);
      Settings.apply(state.settings);
    }
    var old = fromEvents(state || {});
    if (!old) return;
    if (isNewer(old.save, Save.data)) Save.replace(old.save);
    if (!Auth.get() && old.account && old.account.token) {
      Auth.set({ username: old.account.username, token: old.account.token, synced: 0 });
    }
  }

  // подписчики на изменение сохранения или входа, главный из них — store.refresh()
  var listeners = [];

  function notify() { listeners.forEach(function (fn) { fn(); }); }

  // копия {save, auth} во Flutter (файл save.json), в браузере ничего не делает
  function backup() {
    Bridge.call('backup', JSON.stringify({ save: Save.data, auth: Auth.get() }));
  }

  // одновременно идёт только один PUT
  // если сохранение изменилось во время отправки, ставим pushAgain и отправляем ещё раз
  var pushing = null;
  var pushAgain = false;

  var Save = {
    data: normalizeSave(readJSON(window.localStorage, SAVE_KEY)),

    get: function () { return this.data; },

    onChange: function (fn) { listeners.push(fn); },

    // заменить сохранение целиком (при выходе передаём null)
    replace: function (save) {
      this.data = save ? normalizeSave(save) : null;
      if (this.data) Settings.apply(this.data.settings);
      writeJSON(window.localStorage, SAVE_KEY, this.data);
      backup();
      notify();
    },

    // игрок что-то закончил (игру, карточки, правку профиля):
    // меняем сохранение, пишем на телефон и сразу отправляем на сервер
    commit: function (mutator, opts) {
      if (!this.data) return null;
      mutator(this.data);
      // updated должно строго расти, по нему решают, какое сохранение новее
      // если часы телефона отстали, берём прошлое значение + 1 мс
      this.data.updated = Math.max(Date.now(), this.data.updated + 1);
      writeJSON(window.localStorage, SAVE_KEY, this.data);
      backup();
      notify();
      return this.push(opts);
    },

    // PUT /api/save, возвращает Promise<boolean>: получилось ли отправить
    // без сети сохранение остаётся на телефоне и уйдёт при следующем запуске
    push: function (opts) {
      var self = this;
      if (pushing) { pushAgain = true; return pushing; }
      var token = Auth.token();
      if (!token || !this.data) return Promise.resolve(false);
      var keepalive = opts && opts.keepalive;
      pushing = api('PUT', '/api/save', { save: this.data }, { token: token, keepalive: keepalive })
        .then(function () {
          Auth.patch({ synced: Date.now() });
          return true;
        }, pushFailed)
        .then(function (ok) {
          pushing = null;
          var again = pushAgain && self.data !== null;
          pushAgain = false;
          return again ? self.push() : ok;
        });
      return pushing;
    },
  };

  // всегда возвращает false
  function pushFailed(err) {
    if (err.status === 409 && err.data && err.data.save) {
      // на сервере другое сохранение: если оно новее, берём его, иначе отправим своё ещё раз
      if (err.data.save.updated > Save.data.updated) Save.replace(err.data.save);
      else pushAgain = true;
    } else if (err.status === 401) {
      expireAuth();
    }
    return false;
  }

  // кэш настроек и сохранение должны совпадать, сохранение главнее
  if (Save.data) Settings.apply(Save.data.settings);

  // ---------- вход и синхронизация ----------

  var Boot = { phase: 'loading', onPhase: null };

  function setPhase(phase) {
    Boot.phase = phase;
    if (Boot.onPhase) Boot.onPhase(phase);
  }

  function expireAuth() {
    var a = Auth.get();
    Auth.set(a ? { username: a.username, token: null, synced: a.synced || 0 } : null);
    setPhase('auth');
  }

  // сравнить сохранение на телефоне с серверным, новее остаётся
  function syncSave() {
    var token = Auth.token();
    if (!token) return Promise.resolve();
    return api('GET', '/api/save', undefined, { token: token, timeout: SYNC_TIMEOUT_MS })
      .then(function (data) { return adopt(data.save); })
      .catch(function (err) {
        if (err.status === 401) expireAuth();
        // нет сети или тайм-аут: продолжаем с тем, что на телефоне
      });
  }

  // серверное сохранение новее — берём его, иначе отправляем своё
  function adopt(server) {
    server = normalizeSave(server);
    if (server && isNewer(server, Save.data)) {
      Save.replace(server);
      return Promise.resolve();
    }
    return Save.push();
  }

  // копия во Flutter переживает очистку WebView, берём её, если она новее
  // в копии может лежать и старый журнал событий, его переводим в сохранение
  function restoreBackup() {
    return Bridge.call('restore').then(function (raw) {
      var copy = parseBackup(raw);
      if (!copy) return;
      if (copy.events && copy.profiles) { migrateOldState(copy); return; }
      var save = normalizeSave(copy.save);
      if (save && isNewer(save, Save.data)) Save.replace(save);
      if (copy.auth && copy.auth.token && !Auth.token()) Auth.set(copy.auth);
    });
  }

  function parseBackup(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  // запуск на каждой странице
  // сайт многостраничный: при каждом переходе страница грузится заново и boot() идёт снова
  // полный цикл нужен один раз за запуск приложения, поэтому после него ставим флаг в sessionStorage
  // фазы: loading — заставка, auth — окно входа (_auth.html), ready — можно играть
  function boot() {
    migrateOldStorage();
    var booted = readJSON(window.sessionStorage, BOOTED_KEY);
    if (booted && Auth.token() && Save.data) { setPhase('ready'); return; }
    setPhase('loading');
    restoreBackup().then(function () {
      if (!Auth.token()) { setPhase('auth'); return null; }
      return syncSave().then(finishBoot);
    }).catch(function (e) {
      console.error('boot', e);
      setPhase(Auth.token() ? 'ready' : 'auth');
    });
  }

  // старый журнал из localStorage переводим в сохранение и удаляем
  function migrateOldStorage() {
    var old = readJSON(window.localStorage, OLD_STATE_KEY);
    if (!old) return;
    migrateOldState(old);
    writeJSON(window.localStorage, OLD_STATE_KEY, null);
  }

  function finishBoot() {
    if (Boot.phase === 'auth') return;
    if (!Save.data) Save.replace(emptySave());
    enterGame();
  }

  function enterGame() {
    writeJSON(window.sessionStorage, BOOTED_KEY, true);
    setPhase('ready');
  }

  // запоминаем аккаунт, сохранение другого аккаунта выбрасываем
  function rememberAccount(data) {
    var prev = Auth.get();
    if (prev && prev.username && prev.username !== data.username) Save.replace(null);
    Auth.set({ username: data.username, token: data.token, synced: 0 });
  }

  // если на телефоне есть прогресс без аккаунта (остался от старой версии),
  // он уходит в новый аккаунт, а имя и зверёк берутся из формы
  function signup(form) {
    var auth = Auth.get();
    var keepLocal = hasProgress(Save.data) && !(auth && auth.username);
    return api('POST', '/api/signup', {
      username: form.username, password: form.password,
      name: form.name, avatar: form.avatar, updated: Date.now(),
    }).then(function (data) {
      rememberAccount(data);
      if (keepLocal) {
        Save.commit(function (s) { s.profile = { name: form.name, avatar: form.avatar }; });
      } else {
        Save.replace(data.save);
      }
      enterGame();
    });
  }

  function login(username, password) {
    return api('POST', '/api/login', { username: username, password: password })
      .then(function (data) {
        rememberAccount(data);
        // не ждём: новое серверное сохранение подставится сразу, а своё уйдёт в фоне
        adopt(data.save);
        enterGame();
      });
  }

  // сначала пробуем отправить сохранение, false — игрок передумал выходить
  function logout() {
    return Save.push().then(function (ok) {
      if (!ok && !window.confirm('Не получилось отправить прогресс на сервер. Если выйти сейчас, ' +
          'несохранённый прогресс пропадёт. Всё равно выйти?')) return false;
      Save.replace(null);
      Auth.set(null);
      writeJSON(window.sessionStorage, BOOTED_KEY, null);
      setPhase('auth');
      return true;
    });
  }

  // ---------- словарь ----------

  var contentPromise = null;

  // /content.json грузится один раз за страницу
  function loadContent() {
    if (!contentPromise) {
      contentPromise = fetch('/content.json').then(function (r) { return r.json(); }).then(prepare);
    }
    return contentPromise;
  }

  // индексы wordById, topicBySlug и topic.words, чтобы не искать слова перебором
  function prepare(c) {
    c.wordById = {};
    c.topicBySlug = {};
    c.topics.forEach(function (t) { t.words = []; c.topicBySlug[t.slug] = t; });
    c.words.forEach(function (w) {
      c.wordById[w.id] = w;
      var t = c.topicBySlug[w.topic];
      if (t) t.words.push(w);
    });
    return c;
  }

  // картинка слова: файл, цветной круг, цифра или эмодзи (в vocab/_pic.html то же самое)
  function pic(word) {
    if (!word) return '';
    if (word.img) return '<img src="' + escapeHtml(word.img) + '" alt="" class="h-full w-full object-contain">';
    if (word.color) {
      return '<span class="block h-full w-full rounded-full border-4 border-line-soft" style="background:' +
        escapeHtml(word.color) + '"></span>';
    }
    var text = word.number != null ? word.number : word.emoji;
    if (text == null || text === '') return '';
    return '<span class="flex h-full w-full items-center justify-center font-extrabold leading-none">' +
      escapeHtml(text) + '</span>';
  }

  // все признаки картинки слова: файл, цвет, цифра, эмодзи
  function picKeys(word) {
    return [word.img && 'i' + word.img, word.color && 'c' + word.color,
      word.number != null && 'n' + word.number, word.emoji && 'e' + word.emoji].filter(Boolean);
  }

  // по ключу видно, есть ли у слова картинка (пустая строка — нет)
  function picKey(word) {
    return picKeys(word)[0] || '';
  }

  // у «узы» (земляника) есть только 🍓, а у «боры» (клубника) фото и тот же 🍓
  // ребёнок их не различит, поэтому сравниваем все признаки, а не только показанный
  function samePic(a, b) {
    var keysB = picKeys(b);
    return picKeys(a).some(function (key) { return keysB.indexOf(key) >= 0; });
  }

  // озвучка слова по кнопке работает всегда, настройка «Звук» гасит только звуки ответов
  function playAudio(word) {
    if (!word || !word.audio) return;
    try { new Audio(word.audio).play(); } catch (e) { /* без звука */ }
  }

  // ---------- тема ----------

  // 'system' (как в телефоне), 'light' или 'dark'
  // хранится на устройстве, а не в сохранении: у каждого телефона своя система
  var Theme = {
    get: function () {
      var t = null;
      try { t = window.localStorage.getItem(THEME_KEY); } catch (e) { /* нет хранилища */ }
      return t === 'light' || t === 'dark' ? t : 'system';
    },

    set: function (theme) {
      try {
        if (theme === 'system') window.localStorage.removeItem(THEME_KEY);
        else window.localStorage.setItem(THEME_KEY, theme);
      } catch (e) { /* выбор живёт до перезагрузки */ }
      if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
      else delete document.documentElement.dataset.theme;
      notify();
    },
  };

  // ---------- прогресс ----------

  // итоги игры: answers — [{w: id слова, ok: true или false}], stars — от 1 до 3
  function addGame(save, slug, answers, stars) {
    var now = Date.now();
    var day = dayEntry(save, now);
    var game = gameEntry(save, slug);
    answers.forEach(function (answer) {
      var word = wordEntry(save, answer.w);
      var field = answer.ok ? 'ok' : 'bad';
      word[field]++;
      day[field]++;
      game[field]++;
      word.streak = answer.ok ? (word.streak || 0) + 1 : 0;
      word.last = now;
    });
    game.played++;
    game.best = Math.max(game.best || 0, stars);
  }

  // трудное: были ошибки, а серия верных ответов после них ещё короткая
  // в старых сохранениях streak нет, считаем его нулём
  function isHard(w) {
    return w.bad > 0 && (w.streak || 0) < HARD_CLEARED_AFTER;
  }

  // выученное слово не может быть трудным, иначе оно попало бы в оба списка
  function isLearned(w) {
    return w.ok >= LEARNED_MIN_OK && w.ok > w.bad && !isHard(w);
  }

  // трудные слова: сначала те, где больше ошибок
  // возвращает [{word, ok, bad, streak}]
  function hardWords(save, content) {
    if (!save || !content) return [];
    var byWord = save.words;
    return Object.keys(byWord)
      .filter(function (id) {
        return isHard(byWord[id]) && content.wordById[id];
      })
      .sort(function (a, b) {
        return byWord[b].bad - byWord[a].bad || (byWord[a].streak || 0) - (byWord[b].streak || 0);
      })
      .map(function (id) {
        var w = byWord[id];
        return { word: content.wordById[id], ok: w.ok, bad: w.bad, streak: w.streak || 0 };
      });
  }

  function addViews(save, ids) {
    var now = Date.now();
    var day = dayEntry(save, now);
    ids.forEach(function (id) {
      var word = wordEntry(save, id);
      word.seen++;
      word.last = now;
      day.seen++;
    });
  }

  // карточки темы: просмотры копятся на странице
  // в сохранение они уходят одним действием при выходе со страницы или по кнопке «Готово»
  function cardViews() {
    return {
      seenIds: {},
      pending: [],

      init: function () {
        var self = this;
        window.addEventListener('pagehide', function () { self.flush(true); });
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') self.flush(true);
        });
      },

      // одну карточку за визит считаем один раз
      see: function (id) {
        if (this.seenIds[id]) return;
        this.seenIds[id] = true;
        this.pending.push(id);
      },

      // та же проверка, что в статистике, чтобы галочка совпадала со счётчиком
      learned: function (id) {
        var w = this.$store.app.stats.byWord[id];
        return !!w && isLearned(w);
      },

      flush: function (keepalive) {
        if (!this.pending.length) return Promise.resolve(false);
        var ids = this.pending;
        this.pending = [];
        return Save.commit(function (s) { addViews(s, ids); }, { keepalive: keepalive }) || Promise.resolve(false);
      },

      done: function (url) {
        this.flush(true);
        window.location.href = url;
      },
    };
  }

  // ---------- статистика ----------

  // вся статистика для шаблонов ($store.app.stats), считается заново из сохранения
  // content может быть null, пока словарь грузится
  function computeStats(save, content) {
    save = save || emptySave();
    var byWord = save.words;
    var days = save.days;
    var ok = 0;
    var bad = 0;
    var learned = 0;
    Object.keys(byWord).forEach(function (id) {
      ok += byWord[id].ok || 0;
      bad += byWord[id].bad || 0;
      // слово могли удалить из словаря, тогда оно не считается выученным
      if (isLearned(byWord[id]) && (!content || content.wordById[id])) learned++;
    });
    var hard = hardWords(save, content);
    var daily = dailyChart(days);

    return {
      xp: ok * XP_PER_CORRECT,
      streak: dayStreak(days),
      answers: ok + bad,
      accuracy: percent(ok, ok + bad),
      activeDays: Object.keys(days).filter(function (key) { return isStudyDay(days[key]); }).length,
      learned: learned,
      totalWords: content ? content.words.length : 0,
      hard: hard.slice(0, HARD_SHOWN),
      hardCount: hard.length,
      hardPlayable: hard.length >= HARD_MIN,
      daily: daily,
      maxDay: chartMax(daily),
      topics: content ? topicProgress(content, byWord) : [],
      byWord: byWord,
    };
  }

  // день занятий — день, когда был хотя бы один верный ответ в игре
  // просмотр карточек не считается, иначе одна открытая карточка продлевала бы серию
  function isStudyDay(day) {
    return !!day && day.ok > 0;
  }

  // серия дней считается от сегодня, а если сегодня ещё не играли — от вчера
  function dayStreak(days) {
    var streak = 0;
    var i = isStudyDay(days[dayKey(daysAgo(0))]) ? 0 : 1;
    while (isStudyDay(days[dayKey(daysAgo(i))])) {
      streak++;
      i++;
    }
    return streak;
  }

  // столбики графика от самого старого дня к сегодняшнему, подпись — дата дд.мм
  function dailyChart(days) {
    var chart = [];
    for (var i = CHART_DAYS - 1; i >= 0; i--) {
      var key = dayKey(daysAgo(i));
      var day = days[key] || { ok: 0, bad: 0, seen: 0 };
      chart.push({ key: key, label: key.slice(8, 10) + '.' + key.slice(5, 7), ok: day.ok, bad: day.bad, seen: day.seen });
    }
    return chart;
  }

  // минимум 1, чтобы не делить на ноль, пока ответов нет
  function chartMax(chart) {
    return Math.max.apply(null, chart.map(function (d) { return d.ok + d.bad; }).concat([1]));
  }

  // по каждой теме: сколько слов выучено и сколько уже встречалось
  function topicProgress(content, byWord) {
    return content.topics.map(function (topic) {
      var learned = topic.words.filter(function (w) { return byWord[w.id] && isLearned(byWord[w.id]); });
      var seen = topic.words.filter(function (w) {
        var s = byWord[w.id];
        return s && (s.seen || s.ok || s.bad);
      });
      var total = topic.words.length;
      return {
        slug: topic.slug, title: topic.title, icon: topic.icon, total: total,
        learned: learned.length,
        percent: percent(learned.length, total),
        seen: seen.length,
        seenPercent: percent(seen.length, total),
      };
    });
  }

  var KNUTH_HASH = 2654435761;

  // слово дня: весь день одно и то же
  function wordOfDay(content) {
    var pool = content.words.filter(function (w) {
      var t = content.topicBySlug[w.topic];
      return t && t.kind !== 'phrases';
    });
    if (!pool.length) return null;
    // номер дня по местному времени, чтобы слово менялось в полночь
    // умножение на хэш Кнута перемешивает слова, чтобы они шли не подряд
    // >>> 0 делает число неотрицательным
    var now = new Date();
    var day = Math.floor((now.getTime() - now.getTimezoneOffset() * MINUTE_MS) / DAY_MS);
    return pool[((day * KNUTH_HASH) >>> 0) % pool.length];
  }

  // ---------- звуки ----------

  var audioCtx = null;

  // ноты каждого звука (частоты в Гц)
  var NOTES = { ok: [660, 880], bad: [220, 165], win: [523, 659, 784, 1046], flip: [440] };
  var DEFAULT_NOTES = [440];
  var NOTE_STEP = 0.12; // шаг между нотами, секунды
  var NOTE_ATTACK = 0.02;
  var NOTE_FADE = 0.25;
  var NOTE_STOP = 0.3;
  var NOTE_VOLUME = 0.25;
  var SILENCE = 0.0001; // exponentialRamp не умеет идти от нуля

  // короткие звуки делаем через Web Audio, файлы не нужны
  var Sound = {
    play: function (kind) {
      if (!Settings.values.sound) return;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = audioCtx || new AC();
        var wave = kind === 'bad' ? 'triangle' : 'sine';
        (NOTES[kind] || DEFAULT_NOTES).forEach(function (freq, i) {
          playNote(freq, wave, audioCtx.currentTime + i * NOTE_STEP);
        });
      } catch (e) { /* звук не обязателен */ }
    },
  };

  function playNote(freq, wave, start) {
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.type = wave;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(SILENCE, start);
    gain.gain.exponentialRampToValueAtTime(NOTE_VOLUME, start + NOTE_ATTACK);
    gain.gain.exponentialRampToValueAtTime(SILENCE, start + NOTE_FADE);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + NOTE_STOP);
  }

  // ---------- геолокация ----------

  var IZHEVSK = { lat: 56.8526, lon: 53.2045 };
  var EARTH_RADIUS_KM = 6371;
  var GEO_TIMEOUT_MS = 10000;
  var GEO_MAX_AGE_MS = 3600000; // место часовой давности тоже подходит

  // расстояние по прямой в км (формула гаверсинусов)
  function distanceKm(a, b) {
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLon = (b.lon - a.lon) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return Math.round(EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
  }

  // сначала спрашиваем Flutter, если не вышло — браузер
  // null — место узнать не удалось
  function locate() {
    return Bridge.call('location').then(function (pos) {
      if (pos && pos.lat != null) return pos;
      if (!navigator.geolocation) return null;
      return new Promise(function (resolve) {
        navigator.geolocation.getCurrentPosition(
          function (p) { resolve({ lat: p.coords.latitude, lon: p.coords.longitude }); },
          function () { resolve(null); },
          { timeout: GEO_TIMEOUT_MS, maximumAge: GEO_MAX_AGE_MS }
        );
      });
    });
  }

  // ---------- Alpine ----------

  // name и avatar — что показываем (без имени берём логин, без зверька первого из списка)
  // ownName и ownAvatar — что сохранено, они нужны для формы правки
  function shownProfile(p, account) {
    var name = (p.name || '').trim();
    return {
      name: name || (account ? account.username : ''),
      avatar: p.avatar || AVATARS[0],
      ownName: name,
      ownAvatar: p.avatar || '',
    };
  }

  // geo действует, только если разрешена на этом устройстве
  function shownSettings() {
    return Object.assign({}, Settings.values, { geo: Settings.geoEnabled() });
  }

  document.addEventListener('alpine:init', function () {
    var Alpine = window.Alpine;
    Alpine.store('app', {
      phase: 'loading', // loading — заставка, auth — окно входа, ready — игра
      profile: null,
      account: null,
      settings: shownSettings(),
      theme: Theme.get(),
      stats: computeStats(null, null),
      content: null,

      // пересобирает всё, что показывают шаблоны
      // пока фаза не ready, profile пустой, чтобы шапка не мелькала за окном входа
      refresh: function () {
        var save = Save.data;
        var auth = Auth.get();
        this.account = auth && auth.token ? { username: auth.username, synced: auth.synced || 0 } : null;
        this.profile = save && Boot.phase === 'ready' ? shownProfile(save.profile, this.account) : null;
        this.settings = shownSettings();
        this.theme = Theme.get();
        this.stats = computeStats(save, this.content);
      },
    });

    var store = Alpine.store('app');
    Save.onChange(function () { store.refresh(); });
    Boot.onPhase = function (phase) { store.phase = phase; store.refresh(); };
    boot();
    store.phase = Boot.phase;
    store.refresh();
    loadContent().then(function (c) {
      store.content = c;
      store.refresh();
    }).catch(function (e) { console.error('content', e); });
  });

  // всё, что нужно шаблонам и games.js
  window.ZB = {
    Save: Save, Settings: Settings, Theme: Theme, Bridge: Bridge, Sound: Sound,
    loadContent: loadContent, wordOfDay: wordOfDay,
    addGame: addGame, cardViews: cardViews, hardWords: hardWords,
    HARD_MIN: HARD_MIN, XP_PER_CORRECT: XP_PER_CORRECT,
    pic: pic, picKey: picKey, samePic: samePic, playAudio: playAudio,
    signup: signup, login: login, logout: logout,
    locate: locate, distanceKm: distanceKm, IZHEVSK: IZHEVSK,
    shuffle: shuffle, sample: sample, param: param,
    AVATARS: AVATARS,
  };
})();
