// ==UserScript==
// @name         Artist Lab → NovelAI Bridge
// @namespace    artist-lab
// @version      1.0.1
// @description  Artist Lab의 "NAI로 보내기": 생성 설정 전체(모델·프롬프트·UC·캐릭터·해상도·Steps·Seed·Guidance·Sampler…)를 NovelAI 이미지 생성 화면에 적용합니다.
// @match        http://127.0.0.1:8766/*
// @match        http://localhost:8766/*
// @match        https://novelai.net/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

/*
 * How it works (same browser profile, Tampermonkey or Violentmonkey):
 *
 *  Artist Lab page --postMessage--> this script on 127.0.0.1:8766
 *      --GM storage (shared by every tab of this script)--> this script on novelai.net
 *
 *  1. Artist Lab asks "is the bridge here?" (ping/pong over window.postMessage).
 *  2. On "NAI로 보내기" it posts a transfer payload (see backend/nai_transfer.py).
 *  3. The bridge pings open NovelAI tabs through GM storage. The best one that answers
 *     (visible > on /image > most recent) gets the transfer; if none answers, one new
 *     tab is opened with GM_openInTab and claims the transfer when it starts.
 *  4. The NovelAI tab downloads Artist Lab's metadata PNG (settings rewritten from Artist
 *     Lab's own record), pastes it into the image generation page, which opens NovelAI's
 *     own "image import" dialog, switches that dialog's import options to what the payload
 *     carries (prompt, UC, characters, settings, seed), clicks "Import Metadata", checks
 *     the result, restores the user's own import options, and reports back.
 *  5. Every step is reported to Artist Lab (queued / received / applying / applied /
 *     failed). A transfer older than its TTL is never applied, and an applied transfer id
 *     is remembered so the same transfer is never applied twice.
 */
