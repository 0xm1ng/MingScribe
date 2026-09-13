/**
 * 显示层：界面与交互。
 *
 * 职责边界：
 *   - 只消费解析层产出的「统一中间格式」，不关心原始文件是 TXT 还是（未来的）EPUB。
 *   - 阅读位置一律通过「章节序号 + 章节内字符偏移」读写，不使用页码。
 *   - 书籍缓存交给 BookStore：能记住的书直接打开，记不住的才回退到文件选择器。
 */
(function () {
  'use strict';

  var Encoding = window.MingScribe.Encoding;
  var Parser = window.MingScribe.Parser;
  var Progress = window.MingScribe.Progress;
  var Search = window.MingScribe.Search;
  var BookStore = window.MingScribe.BookStore;

  var FONT_STEPS = [16, 18, 20, 22, 24, 26];
  var DEFAULT_FONT_SIZE = 19;
  var PREFS_KEY = 'mingscribe.prefs.v1';
  var SAVE_DEBOUNCE_MS = 400;
  var SEARCH_DEBOUNCE_MS = 180;
  var READING_CPM = 350; // 阅读速度估算（字/分钟），仅用于给出「大约还要读多久」
  var IMAGE_NOTE_PATTERN = /^\[(图片|图)[:：]/;

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
  var bookCache = null;
  var cacheBackend = '';

  var state = {
    book: null,
    meta: null,
    chapterIndex: 0,
    saveTimer: null,
    toastTimer: null,
    pendingKey: '',
    search: { query: '', results: [], index: -1 },
    searchTimer: null,
    dragging: false
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

  /** sticky 为 true 时不自动消失，用于「正在打开…」这类持续状态。 */
  function toast(message, sticky) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
    if (!sticky) {
      state.toastTimer = setTimeout(function () { el.toast.hidden = true; }, 2600);
    }
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

  function bookTitleOf(meta) {
    return (meta && (meta.title || meta.name)) || '未命名';
  }

  /** 读取文件并解码为文本。 */
  function readFileToText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        try {
          resolve(Encoding.decodeBuffer(reader.result).text);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = function () { reject(reader.error || new Error('读取文件失败')); };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ---------------- 书籍缓存 ---------------- */

  /**
   * 按可用性依次降级选择后端：IndexedDB → localStorage → 内存。
   * file:// 场景下 IndexedDB 可能不可用，此时 localStorage 仍能保证「下次直接打开」。
   */
  function initCache(done) {
    var candidates = [];
    if (typeof indexedDB !== 'undefined') {
      candidates.push({ name: 'indexeddb', make: function () { return BookStore.createIdbBackend(); } });
    }
    candidates.push({ name: 'localstorage', make: function () { return BookStore.createLocalStorageBackend(storage); } });
    candidates.push({ name: 'memory', make: function () { return BookStore.createMemoryBackend(); } });

    function tryNext(i) {
      if (i >= candidates.length) {
        bookCache = null;
        cacheBackend = 'none';
        done();
        return;
      }
      var backend;
      try {
        backend = candidates[i].make();
      } catch (err) {
        tryNext(i + 1);
        return;
      }
      Promise.resolve()
        .then(function () { return backend.listMeta(); })
        .then(function () {
          bookCache = BookStore.createStore(backend);
          cacheBackend = candidates[i].name;
          done();
        }, function () {
          tryNext(i + 1);
        });
    }

    tryNext(0);
  }

  function cacheBook(payload) {
    if (!bookCache) return;
    bookCache.put(payload).catch(function () { /* 缓存失败不打断阅读 */ });
  }

  /* ---------------- 书架 ---------------- */

  function renderShelf() {
    var progressList = store.list();
    var byKey = {};
    progressList.forEach(function (r) {
      if (r && r.key) byKey[r.key] = r;
    });

    function paint(books) {
      var seen = {};
      var items = [];

      (books || []).forEach(function (b) {
        if (!b || !b.key || seen[b.key]) return;
        seen[b.key] = true;
        items.push({ key: b.key, title: b.title || b.name, cached: true, rec: byKey[b.key] || null });
      });

      // 进度里有、但缓存中没有的（缓存被清或写入失败）：仍列出，打开时需重新选文件
      progressList.forEach(function (r) {
        if (!r || !r.key || seen[r.key]) return;
        seen[r.key] = true;
        items.push({ key: r.key, title: r.title || r.name, cached: false, rec: r });
      });

      el.shelfList.innerHTML = '';
      el.shelfEmpty.hidden = items.length > 0;

      var frag = document.createDocumentFragment();

      items.forEach(function (item) {
        var li = document.createElement('li');
        li.className = 'shelf-item';

        var main = document.createElement('div');
        main.className = 'shelf-item-main';

        var nameEl = document.createElement('div');
        nameEl.className = 'shelf-item-name';
        nameEl.textContent = item.title;
        nameEl.title = item.title;

        var metaEl = document.createElement('div');
        metaEl.className = 'shelf-item-meta';
        var rec = item.rec;
        var bits = [];
        if (rec && rec.chapterTitle) bits.push(rec.chapterTitle);
        if (rec) bits.push((Number(rec.percent) || 0).toFixed(1) + '%');
        if (rec && rec.updatedAt) bits.push(formatTime(rec.updatedAt));
        bits.push(item.cached ? '已缓存 · 直接打开' : '需重新选择文件');
        metaEl.textContent = bits.join(' · ');

        main.appendChild(nameEl);
        main.appendChild(metaEl);

        var openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'btn';
        openBtn.textContent = rec ? '继续阅读' : '开始阅读';
        openBtn.setAttribute('data-action', 'open');
        openBtn.setAttribute('data-key', item.key);
        openBtn.setAttribute('data-name', item.title);

        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'link-btn';
        delBtn.textContent = '删除';
        delBtn.setAttribute('data-action', 'remove');
        delBtn.setAttribute('data-key', item.key);

        li.appendChild(main);
        li.appendChild(openBtn);
        li.appendChild(delBtn);
        frag.appendChild(li);
      });

      el.shelfList.appendChild(frag);
    }

    if (bookCache) {
      bookCache.list().then(paint, function () { paint([]); });
    } else {
      paint([]);
    }
  }

  function onShelfClick(event) {
    var btn = event.target.closest ? event.target.closest('button[data-action]') : null;
    if (!btn) return;

    var action = btn.getAttribute('data-action');
    var key = btn.getAttribute('data-key');

    if (action === 'remove') {
      if (bookCache) bookCache.remove(key).catch(function () {});
      store.remove(key);
      renderShelf();
      toast('已删除该书及其阅读记录');
      return;
    }

    if (action === 'open') {
      openFromKey(key, btn.getAttribute('data-name'));
    }
  }

  /** 缓存里没有这本书：回到文件选择器，重新建立缓存。 */
  function askForFile(key, name) {
    state.pendingKey = key || '';
    toast('这本书还没有缓存，请选择《' + (name || '对应的文件') + '》');
    el.fileInput.value = '';
    el.fileInput.click();
  }

  function openFromKey(key, fallbackName) {
    if (!bookCache) {
      askForFile(key, fallbackName);
      return;
    }

    toast('正在打开…', true);

    bookCache.get(key).then(function (entry) {
      if (!entry || (!entry.handle && !entry.text)) {
        askForFile(key, (entry && entry.meta && entry.meta.name) || fallbackName);
        return;
      }

      var meta = {
        key: key,
        name: entry.meta.name,
        size: entry.meta.size,
        title: entry.meta.title || entry.meta.name
      };

      // 有句柄时优先重读原文件：不占存储，且内容始终最新
      if (entry.handle) {
        BookStore.ensurePermission(entry.handle).then(function (granted) {
          if (!granted) {
            askForFile(key, meta.name);
            return;
          }
          entry.handle.getFile().then(function (file) {
            readFileToText(file).then(
              function (text) { ingest(text, meta, entry.handle); },
              function () { askForFile(key, meta.name); }
            );
          }, function () { askForFile(key, meta.name); });
        });
        return;
      }

      ingest(entry.text, meta, null);
    }, function () {
      askForFile(key, fallbackName);
    });
  }

  /* ---------------- 打开文件 ---------------- */

  /** 优先用文件句柄 API（可持久化）；不支持时退回传统 input。 */
  function pickFile() {
    if (BookStore.supportsFileSystemAccess()) {
      window.showOpenFilePicker({
        types: [{ description: '文本文件', accept: { 'text/plain': ['.txt', '.text'] } }],
        multiple: false
      }).then(function (handles) {
        var handle = handles && handles[0];
        if (!handle) return;
        return handle.getFile().then(function (file) { openFile(file, handle); });
      }).catch(function (err) {
        // 用户主动取消不算错误
        if (err && err.name === 'AbortError') return;
        pickFileFallback();
      });
      return;
    }
    pickFileFallback();
  }

  function pickFileFallback() {
    el.fileInput.value = '';
    el.fileInput.click();
  }

  function openFile(file, handle) {
    if (!file) return;
    toast('正在打开《' + file.name.replace(/\.[^.]+$/, '') + '》…', true);

    readFileToText(file).then(function (text) {
      var meta = {
        key: BookStore.makeKey(file.name, file.size),
        name: file.name,
        size: file.size,
        title: file.name.replace(/\.[^.]+$/, '')
      };
      ingest(text, meta, handle || null);
    }, function () {
      toast('读取文件失败');
    });
  }

  /** 解析 → 缓存 → 进入阅读。 */
  function ingest(rawText, meta, handle) {
    try {
      var book = Parser.parseTxt(rawText, { bookTitle: meta.title });

      if (!book.totalChars) {
        toast('这个文件是空的，没有可读内容');
        return;
      }

      cacheBook({
        key: meta.key,
        title: meta.title,
        name: meta.name,
        size: meta.size,
        chapters: book.chapters.length,
        chars: book.totalChars,
        text: rawText,
        handle: handle || null
      });

      openBook(book, meta);
    } catch (err) {
      toast('打开失败：' + (err && err.message ? err.message : '未知错误'));
    }
  }

  function openBook(book, meta) {
    state.book = book;
    state.meta = meta;

    var saved = store.get(meta.key);
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
      toast('解析完成：' + book.chapters.length + ' 章 · ' + formatNumber(book.totalChars) + ' 字');
    }
  }

  function enterReader() {
    resetSearch();
    el.shelfScreen.hidden = true;
    el.readerScreen.hidden = false;
    el.readerBookName.textContent = bookTitleOf(state.meta);
    el.toc.hidden = true;
    buildToc();
  }

  function backToShelf() {
    flushSave();
    resetSearch();
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

      // data-off 记的是「去掉行首空白后的正文起点」，
      // 这样搜索命中的偏移能精确落到段落里的同一个字
      var lead = line.length - line.replace(/^\s+/, '').length;

      var node;
      if (trimmed === chapter.title) {
        node = document.createElement('h2');
      } else if (IMAGE_NOTE_PATTERN.test(trimmed)) {
        // TXT 无法承载图片，占位文字弱化处理，避免打断阅读节奏
        node = document.createElement('p');
        node.className = 'img-note';
      } else {
        node = document.createElement('p');
      }

      node.setAttribute('data-off', String(lineStart + lead));
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

    // 搜索进行中时，翻章也要保留高亮，否则跳章后关键词就找不着了
    if (state.search.query) applyHighlights();

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

  function setProgressVisual(pct) {
    var shown = Math.max(0, Math.min(100, Number(pct) || 0));
    el.progressFill.style.width = shown + '%';
    el.progressKnob.style.left = shown + '%';
    el.progressText.textContent = shown.toFixed(1) + '%';
    el.progressBar.setAttribute('aria-valuenow', shown.toFixed(1));
  }

  /** 把字数换算成「大约还要读多久」。只是估算，不追求精确。 */
  function formatDuration(chars) {
    var minutes = Math.round((Number(chars) || 0) / READING_CPM);
    if (minutes < 1) return '不到 1 分钟';
    if (minutes < 60) return minutes + ' 分钟';
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    return rest ? hours + ' 小时 ' + rest + ' 分' : hours + ' 小时';
  }

  function updateStatus() {
    if (!state.book) return;
    var chapter = state.book.chapters[state.chapterIndex];
    if (!chapter) return;

    var span = Math.max(0, chapter.end - chapter.start);
    var read = Math.min(currentOffset(), span);
    var remainChapter = Math.max(0, span - read);
    var remainTotal = Math.max(0, state.book.totalChars - (chapter.start + read));

    el.readerStatus.textContent =
      '本章剩余 ' + formatNumber(remainChapter) + ' 字 · 约 ' + formatDuration(remainChapter) +
      '　｜　全书剩余 ' + formatNumber(remainTotal) + ' 字 · 约 ' + formatDuration(remainTotal);
  }

  function updateProgressDisplay() {
    if (!state.book) return;
    var pct = Progress.computePercent(state.book, state.chapterIndex, currentOffset());
    setProgressVisual(pct);
    updateStatus();
  }

  /* ---------------- 进度条拖动跳转 ---------------- */

  function ratioFromPointer(event) {
    var rect = el.progressBar.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  }

  function globalOffsetAtRatio(ratio) {
    var total = state.book ? state.book.totalChars || 0 : 0;
    return Math.round(ratio * Math.max(0, total - 1));
  }

  /** 拖动过程中只更新视觉与「松手会跳到哪一章」，不真正切章。 */
  function previewSeek(ratio) {
    if (!state.book) return;
    setProgressVisual(ratio * 100);
    var pos = Progress.resolveGlobalOffset(state.book, globalOffsetAtRatio(ratio));
    var chapter = state.book.chapters[pos.chapterIndex];
    el.readerStatus.textContent = '松手跳到：' + ((chapter && chapter.title) || ('第 ' + (pos.chapterIndex + 1) + ' 节'));
  }

  function commitSeek(ratio) {
    if (!state.book) return;
    var pos = Progress.resolveGlobalOffset(state.book, globalOffsetAtRatio(ratio));
    renderChapter(pos.chapterIndex, pos.charOffset);
  }

  function seekByChars(deltaChars) {
    if (!state.book) return;
    var total = state.book.totalChars || 1;
    var current = Progress.globalOffsetOf(state.book, state.chapterIndex, currentOffset());
    var next = Math.max(0, Math.min(total - 1, current + deltaChars));
    var pos = Progress.resolveGlobalOffset(state.book, next);
    renderChapter(pos.chapterIndex, pos.charOffset);
  }

  /* ---------------- 全文搜索 ---------------- */

  function openSearchPanel() {
    if (!state.book) return;
    el.searchPanel.hidden = false;
    el.toc.hidden = true;
    el.searchInput.focus();
    el.searchInput.select();
  }

  function closeSearchPanel() {
    el.searchPanel.hidden = true;
    if (state.searchTimer) {
      clearTimeout(state.searchTimer);
      state.searchTimer = null;
    }
  }

  function searchPanelOpen() {
    return !el.searchPanel.hidden;
  }

  function runSearch(raw) {
    var query = String(raw == null ? '' : raw).trim();
    state.search.query = query;
    state.search.index = -1;

    if (!query) {
      state.search.results = [];
      el.searchCount.textContent = '输入关键词，在整本书里搜索。';
      el.searchResults.innerHTML = '';
      clearHighlights();
      return;
    }

    if (!state.book) return;

    var result = Search.searchBook(state.book, query);
    state.search.results = result.results;

    el.searchCount.textContent = result.total
      ? (result.truncated
          ? '找到 ' + result.total + ' 处以上，已截断——换个更具体的词会更准'
          : '找到 ' + result.total + ' 处')
      : '没有找到「' + query + '」';

    renderSearchResults();

    if (!result.results.length) {
      clearHighlights();
      return;
    }

    // 从当前阅读位置往后找第一条，避免每次搜索都被拽回开头
    var start = Search.firstIndexFrom(
      result.results,
      Progress.globalOffsetOf(state.book, state.chapterIndex, currentOffset())
    );
    gotoResult(start < 0 ? 0 : start);
  }

  function renderSearchResults() {
    el.searchResults.innerHTML = '';
    var frag = document.createDocumentFragment();

    state.search.results.forEach(function (r, i) {
      var li = document.createElement('li');
      li.className = 'search-item';
      li.setAttribute('data-i', String(i));

      var caption = document.createElement('div');
      caption.className = 'search-item-chapter';
      caption.textContent = r.chapterTitle;

      var snippet = document.createElement('div');
      snippet.className = 'search-item-snippet';
      snippet.innerHTML = Search.renderHighlightedHtml(r.snippet, [[r.hitStart, r.hitEnd]]);

      li.appendChild(caption);
      li.appendChild(snippet);
      frag.appendChild(li);
    });

    el.searchResults.appendChild(frag);
  }

  function markResultActive(index) {
    var items = el.searchResults.querySelectorAll('.search-item');
    for (var i = 0; i < items.length; i++) {
      if (i === index) {
        items[i].classList.add('active');
        if (items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
      } else {
        items[i].classList.remove('active');
      }
    }
  }

  function gotoResult(index) {
    var results = state.search.results;
    if (!results || !results.length) return;

    var i = ((index % results.length) + results.length) % results.length;
    var hit = results[i];
    state.search.index = i;

    renderChapter(hit.chapterIndex, hit.offset);
    applyHighlights();
    markCurrentHit(hit.offset);
    markResultActive(i);
  }

  function stepResult(delta) {
    if (!state.search.results.length) return;
    gotoResult(state.search.index + delta);
  }

  /** 给当前章节里所有关键词打高亮。重复执行不会叠加（先读 textContent 再重写）。 */
  function applyHighlights() {
    var query = state.search.query;
    if (!query) return;

    var nodes = el.content.querySelectorAll('[data-off]');
    for (var i = 0; i < nodes.length; i++) {
      var text = nodes[i].textContent;
      var ranges = Search.highlightRanges(text, query);
      if (ranges.length) nodes[i].innerHTML = Search.renderHighlightedHtml(text, ranges);
    }
  }

  function clearHighlights() {
    var nodes = el.content.querySelectorAll('[data-off]');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].querySelector('mark')) nodes[i].textContent = nodes[i].textContent;
    }
  }

  /** 把「当前这一处」的高亮标成更显眼的颜色，方便在长章节里一眼找到。 */
  function markCurrentHit(offset) {
    var marks = el.content.querySelectorAll('mark');
    for (var i = 0; i < marks.length; i++) marks[i].classList.remove('current');

    var nodes = el.content.querySelectorAll('[data-off]');
    var target = null;
    var local = 0;

    for (var j = 0; j < nodes.length; j++) {
      var start = Number(nodes[j].getAttribute('data-off'));
      var length = nodes[j].textContent.length;
      if (start <= offset && offset < start + length) {
        target = nodes[j];
        local = offset - start;
        break;
      }
    }
    if (!target) return;

    var walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, null);
    var acc = 0;
    var node;
    while ((node = walker.nextNode())) {
      var len = node.nodeValue.length;
      if (local >= acc && local < acc + len) {
        var parent = node.parentElement;
        if (parent && parent.tagName === 'MARK') parent.classList.add('current');
        return;
      }
      acc += len;
    }
  }

  function resetSearch() {
    state.search = { query: '', results: [], index: -1 };
    if (state.searchTimer) {
      clearTimeout(state.searchTimer);
      state.searchTimer = null;
    }
    el.searchInput.value = '';
    el.searchResults.innerHTML = '';
    el.searchCount.textContent = '输入关键词，在整本书里搜索。';
    closeSearchPanel();
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
      requestAnimationFrame(function () {
        positionAt(anchor);
        updateProgressDisplay();
      });
    }
    toast('字号 ' + next + 'px');
  }

  /* ---------------- 事件绑定 ---------------- */

  function onKeyDown(event) {
    if (el.readerScreen.hidden || !state.book) return;

    // Ctrl/Cmd + F 打开搜索（覆盖浏览器自带查找，否则会跟本页搜索抢焦点）
    if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault();
      openSearchPanel();
      return;
    }

    // 进度条获得焦点时，左右键做精细跳转而不是翻章
    if (event.target === el.progressBar) {
      var span = Math.max(1, Math.round((state.book.totalChars || 1) * 0.01));
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        seekByChars(event.key === 'ArrowLeft' ? -span : span);
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        var pos = Progress.resolveGlobalOffset(state.book, event.key === 'Home' ? 0 : (state.book.totalChars || 1) - 1);
        renderChapter(pos.chapterIndex, pos.charOffset);
        return;
      }
    }

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
        // 先关搜索面板，再关目录：一次 Esc 只关一层
        if (searchPanelOpen()) closeSearchPanel();
        else el.toc.hidden = true;
        return;
      default:
        return;
    }

    event.preventDefault();
    updateProgressDisplay();
    scheduleSave();
  }

  function bindEvents() {
    if (el.openFileBtn) {
      el.openFileBtn.addEventListener('click', pickFile);
    }

    el.fileInput.addEventListener('change', function () {
      var file = el.fileInput.files && el.fileInput.files[0];
      if (file) openFile(file, null);
    });

    el.shelfList.addEventListener('click', onShelfClick);

    el.clearAll.addEventListener('click', function () {
      if (bookCache) bookCache.clear().catch(function () {});
      store.clear();
      renderShelf();
      toast('已清空全部书籍与阅读记录');
    });

    el.backBtn.addEventListener('click', backToShelf);
    el.prevBtn.addEventListener('click', function () { goChapter(-1); });
    el.nextBtn.addEventListener('click', function () { goChapter(1); });

    el.tocBtn.addEventListener('click', function () {
      el.toc.hidden = !el.toc.hidden;
      if (!el.toc.hidden) closeSearchPanel();
    });
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

    /* 进度条：按下拖动预览，松手跳转 */
    el.progressBar.addEventListener('pointerdown', function (event) {
      if (!state.book) return;
      state.dragging = true;
      el.progressBar.classList.add('dragging');
      if (el.progressBar.setPointerCapture) {
        try { el.progressBar.setPointerCapture(event.pointerId); } catch (err) { /* 忽略 */ }
      }
      previewSeek(ratioFromPointer(event));
      event.preventDefault();
    });

    el.progressBar.addEventListener('pointermove', function (event) {
      if (!state.dragging) return;
      previewSeek(ratioFromPointer(event));
    });

    function endDrag(event) {
      if (!state.dragging) return;
      state.dragging = false;
      el.progressBar.classList.remove('dragging');
      if (el.progressBar.releasePointerCapture && event && event.pointerId != null) {
        try { el.progressBar.releasePointerCapture(event.pointerId); } catch (err) { /* 忽略 */ }
      }
      commitSeek(ratioFromPointer(event));
    }

    el.progressBar.addEventListener('pointerup', endDrag);
    el.progressBar.addEventListener('pointercancel', endDrag);

    /* 搜索 */
    el.searchBtn.addEventListener('click', function () {
      if (searchPanelOpen()) closeSearchPanel();
      else openSearchPanel();
    });
    el.searchCloseBtn.addEventListener('click', function () {
      closeSearchPanel();
      el.content.focus();
    });

    el.searchInput.addEventListener('input', function () {
      if (state.searchTimer) clearTimeout(state.searchTimer);
      var value = el.searchInput.value;
      state.searchTimer = setTimeout(function () { runSearch(value); }, SEARCH_DEBOUNCE_MS);
    });

    el.searchInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        stepResult(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeSearchPanel();
        el.content.focus();
      }
    });

    el.searchPrevBtn.addEventListener('click', function () { stepResult(-1); });
    el.searchNextBtn.addEventListener('click', function () { stepResult(1); });

    el.searchResults.addEventListener('click', function (event) {
      var li = event.target.closest ? event.target.closest('.search-item') : null;
      if (!li) return;
      gotoResult(Number(li.getAttribute('data-i')));
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
    el.openFileBtn = $('btn-open-file');
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
    el.progressBar = $('progress-bar');
    el.progressFill = $('progress-fill');
    el.progressKnob = $('progress-knob');
    el.progressText = $('progress-text');
    el.readerStatus = $('reader-status');

    el.searchBtn = $('btn-search');
    el.searchPanel = $('search-panel');
    el.searchInput = $('search-input');
    el.searchCount = $('search-count');
    el.searchResults = $('search-results');
    el.searchPrevBtn = $('btn-search-prev');
    el.searchNextBtn = $('btn-search-next');
    el.searchCloseBtn = $('btn-search-close');

    el.toast = $('toast');
  }

  function init() {
    cacheElements();
    bindEvents();

    var prefs = loadPrefs();
    applyFontSize(prefs.fontSize || DEFAULT_FONT_SIZE);
    applyTheme(prefs.theme || 'light');

    renderShelf();
    initCache(function () {
      renderShelf();
      if (cacheBackend === 'memory') {
        // 内存后端只在当前会话有效，明确告知，避免用户误以为已记住
        toast('当前环境无法持久保存书籍，关闭页面后需重新选择文件');
      }
    });
  }

  init();
})();
