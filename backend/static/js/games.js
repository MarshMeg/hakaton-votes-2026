// шесть игр и режим «Трудные слова»
// каждая игра — Alpine-компонент, раунды строятся из словаря прямо на телефоне
// ответы копятся в this.answers и попадают в сохранение один раз, в finish()
// если игру бросить, прогресс не изменится
(function () {
  'use strict';

  var ZB = window.ZB;

  var ROUNDS = 8;
  var WRONG_OPTIONS = 3; // неверных вариантов рядом с верным
  var RECENT_MAX = 4; // столько последних слов не повторяются
  var AUTO_NEXT_MS = 900; // пауза после верного ответа
  var THREE_STARS = 0.9; // доля верных ответов для трёх звёзд
  var TWO_STARS = 0.6; // и для двух

  function randomItem(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  // для сравнения слов: без пробелов по краям и без учёта регистра
  function normalize(text) {
    return String(text || '').trim().toLowerCase();
  }

  // общая часть всех игр: словарь, тема, счёт, звёзды, итоги
  // игра = base(slug, extra), поля из extra перекрывают общие
  // у каждой игры обязательно только newRound(), он готовит раунд
  // цикл: start → newRound → answer → next → ... → finish
  function base(slug, extra) {
    var game = {
      slug: slug,
      loading: true,
      content: null,
      topic: ZB.param('topic'),
      rounds: ROUNDS,
      round: 0,
      score: 0,
      maxScore: ROUNDS,
      done: false,
      empty: false, // играть не во что (в «Трудных словах» мало слов)
      answers: [], // [{w: id слова, ok}]
      feedback: null, // 'ok' | 'bad' | null
      message: '',

      init: function () {
        var self = this;
        ZB.loadContent().then(function (c) {
          self.content = c;
          if (self.topic && !c.topicBySlug[self.topic]) self.topic = '';
          self.loading = false;
          self.start();
        });
      },

      setTopic: function (slug) {
        this.topic = slug;
        var url = slug ? '?topic=' + encodeURIComponent(slug) : window.location.pathname;
        window.history.replaceState(null, '', url);
        this.start();
      },

      start: function () {
        this.reset();
        this.newRound();
      },

      // счёт и ответы с нуля
      reset: function () {
        this.round = 0;
        this.score = 0;
        this.maxScore = this.rounds;
        this.done = false;
        this.answers = [];
        this.feedback = null;
        this.message = '';
      },

      // слова выбранной темы (или все), можно отфильтровать
      pool: function (filter) {
        var c = this.content;
        var words = this.topic ? c.topicBySlug[this.topic].words : c.words;
        return filter ? words.filter(filter) : words.slice();
      },

      topicOf: function (word) { return this.content.topicBySlug[word.topic]; },

      // случайное слово, которого не было в последних раундах
      // помним не больше половины пула, иначе в маленькой теме не из чего выбирать
      recent: [],
      pickFresh: function (pool) {
        var recent = this.recent;
        var fresh = pool.filter(function (w) { return recent.indexOf(w.id) < 0; });
        var word = randomItem(fresh.length ? fresh : pool);
        var remember = Math.min(RECENT_MAX, Math.floor(pool.length / 2));
        this.recent = [word.id].concat(recent).slice(0, remember);
        return word;
      },

      // неверные варианты: другие слова, не синонимы правильного
      // иначе среди вариантов было бы второе верное слово
      distractors: function (target, n, field) {
        var used = {};
        used[normalize(target[field])] = true;
        // до n случайных слов из list с новым текстом
        var pick = function (list) {
          var out = [];
          ZB.shuffle(list).forEach(function (w) {
            var key = normalize(w[field]);
            if (out.length >= n || used[key] || isSynonym(w, target)) return;
            used[key] = true;
            out.push(w);
          });
          return out;
        };
        // сначала из той же темы, так сложнее угадать, не хватит — берём из всех
        var picked = pick(this.topicOf(target).words);
        if (picked.length < n) {
          picked = picked.concat(pick(this.content.words).slice(0, n - picked.length));
        }
        return picked;
      },

      // только запомнить ответ, без счёта и звука
      log: function (word, ok) { this.answers.push({ w: word.id, ok: ok }); },

      answer: function (word, ok) {
        this.log(word, ok);
        if (ok) this.score++;
        this.feedback = ok ? 'ok' : 'bad';
        ZB.Sound.play(ok ? 'ok' : 'bad');
      },

      next: function () {
        this.feedback = null;
        this.message = '';
        this.round++;
        if (this.round >= this.rounds) this.finish();
        else this.newRound();
      },

      // после верного ответа идём дальше сами, после ошибки ждём кнопку
      autoNext: function () {
        var self = this;
        var round = this.round;
        // если игрок сам нажал «Дальше», второй раз не переключаем
        setTimeout(function () {
          if (self.round === round && self.feedback === 'ok') self.next();
        }, AUTO_NEXT_MS);
      },

      finish: function () {
        var slug = this.slug;
        var answers = this.answers;
        var stars = this.stars();
        this.done = true;
        ZB.Save.commit(function (s) { ZB.addGame(s, slug, answers, stars); });
        ZB.Sound.play('win');
      },

      // от 90% верных — три звезды, от 60% — две, иначе одна
      stars: function () {
        var share = this.maxScore ? this.score / this.maxScore : 0;
        if (share >= THREE_STARS) return 3;
        if (share >= TWO_STARS) return 2;
        return 1;
      },

      progress: function () {
        return Math.round(100 * this.round / this.rounds);
      },

      pic: ZB.pic,
      hasPic: function (w) { return !!ZB.picKey(w); },
      speak: ZB.playAudio,
    };
    Object.keys(extra).forEach(function (k) { game[k] = extra[k]; });
    return game;
  }

  // синонимы: «чырткем» и «салам» оба значат «привет»
  function isSynonym(word, target) {
    return normalize(word.ru) === normalize(target.ru) || normalize(word.udm) === normalize(target.udm);
  }

  // ---------- «Выбери перевод» ----------

  // механика «Выбери перевод», её же берёт «Трудные слова»
  function chooseRounds() {
    return {
      target: null,
      options: [],
      chosen: null,
      reverse: false, // false: удм → рус; true: картинка/рус → удм

      newRound: function () {
        var pool = this.pool();
        this.target = this.pickFresh(pool);
        this.reverse = this.round % 2 === 1;
        var field = this.reverse ? 'udm' : 'ru';
        this.options = ZB.shuffle([this.target].concat(this.distractors(this.target, WRONG_OPTIONS, field)));
        this.chosen = null;
        ZB.playAudio(this.reverse ? null : this.target);
      },

      pick: function (opt) {
        if (this.feedback) return;
        this.chosen = opt.id;
        // вариант с таким же текстом тоже верный (синонимы)
        var ok = opt.id === this.target.id || this.optionText(opt) === this.optionText(this.target);
        this.answer(this.target, ok);
        if (ok) this.autoNext();
        else this.message = this.target.udm + ' — ' + this.target.ru;
      },

      optionText: function (opt) { return this.reverse ? opt.udm : opt.ru; },
    };
  }

  function choose() {
    return base('choose', chooseRounds());
  }

  // ---------- «Трудные слова» ----------

  var HARD_MAX = 10; // берём самые трудные
  var HARD_REPEATS = 2; // каждое слово примерно по два раза

  // очередь слов на rounds раундов, одно слово не идёт два раза подряд
  function wordQueue(words, rounds) {
    var queue = [];
    while (queue.length < rounds) {
      var lap = ZB.shuffle(words);
      if (queue.length && lap[0] === queue[queue.length - 1]) lap.push(lap.shift());
      queue = queue.concat(lap);
    }
    return queue;
  }

  // {id: true}, чтобы быстро проверять, есть ли слово
  function idSet(ids) {
    var set = {};
    ids.forEach(function (id) { set[id] = true; });
    return set;
  }

  // «Выбери перевод», но слова — те, в которых ребёнок ошибался
  function hard() {
    // запоминаем start и finish от choose, чтобы вызвать их из своих версий
    var game = base('hard', chooseRounds());
    var extra = {
      hardList: [], // [{word, ok, bad, streak}]
      hardLeft: 0, // сколько трудных слов всего
      cleared: 0, // сколько слов перестали быть трудными

      start: function () {
        var all = ZB.hardWords(ZB.Save.get(), this.content);
        this.hardLeft = all.length;
        this.hardList = all.slice(0, HARD_MAX);
        this.empty = all.length < ZB.HARD_MIN;
        this.cleared = 0;
        this.rounds = Math.min(ROUNDS, this.hardList.length * HARD_REPEATS);
        if (this.empty) {
          this.round = 0;
          this.done = false;
          this.feedback = null;
          return;
        }
        var words = this.hardList.map(function (h) { return h.word; });
        this.queue = wordQueue(words, this.rounds);
        chooseStart.call(this);
      },

      queue: [],
      // слово берём из очереди, а не случайное
      pickFresh: function () { return this.queue[this.round]; },

      // после записи игры смотрим, какие слова вышли из списка трудных
      finish: function () {
        chooseFinish.call(this);
        var stillHard = idSet(ZB.hardWords(ZB.Save.get(), this.content).map(function (h) { return h.word.id; }));
        var answered = idSet(this.answers.map(function (a) { return a.w; }));
        this.cleared = this.hardList.filter(function (h) {
          return answered[h.word.id] && !stillHard[h.word.id];
        }).length;
      },
    };
    var chooseStart = game.start;
    var chooseFinish = game.finish;
    Object.keys(extra).forEach(function (k) { game[k] = extra[k]; });
    var init = game.init;
    game.init = function () {
      var self = this;
      init.call(this);
      // сохранение могло прийти с сервера уже после открытия страницы
      ZB.Save.onChange(function () { if (self.empty && self.content) self.start(); });
    };
    return game;
  }

  // ---------- «Найди лишнее» ----------

  var ODD_SAME = 3; // слов из основной темы рядом с одним «лишним»

  // темы без фраз и с достаточным числом слов
  function oddTopics(content) {
    return content.topics.filter(function (t) { return t.kind !== 'phrases' && t.words.length >= ODD_SAME; });
  }

  function odd() {
    return base('odd', {
      words: [],
      oddWord: null,
      mainTopic: null,
      chosen: null,
      showPics: false,

      newRound: function () {
        var topics = oddTopics(this.content);
        // лишнее слово берём из другого семейства тем, иначе ответ спорный (овощи среди еды)
        var main = randomItem(topics);
        var other = randomItem(topics.filter(function (t) { return t.family !== main.family; }));
        this.mainTopic = main;
        this.oddWord = ZB.sample(other.words, 1)[0];
        this.words = ZB.shuffle(ZB.sample(main.words, ODD_SAME).concat([this.oddWord]));
        this.chosen = null;
        this.showPics = false;
      },

      pick: function (w) {
        if (this.feedback) return;
        this.chosen = w.id;
        var ok = w.id === this.oddWord.id;
        this.answer(this.oddWord, ok);
        this.showPics = true;
        this.message = '«' + this.oddWord.udm + '» — ' + this.oddWord.ru + ', это из темы «' +
          this.topicOf(this.oddWord).title + '». Остальные слова — «' + this.mainTopic.title + '».';
      },
    });
  }

  // ---------- «Сортировка» ----------

  var SORT_ROUNDS = 3;
  var NEXT_SET_MS = 700; // пауза после последнего слова набора
  var SHAKE_MS = 500; // слово трясётся, если положили не туда
  var DRAG_MIN_PX = 8; // сдвиг меньше этого считается нажатием

  // у корзинки может быть несколько тем
  function groupWords(content, group) {
    var words = [];
    group.topics.forEach(function (slug) { words = words.concat(content.topicBySlug[slug].words); });
    return words;
  }

  // наборы, где в каждой корзинке есть хотя бы одно слово
  function playableSets(content) {
    return content.sorting.filter(function (set) {
      return set.groups.every(function (g) {
        return g.topics.some(function (slug) {
          return content.topicBySlug[slug] && content.topicBySlug[slug].words.length;
        });
      });
    });
  }

  // count случайных слов, сначала ещё не бывшие в партии
  function pickUnused(words, count, used) {
    var unused = words.filter(function (w) { return !used[w.id]; });
    var picked = ZB.sample(unused, count);
    if (picked.length < count) {
      var rest = words.filter(function (w) { return picked.indexOf(w) < 0; });
      picked = picked.concat(ZB.sample(rest, count - picked.length));
    }
    return picked;
  }

  // элемент под пальцем, само слово на миг прячем, иначе elementFromPoint вернёт его
  function elementUnder(ev) {
    var el = ev.target;
    var prev = el.style.visibility;
    el.style.visibility = 'hidden';
    var under = document.elementFromPoint(ev.clientX, ev.clientY);
    el.style.visibility = prev;
    return under;
  }

  function sort() {
    return base('sort', {
      rounds: SORT_ROUNDS,
      set: null,
      groups: [],
      items: [],
      selected: null,
      shake: null,
      drag: null,
      // все поля объявляем заранее, иначе Alpine запишет их в x-data на <body>
      usedSets: [], // наборы, уже бывшие в партии
      usedWords: {}, // слова, уже бывшие в партии

      // число слов зависит от набора, поэтому maxScore копится в newRound
      start: function () {
        this.reset();
        this.maxScore = 0;
        this.usedSets = [];
        this.usedWords = {};
        this.newRound();
      },

      newRound: function () {
        var c = this.content;
        var self = this;
        this.set = this.pickSet(playableSets(c));
        // слов на корзинку столько, чтобы всё влезло на экран
        var perGroup = this.set.groups.length > 2 ? 2 : 3;
        var items = [];
        this.groups = this.set.groups.map(function (g, gi) {
          pickUnused(groupWords(c, g), perGroup, self.usedWords).forEach(function (w) {
            self.usedWords[w.id] = true;
            items.push({ word: w, group: gi, placed: false, tried: false });
          });
          return { label: g.label, icon: g.icon || '', placed: [] };
        });
        this.items = ZB.shuffle(items);
        this.maxScore += items.length;
        this.selected = null;
      },

      // набор не повторяется, пока не сыграны все остальные
      pickSet: function (sets) {
        var used = this.usedSets;
        var fresh = sets.filter(function (s) { return used.indexOf(s.title) < 0; });
        if (!fresh.length) { this.usedSets = []; fresh = sets; }
        var set = randomItem(fresh);
        this.usedSets.push(set.title);
        return set;
      },

      remaining: function () { return this.items.filter(function (i) { return !i.placed; }); },

      drop: function (item, groupIndex) {
        if (!item || item.placed) return;
        var ok = item.group === groupIndex;
        // слово лежит на поле, пока не положат верно, но в счёт идёт только первая попытка
        if (!item.tried) {
          this.log(item.word, ok);
          if (ok) this.score++;
        }
        item.tried = true;
        this.selected = null;
        if (ok) this.place(item, groupIndex);
        else this.reject(item);
      },

      // слово легло в свою корзинку, разложены все — следующий набор
      place: function (item, groupIndex) {
        var self = this;
        item.placed = true;
        this.groups[groupIndex].placed.push(item.word);
        ZB.Sound.play('ok');
        if (!this.remaining().length) setTimeout(function () { self.next(); }, NEXT_SET_MS);
      },

      // не та корзинка: слово трясётся и остаётся на поле
      reject: function (item) {
        var self = this;
        ZB.Sound.play('bad');
        this.shake = item.word.id;
        setTimeout(function () { self.shake = null; }, SHAKE_MS);
      },

      // можно перетащить слово или нажать слово, а потом корзинку
      dragStart: function (ev, item) {
        this.drag = { item: item, x0: ev.clientX, y0: ev.clientY, dx: 0, dy: 0, moved: false };
        try { ev.target.setPointerCapture(ev.pointerId); } catch (e) { /* старый WebView */ }
      },

      dragMove: function (ev) {
        if (!this.drag) return;
        this.drag.dx = ev.clientX - this.drag.x0;
        this.drag.dy = ev.clientY - this.drag.y0;
        if (Math.abs(this.drag.dx) + Math.abs(this.drag.dy) > DRAG_MIN_PX) this.drag.moved = true;
      },

      dragEnd: function (ev) {
        var drag = this.drag;
        if (!drag) return;
        this.drag = null;
        if (!drag.moved) {
          this.selected = this.selected === drag.item ? null : drag.item;
          return;
        }
        var under = elementUnder(ev);
        var bucket = under && under.closest('[data-bucket]');
        if (bucket) this.drop(drag.item, Number(bucket.getAttribute('data-bucket')));
      },

      dragStyle: function (item) {
        if (!this.drag || this.drag.item !== item) return '';
        return 'transform: translate(' + this.drag.dx + 'px,' + this.drag.dy + 'px) scale(1.08); z-index: 30; position: relative;';
      },

      tapBucket: function (gi) { if (this.selected) this.drop(this.selected, gi); },

      progress: function () {
        var total = this.items.length || 1;
        var done = this.items.filter(function (i) { return i.placed; }).length;
        return Math.round(100 * (this.round + done / total) / this.rounds);
      },
    });
  }

  // ---------- «Найди пару» (Memory) ----------

  var MEMORY_PAIRS = 6;
  var MEMORY_MIN_PAIRS = 3; // в теме меньше пар — берём слова из всего словаря
  var FLIP_BACK_MS = 900; // столько видны две несовпавшие карточки
  var MEMORY_FINISH_MS = 600;

  // два слова с одним переводом дали бы неразличимые пары
  function uniqueByTranslation(words) {
    var seenRu = {};
    return words.filter(function (w) {
      if (seenRu[w.ru]) return false;
      seenRu[w.ru] = true;
      return true;
    });
  }

  // две карточки на слово: удмуртское слово и картинка
  // если картинки нет или она уже была, вместо неё перевод
  // uid нужен для x-for
  function pairCards(words) {
    var seenPic = {};
    var cards = [];
    words.forEach(function (w) {
      var key = ZB.picKey(w);
      var usePic = key && !seenPic[key];
      if (usePic) seenPic[key] = true;
      cards.push({ uid: w.id + 'u', word: w, side: 'udm', flipped: false, matched: false });
      cards.push({ uid: w.id + 'p', word: w, side: usePic ? 'pic' : 'ru', flipped: false, matched: false });
    });
    return cards;
  }

  function memory() {
    return base('memory', {
      rounds: 1,
      cards: [],
      open: [],
      moves: 0,
      pairs: 0,
      busy: false,

      newRound: function () {
        var words = uniqueByTranslation(ZB.shuffle(this.pool()));
        if (words.length < MEMORY_MIN_PAIRS) words = ZB.shuffle(this.content.words);
        words = words.slice(0, MEMORY_PAIRS);
        this.cards = ZB.shuffle(pairCards(words));
        this.pairs = words.length;
        this.maxScore = words.length;
        this.moves = 0;
        this.open = [];
      },

      // открыты две карточки: одно слово — пара, иначе закрываем обе
      // busy не даёт открыть третью, пока две видны
      flip: function (card) {
        if (this.busy || card.flipped || card.matched) return;
        card.flipped = true;
        ZB.Sound.play('flip');
        this.open.push(card);
        if (this.open.length < 2) return;
        this.moves++;
        var a = this.open[0];
        var b = this.open[1];
        this.open = [];
        if (a.word.id === b.word.id) this.match(a, b);
        else this.flipBack(a, b);
      },

      // после последней пары через паузу показываем итоги
      match: function (a, b) {
        var self = this;
        a.matched = b.matched = true;
        this.log(a.word, true);
        ZB.Sound.play('ok');
        this.score++;
        ZB.playAudio(a.word);
        if (this.cards.every(function (c) { return c.matched; })) {
          setTimeout(function () {
            // игру могли начать заново за время паузы
            if (self.cards.every(function (c) { return c.matched; })) self.finish();
          }, MEMORY_FINISH_MS);
        }
      },

      flipBack: function (a, b) {
        var self = this;
        this.busy = true;
        setTimeout(function () {
          a.flipped = b.flipped = false;
          self.busy = false;
        }, FLIP_BACK_MS);
      },

      // звёзды за число ходов, идеально — один ход на пару
      stars: function () {
        if (this.moves <= this.pairs + 2) return 3;
        if (this.moves <= this.pairs * 2) return 2;
        return 1;
      },

      progress: function () { return Math.round(100 * this.score / (this.pairs || 1)); },
    });
  }

  // ---------- «Собери слово» ----------

  // одно слово без пробелов, дефисов и знаков, от 2 до 10 букв
  var SINGLE_WORD = /^[^\s\-.,!?…]{2,10}$/;
  var SHUFFLE_TRIES = 5;

  // если буквы случайно остались по порядку, мешаем заново
  function scramble(chars) {
    var mixed = ZB.shuffle(chars);
    for (var i = 0; i < SHUFFLE_TRIES && mixed.join('') === chars.join('') && chars.length > 1; i++) {
      mixed = ZB.shuffle(chars);
    }
    return mixed;
  }

  function assemble() {
    return base('assemble', {
      target: null,
      letters: [],
      picked: [],

      newRound: function () {
        var self = this;
        var fits = function (w) { return self.topicOf(w).kind !== 'phrases' && SINGLE_WORD.test(w.udm); };
        var pool = this.pool(fits);
        if (!pool.length) pool = this.content.words.filter(fits);
        this.target = this.pickFresh(pool);
        var chars = Array.from(this.target.udm.toLowerCase());
        // idx нужен, чтобы одинаковые буквы были разными плитками
        this.letters = scramble(chars).map(function (ch, idx) { return { ch: ch, idx: idx, used: false }; });
        this.picked = [];
      },

      take: function (tile) {
        if (this.feedback || tile.used) return;
        tile.used = true;
        this.picked.push(tile);
        ZB.Sound.play('flip');
        if (this.picked.length === this.letters.length) this.check();
      },

      giveBack: function (pos) {
        if (this.feedback) return;
        var tile = this.picked.splice(pos, 1)[0];
        if (tile) tile.used = false;
      },

      check: function () {
        var word = this.picked.map(function (t) { return t.ch; }).join('');
        var ok = word === this.target.udm.toLowerCase();
        this.answer(this.target, ok);
        if (ok) { ZB.playAudio(this.target); this.autoNext(); }
        else this.message = 'Правильно: ' + this.target.udm;
      },

      slots: function () {
        var out = [];
        for (var i = 0; i < this.letters.length; i++) out.push(this.picked[i] ? this.picked[i].ch : '');
        return out;
      },
    });
  }

  // ---------- «Правда или ложь» ----------

  var FAKE_CANDIDATES = 6; // из стольких слов ищем подмену

  function truefalse() {
    return base('truefalse', {
      target: null,
      shown: null,
      isTrue: true,

      newRound: function () {
        var pool = this.pool();
        this.target = this.pickFresh(pool);
        this.isTrue = Math.random() < 0.5;
        this.shown = this.target;
        if (!this.isTrue) {
          var t = this.target;
          // подмена должна явно не подходить: другая картинка и другой перевод
          var others = this.distractors(t, FAKE_CANDIDATES, 'ru').filter(function (w) { return !ZB.samePic(t, w); });
          if (others.length) this.shown = others[0];
          else this.isTrue = true; // подменить нечем
        }
      },

      say: function (yes) {
        if (this.feedback) return;
        var ok = yes === this.isTrue;
        // ответ засчитываем показанному слову
        this.answer(this.shown, ok);
        this.message = '«' + this.shown.udm + '» — это ' + this.shown.ru + '.';
        if (ok) this.autoNext();
      },
    });
  }

  // имена совпадают со slug игр, game.html пишет x-data="{{ game.slug }}"
  document.addEventListener('alpine:init', function () {
    var Alpine = window.Alpine;
    Alpine.data('choose', choose);
    Alpine.data('hard', hard);
    Alpine.data('odd', odd);
    Alpine.data('sort', sort);
    Alpine.data('memory', memory);
    Alpine.data('assemble', assemble);
    Alpine.data('truefalse', truefalse);
  });
})();
