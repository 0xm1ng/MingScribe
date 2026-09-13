/**
 * 显示层：界面与交互。
 *
 * 职责边界：
 *   - 只消费解析层产出的「统一中间格式」，不关心原始文件是 TXT 还是（未来的）EPUB。
 *   - 阅读位置一律通过「章节序号 + 章节内字符偏移」读写，不使用页码。
 */
(function () {
  'use strict';

  var Encoding = window.MingScribe.Encoding;
  var Parser = window.MingScribe.Parser;
  var Progress = window.MingScribe.Progress;

  var FONT_STEPS = [16, 18, 20, 22, 24, 26];
  var DEFAULT_FONT_SIZE = 19;
  var PREFS_KEY = 'mingscribe.prefs.v1';
  var SAVE_DEBOUNCE_MS = 400;

  /** localStorage 不可用（隐私模式等）时退回内存实现，保证功能不中断。 */
  function safeStorage() {
    try {
      var probe = '__mingscribe_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return window.localStorage;
    } catch (err) {
      var mem = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; }
      };
    }
  }

  var storage = safeStorage();
  var store = Progress.createStore(storage);

  var state = {
    book: null,
    meta: null,
    chapterIndex: 0,
    saveTimer: null,
    toastTimer: null
  };

  var el = {};

  function $(id) { return document.getElementById(id); }

  /* ---------------- 偏好设置 ---------------- */

  function loadPrefs() {
    try {
      var parsed = JSON.parse(storage.getItem(PREFS_KEY));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function savePrefs(patch) {
    var prefs = loadPrefs();
    Object.keys(patch).forEach(function (k) { prefs[k] = patch[k]; });
    try { storage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (err) { /* 忽略写入失败 */ }
    return prefs;
  }

  function nearestFontIndex(size) {
    var best = 0;
    for (var i = 0; i < FONT_STEPS.length; i++) {
      if (FONT_STEPS[i] <= size) best = i;
    }
    return best;
  }

  function applyFontSize(size) {
    var clamped = Math.max(FONT_STEPS[0], Math.min(Number(size) || DEFAULT_FONT_SIZE, FONT_STEPS[FONT_STEPS.length - 1]));
    document.documentElement.style.setProperty('--reader-font-size', clamped + 'px');
    savePrefs({ fontSize: clamped });
    return clamped;
  }

  function applyTheme(theme) {
    var value = theme === 'dark' ? 'dark' : 'light';
    document.body.setAttribute('data-theme', value);
    savePrefs({ theme: value });
    return value;
  }

  /* ---------------- 工具 ---------------- */

  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { el.toast.hidden = true; }, 2600);
  }

  function formatNumber(n) {
    return String(n == null ? 0 : n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function formatTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  /* ---------------- 书架 ---------------- */

  function renderShelf() {
    var records = store.list();

    el.shelfList.innerHTML = '';
    el.shelfEmpty.hidden = records.length > 0;

    var frag = document.createDocumentFragment();

    records.forEach(function (r) {
      var li = document.createElement('li');
      li.className = 'shelf-item';

      var main = document.createElement('div');
      main.className = 'shelf-item-main';

      var nameEl = document.createElement('div');
      nameEl.className = 'shelf-item-name';
      nameEl.textContent = r.title || r.name;

      var metaEl = document.createElement('div');
      metaEl.className = 'shelf-item-meta';
      metaEl.textContent = [
        r.chapterTitle || '',
        (Number(r.percent) || 0).toFixed(1) + '%',
        formatTime(r.updatedAt)
      ].filter(Boolean).join(' · ');

      main.appendChild(nameEl);
      main.appendChild(metaEl);

      var openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn';
      openBtn.textContent = '继续阅读';
      openBtn.setAttribute('data-action', 'open');
      openBtn.setAttribute('data-key', r.key);
      openBtn.setAttribute('data-name', r.title || r.name);

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'link-btn';
      delBtn.textContent = '删除';
      delBtn.setAttribute('data-action', 'remove');
      delBtn.setAttribute('data-key', r.key);

      li.appendChild(main);
      li.appendChild(openBtn);
      li.appendChild(delBtn);
      frag.appendChild(li);
    });

    el.shelfList.appendChild(frag);
  }

  function onShelfClick(event) {
    var btn = event.target.closest ? event.target.closest('button[data-action]') : null;
    if (!btn) return;

    var action = btn.getAttribute('data-action');
    var key = btn.getAttribute('data-key');

    if (action === 'remove') {
      store.remove(key);
      renderShelf();
      toast('已删除该条阅读记录');
      return;
    }

    if (action === 'open') {
      toast('请在文件选择器中选择《' + btn.getAttribute('data-name') + '》对应的文件');
      el.fileInput.value = '';
      el.fileInput.click();
    }
  }

  /* ---------------- 打开文件 ---------------- */

  function openFile(file) {
    if (!file) return;

    var reader = new FileReader();

    reader.onload = function () {
      try {
        var decoded = Encoding.decodeBuffer(reader.result);
        var bookTitle = file.name.replace(/\.[^.]+$/, '');

        var book = Parser.parseTxt(decoded.text, { bookTitle: bookTitle });

        if (book.totalChars === 0) {
          toast('这个文件是空的，没有可读内容');
          return;
        }

        state.book = book;
        state.meta = {
          key: Progress.bookKey(file.name, file.size),
          name: file.name,
          size: file.size,
          title: bookTitle,
          encoding: decoded.encoding
        };

        var saved = store.get(state.meta.key);
        var target = saved
          ? Progress.resolvePosition(book, saved.chapterIndex, saved.charOffset)
          : { chapterIndex: 0, charOffset: 0 };

        enterReader();
        renderChapter(target.chapterIndex, target.charOffset);

        if (Encoding.garbledRatio(book.text) > 0.02) {
          toast('文字可能仍有乱码，建议换一个来源的文件试试');
        } else if (saved) {
          toast('已恢复到上次位置：' + (saved.chapterTitle || '第 ' + (saved.chapterIndex + 1) + ' 章'));
        } else {
          toast('解析完成：' + book.chapters.length + ' 章 · ' +
            formatNumber(book.totalChars) + ' 字 · ' + String(decoded.encoding).toUpperCase());
        }
      } catch (err) {
        toast('打开失败：' + (err && err.message ? err.message : '未知错误'));
      }
    };

    reader.onerror = function () { toast('读取文件失败'); };
    reader.readAsArrayBuffer(file);
  }

  function enterReader() {
    el.shelfScreen.hidden = true;
    el.readerScreen.hidden = false;
    el.readerBookName.textContent = state.meta.title || state.meta.name;
    el.toc.hidden = true;
    buildToc();
  }

  function backToShelf() {
    flushSave();
    el.readerScreen.hidden = true;
    el.shelfScreen.hidden = false;
    el.toc.hidden = true;
    state.book = null;
    state.meta = null;
    renderShelf();
  }

  /* ---------------- 阅读器 ---------------- */

  function buildToc() {
    el.tocList.innerHTML = '';
    if (!state.book) return;

    var frag = document.createDocumentFragment();
    state.book.chapters.forEach(function (chapter, i) {
      var li = document.createElement('li');
      li.textContent = chapter.title || ('第 ' + (i + 1) + ' 节');
      li.title = li.textContent;
      li.setAttribute('data-index', String(i));
      frag.appendChild(li);
    });
    el.tocList.appendChild(frag);
  }

  function updateTocActive(index) {
    var items = el.tocList.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) {
      if (i === index) items[i].classList.add('active');
      else items[i].classList.remove('active');
    }
  }

  /**
   * 把一章渲染成 DOM。每个段落都记录它在「本章内的字符偏移」，
   * 这样字号/窗口变化后依然能精确定位回同一处内容。
   */
  function buildChapterBody(chapter) {
    var frag = document.createDocumentFragment();
    var lines = chapter.text.split('\n');
    var cursor = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var lineStart = cursor;
      cursor += line.length + 1;

      var trimmed = line.trim();
      if (!trimmed) continue;

      var node = trimmed === chapter.title
        ? document.createElement('h2')
        : document.createElement('p');

      node.setAttribute('data-off', String(lineStart));
      node.textContent = trimmed;
      frag.appendChild(node);
    }

    return frag;
  }

  function renderChapter(index, charOffset) {
    if (!state.book) return;

    var total = state.book.chapters.length;
    var idx = Math.max(0, Math.min(Number(index) || 0, total - 1));
    var chapter = state.book.chapters[idx];
    state.chapterIndex = idx;

    el.content.innerHTML = '';
    el.content.appendChild(buildChapterBody(chapter));
    el.readerChapterName.textContent = chapter.title || ('第 ' + (idx + 1) + ' 节');

    updateTocActive(idx);
    el.prevBtn.disabled = idx <= 0;
    el.nextBtn.disabled = idx >= total - 1;

    el.content.scrollTop = 0;
    positionAt(Math.max(0, Math.min(Number(charOffset) || 0, chapter.end - chapter.start)));

    updateProgressDisplay();
    scheduleSave();
  }

  /** 滚动到本章内指定字符偏移所在的段落。 */
  function positionAt(offset) {
    var nodes = el.content.querySelectorAll('[data-off]');
    var target = null;

    for (var i = 0; i < nodes.length; i++) {
      if (Number(nodes[i].getAttribute('data-off')) <= offset) target = nodes[i];
      else break;
    }

    el.content.scrollTop = target && target !== nodes[0] ? target.offsetTop : 0;
  }

  /** 当前视口顶部对应的本章字符偏移。 */
  function currentOffset() {
    var nodes = el.content.querySelectorAll('[data-off]');
    if (!nodes.length) return 0;

    var top = el.content.scrollTop;
    var best = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].offsetTop <= top + 4) best = Number(nodes[i].getAttribute('data-off'));
      else break;
    }
    return best;
  }

  function updateProgressDisplay() {
    if (!state.book) return;
    var pct = Progress.computePercent(state.book, state.chapterIndex, currentOffset());
    el.progressFill.style.width = pct + '%';
    el.progressText.textContent = pct.toFixed(1) + '%';
  }

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    if (!state.book || !state.meta) return;
    try {
      store.save(Progress.makeRecord(state.book, state.meta, state.chapterIndex, currentOffset()));
    } catch (err) { /* 存储失败不应打断阅读 */ }
  }

  function goChapter(delta) {
    if (!state.book) return;
    var target = state.chapterIndex + delta;
    if (target < 0 || target >= state.book.chapters.length) return;
    renderChapter(target, 0);
  }

  function stepFont(delta) {
    var current = Number(loadPrefs().fontSize) || DEFAULT_FONT_SIZE;
    var next = FONT_STEPS[Math.max(0, Math.min(nearestFontIndex(current) + delta, FONT_STEPS.length - 1))];
    if (next === current) {
      toast('已到字号极限');
      return;
    }
    var anchor = currentOffset();
    applyFontSize(next);
    if (state.book) {
      requestAnimationFrame(function () { positionAt(anchor); });
    }
    toast('字号 ' + next + 'px');
  }

  /* ---------------- 事件绑定 ---------------- */

  function onKeyDown(event) {
    if (el.readerScreen.hidden || !state.book) return;

    var viewport = el.content.clientHeight;

    switch (event.key) {
      case 'ArrowLeft':
        goChapter(-1);
        break;
      case 'ArrowRight':
        goChapter(1);
        break;
      case 'PageDown':
      case ' ':
        el.content.scrollTop += viewport * 0.9;
        break;
      case 'PageUp':
        el.content.scrollTop -= viewport * 0.9;
        break;
      case 'Home':
        el.content.scrollTop = 0;
        break;
      case 'End':
        el.content.scrollTop = el.content.scrollHeight;
        break;
      case 'Escape':
        el.toc.hidden = true;
        return;
      default:
        return;
    }

    event.preventDefault();
    updateProgressDisplay();
    scheduleSave();
  }

  function bindEvents() {
    el.fileInput.addEventListener('change', function () {
      var file = el.fileInput.files && el.fileInput.files[0];
      if (file) openFile(file);
    });

    el.shelfList.addEventListener('click', onShelfClick);

    el.clearAll.addEventListener('click', function () {
      store.clear();
      renderShelf();
      toast('已清空全部阅读记录');
    });

    el.backBtn.addEventListener('click', backToShelf);
    el.prevBtn.addEventListener('click', function () { goChapter(-1); });
    el.nextBtn.addEventListener('click', function () { goChapter(1); });

    el.tocBtn.addEventListener('click', function () { el.toc.hidden = !el.toc.hidden; });
    el.tocCloseBtn.addEventListener('click', function () { el.toc.hidden = true; });

    el.tocList.addEventListener('click', function (event) {
      var li = event.target.closest ? event.target.closest('li[data-index]') : null;
      if (!li) return;
      renderChapter(Number(li.getAttribute('data-index')), 0);
      el.toc.hidden = true;
      el.content.focus();
    });

    el.fontUpBtn.addEventListener('click', function () { stepFont(1); });
    el.fontDownBtn.addEventListener('click', function () { stepFont(-1); });
    el.themeBtn.addEventListener('click', function () {
      var next = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      toast(next === 'dark' ? '已切换到夜间模式' : '已切换到日间模式');
    });

    el.content.addEventListener('scroll', function () {
      updateProgressDisplay();
      scheduleSave();
    });

    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeunload', flushSave);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushSave();
    });
  }

  function cacheElements() {
    el.shelfScreen = $('shelf-screen');
    el.readerScreen = $('reader-screen');
    el.fileInput = $('file-input');
    el.shelfList = $('shelf-list');
    el.shelfEmpty = $('shelf-empty');
    el.clearAll = $('clear-all');

    el.readerBookName = $('reader-book-name');
    el.readerChapterName = $('reader-chapter-name');
    el.content = $('reader-content');
    el.toc = $('toc');
    el.tocList = $('toc-list');
    el.tocBtn = $('btn-toc');
    el.tocCloseBtn = $('btn-toc-close');
    el.backBtn = $('btn-back');
    el.prevBtn = $('btn-prev');
    el.nextBtn = $('btn-next');
    el.fontUpBtn = $('btn-font-up');
    el.fontDownBtn = $('btn-font-down');
    el.themeBtn = $('btn-theme');
    el.progressFill = $('progress-fill');
    el.progressText = $('progress-text');
    el.toast = $('toast');
  }

  function init() {
    cacheElements();
    bindEvents();

    var prefs = loadPrefs();
    applyFontSize(prefs.fontSize || DEFAULT_FONT_SIZE);
    applyTheme(prefs.theme || 'light');

    renderShelf();
  }

  init();
})();