(function () {
  'use strict';

  const VERSION = '1.0.1';
  const PROTOCOL = 1;
  const NAI_IMAGE_URL = 'https://novelai.net/image';
  const KEYS = {
    transfer: 'alnb.transfer',
    claim: 'alnb.claim',
    status: 'alnb.status',
    done: 'alnb.done',
    ping: 'alnb.ping',
    pong: 'alnb.pong',
  };
  const PING_WAIT_MS = 900;
  const PAGE_READY_TIMEOUT_MS = 60000;
  const DIALOG_TIMEOUT_MS = 12000;
  const DONE_LIMIT = 50;
  // NovelAI's own import options (localStorage keys of its image import dialog).
  const IMPORT_TOGGLES = [
    'imagegen-import-prompt', 'imagegen-import-uc', 'imagegen-import-characters', 'imagegen-import-settings',
    'imagegen-import-seed', 'imagegen-append-characters', 'imagegen-import-clean-brackets',
    'imagegen-import-vibe-transfer', 'imagegen-append-vibe-transfer', 'imagegen-import-actual-prompt',
  ];
  const IMPORT_BUTTON_TEXTS = ['Import Metadata', 'メタデータをインポート'];
  // The only pages the Artist Lab side talks to (the @match lines), as browser origins.
  const ARTIST_LAB_ORIGINS = ['http://127.0.0.1:8766', 'http://localhost:8766'];
  const MARKER_ATTRIBUTE = 'data-artist-lab-nai-bridge';
  const LOG_PREFIX = '[Artist Lab NAI Bridge]';
  const SETTING_FIELDS = ['model', 'width', 'height', 'steps', 'scale', 'cfg_rescale', 'sampler', 'noise_schedule', 'sm', 'sm_dyn'];

  // ---- pure helpers (unit tested) ---------------------------------------------------------

  function validPayload(p) {
    return !!(p && p.source === 'artist-lab' && p.target === 'novelai' && p.protocol === PROTOCOL &&
      typeof p.transfer_id === 'string' && p.transfer_id && p.generation && typeof p.generation === 'object' &&
      p.image && typeof p.image.url === 'string');
  }

  function isFresh(p, now) {
    const created = Date.parse(p && p.created_at);
    const ttl = (p && Number(p.expires_in_s)) || 120;
    return Number.isFinite(created) && now - created <= ttl * 1000 && created - now <= 60000;
  }

  // Best NovelAI tab among the ones that answered a ping.
  function chooseTab(pongs) {
    const list = (pongs || []).filter(x => x && x.tab);
    list.sort((a, b) => (b.visible - a.visible) || (b.image - a.image) || (b.at - a.at));
    return list.length ? list[0].tab : null;
  }

  // Which NovelAI import options to switch on for this payload.
  function importOptions(generation) {
    const has = k => generation[k] !== undefined && generation[k] !== null;
    return {
      'imagegen-import-prompt': has('prompt'),
      'imagegen-import-uc': has('negative_prompt'),
      'imagegen-import-characters': has('character_prompt'),
      'imagegen-import-settings': SETTING_FIELDS.some(has),
      'imagegen-import-seed': has('seed'),
      'imagegen-append-characters': false,
      'imagegen-import-clean-brackets': false,
      'imagegen-import-vibe-transfer': false,
      'imagegen-append-vibe-transfer': false,
      'imagegen-import-actual-prompt': false,
    };
  }

  function rememberDone(list, id) {
    const next = (Array.isArray(list) ? list : []).filter(x => x !== id);
    next.push(id);
    return next.slice(-DONE_LIMIT);
  }

  const norm = s => String(s || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();

  // Compare what NovelAI now holds with what was sent. `state` is NovelAI's own saved
  // image-generation state ({model, prompt, params}); a value NovelAI does not expose is
  // simply not checked.
  function verify(g, state, shownPrompt) {
    const checks = {};
    if (g.model && state.model) checks.model = state.model === g.model;
    if (typeof g.prompt === 'string' && g.prompt.trim()) {
      const shown = norm(state.prompt != null ? state.prompt : shownPrompt);
      checks.prompt = shown.length > 0 && shown.includes(norm(g.prompt).slice(0, 40));
    }
    const params = state.params || {};
    for (const key of ['steps', 'seed', 'width', 'height', 'scale', 'cfg_rescale', 'sampler']) {
      if (g[key] != null && params[key] != null) checks[key] = String(params[key]) === String(g[key]);
    }
    return checks;
  }

  // A message from the Artist Lab page itself. event.source cannot be compared with
  // `window`: inside a userscript sandbox (Tampermonkey with @grant) `window` is a wrapper
  // object, never identical to the window a page message comes from - comparing them made
  // the bridge ignore every ping. event.origin is set by the browser, not by the sender.
  function isArtistLabPageMessage(event, pageOrigin) {
    return !!event && ARTIST_LAB_ORIGINS.includes(pageOrigin) && event.origin === pageOrigin &&
      !!event.data && event.data.source === 'artist-lab';
  }

  // ---- Artist Lab side ------------------------------------------------------------------------

  // `win` must be the page's real window (unsafeWindow in a userscript), not the sandbox one.
  function createArtistLabSide(env) {
    const { gm, win, now, sleep, newId, openTab } = env;
    const log = env.log || (() => {});
    const post = msg => win.postMessage({ source: 'artist-lab-nai-bridge', ...msg }, win.location.origin);
    const watching = new Set();

    gm.addValueChangeListener(KEYS.status, (_key, _old, status) => {
      if (status && watching.has(status.transfer_id)) {
        post({ type: 'status', ...status });
        if (status.state === 'applied' || status.state === 'failed') watching.delete(status.transfer_id);
      }
    });

    async function findNovelAiTab() {
      const pingId = newId();
      const pongs = [];
      const off = gm.addValueChangeListener(KEYS.pong, (_k, _o, pong) => {
        if (pong && pong.ping_id === pingId) pongs.push(pong);
      });
      gm.setValue(KEYS.ping, { ping_id: pingId, at: now() });
      await sleep(PING_WAIT_MS);
      if (off !== undefined && gm.removeValueChangeListener) gm.removeValueChangeListener(off);
      return chooseTab(pongs);
    }

    async function transfer(payload) {
      log('transfer received', payload && payload.transfer_id);
      if (!validPayload(payload)) {
        post({ type: 'status', transfer_id: payload && payload.transfer_id, state: 'failed', message: '전송 데이터 형식이 올바르지 않습니다.' });
        return;
      }
      const id = payload.transfer_id;
      if ((gm.getValue(KEYS.done, []) || []).includes(id)) {
        post({ type: 'status', transfer_id: id, state: 'failed', message: '이미 적용된 전송입니다.' });
        return;
      }
      watching.add(id);
      const tab = await findNovelAiTab();
      gm.setValue(KEYS.transfer, { payload, target_tab: tab, mode: tab ? 'existing' : 'new', queued_at: now() });
      post({ type: 'status', transfer_id: id, state: 'queued', mode: tab ? 'existing' : 'new' });
      if (!tab) openTab(NAI_IMAGE_URL);
    }

    function onMessage(event) {
      if (!isArtistLabPageMessage(event, win.location.origin)) return;
      const data = event.data;
      if (data.type === 'ping') {
        log('ping received');
        post({ type: 'pong', ping_id: data.ping_id, version: VERSION, protocol: PROTOCOL });
        log('pong sent');
      }
      if (data.type === 'transfer') transfer(data.payload);
    }

    return { onMessage, transfer, findNovelAiTab, post };
  }

  // Everything the userscript does on an Artist Lab page: listen to the page, mark the page
  // (the marker tells Artist Lab "the script runs here" even before any message), say ready.
  function startArtistLabPage(env) {
    const { pageWin, doc } = env;
    const log = env.log || (() => {});
    if (!ARTIST_LAB_ORIGINS.includes(pageWin.location.origin)) return null;
    const side = createArtistLabSide({ ...env, win: pageWin, log });
    pageWin.addEventListener('message', side.onMessage);
    // At document-start <html> may not exist yet; set the marker as soon as it does.
    const mark = () => {
      const root = doc.documentElement;
      if (root && root.getAttribute(MARKER_ATTRIBUTE) !== VERSION) root.setAttribute(MARKER_ATTRIBUTE, VERSION);
      return !!root;
    };
    if (!mark()) doc.addEventListener('readystatechange', mark);
    doc.addEventListener('DOMContentLoaded', mark);
    side.post({ type: 'ready', version: VERSION, protocol: PROTOCOL });
    log('ready', VERSION, pageWin.location.origin);
    return side;
  }

  // ---- NovelAI side -----------------------------------------------------------------------------

  function createNovelAiSide(env) {
    const { gm, page, tabId, now, sleep, fetchBytes } = env;
    let busy = null;

    const report = (transferId, state, extra) =>
      gm.setValue(KEYS.status, { transfer_id: transferId, state, tab: tabId, at: now(), ...(extra || {}) });

    function answerPing(ping) {
      if (!ping || !ping.ping_id) return;
      gm.setValue(KEYS.pong, { ping_id: ping.ping_id, tab: tabId, at: now(), visible: page.isVisible() ? 1 : 0, image: page.isImagePage() ? 1 : 0 });
    }

    async function claimNew(record) {
      const id = record.payload.transfer_id;
      const claim = gm.getValue(KEYS.claim, null);
      if (claim && claim.transfer_id === id) return claim.tab === tabId;
      gm.setValue(KEYS.claim, { transfer_id: id, tab: tabId, at: now() });
      await sleep(300);
      const after = gm.getValue(KEYS.claim, null);
      return !!after && after.transfer_id === id && after.tab === tabId;
    }

    async function consider(record) {
      if (!record || !validPayload(record.payload)) return false;
      const payload = record.payload;
      const id = payload.transfer_id;
      if ((gm.getValue(KEYS.done, []) || []).includes(id) || busy === id) return false;
      // An old transfer (e.g. still in storage when a NovelAI tab is opened later) is never
      // applied; Artist Lab has already reported its own timeout to the user.
      if (!isFresh(payload, now())) return false;
      if (record.mode === 'existing' && record.target_tab !== tabId) return false;
      if (record.mode === 'new' && !(await claimNew(record))) return false;
      if (!page.isImagePage()) {
        // Same tab, same claim: the script starts again on /image and continues there.
        report(id, 'received', { message: 'NovelAI 이미지 생성 화면으로 이동합니다.' });
        page.goToImagePage();
        return false;
      }
      busy = id;
      try {
        await apply(payload);
      } finally {
        busy = null;
      }
      return true;
    }

    async function apply(payload) {
      const id = payload.transfer_id;
      gm.setValue(KEYS.done, rememberDone(gm.getValue(KEYS.done, []), id)); // never twice
      report(id, 'received');
      const ready = await page.waitForImageGenUi(PAGE_READY_TIMEOUT_MS);
      if (!ready) {
        report(id, 'failed', { message: 'NovelAI 이미지 생성 화면이 준비되지 않았습니다. 로그인 상태를 확인한 뒤 다시 시도해 주세요.' });
        return;
      }
      report(id, 'applying');
      let bytes;
      try {
        bytes = await fetchBytes(payload.image.url);
      } catch (error) {
        report(id, 'failed', { message: `Artist Lab에서 설정 이미지를 받지 못했습니다 (${error && error.message || error}). Artist Lab이 실행 중인지 확인해 주세요.` });
        return;
      }
      const previous = page.setImportOptions(importOptions(payload.generation));
      try {
        page.pasteImage(bytes, payload.image.filename || 'artist-lab.png');
        const button = await page.waitForImportButton(IMPORT_BUTTON_TEXTS, DIALOG_TIMEOUT_MS);
        if (!button) {
          report(id, 'failed', { message: 'NovelAI 가져오기 창에서 메타데이터 가져오기 버튼을 찾지 못했습니다 (NovelAI 화면이 바뀌었을 수 있습니다).' });
          page.closeDialog();
          return;
        }
        page.click(button);
        await sleep(900);
      } finally {
        page.restoreImportOptions(previous);
      }
      const checks = verify(payload.generation, page.readState() || {}, page.readPrompt());
      const failedChecks = Object.keys(checks).filter(k => !checks[k]);
      report(id, 'applied', {
        checks,
        message: failedChecks.length
          ? `NovelAI에 적용했지만 확인되지 않은 항목이 있습니다: ${failedChecks.join(', ')} (NovelAI의 설정 잠금 등)`
          : 'NovelAI 탭에 적용했습니다.',
      });
    }

    return { answerPing, consider, apply };
  }

  // ---- exports for tests / browser wiring --------------------------------------------------------

  const api = { VERSION, PROTOCOL, KEYS, IMPORT_TOGGLES, IMPORT_BUTTON_TEXTS, ARTIST_LAB_ORIGINS, MARKER_ATTRIBUTE, validPayload, isFresh, chooseTab, importOptions, rememberDone, verify, isArtistLabPageMessage, createArtistLabSide, startArtistLabPage, createNovelAiSide };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }
  if (typeof GM_getValue === 'undefined') return;

  // ---- browser wiring -------------------------------------------------------------------------------

  const PW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const now = () => Date.now();
  const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const gm = {
    getValue: (k, d) => GM_getValue(k, d),
    setValue: (k, v) => GM_setValue(k, v),
    addValueChangeListener: (k, fn) => GM_addValueChangeListener(k, fn),
    removeValueChangeListener: typeof GM_removeValueChangeListener === 'function' ? GM_removeValueChangeListener : null,
  };

  if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
    startArtistLabPage({
      gm, pageWin: PW, doc: document, now, sleep, newId,
      openTab: url => GM_openInTab(url, { active: true, insert: true, setParent: true }),
      log: (...args) => console.info(LOG_PREFIX, ...args),
    });
    return;
  }

  // novelai.net
  const tabId = (() => {
    try {
      let id = sessionStorage.getItem('artist-lab-nai-bridge-tab');
      if (!id) { id = newId(); sessionStorage.setItem('artist-lab-nai-bridge-tab', id); }
      return id;
    } catch (_) { return newId(); }
  })();

  // Objects handed to NovelAI's own listeners are created in the page's world.
  const pageObject = value => PW.JSON.parse(JSON.stringify(value));
  const isVisible = el => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const textOf = el => String(el && el.textContent || '').trim();
  const mainPromptEditor = () => {
    const editors = [...document.querySelectorAll('.prompt-input-box-prompt .ProseMirror, .prompt-input-box-base-prompt .ProseMirror, .image-gen-prompt-main [data-prompt-input="true"] .ProseMirror')]
      .filter(e => !e.closest('.character-prompt-input'));
    return editors.find(isVisible) || editors[0] || null;
  };

  const page = {
    isVisible: () => document.visibilityState === 'visible',
    isImagePage: () => location.pathname === '/image' || location.pathname.startsWith('/image/'),
    goToImagePage: () => location.assign(NAI_IMAGE_URL),
    async waitForImageGenUi(timeout) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (document.querySelector('.image-gen-page') && mainPromptEditor()) return true;
        await sleep(250);
      }
      return false;
    },
    setImportOptions(values) {
      const previous = {};
      for (const key of IMPORT_TOGGLES) {
        previous[key] = PW.localStorage.getItem(key);
        PW.localStorage.setItem(key, JSON.stringify(!!values[key]));
        PW.dispatchEvent(new PW.CustomEvent('localStorageChanged', pageObject({ detail: { listener: 'artist-lab-nai-bridge', key } })));
      }
      return previous;
    },
    restoreImportOptions(previous) {
      for (const key of Object.keys(previous || {})) {
        if (previous[key] === null) PW.localStorage.removeItem(key); else PW.localStorage.setItem(key, previous[key]);
        PW.dispatchEvent(new PW.CustomEvent('localStorageChanged', pageObject({ detail: { listener: 'artist-lab-nai-bridge', key } })));
      }
    },
    pasteImage(bytes, filename) {
      const data = new PW.Uint8Array(bytes.byteLength);
      data.set(new Uint8Array(bytes));
      const file = new PW.File([data], filename, pageObject({ type: 'image/png' }));
      const transfer = new PW.DataTransfer();
      transfer.items.add(file);
      const init = pageObject({ bubbles: true, cancelable: true });
      init.clipboardData = transfer;
      PW.document.dispatchEvent(new PW.ClipboardEvent('paste', init));
    },
    async waitForImportButton(texts, timeout) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const button = [...document.querySelectorAll('button')].find(b => texts.includes(textOf(b)) && isVisible(b));
        if (button) return button;
        await sleep(150);
      }
      return null;
    },
    closeDialog: () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    click: el => el.click(),
    readPrompt: () => textOf(mainPromptEditor()),
    // NovelAI keeps the current image settings in localStorage (imagegen-model,
    // imagegen-prompt, imagegen-params-<model>); read back after the import.
    readState: () => {
      const read = key => { try { const v = PW.localStorage.getItem(key); return v == null ? null : JSON.parse(v); } catch (_) { return null; } };
      const model = read('imagegen-model');
      return { model, prompt: read('imagegen-prompt'), params: model ? read(`imagegen-params-${model}`) : null };
    },
  };

  const fetchBytes = url => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url, responseType: 'arraybuffer', timeout: 20000,
      onload: r => (r.status === 200 && r.response ? resolve(r.response) : reject(new Error(`HTTP ${r.status}`))),
      onerror: () => reject(new Error('연결 실패')),
      ontimeout: () => reject(new Error('시간 초과')),
    });
  });

  const side = createNovelAiSide({ gm, page, tabId, now, sleep, fetchBytes });
  GM_addValueChangeListener(KEYS.ping, (_k, _o, ping) => side.answerPing(ping));
  GM_addValueChangeListener(KEYS.transfer, (_k, _o, record) => { side.consider(record); });
  // A transfer waiting for a newly opened tab (or this tab after moving to /image).
  const start = () => side.consider(GM_getValue(KEYS.transfer, null));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
