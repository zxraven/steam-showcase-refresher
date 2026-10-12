// ==UserScript==
// @name         Steam Showcase Refresher
// @name:uk      Steam Showcase Refresher
// @name:ru      Steam Showcase Refresher
// @namespace    alex.nocturne.steam.showcase
// @version      1.13
// @description  Install an animated Steam Artwork Showcase (2 GIFs) or Workshop Showcase (5 strips) in a few clicks.
// @description:uk  Анімована вітрина в профілі Steam у кілька кліків: вітрина ілюстрацій (2 GIF) або вітрина майстерні (5 смуг).
// @description:ru  Анимированная витрина в профиле Steam в несколько кликов: витрина иллюстраций (2 GIF) или витрина мастерской (5 полос).
// @author       Alex Nocturne
// @copyright    Copyright (c) 2026 Alex Nocturne
// @license      Free for personal use. Provided AS IS, without warranty of any kind. Resale prohibited.
// @match        https://steamcommunity.com/*
// @run-at       document-idle
// @noframes
// @sandbox      JavaScript
// @grant        unsafeWindow
// @grant        GM_addStyle
// ==/UserScript==

/*
 * Steam Showcase Refresher 1.13
 * Copyright (c) 2026 Alex Nocturne.
 *
 * Provided AS IS, free of charge, as a helper for installing artwork.
 * No warranty and no support. You use it at your own risk.
 * Not affiliated with or endorsed by Valve or Steam.
 *
 * What it does, step by step (only on steamcommunity.com, only with your Steam session):
 *   1. Opens your showcase editor and lets you pick which showcase to replace:
 *      an Artwork Showcase (2 GIFs: 506 + 100 px) or a Workshop Showcase (5 strips, 119 px each).
 *   2. Uploads the GIFs through Steam's own upload form (Workshop strips as Workshop items).
 *   3. Puts them into the chosen showcase and saves the profile.
 *   4. Optionally (only if you ask, Artwork Showcase only) helps hide or remove old artwork you tick yourself.
 * It never asks for your password, never sends data anywhere except Steam itself.
 */
(() => {
  'use strict';
  const VERSION = '1.13';
  const sw = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const K = 'steamShowcaseRefresher.job.v4';
  const LANG_KEY = 'steamShowcaseRefresher.language';
  const DB = 'steamShowcaseRefresher.files.v3';
  const UPLOAD = 'https://steamcommunity.com/sharedfiles/edititem/767/3/';
  const EDIT = 'https://steamcommunity.com/my/edit/showcases';
  const PROFILE = 'https://steamcommunity.com/my/';
  const GALLERY = 'https://steamcommunity.com/my/images/?appid=0&sort=newestfirst&browsefilter=myfiles&view=grid';
  const WORKSHOP_LIST = 'https://steamcommunity.com/my/myworkshopfiles/?appid=480&sortmethod=lastupdated';
  const WORKSHOP_APP = 480;            // neutral app id commonly used for long Workshop Showcases
  const STRIP_W = 119;                 // recommended width of one Workshop Showcase strip
  // Supported showcase layouts. type = Steam profile showcase type id.
  const LAYOUTS = {
    artwork: {kind: 'artwork', type: 13, parts: [
      {key: 'main', width: 506, en: 'Main GIF (wide, 506 px)', ru: 'Основной GIF (широкий, 506 px)', uk: 'Основний GIF (широкий, 506 px)', short: 'Main'},
      {key: 'side', width: 100, en: 'Side GIF (narrow, 100 px)', ru: 'Боковой GIF (узкий, 100 px)', uk: 'Бічний GIF (вузький, 100 px)', short: 'Side'},
    ]},
    workshop: {kind: 'workshop', type: 12, parts: [1, 2, 3, 4, 5].map(n =>
      ({key: 's' + n, width: null, en: `Strip ${n}`, ru: `Полоса ${n}`, uk: `Смуга ${n}`, short: String(n)}))},
  };
  const SHOP = 'https://alexnocturne.blacksea.in.ua';
  const TITLE = '⠀';             // invisible artwork title
  const HARD_LIMIT = 8 * 1024 * 1024;  // Steam rejects artwork over this size
  const SOFT_LIMIT = 5 * 1024 * 1024;  // above this Steam sometimes rejects uploads

  const savedLang = (() => { try { return localStorage.getItem(LANG_KEY); } catch { return null; } })();
  const LANGS = [['en', 'EN'], ['uk', 'UA'], ['ru', 'RU']];   // panel order: EN | UA | RU
  const navLang = String(navigator.language || '').toLowerCase();
  let language = LANGS.some(([c]) => c === savedLang) ? savedLang
    : navLang.startsWith('uk') ? 'uk' : navLang.startsWith('ru') ? 'ru' : 'en';
  const I = (en, ru, uk) => language === 'ru' ? ru : language === 'uk' ? (uk ?? en) : en;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = (q, root = document) => root.querySelector(q);
  const $$ = (q, root = document) => [...root.querySelectorAll(q)];
  const okID = s => /^\d{7,20}$/.test(String(s ?? ''));
  const safe = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeURL = u => { try { const x = new URL(u, location.href); return /^https:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
  const itemURL = id => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
  const isUpload = () => location.pathname.startsWith('/sharedfiles/edititem/767/3');
  const isGallery = () => /\/images\/?$/.test(location.pathname);
  const isEdit = () => /\/edit\/showcases\/?$/.test(location.pathname);
  const isWorkshopList = () => /\/myworkshopfiles\/?$/.test(location.pathname);
  const owner = () => { const v = sw.g_steamID; return v && v !== 'false' ? String(v) : ''; };
  const blankTitle = t => String(t || '').replace(/[\s⠀​ㅤ]/g, '') === '';
  const mb = n => (n / 1048576).toFixed(1) + ' MB';

  // UI state (not persisted)
  let open = false, working = false, message = '', messageErr = false;
  let layout = 'artwork';                      // layout chosen on the start screen
  let files = {};                              // part key -> File (possibly byte-patched copy)
  let info = {};                               // part key -> validation result
  let errs = {};                               // part key -> error text
  let previews = {};                           // part key -> object URL
  let rightsOK = false;
  let showcaseChoices = [], chosenKey = '';
  let galleryLoaded = false, groups = null, picks = new Set(), deletionStarted = false;
  let recoverCandidate = null, pendingStuck = false;

  // Layout helpers. j = persisted job.
  const L = j => LAYOUTS[j?.layout] || LAYOUTS.artwork;
  const partKeys = j => L(j).parts.map(p => p.key);
  const idList = j => partKeys(j).map(k => String(j?.ids?.[k] || ''));
  const allUploaded = j => idList(j).every(okID);
  const nextPart = j => partKeys(j).findIndex(k => !okID(j?.ids?.[k]));
  const listURL = j => L(j).kind === 'workshop' ? WORKSHOP_LIST : GALLERY;
  const onList = j => L(j).kind === 'workshop' ? isWorkshopList() : isGallery();
  const showcaseName = j => L(j).kind === 'workshop' ? I('Workshop Showcase', 'Витрина мастерской', 'Вітрина майстерні') : I('Artwork Showcase', 'Витрина иллюстраций', 'Вітрина ілюстрацій');

  // ---------- real thumbnails ----------
  // Gallery tiles of long artwork often look like 1-px strips, so the picture is taken
  // from the artwork's own page (same site, your session) and cached for this tab.
  const thumbCache = (() => { try { return JSON.parse(sessionStorage.getItem('ssr.thumbs') || '{}'); } catch { return {}; } })();
  const saveThumbs = () => { try { sessionStorage.setItem('ssr.thumbs', JSON.stringify(thumbCache)); } catch {} };
  function sized(u) {
    try {
      const x = new URL(u);
      if (!/steamusercontent|steamstatic|akamaihd|steampowered/i.test(x.hostname)) return u;
      x.search = '';
      x.searchParams.set('imw', '160'); x.searchParams.set('imh', '480');
      x.searchParams.set('ima', 'fit'); x.searchParams.set('impolicy', 'Letterbox'); x.searchParams.set('letterbox', 'false');
      return x.href;
    } catch { return u; }
  }
  async function realThumb(id) {
    if (thumbCache[id]) return thumbCache[id];
    const r = await fetch(itemURL(id), {credentials: 'include'});
    if (!r.ok) return '';
    const d = new DOMParser().parseFromString(await r.text(), 'text/html');
    const u = d.querySelector('#ActualMedia')?.getAttribute('src') ||
      d.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
      d.querySelector('link[rel="image_src"]')?.getAttribute('href') ||
      d.querySelector('.actualmediactn img, .workshopItemPreviewImageMain')?.getAttribute('src') || '';
    const ok = safeURL(u);
    if (ok) { thumbCache[id] = ok; saveThumbs(); }
    return ok;
  }
  async function hydrateThumbs(ids) {
    const todo = [...new Set(ids)].filter(id => okID(id) && !thumbCache[id]);
    for (let i = 0; i < todo.length; i += 3) {
      await Promise.all(todo.slice(i, i + 3).map(async id => {
        try {
          const u = await realThumb(id);
          if (u) $$(`#ssr-panel img[data-tid="${id}"]`).forEach(im => { im.src = sized(u); im.dataset.orig = u; });
        } catch (e) { log('thumb', id, e.message); }
      }));
    }
  }

  // ---------- persisted job ----------
  const state = () => { try { return JSON.parse(localStorage.getItem(K) || 'null'); } catch { return null; } };
  const store = job => { localStorage.setItem(K, JSON.stringify(job)); render(); };
  const setPhase = (name, extra = {}) => { const j = state(); if (j) store({...j, phase: name, ...extra}); };
  const report = (text, err = false) => { message = text; messageErr = err; (err ? console.error : console.info)('[ShowcaseRefresher]', text); render(); };
  const halt = text => { const j = state(); if (j && j.phase !== 'paused') store({...j, phase: 'paused', pausedFrom: j.phase}); report(text, true); };
  const log = (...xs) => console.info('[ShowcaseRefresher]', ...xs);
  const goto = uri => location.assign(uri);
  const allowed = job => !job?.steamID || !owner() || owner() === job.steamID;

  // ---------- IndexedDB for the selected GIFs (they must survive page navigation) ----------
  function dbConn() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  }
  async function dbRun(mode, fn) {
    const db = await dbConn();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('files', mode); const req = fn(tx.objectStore('files'));
        tx.oncomplete = () => resolve(req?.result); tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  const writeFile = (name, file) => dbRun('readwrite', s => s.put(file, name));
  const getFile = name => dbRun('readonly', s => s.get(name));
  const wipeFiles = () => dbRun('readwrite', s => s.clear());

  // ---------- GIF validation ----------
  async function checkGif(file, width) {
    if (!file) throw Error(I('Choose a GIF file.', 'Выбери GIF-файл.', 'Обери GIF-файл.'));
    if (file.size > HARD_LIMIT) throw Error(I(`${mb(file.size)} — Steam accepts files up to 8 MB.`, `${mb(file.size)} — Steam принимает файлы до 8 МБ.`, `${mb(file.size)} — Steam приймає файли до 8 МБ.`));
    if (file.size < 16) throw Error(I('The file is empty or damaged.', 'Файл пустой или повреждён.', 'Файл порожній або пошкоджений.'));
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    const magic = String.fromCharCode(...head.slice(0, 6));
    if (!['GIF89a', 'GIF87a'].includes(magic)) throw Error(I('This is not a GIF file.', 'Это не GIF-файл.', 'Це не GIF-файл.'));
    const w = head[6] + (head[7] << 8), h = head[8] + (head[9] << 8);
    if (h < 1 || (width && w !== width)) throw Error(I(`Size ${w}×${h}; this slot needs width ${width} px.`, `Размер ${w}×${h}; для этого места нужна ширина ${width} px.`, `Розмір ${w}×${h}; для цього місця потрібна ширина ${width} px.`));
    // Long Steam artwork trick: last byte 0x3B (GIF trailer) -> 0x21. Applied to a copy only.
    const last = new Uint8Array(await file.slice(-1).arrayBuffer())[0];
    let out = file, patched = false;
    if (last === 0x3B) {
      out = new File([file.slice(0, -1), new Uint8Array([0x21])], file.name, {type: 'image/gif'});
      patched = true;
    }
    return {file: out, meta: {name: file.name, size: file.size, width: w, height: h, patched}};
  }
  const partDef = key => Object.values(LAYOUTS).flatMap(l => l.parts).find(p => p.key === key);
  async function setPart(key, file) {
    if (previews[key]) URL.revokeObjectURL(previews[key]);
    previews[key] = file ? URL.createObjectURL(file) : '';
    files[key] = null; info[key] = null; errs[key] = '';
    if (!file) return;
    try { const r = await checkGif(file, partDef(key).width); files[key] = r.file; info[key] = r.meta; }
    catch (e) { errs[key] = e.message; info[key] = {name: file.name}; }
  }
  async function onPick(key, file) { await setPart(key, file); message = ''; render(); }
  // Workshop strips: one multi-select, ordered by file name (strip_1 … strip_5).
  async function onPickMany(list) {
    const parts = LAYOUTS.workshop.parts;
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'}));
    message = ''; messageErr = false;
    if (sorted.length !== parts.length)
      { message = I(`Choose exactly ${parts.length} GIFs (you chose ${sorted.length}).`, `Выбери ровно ${parts.length} GIF (выбрано ${sorted.length}).`, `Обери рівно ${parts.length} GIF (обрано ${sorted.length}).`); messageErr = true; }
    for (let i = 0; i < parts.length; i++) await setPart(parts[i].key, sorted[i] || null);
    render();
  }
  function setProblem() {
    const parts = LAYOUTS[layout].parts;
    if (parts.some(p => !files[p.key])) return '';
    const hs = parts.map(p => info[p.key].height), ws = parts.map(p => info[p.key].width);
    if (layout === 'artwork' && hs[0] !== hs[1])
      return I(`Heights differ: Main ${hs[0]} px, Side ${hs[1]} px. Use a matching pair.`,
               `Высота отличается: основной ${hs[0]} px, боковой ${hs[1]} px. Нужна пара из одного комплекта.`, `Висота відрізняється: основний ${hs[0]} px, бічний ${hs[1]} px. Потрібна пара з одного комплекту.`);
    if (layout === 'workshop' && (new Set(hs).size > 1 || new Set(ws).size > 1))
      return I(`All strips must be the same size; now: ${parts.map(p => info[p.key].width + '×' + info[p.key].height).join(', ')}.`,
               `Все полосы должны быть одного размера; сейчас: ${parts.map(p => info[p.key].width + '×' + info[p.key].height).join(', ')}.`, `Усі смуги мають бути одного розміру; зараз: ${parts.map(p => info[p.key].width + '×' + info[p.key].height).join(', ')}.`);
    return '';
  }
  function setWarning() {
    if (layout !== 'workshop') return '';
    const w = info.s1?.width;
    return w && w !== STRIP_W && !setProblem()
      ? I(`Strips are ${w} px wide; the Workshop Showcase is designed for ${STRIP_W} px, so Steam will scale them.`,
          `Ширина полос ${w} px; витрина мастерской рассчитана на ${STRIP_W} px, Steam их масштабирует.`, `Ширина смуг ${w} px; вітрина майстерні розрахована на ${STRIP_W} px, Steam їх масштабує.`) : '';
  }

  // ---------- Showcase editor reading ----------
  function selectsAll() {
    return [...new Set($$('select[name="profile_showcase[]"], select[id^="showcase_"][id$="_select"]'))];
  }
  function purchaseOf(select) {
    const index = (select.id.match(/^showcase_(\d+)_select$/) || [])[1] ??
      (String(select.dataset.slot || '').match(/^\d+$/) ? select.dataset.slot : null);
    const opt = select.selectedOptions?.[0] || null;
    const fromOption = opt?.getAttribute('data-purchaseid');
    const fromHidden = index === null ? null : $(`#showcase_${index}_purchaseid`)?.value;
    const nums = [fromOption, fromHidden].filter(v => v !== null && v !== undefined && v !== '');
    if (nums.some(x => !/^\d+$/.test(String(x)))) return null;
    if (nums.length > 1 && String(BigInt(nums[0])) !== String(BigInt(nums[1]))) { log('Conflicting purchase IDs', index, nums); return null; }
    return {index, purchase: nums.length ? String(BigInt(nums[0])) : '0', name: (opt?.textContent || '').trim()};
  }
  function previewRoots(type) {
    return $$(`#showcase_preview_${type}, [data-eshowcasetype="${type}"]`);
  }
  function rootPurchase(el) {
    const p = el.getAttribute('data-purchaseid') || el.getAttribute('data-eshowcasepurchaseid');
    return p != null && /^\d+$/.test(p) ? String(BigInt(p)) : null;
  }
  function findPreview(type, purchase) {
    const roots = previewRoots(type);
    if (!roots.length) return null;
    const exact = roots.find(el => rootPurchase(el) === purchase);
    if (exact) return exact;
    return roots.length === 1 ? roots[0] : null;
  }
  // Showcases of the given type present in the editor, in profile order.
  function showcasesOfType(type) {
    const out = [];
    for (const select of selectsAll()) {
      if (String(select.value) !== String(type)) continue;
      const p = purchaseOf(select); if (!p) continue;
      if (out.some(x => x.purchase === p.purchase)) continue;
      out.push({type, ...p, select, position: out.length + 1});
    }
    if (!out.length) {
      const root = $(`#showcase_preview_${type}, [data-eshowcasetype="${type}"]`);
      if (root) out.push({type, index: null, purchase: rootPurchase(root) || '0', name: '', select: null, position: 1});
    }
    return out;
  }
  function slotsOf(type, purchase) {
    const slots = [], thumbs = [];
    const root = findPreview(type, purchase);
    if (root) {
      for (const el of root.querySelectorAll('.showcase_slot[data-slotjson]')) {
        try {
          const obj = JSON.parse(el.getAttribute('data-slotjson') || '{}');
          if (Number.isInteger(obj.slot) && obj.slot >= 0) {
            slots[obj.slot] = String(obj.publishedfileid || '');
            thumbs[obj.slot] = safeURL(el.querySelector('img')?.getAttribute('src') || '');
          }
        } catch {}
      }
    }
    for (const el of document.querySelectorAll('input[name^="rgShowcaseConfig["]')) {
      const m = el.name.match(/^rgShowcaseConfig\[(\d+)_(\d+)\]\[(\d+)\]\[publishedfileid\]$/);
      if (m && m[1] === String(type) && String(BigInt(m[2])) === String(purchase) && !slots[Number(m[3])])
        slots[Number(m[3])] = String(el.value || '');
    }
    return {slots, thumbs};
  }
  // Current item IDs in the target showcase, one per slot of the job's layout.
  const targetSlots = (j, target) => { const s = slotsOf(L(j).type, target.purchase).slots; return partKeys(j).map((_, i) => s[i] || ''); };
  // Every item ID used by any showcase on the profile, with a human label and thumbnail.
  function usedArtwork(excludeKey = null) {
    const map = {};
    const names = {};
    const counters = {};
    for (const sel of selectsAll()) {
      const p = purchaseOf(sel); if (!p) continue;
      const t = String(sel.value);
      counters[t] = (counters[t] || 0) + 1;
      names[`${t}_${p.purchase}`] = (p.name || I('showcase', 'витрина', 'вітрина')) + (t === '13' || t === '12' ? ` №${counters[t]}` : '');
    }
    const add = (id, type, purchase, thumb) => {
      if (!okID(id)) return;
      const key = `${type}_${purchase}`;
      if (key === excludeKey) return;
      const label = names[key] || I('another showcase', 'другая витрина', 'інша вітрина');
      if (!map[id]) map[id] = {label, thumb: thumb || ''};
      else if (!map[id].thumb && thumb) map[id].thumb = thumb;
    };
    for (const el of document.querySelectorAll('.showcase_slot[data-slotjson]')) {
      const root = el.closest('[data-eshowcasetype], [id^="showcase_preview_"]');
      const type = root?.getAttribute('data-eshowcasetype') || (root?.id.match(/^showcase_preview_(\d+)$/) || [])[1] || '?';
      const purchase = (root && rootPurchase(root)) || '0';
      try {
        const obj = JSON.parse(el.getAttribute('data-slotjson') || '{}');
        add(String(obj.publishedfileid || ''), type, purchase, safeURL(el.querySelector('img')?.getAttribute('src') || ''));
      } catch {}
    }
    for (const el of document.querySelectorAll('input[name^="rgShowcaseConfig["]')) {
      const m = el.name.match(/^rgShowcaseConfig\[(\d+)_(\d+)\]\[\d+\]\[publishedfileid\]$/);
      if (m) add(String(el.value || ''), m[1], String(BigInt(m[2])), '');
    }
    return map;
  }
  function actualShowcaseForm(target) {
    const area = $('#showcases');
    const form = area?.closest('form') || target?.select?.closest('form');
    if (form && (!area || form.contains(area))) return form;
    if (!area) return null;
    const matches = $$('form').filter(f => f.contains(area));
    return matches.length === 1 ? matches[0] : null;
  }
  function actualSaveButton(target) {
    if (!$('#showcases')) return null;
    const form = actualShowcaseForm(target);
    const allowedButton = b => !b.disabled && !b.closest('#ssr-panel') && b.getAttribute('aria-disabled') !== 'true';
    const within = form ? [...form.querySelectorAll('button[type="submit"],input[type="submit"]')].filter(allowedButton) : [];
    const primary = within.filter(b => b.matches('.DialogButton.Primary, .Primary.DialogButton, input[type="submit"].Primary'));
    if (primary.length === 1) return primary[0];
    if (primary.length === 0 && within.length === 1) return within[0];
    const globalPrimary = $$('button.DialogButton.Primary[type="submit"],input.Primary[type="submit"]').filter(allowedButton);
    if (globalPrimary.length === 1) return globalPrimary[0];
    log('Save discovery ambiguous', {form: !!form, within: within.length, primary: primary.length, globalPrimary: globalPrimary.length});
    return null;
  }
  async function waitFor(fn, ms = 15000, step = 250) {
    const begin = Date.now();
    while (Date.now() - begin < ms) { const v = fn(); if (v) return v; await sleep(step); }
    return null;
  }
  function readShowcaseLevel(type, target) {
    const root = findPreview(type, target.purchase);
    const level = root?.dataset.eshowcaselevel || root?.dataset.level ||
      target.select?.closest('[data-eshowcaselevel]')?.dataset.eshowcaselevel || '1';
    return /^\d+$/.test(String(level)) && Number(level) > 0 ? Number(level) : 1;
  }
  const editorReady = () => !!($('#showcases') || selectsAll().length || $('[data-eshowcasetype], [id^="showcase_preview_"]'));

  // ---------- Step 1: choose which showcase to replace ----------
  async function pickShowcase(j) {
    j = state() || j;
    if (!isEdit() || working) return;
    working = true;
    try {
      await waitFor(editorReady, 12000);
      await sleep(600);
      const type = L(j).type, n = partKeys(j).length;
      const list = showcasesOfType(type);
      showcaseChoices = list.map(s => {
        const {slots, thumbs} = slotsOf(type, s.purchase);
        return {key: s.purchase, purchase: s.purchase, index: s.index, name: s.name, position: s.position,
          slots: Array.from({length: n}, (_, i) => slots[i] || ''), thumbs: Array.from({length: n}, (_, i) => thumbs[i] || '')};
      });
      log('Showcases found', type, showcaseChoices);
      const knownIDs = Object.keys(usedArtwork());
      if (!j.knownIDs) { j = {...j, knownIDs}; store(j); }
      if (showcaseChoices.length === 1) { working = false; return chooseShowcase(showcaseChoices[0].key); }
      if (showcaseChoices.length === 0) {
        if (allUploaded(j)) { store({...j, phase: 'need-showcase'}); return; }
        // Steam may only offer the showcase after something is uploaded,
        // so we upload first and ask to add the showcase afterwards.
        store({...j, phase: 'upload', cur: nextPart(j), target: null, oldSlots: []});
        goto(UPLOAD); return;
      }
      chosenKey = chosenKey || showcaseChoices[0].key;
      render();
    } catch (e) { halt(I('Showcase list: ', 'Список витрин: ', 'Список вітрин: ') + e.message); }
    finally { working = false; }
  }
  function chooseShowcase(key) {
    const j = state(); if (!j) return;
    const c = showcaseChoices.find(x => x.key === key); if (!c) return;
    const target = {purchase: c.purchase, index: c.index, name: c.name, position: c.position};
    const oldSlots = c.slots.filter(okID);
    const thumbs = {}; c.slots.forEach((id, i) => { if (okID(id) && c.thumbs[i]) thumbs[id] = c.thumbs[i]; });
    const uploaded = allUploaded(j);
    store({...j, target, oldSlots, thumbs: {...(j.thumbs || {}), ...thumbs},
      phase: uploaded ? 'apply' : 'upload', cur: uploaded ? j.cur : nextPart(j)});
    if (uploaded) apply(); else goto(UPLOAD);
  }

  // ---------- Step 2: upload through Steam's own form ----------
  function successID(j) {
    const p = new URLSearchParams(location.search), id = p.get('id');
    if (!okID(id)) return '';
    if (/fileuploadsuccess/i.test(location.href) || p.has('fileuploadsuccess')) return id;
    if (!/\/sharedfiles\/filedetails\/?$/.test(location.pathname)) return '';
    if (/\/sharedfiles\/edititem\/767\/3/.test(document.referrer)) return id;
    // Workshop items land on their details page ("additional work required") without the success flag.
    if (L(j).kind === 'workshop' && Date.now() - (j.submittedAt || 0) < 10 * 60000) return id;
    return '';
  }
  async function uploadOne(j) {
    if (!isUpload() || working) return;
    working = true;
    const part = L(j).parts[j.cur];
    try {
      if (!part) throw Error(I('Unknown upload step.', 'Неизвестный шаг загрузки.', 'Невідомий крок завантаження.'));
      const meta = j.meta?.[part.key];
      const f = await getFile(part.key);
      if (!f || !meta) throw Error(I('The GIF is no longer in browser storage. Press Stop and start again.', 'GIF пропал из хранилища браузера. Нажми «Остановить» и начни заново.', 'GIF зник зі сховища браузера. Натисни «Зупинити» й почни знову.'));
      const form = await waitFor(() => { const x = $('#SubmitItemForm'); return x && x.tagName === 'FORM' ? x : null; }, 14000, 300);
      if (!form) throw Error(I('Steam changed its upload form.', 'Steam изменил форму загрузки.', 'Steam змінив форму завантаження.'));
      const file = $('input[type="file"][name="file"]', form) || $('input[type="file"][name="file"]');
      const title = $('[name="title"]', form), consent = $('[name="agree_terms"]', form);
      const w = $('[name="image_width"]', form), h = $('[name="image_height"]', form);
      if (!file || !title || !consent || !w || !h) throw Error(I('Steam upload form is incomplete. Nothing was sent.', 'Форма Steam неполная. Ничего не отправлено.', 'Форма Steam неповна. Нічого не надіслано.'));
      const workshop = L(j).kind === 'workshop';
      if (workshop && !$('[name="consumer_app_id"]', form)) throw Error(I('Steam upload form has no Workshop field. Nothing was sent.', 'В форме Steam нет поля мастерской. Ничего не отправлено.', 'У формі Steam немає поля майстерні. Нічого не надіслано.'));
      const transfer = new DataTransfer();
      transfer.items.add(f instanceof File ? f : new File([f], meta.name, {type: 'image/gif'}));
      file.files = transfer.files;
      file.dispatchEvent(new Event('change', {bubbles: true}));
      title.value = TITLE; title.dispatchEvent(new Event('input', {bubbles: true}));
      consent.checked = true; consent.dispatchEvent(new Event('change', {bubbles: true}));
      const set = (name, value) => { const e = $(`[name="${name}"]`, form); if (e) e.value = String(value); };
      set('visibility', 0); set('cloudfilenameprefix', Math.trunc(Date.now() / 1000) + '_');
      if (workshop) { set('consumer_app_id', WORKSHOP_APP); set('file_type', 0); }  // community Workshop item
      else set('file_type', 3);                                                       // artwork
      const vis = $('#Visibility0', form); if (vis) { vis.checked = true; vis.dispatchEvent(new Event('change', {bubbles: true})); }
      await waitFor(() => +w.value === meta.width && +h.value === meta.height, 7500, 250);
      await sleep(400);
      if (!file.files || file.files.length !== 1) throw Error(I('Steam cleared the selected file.', 'Steam сбросил выбранный файл.', 'Steam скинув обраний файл.'));
      if (workshop) {
        // Steam may re-apply defaults on change events; enforce the Workshop fields right before sending.
        set('consumer_app_id', WORKSHOP_APP); set('file_type', 0); set('visibility', 0);
      } else {
        w.value = '1000'; h.value = '1'; w.removeAttribute('id'); h.removeAttribute('id');
      }
      store({...j, phase: 'pending', submittedAt: Date.now()});
      log('Submitting GIF', part.key, meta.name, workshop ? 'as Workshop item' : 'as artwork');
      HTMLFormElement.prototype.submit.call(form);
    } catch (e) { halt(I('Upload ', 'Загрузка ', 'Завантаження ') + (part?.short || '?') + ': ' + e.message); }
    finally { working = false; }
  }
  function gotID(id) {
    const j = state(); if (!j || !okID(id) || !['pending', 'recover'].includes(j.phase)) return;
    const key = partKeys(j)[j.cur]; if (!key) return;
    const next = {...j, ids: {...(j.ids || {}), [key]: id}};
    const n = nextPart(next);
    if (n >= 0) { store({...next, phase: 'upload', cur: n}); goto(UPLOAD); }
    else { store({...next, phase: 'apply'}); goto(EDIT); }
  }

  // ---------- Gallery helpers ----------
  function galleryID(el) {
    const trial = [el, ...$$('[data-publishedfileid],a[onclick],a[href],input[name]', el)];
    for (const node of trial) {
      const d = node.getAttribute('data-publishedfileid'); if (okID(d)) return d;
      const on = node.getAttribute('onclick') || '';
      let m = on.match(/OnScreenshotClicked\(\s*['"]?(\d{7,20})/); if (m) return m[1];
      const n = node.getAttribute('name') || '';
      m = n.match(/screenshots\[(\d{7,20})\]/); if (m) return m[1];
      const href = node.getAttribute('href') || '';
      try {
        const u = new URL(href, location.href);
        if (u.origin === location.origin && /\/sharedfiles\/(?:filedetails|itemedittext)\/?$/.test(u.pathname) && okID(u.searchParams.get('id')))
          return u.searchParams.get('id');
      } catch {}
    }
    return '';
  }
  function galleryNodes() {
    const base = $$('.profile_media_item, .imgWallItem, a[onclick*="OnScreenshotClicked"], [data-publishedfileid]')
      .filter(e => !e.closest('#ssr-panel'));
    const out = new Map();
    for (const e of base) {
      const id = galleryID(e); if (!okID(id)) continue;
      const item = e.closest('.profile_media_item, .imgWallItem') || e;
      const title = (item.getAttribute('title') || item.textContent || '').trim().slice(0, 60);
      const img = item.querySelector('img');
      // Steam's gallery src is a 1-px strip (imh=1); the first srcset entry is a proper preview.
      const fromSet = (img?.getAttribute('srcset') || '').split(',')[0].trim().split(/\s+/)[0];
      const thumb = safeURL(fromSet || '');
      if (!out.has(id)) out.set(id, {id, title, thumb, el: item});
    }
    return [...out.values()];
  }
  async function loadWholeGallery() {
    let last = -1, steady = 0;
    for (let n = 0; n < 40 && steady < 4; n++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(500);
      const count = galleryNodes().length;
      if (last === count) steady++; else steady = 0;
      last = count;
    }
    window.scrollTo(0, 0);
    galleryLoaded = true;
  }

  // Recovery when Steam did not confirm an upload: find the newest untitled item.
  async function recoverScan(j) {
    if (!onList(j) || working) return;
    working = true;
    try {
      await loadWholeGallery();
      const known = new Set([...(j.oldSlots || []), ...(j.knownIDs || []), ...idList(j)].filter(Boolean));
      const cand = galleryNodes().find(x => blankTitle(x.title) && !known.has(x.id));
      recoverCandidate = cand ? {id: cand.id} : {none: true};
      log('Recovery candidate', partKeys(j)[j.cur], recoverCandidate);
      render();
      if (cand) hydrateThumbs([cand.id]);
    } catch (e) { halt(e.message); }
    finally { working = false; }
  }

  // ---------- Step 3: put all parts into the showcase and save ----------
  async function apply() {
    if (!isEdit() || working) return;
    let j = state();
    if (!j || j.phase !== 'apply' || !allUploaded(j)) return;
    if (!allowed(j)) return halt(I('A different Steam account is signed in.', 'Открыт другой аккаунт Steam.', 'Відкрито інший акаунт Steam.'));
    working = true;
    try {
      const type = L(j).type;
      await waitFor(editorReady, 12000);
      await sleep(400);
      let list = showcasesOfType(type);
      for (let i = 0; !list.length && i < 20; i++) { await sleep(350); list = showcasesOfType(type); }
      if (j.target && !list.some(s => s.purchase === j.target.purchase) && list.length !== 1) { j = {...j, target: null}; store(j); }
      if (!j.target) {
        if (!list.length) { store({...j, phase: 'need-showcase'}); return; }
        if (list.length > 1) { working = false; store({...j, phase: 'pick-showcase'}); await pickShowcase(state()); return; }
        const s = list[0];
        j = {...j, target: {purchase: s.purchase, index: s.index, name: s.name, position: 1},
          oldSlots: targetSlots(j, s).filter(okID)};
        store(j);
      }
      const target = list.find(s => s.purchase === j.target.purchase) || (list.length === 1 ? list[0] : null);
      if (!target) throw Error(I(`${showcaseName(j)} not found. Your GIFs are uploaded; press Retry.`, `${showcaseName(j)} не найдена. GIF уже загружены; нажми «Повторить».`, `${showcaseName(j)}: не знайдено. GIF уже завантажені; натисни «Повторити».`));
      const ids = idList(j);
      const save = await waitFor(() => { const b = actualSaveButton(target); return b && b.isConnected ? b : null; });
      if (!save) throw Error(I('Steam Save button not found. GIFs are uploaded; nothing was deleted.', 'Не найдена кнопка сохранения Steam. GIF загружены, ничего не удалено.', 'Не знайдено кнопку збереження Steam. GIF завантажені, нічого не видалено.'));
      const nativePreview = sw.PreviewShowcaseConfigWithSlotChange;
      if (typeof nativePreview !== 'function')
        throw Error(I('Steam showcase editor is unavailable (layout changed?). GIFs are uploaded; you can place them manually.', 'Редактор витрин Steam недоступен (изменилась разметка?). GIF загружены, их можно поставить вручную.', 'Редактор вітрин Steam недоступний (змінилася розмітка?). GIF завантажені, їх можна поставити вручну.'));
      const level = readShowcaseLevel(type, target);
      log('Applying', {type, purchase: target.purchase, level, ids});
      for (let slot = 0; slot < ids.length; slot++) {
        if (targetSlots(j, target)[slot] === ids[slot]) continue;
        await Promise.resolve(nativePreview.call(sw, type, Number(target.purchase), level, slot, {publishedfileid: ids[slot]}));
        if (!await waitFor(() => targetSlots(j, target)[slot] === ids[slot], 16000))
          throw Error(I(`Steam did not accept item ${ids[slot]} in slot ${slot + 1}; nothing was saved.`, `Steam не принял работу ${ids[slot]} в место ${slot + 1}; ничего не сохранено.`, `Steam не прийняв роботу ${ids[slot]} у місце ${slot + 1}; нічого не збережено.`));
      }
      const current = targetSlots(j, target);
      if (current.some((id, i) => id !== ids[i]))
        throw Error(I(`Steam shows ${current.join('/')} instead of ${ids.join('/')}.`, `Steam показывает ${current.join('/')} вместо ${ids.join('/')}.`, `Steam показує ${current.join('/')} замість ${ids.join('/')}.`));
      const realSave = await waitFor(() => actualSaveButton(showcasesOfType(type).find(s => s.purchase === target.purchase) || target));
      if (!realSave) throw Error(I('Steam redrew the editor and Save is unavailable.', 'Steam перерисовал редактор, кнопка сохранения недоступна.', 'Steam перемалював редактор, кнопка збереження недоступна.'));
      store({...j, phase: 'verify-showcase', appliedAt: Date.now()});
      log('All slots confirmed in preview; clicking Save');
      let leaving = false;
      window.addEventListener('beforeunload', () => { leaving = true; }, {once: true});
      realSave.click();
      // Wait for Steam to finish saving (navigation or the button settling), then re-open to verify.
      await sleep(2500);
      await waitFor(() => leaving || !actualSaveButton(target), 9000, 300);
      if (!leaving && isEdit() && state()?.phase === 'verify-showcase')
        location.assign(EDIT + '?ssr_verify=' + Date.now());
    } catch (e) {
      halt(I('Showcase: ', 'Витрина: ', 'Вітрина: ') + e.message);
    } finally { working = false; }
  }
  async function verifyShowcase() {
    if (!isEdit()) return;
    const j = state(); if (!j || j.phase !== 'verify-showcase') return;
    await waitFor(editorReady, 12000);
    const type = L(j).type, ids = idList(j);
    for (let i = 0; i < 24; i++) {
      const target = showcasesOfType(type).find(s => s.purchase === j.target?.purchase);
      if (target) {
        const s = targetSlots(j, target);
        if (s.every((id, k) => id === ids[k])) {
          const used = usedArtwork(`${type}_${target.purchase}`);
          store({...j, phase: 'done', fresh: true, used, finishedAt: Date.now()});
          await wipeFiles().catch(console.warn);
          await sleep(800);
          goto(PROFILE);
          return;
        }
      }
      await sleep(500);
    }
    halt(I('After reloading, Steam does not show the new artwork yet. GIFs are uploaded — do not upload them again; press Retry.',
           'После перезагрузки Steam пока не показывает новую работу. GIF загружены — не загружай их снова, нажми «Повторить».', 'Після перезавантаження Steam поки не показує нову роботу. GIF завантажені — не завантажуй їх знову, натисни «Повторити».'));
  }

  // ---------- Optional cleanup of old artwork ----------
  function buildGroups(j) {
    const protect = new Set(idList(j).filter(okID));
    const used = j.used || {};
    const old = new Set((j.oldSlots || []).map(String));
    const g = {replaced: [], free: [], other: []};
    for (const n of galleryNodes()) {
      if (protect.has(n.id)) continue;
      const good = (j.thumbs || {})[n.id] || used[n.id]?.thumb || n.thumb || '';
      const item = {id: n.id, title: blankTitle(n.title) ? '' : n.title, thumb: good, good: !!good};
      if (used[n.id]) g.other.push({...item, where: used[n.id].label});
      else if (old.has(n.id)) g.replaced.push(item);
      else g.free.push(item);
    }
    return g;
  }
  async function cleanupScan() {
    if (!isGallery() || working) return;
    working = true;
    try {
      await loadWholeGallery();
      const j = state(); if (!j) return;
      if (j.phase === 'cleanup-verify') {
        if (j.cleanAction === 'private') { store({...j, phase: 'cleaned', cleaned: (j.toDelete || []).length}); return; }
        const left = galleryNodes().filter(x => (j.toDelete || []).includes(x.id));
        if (left.length) halt(I('Steam still lists: ', 'Steam всё ещё показывает: ', 'Steam досі показує: ') + left.map(x => x.id).join(', ') +
          I('. Reload the page and check; deletion is not repeated automatically.', '. Обнови страницу и проверь; удаление автоматически не повторяется.', '. Онови сторінку й перевір; видалення автоматично не повторюється.'));
        else store({...j, phase: 'cleaned', cleaned: (j.toDelete || []).length});
        return;
      }
      groups = buildGroups(j);
      picks = new Set(groups.replaced.map(x => x.id));
      log('Cleanup groups', groups);
      render();
      hydrateThumbs([...groups.replaced, ...groups.free, ...groups.other].filter(x => !x.good).map(x => x.id));
    } catch (e) { halt(I('Gallery: ', 'Галерея: ', 'Галерея: ') + e.message); }
    finally { working = false; }
  }
  function nativeFormIDs(form) {
    const found = new Set();
    for (const [key, val] of new FormData(form).entries()) {
      if (!/screenshot|publishedfile/i.test(key)) continue;
      const m = key.match(/\[(\d{7,20})\]/); if (m) found.add(m[1]);
      if (/screenshots\[\]|screenshots|publishedfileids/i.test(key) && okID(val)) found.add(String(val));
    }
    for (const inp of $$('input[type="checkbox"]:checked', form)) {
      const m = (inp.name + ' ' + inp.id).match(/(?:screenshot|publishedfile)[^\d]*(\d{7,20})/i);
      if (m) found.add(m[1]);
    }
    if (!found.size) {
      for (const tile of galleryNodes()) {
        if (tile.el.matches('.selected, .screenshot_selected, .imgWallItemSelected') ||
          tile.el.querySelector('.selected, .screenshot_selected, .imgWallItemSelected, input[type="checkbox"]:checked'))
          found.add(tile.id);
      }
    }
    return [...found];
  }
  // action: 'private' (hide — reversible, removes the +N counter for visitors) or 'delete' (permanent).
  async function batchOld(action) {
    if (!isGallery() || working) return;
    const j = state(); if (!j || j.phase !== 'cleanup' || !galleryLoaded || !groups) return;
    const chosen = [...picks];
    const allowedIDs = new Set([...groups.replaced, ...groups.free].map(x => x.id));
    const protect = new Set(idList(j).filter(okID));
    if (!chosen.length) return report(I('Nothing is ticked.', 'Ничего не отмечено.', 'Нічого не позначено.'), true);
    if (chosen.some(id => protect.has(id) || !allowedIDs.has(id))) return halt(I('Artwork ID mismatch; canceled.', 'Несовпадение ID, отменено.', 'Невідповідність ID, скасовано.'));
    const hide = action === 'private';
    const question = hide
      ? I(`Hide ${chosen.length} artwork(s)?\n\nThey stay in Steam with visibility "Only me". Visitors will no longer see them or the +N counter. You can make them public again in your gallery at any time.`,
          `Скрыть работ: ${chosen.length}?\n\nОни останутся в Steam с видимостью «Только я». Гости больше не увидят их и счётчик +N. Вернуть видимость можно в любой момент в галерее.`, `Приховати робіт: ${chosen.length}?\n\nВони залишаться в Steam з видимістю «Тільки я». Гості більше не бачитимуть їх і лічильник +N. Повернути видимість можна будь-коли в галереї.`)
      : I(`Permanently delete ${chosen.length} artwork(s) from Steam?\n\n${chosen.join('\n')}\n\nThis cannot be undone. Keep your own copies of anything you want to reuse.`,
          `Безвозвратно удалить из Steam работ: ${chosen.length}?\n\n${chosen.join('\n')}\n\nОтменить это нельзя. Сохрани у себя копии того, что захочешь использовать снова.`, `Безповоротно видалити зі Steam робіт: ${chosen.length}?\n\n${chosen.join('\n')}\n\nСкасувати це неможливо. Збережи в себе копії того, що захочеш використати знову.`);
    if (!window.confirm(question)) return;
    working = true;
    try {
      if (typeof sw.OnScreenshotClicked !== 'function' || typeof sw.ConfirmBatchAction !== 'function')
        throw Error(I('Steam management functions are unavailable.', 'Не найдены функции управления Steam.', 'Не знайдено функцій керування Steam.'));
      const form = $('#BatchScreenshotManagement');
      if (!form || form.tagName !== 'FORM') throw Error(I('Steam deletion form was not found.', 'Не найдена форма удаления Steam.', 'Не знайдено форму видалення Steam.'));
      if (form.action && new URL(form.action, location.href).origin !== location.origin) throw Error(I('Unexpected form destination.', 'Неожиданный адрес формы.', 'Неочікувана адреса форми.'));
      if (nativeFormIDs(form).length) throw Error(I('Some items are already selected in Steam. Reload the page.', 'В Steam уже отмечены работы. Обнови страницу.', 'У Steam уже позначено роботи. Онови сторінку.'));
      if (typeof sw.ToggleManagementMode === 'function') sw.ToggleManagementMode();
      else if ($('#ScreenshotManagementToggle')) $('#ScreenshotManagementToggle').click();
      else throw Error(I('Could not enable management mode.', 'Не удалось включить режим управления.', 'Не вдалося увімкнути режим керування.'));
      for (const id of chosen) sw.OnScreenshotClicked(id);
      const selected = nativeFormIDs(form);
      if (selected.length !== chosen.length || selected.some(id => !chosen.includes(id)) || chosen.some(id => !selected.includes(id)))
        throw Error(I('Steam selected a different set; deletion canceled. Reload the page.', 'Steam выделил другой набор; удаление отменено. Обнови страницу.', 'Steam виділив інший набір; видалення скасовано. Онови сторінку.'));
      const answer = sw.ConfirmBatchAction(action);
      if (answer === false) { report(I('Canceled in Steam.', 'Отменено в Steam.', 'Скасовано в Steam.')); return; }
      const field = $('#BatchScreenshotManagementAction', form) || $('input[name="action"]', form);
      if (field && field.value !== action) throw Error(I('Steam did not accept the action; nothing was sent. Reload the page.', 'Steam не принял действие; ничего не отправлено. Обнови страницу.', 'Steam не прийняв дію; нічого не надіслано. Онови сторінку.'));
      if (deletionStarted) throw Error(I('Repeated submission blocked.', 'Повторная отправка заблокирована.', 'Повторне надсилання заблоковано.'));
      deletionStarted = true;
      store({...j, phase: 'cleanup-verify', toDelete: chosen, cleanAction: action});
      if (typeof sw.hideModal === 'function') { try { sw.hideModal('confirmBatchModal'); } catch {} }
      HTMLFormElement.prototype.submit.call(form);
    } catch (e) {
      if (!deletionStarted) report(e.message, true); else halt(e.message);
    } finally { working = false; }
  }

  // ---------- Start / stop ----------
  async function start() {
    if (working) return;
    const parts = LAYOUTS[layout].parts;
    if (!owner()) return report(I('Sign in to Steam Community first.', 'Сначала войди в Steam Community.', 'Спершу увійди в Steam Community.'), true);
    if (parts.some(p => !files[p.key])) return report(I('Choose all GIFs.', 'Выбери все GIF.', 'Обери всі GIF.'), true);
    const p = setProblem(); if (p) return report(p, true);
    if (!rightsOK) return report(I('Tick the permission checkbox.', 'Отметь галочку о праве публикации.', 'Познач галочку про право публікації.'), true);
    working = true;
    try {
      await wipeFiles().catch(() => {});
      const meta = {};
      for (const part of parts) { await writeFile(part.key, files[part.key]); meta[part.key] = info[part.key]; }
      const j = {version: 4, layout, phase: 'pick-showcase', steamID: owner(), created: Date.now(),
        meta, ids: {}, cur: 0, target: null, oldSlots: [], thumbs: {}};
      store(j); goto(EDIT);
    } catch (e) { report(e.message, true); }
    finally { working = false; }
  }
  async function finish() {
    try { localStorage.removeItem(K); } catch {}
    await wipeFiles().catch(() => {});
    message = ''; groups = null; recoverCandidate = null; picks.clear();
    for (const k of Object.keys(previews)) if (previews[k]) URL.revokeObjectURL(previews[k]);
    files = {}; info = {}; errs = {}; previews = {};
    rightsOK = false; open = false; render();
  }
  function retry() {
    const j = state(); if (!j) return;
    const from = j.pausedFrom || '';
    message = '';
    const to = {
      'pick-showcase': ['pick-showcase', EDIT], 'upload': ['upload', UPLOAD],
      'apply': ['apply', EDIT], 'verify-showcase': ['verify-showcase', EDIT], 'need-showcase': ['apply', EDIT],
      'recover': ['recover', listURL(j)],
      'cleanup': ['cleanup', GALLERY], 'cleanup-verify': ['cleanup-verify', GALLERY],
    }[from];
    if (!to) { setPhase('done'); return; }
    store({...j, phase: to[0]});
    if (location.href.split('?')[0] === to[1].split('?')[0]) location.reload(); else goto(to[1]);
  }

  // ---------- UI ----------
  const partLabel = j => { const p = L(j).parts[j?.cur]; return p ? (L(j).kind === 'workshop' ? I(`strip ${p.short} of 5`, `полоса ${p.short} из 5`, `смуга ${p.short} з 5`) : I(p.short + ' GIF', p.key === 'main' ? 'основной GIF' : 'боковой GIF', p.key === 'main' ? 'основний GIF' : 'бічний GIF')) : ''; };
  const STEPS = {
    'pick-showcase': [1, () => I('Choose showcase', 'Выбор витрины', 'Вибір вітрини')],
    'upload': [2, j => I(`Uploading ${partLabel(j)}`, `Загрузка: ${partLabel(j)}`, `Завантаження: ${partLabel(j)}`)],
    'pending': [2, () => I('Waiting for Steam', 'Ждём Steam', 'Чекаємо на Steam')],
    'recover': [2, () => I('Finding the upload', 'Поиск загрузки', 'Пошук завантаження')],
    'apply': [3, () => I('Placing in showcase', 'Установка в витрину', 'Встановлення у вітрину')],
    'need-showcase': [3, () => I('Add the showcase', 'Добавь витрину', 'Додай вітрину')],
    'verify-showcase': [3, () => I('Checking the result', 'Проверка результата', 'Перевірка результату')],
  };
  function thumbBox(url, cls = '', id = '') {
    const real = id && thumbCache[id];
    const src = real ? sized(real) : url;
    return `<span class="ssr-thumb ${cls}"><img ${src ? `src="${safe(src)}"` : ''} ${real ? `data-orig="${safe(real)}"` : ''} ${id ? `data-tid="${safe(id)}"` : ''} alt=""></span>`;
  }
  function fileStatus(key) {
    const m = info[key];
    if (errs[key]) return `<span class="ssr-bad">✗ ${safe(errs[key])}</span>`;
    if (m?.width) return `<span class="ssr-ok">✓ ${m.width}×${m.height}, ${mb(m.size)}</span>` +
      (m.size > SOFT_LIMIT ? `<br><span class="ssr-warn">${I('Over 5 MB: Steam sometimes rejects such files.', 'Больше 5 МБ: Steam иногда отклоняет такие файлы.', 'Понад 5 МБ: Steam іноді відхиляє такі файли.')}</span>` : '');
    return `<span class="ssr-muted">${I('not chosen', 'не выбран', 'не обрано')}</span>`;
  }
  function fileField(part) {
    const key = part.key, m = info[key];
    return `<div class="ssr-file">
      ${previews[key] ? `<span class="ssr-thumb ssr-${key}"><img src="${previews[key]}" alt=""></span>` : `<span class="ssr-thumb ssr-empty ssr-${key}">GIF</span>`}
      <div class="ssr-file-info"><div class="ssr-file-label">${I(part.en, part.ru, part.uk)}</div>
        <div class="ssr-file-name">${safe(m?.name || '')}</div><div>${fileStatus(key)}</div>
        <button type="button" class="ssr-btn" data-pick-file="${key}">${m ? I('Change', 'Заменить', 'Замінити') : I('Choose file', 'Выбрать файл', 'Обрати файл')}</button>
        <input type="file" id="ssr-in-${key}" accept=".gif,image/gif" hidden>
      </div></div>`;
  }
  function stripsField() {
    const parts = LAYOUTS.workshop.parts;
    const any = parts.some(p => info[p.key]);
    const bad = parts.filter(p => errs[p.key]);
    return `<div class="ssr-file ssr-multi">
      <div class="ssr-strips">${parts.map(p => `<span class="ssr-strip ${errs[p.key] ? 'bad' : files[p.key] ? 'ok' : ''}" title="${safe(info[p.key]?.name || '')}">
        ${previews[p.key] ? `<img src="${previews[p.key]}" alt="">` : ''}<b>${p.short}</b></span>`).join('')}</div>
      <div class="ssr-file-info"><div class="ssr-file-label">${I('5 strips, left to right', '5 полос, слева направо', '5 смуг, зліва направо')}</div>
        <small>${I(`Select all 5 GIFs at once. They are ordered by file name (…_1 … …_5). Recommended width: ${STRIP_W} px.`,
                   `Выбери все 5 GIF сразу. Порядок — по имени файла (…_1 … …_5). Рекомендуемая ширина: ${STRIP_W} px.`, `Обери всі 5 GIF одразу. Порядок — за назвою файлу (…_1 … …_5). Рекомендована ширина: ${STRIP_W} px.`)}</small>
        ${any && !bad.length && parts.every(p => files[p.key]) && !setProblem() ? `<div class="ssr-ok">✓ ${info.s1.width}×${info.s1.height}</div>` : ''}
        ${bad.map(p => `<div class="ssr-bad">✗ ${p.short}: ${safe(errs[p.key])}</div>`).join('')}
        <button type="button" class="ssr-btn" id="ssr-pick-many">${any ? I('Choose again', 'Выбрать заново', 'Обрати знову') : I('Choose 5 files', 'Выбрать 5 файлов', 'Обрати 5 файлів')}</button>
        <input type="file" id="ssr-in-many" accept=".gif,image/gif" multiple hidden>
      </div></div>`;
  }
  function itemTile(x, checkable, note = '') {
    const checked = picks.has(x.id) ? 'checked' : '';
    return `<label class="ssr-tile ${checkable ? '' : 'ssr-locked'} ${checked ? 'on' : ''}" title="ID ${x.id}">
      ${thumbBox(x.good ? x.thumb : '', 'ssr-card', x.good ? '' : x.id) /* gallery strip is not useful */}
      <span class="ssr-tile-bar">${checkable ? `<input type="checkbox" data-del="${x.id}" ${checked}>` : '<span>🔒</span>'}
        <a href="${itemURL(x.id)}" target="_blank" rel="noopener" title="${I('Open on Steam', 'Открыть в Steam', 'Відкрити в Steam')}">↗</a></span>
      <small>${safe(note || x.title || I('untitled', 'без названия', 'без назви'))}</small></label>`;
  }
  function body(j) {
    if (mgr) return managerBody();
    const step = j?.phase || 'idle';
    const s = STEPS[step];
    let h = '';
    if (s) h += `<div class="ssr-steps">${[1, 2, 3].map(n => `<span class="${n < s[0] ? 'done' : n === s[0] ? 'now' : ''}">${n}</span>`).join('')}<b>${safe(s[1](j))}</b></div>`;
    if (message) h += `<div class="ssr-note ${messageErr ? 'ssr-note-bad' : ''}">${safe(message)}</div>`;

    if (step === 'idle') {
      if (!owner()) h += `<div class="ssr-note ssr-note-bad">${I('Sign in to Steam Community to use this.', 'Войди в Steam Community, чтобы начать.', 'Увійди в Steam Community, щоб почати.')}</div>`;
      h += `<div class="ssr-tabs"><button type="button" data-layout="artwork" class="${layout === 'artwork' ? 'active' : ''}">${I('Artwork · 2 GIFs', 'Иллюстрации · 2 GIF', 'Ілюстрації · 2 GIF')}</button>
        <button type="button" data-layout="workshop" class="${layout === 'workshop' ? 'active' : ''}">${I('Workshop · 5 strips', 'Мастерская · 5 полос', 'Майстерня · 5 смуг')}</button></div>`;
      if (layout === 'artwork') {
        h += `<p>${I('Choose the two GIFs from your artwork set — the script uploads them and puts them into your Artwork Showcase. Nothing is deleted.',
                     'Выбери два GIF из комплекта — скрипт загрузит их и поставит в витрину иллюстраций. Ничего не удаляется.', 'Обери два GIF з комплекту — скрипт завантажить їх і поставить у вітрину ілюстрацій. Нічого не видаляється.')}</p>`;
        h += LAYOUTS.artwork.parts.map(fileField).join('');
      } else {
        h += `<p>${I('Choose the five strips from your set — the script uploads them as Workshop items and puts them into your Workshop Showcase. Nothing is deleted.',
                     'Выбери пять полос из комплекта — скрипт загрузит их как предметы мастерской и поставит в витрину мастерской. Ничего не удаляется.', 'Обери п’ять смуг з комплекту — скрипт завантажить їх як предмети майстерні й поставить у вітрину майстерні. Нічого не видаляється.')}</p>`;
        h += stripsField();
        h += `<button type="button" class="ssr-link ssr-mgr-link" id="ssr-mgr-open">${I('My Workshop strips: review and delete old ones →', 'Мои полосы мастерской: обзор и удаление старых →', 'Мої смуги майстерні: огляд і видалення старих →')}</button>`;
      }
      const p = setProblem(); if (p) h += `<div class="ssr-note ssr-note-bad">${safe(p)}</div>`;
      const wn = setWarning(); if (wn) h += `<div class="ssr-note">${safe(wn)}</div>`;
      const ready = LAYOUTS[layout].parts.every(x => files[x.key]) && !p && owner();
      h += `<label class="ssr-check"><input type="checkbox" id="ssr-rights" ${rightsOK ? 'checked' : ''}> ${I('I have the right to publish these GIFs', 'У меня есть право публиковать эти GIF', 'Я маю право публікувати ці GIF')}</label>
        <button type="button" class="ssr-btn ssr-primary" id="ssr-start" ${ready && rightsOK ? '' : 'disabled'}>${I('Install to my showcase', 'Установить в витрину', 'Встановити у вітрину')}</button>`;
    }
    if (step === 'pick-showcase') {
      const ws = L(j).kind === 'workshop';
      if (showcaseChoices.length > 1) {
        h += `<p>${ws ? I('Your profile has several Workshop Showcases. Which one should get the new artwork?', 'В профиле несколько витрин мастерской. В какую поставить новую работу?', 'У профілі кілька вітрин майстерні. У яку поставити нову роботу?')
                      : I('Your profile has several Artwork Showcases. Which one should get the new artwork?', 'В профиле несколько витрин иллюстраций. В какую поставить новую работу?', 'У профілі кілька вітрин ілюстрацій. У яку поставити нову роботу?')}</p><div class="ssr-choices">`;
        for (const c of showcaseChoices) {
          const thumbs = ws ? c.thumbs.map(t => thumbBox(t, 'ssr-mini')).join('') : thumbBox(c.thumbs[0], 'ssr-main') + thumbBox(c.thumbs[1], 'ssr-side');
          h += `<label class="ssr-choice ${chosenKey === c.key ? 'sel' : ''}"><input type="radio" name="ssr-sc" value="${safe(c.key)}" ${chosenKey === c.key ? 'checked' : ''}>
            <span class="ssr-pair">${thumbs}</span>
            <span><b>${showcaseName(j)} №${c.position}</b><small>${I(`#${c.position} from the top among these showcases`, `${c.position}-я сверху среди таких витрин`, `${c.position}-а згори серед таких вітрин`)}</small>
            ${c.slots.some(okID) ? '' : `<small>${I('empty', 'пустая', 'порожня')}</small>`}</span></label>`;
        }
        h += `</div><button type="button" class="ssr-btn ssr-primary" id="ssr-choose">${I('Use this showcase', 'Ставить сюда', 'Ставити сюди')}</button>`;
      } else h += `<p>${I('Reading your showcases…', 'Читаю витрины профиля…', 'Читаю вітрини профілю…')}</p>`;
    }
    if (['upload', 'apply', 'verify-showcase'].includes(step) || (step === 'pending' && !pendingStuck))
      h += `<p>${I('Working automatically. Keep this tab open — it takes about a minute.', 'Всё идёт автоматически. Не закрывай вкладку — это около минуты.', 'Усе йде автоматично. Не закривай вкладку — це близько хвилини.')}</p>`;
    if (step === 'pending' && pendingStuck) {
      h += `<p>${I('Steam did not confirm the upload. If Steam shows an error on the page, read it first.', 'Steam не подтвердил загрузку. Если на странице есть ошибка Steam — прочитай её.', 'Steam не підтвердив завантаження. Якщо на сторінці є помилка Steam — прочитай її.')}</p>
        <button type="button" class="ssr-btn ssr-primary" id="ssr-find">${I('Look for it in my uploads', 'Найти в моих загрузках', 'Знайти в моїх завантаженнях')}</button>
        <button type="button" class="ssr-btn" id="ssr-reupload">${I('Upload again', 'Загрузить ещё раз', 'Завантажити ще раз')}</button>`;
    }
    if (step === 'recover') {
      const part = partLabel(j);
      if (!recoverCandidate) h += `<p>${I('Looking through your uploads…', 'Просматриваю твои загрузки…', 'Переглядаю твої завантаження…')}</p>`;
      else if (recoverCandidate.none) h += `<p>${I('No new untitled item found — the upload did not go through.', 'Новой работы без названия нет — загрузка не прошла.', 'Нової роботи без назви немає — завантаження не пройшло.')}</p>
        <button type="button" class="ssr-btn ssr-primary" id="ssr-reupload">${I('Upload again', 'Загрузить ещё раз', 'Завантажити ще раз')}</button>`;
      else h += `<p>${I(`Is this the ${part} you just uploaded?`, `Это только что загруженный файл (${part})?`, `Це щойно завантажений файл (${part})?`)}</p>
        <div class="ssr-tile ssr-big">${thumbBox('', '', recoverCandidate.id)}<a href="${itemURL(recoverCandidate.id)}" target="_blank" rel="noopener">${I('Open', 'Открыть', 'Відкрити')} ↗</a></div>
        <button type="button" class="ssr-btn ssr-primary" id="ssr-yes">${I('Yes, continue', 'Да, продолжить', 'Так, продовжити')}</button>
        <button type="button" class="ssr-btn" id="ssr-reupload">${I('No, upload again', 'Нет, загрузить заново', 'Ні, завантажити знову')}</button>`;
    }
    if (step === 'need-showcase') {
      h += `<p>${I(`Your profile has no ${showcaseName(j)} yet. Your GIFs are already uploaded.`, `В профиле пока нет витрины: «${showcaseName(j)}». GIF уже загружены.`, `У профілі поки немає вітрини: «${showcaseName(j)}». GIF уже завантажені.`)}</p>
        <ol class="ssr-ol"><li>${I(`On this page, add a showcase and choose <b>${showcaseName(j)}</b>.`, `На этой странице добавь витрину и выбери <b>${showcaseName(j)}</b>.`, `На цій сторінці додай вітрину й обери <b>${showcaseName(j)}</b>.`)}</li>
        <li>${I('Press the button below.', 'Нажми кнопку ниже.', 'Натисни кнопку нижче.')}</li></ol>
        <button type="button" class="ssr-btn ssr-primary" id="ssr-continue">${I('Done, continue', 'Добавил, продолжить', 'Додав, продовжити')}</button>`;
    }
    if (step === 'done') {
      h += `<div class="ssr-success">✓ ${I('Your showcase is updated!', 'Витрина обновлена!', 'Вітрину оновлено!')}</div>
        <p>${I('If you still see the old picture, wait a few seconds and press Ctrl+F5.', 'Если видишь старую картинку — подожди пару секунд и нажми Ctrl+F5.', 'Якщо бачиш стару картинку — зачекай кілька секунд і натисни Ctrl+F5.')}</p>`;
      if (L(j).kind === 'artwork')
        h += `<p class="ssr-muted">${I('See a "+N" tile under the showcase? Those are your other public artworks. You can hide them — optional.', 'Видишь плитку «+N» под витриной? Это другие публичные работы. Их можно скрыть — по желанию.', 'Бачиш плитку «+N» під вітриною? Це інші публічні роботи. Їх можна приховати — за бажанням.')}</p>
        <button type="button" class="ssr-btn" id="ssr-cleanup">${I('Hide old artwork (+N)', 'Скрыть старые работы (+N)', 'Приховати старі роботи (+N)')}</button>`;
      if (L(j).kind === 'workshop')
        h += `<p class="ssr-muted">${I('Old strips stay in Steam as Workshop items. You can review and delete them — optional.', 'Старые полосы остались в Steam как предметы мастерской. Их можно посмотреть и удалить — по желанию.', 'Старі смуги залишилися в Steam як предмети майстерні. Їх можна переглянути й видалити — за бажанням.')}</p>
        <button type="button" class="ssr-btn" id="ssr-mgr-open">${I('Review old strips', 'Посмотреть старые полосы', 'Переглянути старі смуги')}</button>`;
      h += `<button type="button" class="ssr-btn ssr-primary" id="ssr-finish">${I('Close', 'Закрыть', 'Закрити')}</button>`;
    }
    if (step === 'cleanup' || step === 'cleanup-verify') {
      if (step === 'cleanup-verify' || !galleryLoaded || !groups) h += `<p>${I('Loading your artwork gallery…', 'Загружаю галерею работ…', 'Завантажую галерею робіт…')}</p>`;
      else {
        const sec = (title, hint, list, checkable, key) => !list.length ? '' :
          `<div class="ssr-group"><div class="ssr-group-head"><b>${title} (${list.length})</b>
            ${checkable ? `<span><button type="button" class="ssr-link" data-all="${key}">${I('all', 'все', 'усі')}</button> · <button type="button" class="ssr-link" data-none="${key}">${I('none', 'снять', 'зняти')}</button></span>` : ''}</div>
            <small class="ssr-muted">${hint}</small><div class="ssr-tiles">${list.map(x => itemTile(x, checkable, x.where ? I('in: ', 'в: ', 'у: ') + x.where : '')).join('')}</div></div>`;
        const total = groups.replaced.length + groups.free.length + groups.other.length;
        if (!total) h += `<p>${I('Nothing to clean up — only the new artwork is in your gallery.', 'Чистить нечего — в галерее только новая работа.', 'Чистити нічого — у галереї тільки нова робота.')}</p>`;
        h += sec(I('Replaced just now', 'Только что заменённые', 'Щойно замінені'), I('Were in this showcase before. Ticked.', 'Стояли в этой витрине до замены. Уже отмечены.', 'Стояли в цій вітрині до заміни. Уже позначені.'), groups.replaced, true, 'replaced');
        h += sec(I('Not used anywhere', 'Нигде не используются', 'Ніде не використовуються'), I('Not shown in any showcase. Tick only what you recognise.', 'Не стоят ни в одной витрине. Отмечай только то, что узнаёшь.', 'Не стоять у жодній вітрині. Познач тільки те, що впізнаєш.'), groups.free, true, 'free');
        h += sec(I('Used in other showcases', 'Стоят в других витринах', 'Стоять в інших вітринах'), I('Protected — the script will not touch these.', 'Защищены — скрипт их не трогает.', 'Захищені — скрипт їх не чіпає.'), groups.other, false, 'other');
        if (groups.replaced.length + groups.free.length)
          h += `<button type="button" class="ssr-btn ssr-primary" id="ssr-hide" ${picks.size ? '' : 'disabled'}>${I(`Hide ticked (${picks.size})`, `Скрыть отмеченные (${picks.size})`, `Приховати позначені (${picks.size})`)}</button>
            <small class="ssr-muted">${I('Hidden artwork stays in Steam as "Only me" — reversible. Visitors no longer see the +N tile; you still see it on your own profile.', 'Скрытые работы остаются в Steam с видимостью «Только я» — это обратимо. Гости больше не видят плитку +N; ты на своём профиле её видишь.', 'Приховані роботи залишаються в Steam з видимістю «Тільки я» — це оборотно. Гості більше не бачать плитку +N; ти на своєму профілі її бачиш.')}</small>
            <button type="button" class="ssr-link ssr-del-link" id="ssr-delete" ${picks.size ? '' : 'disabled'}>${I('or delete them permanently…', 'или удалить навсегда…', 'або видалити назавжди…')}</button>`;
        h += `<button type="button" class="ssr-btn" id="ssr-finish">${I('Leave everything as is', 'Ничего не менять, закрыть', 'Нічого не змінювати, закрити')}</button>`;
      }
    }
    if (step === 'cleaned') {
      h += j.cleanAction === 'private'
        ? `<div class="ssr-success">✓ ${I(`Hidden: ${j.cleaned || 0}.`, `Скрыто: ${j.cleaned || 0}.`, `Приховано: ${j.cleaned || 0}.`)}</div>
           <p class="ssr-muted">${I('Check it the way visitors see it: open your profile in a private/incognito window.', 'Проверить, как видят гости: открой профиль в окне инкогнито.', 'Перевірити, як бачать гості: відкрий профіль у вікні інкогніто.')}</p>`
        : `<div class="ssr-success">✓ ${I(`Deleted: ${j.cleaned || 0}.`, `Удалено: ${j.cleaned || 0}.`, `Видалено: ${j.cleaned || 0}.`)}</div>`;
      h += `
        <button type="button" class="ssr-btn ssr-primary" id="ssr-finish">${I('Close', 'Закрыть', 'Закрити')}</button>`;
    }
    if (step === 'paused') {
      h += `<p>${I('The script stopped to stay safe. Check the message above.', 'Скрипт остановился, чтобы ничего не испортить. Посмотри сообщение выше.', 'Скрипт зупинився, щоб нічого не зіпсувати. Подивись повідомлення вище.')}</p>
        <button type="button" class="ssr-btn ssr-primary" id="ssr-retry">${I('Retry', 'Повторить', 'Повторити')}</button>`;
    }
    if (j && j.phase !== 'idle') {
      if (idList(j).some(okID)) h += `<div class="ssr-ids">${L(j).parts.map((p, i) => `${safe(p.short)}: ${safe(idList(j)[i] || '—')}`).join(' · ')}</div>`;
      if (!['done', 'cleaned', 'cleanup'].includes(step))
        h += `<button type="button" class="ssr-link ssr-stop" id="ssr-stop">${I('Stop', 'Остановить', 'Зупинити')}</button>`;
    }
    return h;
  }
  function render() {
    const ui = $('#ssr-panel'); if (!ui) return;
    const j = state();
    ui.classList.toggle('collapsed', !open);
    ui.classList.toggle('wide', !!mgr || j?.phase === 'cleanup' || j?.phase === 'pick-showcase');
    ui.innerHTML = `<div class="ssr-top"><button type="button" class="ssr-head" id="ssr-toggle">▣ Showcase Refresher <span>${open ? '−' : '+'}</span></button>
      <div class="ssr-lang">${LANGS.map(([c, t]) => `<button type="button" data-lang="${c}" class="${language === c ? 'active' : ''}">${t}</button>`).join('')}</div></div>
      <div class="ssr-body">${body(j)}
      <div class="ssr-footer">Steam Showcase Refresher ${VERSION}<br>
      Alex Nocturne · <a href="${SHOP}" target="_blank" rel="noopener noreferrer">${I('choose artwork here', 'выбрать иллюстрацию здесь', 'обрати ілюстрацію тут')}</a><br>
      ${I('Provided as is, without support. Not affiliated with Valve.', 'Предоставляется «как есть», без поддержки. Не связан с Valve.', 'Надається «як є», без підтримки. Не пов’язаний з Valve.')}</div></div>`;
    const on = (id, cb) => { const e = $('#' + id, ui); if (e) e.onclick = cb; };
    on('ssr-toggle', () => { open = !open; render(); });
    on('ssr-mgr-open', () => openManager());
    if (mgr) bindManager(ui, on);
    $$('[data-lang]', ui).forEach(e => e.onclick = () => { language = e.dataset.lang; try { localStorage.setItem(LANG_KEY, language); } catch {} message = ''; render(); });
    $$('[data-layout]', ui).forEach(b => b.onclick = () => { layout = b.dataset.layout; message = ''; render(); });
    $$('[data-pick-file]', ui).forEach(b => b.onclick = () => $('#ssr-in-' + b.dataset.pickFile, ui)?.click());
    for (const part of LAYOUTS.artwork.parts) { const inp = $('#ssr-in-' + part.key, ui); if (inp) inp.onchange = e => onPick(part.key, e.target.files?.[0] || null); }
    on('ssr-pick-many', () => $('#ssr-in-many', ui)?.click());
    const many = $('#ssr-in-many', ui); if (many) many.onchange = e => onPickMany(e.target.files || []);
    const r = $('#ssr-rights', ui); if (r) r.onchange = () => { rightsOK = r.checked; render(); };
    on('ssr-start', start);
    $$('input[name="ssr-sc"]', ui).forEach(x => x.onchange = () => { chosenKey = x.value; render(); });
    on('ssr-choose', () => chooseShowcase(chosenKey));
    on('ssr-find', () => { const j2 = state(); if (!j2) return; pendingStuck = false; store({...j2, phase: 'recover'}); goto(listURL(j2)); });
    on('ssr-reupload', () => { const j2 = state(); if (!j2) return; pendingStuck = false; recoverCandidate = null; store({...j2, phase: 'upload'}); goto(UPLOAD); });
    on('ssr-yes', () => { if (recoverCandidate?.id) { const id = recoverCandidate.id; recoverCandidate = null; gotID(id); } });
    on('ssr-continue', () => { setPhase('apply'); message = ''; apply(); });
    on('ssr-cleanup', () => { const j2 = state(); if (!j2) return; store({...j2, phase: 'cleanup'}); galleryLoaded = false; if (isGallery()) cleanupScan(); else goto(GALLERY); });
    on('ssr-finish', finish);
    on('ssr-hide', () => batchOld('private'));
    on('ssr-delete', () => batchOld('delete'));
    on('ssr-retry', retry);
    on('ssr-stop', () => { if (confirm(I('Stop? Artwork already uploaded or deleted on Steam stays as it is.', 'Остановить? Уже загруженное или удалённое в Steam останется как есть.', 'Зупинити? Уже завантажене чи видалене в Steam залишиться як є.'))) finish(); });
    $$('[data-all]', ui).forEach(b => b.onclick = () => { (groups?.[b.dataset.all] || []).forEach(x => picks.add(x.id)); render(); });
    $$('[data-none]', ui).forEach(b => b.onclick = () => { (groups?.[b.dataset.none] || []).forEach(x => picks.delete(x.id)); render(); });
    $$('img[data-tid]', ui).forEach(im => im.addEventListener('error', () => { if (im.dataset.orig && im.src !== im.dataset.orig) im.src = im.dataset.orig; }));
    $$('[data-del]', ui).forEach(el => el.onchange = () => { if (el.checked) picks.add(el.dataset.del); else picks.delete(el.dataset.del); render(); });
  }

  // ---------- Workshop manager: overview and deletion of my Workshop items ----------
  // Long-showcase strips are Workshop items of app 480. Steam hides them from the usual
  // "My Workshop items" lists, so the list is read from the same popup the showcase editor uses,
  // and deletion uses the same form Steam shows on each item's own page.
  const POPUP = 'https://steamcommunity.com/my/publishedfilebrowsepopup/myworkshopitemsforshowcase/';
  const DELETE_PAUSE = 500;  // ms between two deletions
  const SET_GAP = 20000;   // IDs uploaded one after another are close; a bigger jump starts a new set
  let mgr = null;          // manager state while the manager view is open

  async function fetchDoc(url) {
    const r = await fetch(url, {credentials: 'include'});
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    return new DOMParser().parseFromString(await r.text(), 'text/html');
  }
  // Workshop item IDs listed in the picker popup (all pages), with a thumbnail if the popup has one.
  function popupItems(d) {
    const out = new Map();
    const add = (id, el) => {
      if (!okID(id) || out.has(id) || el.closest('#global_header, .responsive_header')) return;
      const box = el.closest('[class*="item"], li, td') || el;
      const img = (el.tagName === 'IMG' ? el : box.querySelector('img'));
      const src = (img?.getAttribute('srcset') || '').split(',')[0].trim().split(/\s+/)[0] || img?.getAttribute('src') || '';
      out.set(id, {id, thumb: safeURL(src)});
    };
    for (const el of d.querySelectorAll('[data-publishedfileid]')) add(el.getAttribute('data-publishedfileid'), el);
    for (const el of d.querySelectorAll('a[href*="filedetails"]')) {
      try { add(new URL(el.getAttribute('href'), location.href).searchParams.get('id') || '', el); } catch {}
    }
    for (const el of d.querySelectorAll('[onclick]')) {
      const on = el.getAttribute('onclick') || '';
      const m = on.match(/(?:publishedfile|select|choose|pick)\w*\s*\(\s*(?:[^,()]*,\s*)*['"]?(\d{7,12})['"]?/i);
      if (m) add(m[1], el);
    }
    for (const el of d.querySelectorAll('[id]')) {
      const m = el.id.match(/(?:publishedfile|sharedfile|item)[_-]?(\d{7,12})$/i);
      if (m) add(m[1], el);
    }
    return [...out.values()];
  }
  async function loadAllPopupItems() {
    const seen = new Set([POPUP]), queue = [POPUP], items = new Map();
    while (queue.length && seen.size <= 20) {
      const url = queue.shift();
      const d = await fetchDoc(url);
      for (const it of popupItems(d)) if (!items.has(it.id)) items.set(it.id, it);
      for (const a of d.querySelectorAll('a[href*="p="]')) {
        try {
          const u = new URL(a.getAttribute('href'), url);
          if (/publishedfilebrowsepopup/.test(u.pathname) && !seen.has(u.href)) { seen.add(u.href); queue.push(u.href); }
        } catch {}
      }
    }
    return [...items.values()];
  }
  // Which items stand in which showcase, read from a fresh copy of the showcase editor.
  function showcaseUsage(d) {
    const names = {}, counters = {}, used = {}, showcases = [];
    for (const sel of d.querySelectorAll('select[id^="showcase_"][id$="_select"], select[name="profile_showcase[]"]')) {
      const opt = sel.querySelector('option[selected]') || sel.selectedOptions?.[0];
      if (!opt) continue;
      const t = String(opt.value), p = opt.getAttribute('data-purchaseid') || '0';
      counters[t] = (counters[t] || 0) + 1;
      names[`${t}_${/^\d+$/.test(p) ? String(BigInt(p)) : p}`] = (opt.textContent || '').trim().replace(/\s*\(.*\)$/, '') + ` №${counters[t]}`;
    }
    const byKey = {};
    for (const el of d.querySelectorAll('.showcase_slot[data-slotjson]')) {
      const root = el.closest('[data-eshowcasetype], [id^="showcase_preview_"]');
      const type = root?.getAttribute('data-eshowcasetype') || (root?.id.match(/^showcase_preview_(\d+)$/) || [])[1] || '?';
      const purchase = (root && rootPurchase(root)) || '0';
      let obj; try { obj = JSON.parse(el.getAttribute('data-slotjson') || '{}'); } catch { continue; }
      const id = String(obj.publishedfileid || '');
      if (!okID(id)) continue;
      const key = `${type}_${purchase}`;
      const label = names[key] || I('a showcase', 'витрина', 'вітрина');
      used[id] = label;
      if (type === '12') (byKey[key] = byKey[key] || {label, slots: []}).slots[obj.slot] = id;
    }
    for (const k of Object.keys(byKey)) showcases.push({label: byKey[k].label, ids: byKey[k].slots.filter(okID)});
    return {used, showcases};
  }
  // Group free items into sets: consecutive uploads with close IDs, at most five per set.
  function makeSets(items) {
    const sorted = [...items].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const runs = [];
    for (const it of sorted) {
      const run = runs[runs.length - 1];
      if (run && run.length < 5 && BigInt(it.id) - BigInt(run[run.length - 1].id) < BigInt(SET_GAP)) run.push(it);
      else runs.push([it]);
    }
    return runs.reverse();  // newest first
  }
  async function openManager() {
    mgr = {loading: true, picks: new Set(), note: ''};
    open = true; render();
    try {
      const [items, edit] = await Promise.all([loadAllPopupItems(), fetchDoc(EDIT)]);
      const {used, showcases} = showcaseUsage(edit);
      const byId = new Map(items.map(x => [x.id, x]));
      const free = items.filter(x => !used[x.id]);
      mgr = {...mgr, loading: false, items, byId, used, showcases, sets: makeSets(free)};
      log('Workshop manager', JSON.stringify({items: items.length, used, showcases, sets: mgr.sets.length}));
      render();
      hydrateThumbs(items.map(x => x.id));
    } catch (e) {
      mgr = {...mgr, loading: false, error: e.message}; render();
    }
  }
  // Reads the delete form from the item's own page (only its owner gets one) and submits it in the background.
  async function deleteWorkshopItem(id) {
    const d = await fetchDoc(itemURL(id));
    const form = d.querySelector('form#PublishedFileDelete, form[action*="/sharedfiles/delete"]');
    if (!form) throw Error(I('no delete form (not your item, or already deleted)', 'нет формы удаления (не твой предмет или уже удалён)', 'немає форми видалення (не твій предмет або вже видалений)'));
    const fd = new URLSearchParams();
    for (const inp of form.querySelectorAll('input[name]')) fd.set(inp.name, inp.value);
    if (fd.get('id') !== String(id)) throw Error(I('form is for another item', 'форма относится к другому предмету', 'форма стосується іншого предмета'));
    fd.set('sessionid', String(sw.g_sessionID || fd.get('sessionid') || ''));
    const action = new URL(form.getAttribute('action') || '/sharedfiles/delete', location.href);
    if (action.origin !== location.origin) throw Error(I('unexpected form destination', 'неожиданный адрес формы', 'неочікувана адреса форми'));
    const r = await fetch(action.href, {method: 'POST', credentials: 'include', body: fd});
    if (!r.ok) throw Error(`HTTP ${r.status}`);
  }
  async function deletePicked() {
    if (!mgr || mgr.busy) return;
    const ids = [...mgr.picks];
    if (!ids.length) return;
    const inUse = [...new Set(ids.filter(id => mgr.used[id]).map(id => mgr.used[id]))];
    if (inUse.length && !window.confirm(I(`Some ticked strips are IN YOUR SHOWCASE:\n\n${inUse.join('\n')}\n\nAfter deleting, these slots will be empty on your profile until you put something else there. Continue?`,
                                           `Часть отмеченных полос СТОИТ В ВИТРИНЕ:\n\n${inUse.join('\n')}\n\nПосле удаления эти места в профиле опустеют, пока не поставишь туда что-то другое. Продолжить?`, `Частина позначених смуг СТОЇТЬ У ВІТРИНІ:\n\n${inUse.join('\n')}\n\nПісля видалення ці місця в профілі спорожніють, доки не поставиш туди щось інше. Продовжити?`))) return;
    if (!window.confirm(I(`Permanently delete ${ids.length} Workshop item(s)? This cannot be undone.`,
                          `Безвозвратно удалить предметов мастерской: ${ids.length}? Отменить это нельзя.`, `Безповоротно видалити предметів майстерні: ${ids.length}? Скасувати це неможливо.`))) return;
    mgr.busy = {done: 0, total: ids.length}; mgr.failed = []; mgr.note = ''; render();
    for (const [n, id] of ids.entries()) {
      if (n) await sleep(DELETE_PAUSE);   // Steam may ignore or refuse deletions sent too quickly
      try { await deleteWorkshopItem(id); }
      catch (e) { mgr.failed.push(`${id}: ${e.message}`); log('delete failed', id, e.message); }
      mgr.busy.done++; render();
    }
    const failed = mgr.failed, total = ids.length;
    await openManager();   // reload the list from Steam to confirm
    const left = ids.filter(id => mgr.byId?.has(id));
    mgr.note = I(`Deleted: ${total - left.length} of ${total}.`, `Удалено: ${total - left.length} из ${total}.`, `Видалено: ${total - left.length} з ${total}.`) +
      (left.length ? I(` Still listed by Steam: ${left.join(', ')}.`, ` Steam всё ещё показывает: ${left.join(', ')}.`, ` Steam досі показує: ${left.join(', ')}.`) : '') +
      (failed.length ? '\n' + failed.join('\n') : '');
    render();
  }
  function stripRow(ids, cls = '') {
    return `<span class="ssr-set-strips ${cls}">${ids.map(id => `<a href="${itemURL(id)}" target="_blank" rel="noopener" title="ID ${id}">${thumbBox(mgr.byId?.get(id)?.thumb || '', 'ssr-setthumb', id)}</a>`).join('')}</span>`;
  }
  function managerBody() {
    let h = `<div class="ssr-mgr-head"><button type="button" class="ssr-link" id="ssr-mgr-back">← ${I('Back', 'Назад', 'Назад')}</button>
      <b>${I('My Workshop strips', 'Мои полосы мастерской', 'Мої смуги майстерні')}</b>
      <button type="button" class="ssr-link" id="ssr-mgr-reload" ${mgr.loading || mgr.busy ? 'disabled' : ''}>${I('Refresh', 'Обновить', 'Оновити')}</button></div>`;
    if (mgr.note) h += `<div class="ssr-note" style="white-space:pre-line">${safe(mgr.note)}</div>`;
    if (mgr.busy) return h + `<p>${I(`Deleting ${mgr.busy.done} of ${mgr.busy.total}… Keep this tab open.`, `Удаляю ${mgr.busy.done} из ${mgr.busy.total}… Не закрывай вкладку.`, `Видаляю ${mgr.busy.done} з ${mgr.busy.total}… Не закривай вкладку.`)}</p>`;
    if (mgr.loading) return h + `<p>${I('Loading your Workshop items…', 'Загружаю твои предметы мастерской…', 'Завантажую твої предмети майстерні…')}</p>`;
    if (mgr.error) return h + `<div class="ssr-note ssr-note-bad">${safe(I('Could not load the list: ', 'Не удалось загрузить список: ', 'Не вдалося завантажити список: ') + mgr.error)}</div>`;
    if (!mgr.items.length) return h + `<p>${I('You have no Workshop items.', 'У тебя нет предметов мастерской.', 'У тебе немає предметів майстерні.')}</p>`;
    if (mgr.showcases.length) {
      h += `<div class="ssr-group"><div class="ssr-group-head"><b>${I('In your showcases', 'Стоят в витринах', 'Стоять у вітринах')}</b></div>
        <small class="ssr-muted">${I('Can be deleted too — the showcase slots will then be empty.', 'Их тоже можно удалить — тогда места в витрине опустеют.', 'Їх теж можна видалити — тоді місця у вітрині спорожніють.')}</small>`;
      mgr.showcases.forEach((sc, i) => {
        const on = sc.ids.length && sc.ids.every(id => mgr.picks.has(id));
        h += `<label class="ssr-set ssr-inuse ${on ? 'on' : ''}"><span><input type="checkbox" data-showcase="${i}" ${on ? 'checked' : ''}> ⚠ ${safe(sc.label)}</span>${stripRow(sc.ids)}</label>`;
      });
      h += `</div>`;
    }
    const otherUsed = mgr.items.filter(x => mgr.used[x.id] && !mgr.showcases.some(s => s.ids.includes(x.id)));
    if (otherUsed.length)
      h += `<div class="ssr-group"><small class="ssr-muted">🔒 ${I('Also used in other showcases:', 'Ещё используются в других витринах:', 'Ще використовуються в інших вітринах:')} ${otherUsed.length}</small></div>`;
    h += `<div class="ssr-group"><div class="ssr-group-head"><b>${I('Not used anywhere', 'Нигде не используются', 'Ніде не використовуються')} (${mgr.sets.reduce((n, s) => n + s.length, 0)})</b>
      ${mgr.sets.length ? `<span><button type="button" class="ssr-link" id="ssr-mgr-all">${I('all', 'все', 'усі')}</button> · <button type="button" class="ssr-link" id="ssr-mgr-none">${I('none', 'снять', 'зняти')}</button></span>` : ''}</div>`;
    if (!mgr.sets.length) h += `<small class="ssr-muted">${I('Nothing to clean up.', 'Чистить нечего.', 'Чистити нічого.')}</small>`;
    else h += `<small class="ssr-muted">${I('Grouped into sets by upload order, newest first. Click a set to tick it; click a strip to open it on Steam.',
                                          'Сгруппированы в комплекты по порядку загрузки, новые сверху. Нажми на комплект, чтобы отметить его; на полосу — чтобы открыть её в Steam.', 'Згруповані в комплекти за порядком завантаження, нові зверху. Натисни на комплект, щоб позначити його; на смугу — щоб відкрити її в Steam.')}</small>`;
    mgr.sets.forEach((set, i) => {
      const ids = set.map(x => x.id), on = ids.every(id => mgr.picks.has(id));
      h += `<label class="ssr-set ${on ? 'on' : ''}"><span><input type="checkbox" data-set="${i}" ${on ? 'checked' : ''}>
        ${set.length === 5 ? I('Set of 5 strips', 'Комплект из 5 полос', 'Комплект із 5 смуг') : I(`${set.length} strip(s)`, `Полос: ${set.length}`, `Смуг: ${set.length}`)}</span>${stripRow(ids)}</label>`;
    });
    h += `</div>`;
    const n = [...mgr.picks].length;
    if (mgr.sets.length || mgr.showcases.length) h += `<button type="button" class="ssr-btn ssr-danger" id="ssr-mgr-delete" ${n ? '' : 'disabled'}>${I(`Delete ticked (${n})`, `Удалить отмеченные (${n})`, `Видалити позначені (${n})`)}</button>
      <small class="ssr-muted">${I('Deleting cannot be undone. Keep your own copies of the GIFs.', 'Удаление необратимо. Храни у себя копии GIF.', 'Видалення незворотне. Зберігай у себе копії GIF.')}</small>`;
    return h;
  }
  function bindManager(ui, on) {
    on('ssr-mgr-back', () => { mgr = null; render(); });
    on('ssr-mgr-reload', () => openManager());
    on('ssr-mgr-delete', deletePicked);
    on('ssr-mgr-all', () => { mgr.sets.flat().forEach(x => mgr.picks.add(x.id)); render(); });
    on('ssr-mgr-none', () => { mgr.picks.clear(); render(); });
    $$('[data-showcase]', ui).forEach(el => el.onchange = () => {
      const ids = mgr.showcases[+el.dataset.showcase]?.ids || [];
      ids.forEach(id => el.checked ? mgr.picks.add(id) : mgr.picks.delete(id)); render();
    });
    $$('[data-set]', ui).forEach(el => el.onchange = () => {
      const ids = (mgr.sets[+el.dataset.set] || []).map(x => x.id);
      ids.forEach(id => el.checked ? mgr.picks.add(id) : mgr.picks.delete(id)); render();
    });
  }

  // ---------- page router ----------
  async function auto() {
    let j = state(); if (!j) return;
    if (!allowed(j)) return halt(I('A different Steam account is signed in.', 'Открыт другой аккаунт Steam.', 'Відкрито інший акаунт Steam.'));
    if (j.phase === 'paused') return;
    if (j.phase === 'pick-showcase') { if (isEdit()) await pickShowcase(j); else goto(EDIT); return; }
    if (j.phase === 'upload') { if (isUpload()) await uploadOne(j); else goto(UPLOAD); return; }
    if (j.phase === 'pending') {
      const id = successID(j); if (id) return gotID(id);
      const wait = 60000 - (Date.now() - (j.submittedAt || 0));
      if (isUpload() || wait <= 0) { pendingStuck = true; render(); }
      else setTimeout(() => { if (state()?.phase === j.phase) { pendingStuck = true; render(); } }, wait);
      return;
    }
    if (j.phase === 'recover') { if (onList(j)) await recoverScan(j); else goto(listURL(j)); return; }
    if (j.phase === 'apply') { if (isEdit()) await apply(); else goto(EDIT); return; }
    if (j.phase === 'need-showcase') { if (!isEdit()) goto(EDIT); return; }
    if (j.phase === 'verify-showcase') { if (isEdit()) await verifyShowcase(); else if (!isUpload() && !isGallery() && !isWorkshopList()) goto(EDIT); return; }
    if (j.phase === 'done' && j.fresh) {
      // Reload the profile once so the new artwork is shown instead of a cached page.
      store({...j, fresh: false});
      await sleep(2500);
      location.reload();
      return;
    }
    if (j.phase === 'cleanup' || j.phase === 'cleanup-verify') { if (isGallery()) await cleanupScan(); else goto(GALLERY); }
  }
  function init() {
    if (window.top !== window.self || $('#ssr-panel') || !document.body) return;
    const styles = `
#ssr-panel{position:fixed;bottom:16px;right:16px;z-index:2147483646;width:min(400px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;
 background:#16202d;color:#dfe9f2;border:1px solid #3f5b72;border-radius:10px;box-shadow:0 10px 36px #000b;font:13px/1.45 "Motiva Sans",Arial,sans-serif}
#ssr-panel.wide{width:min(470px,calc(100vw - 32px))}
#ssr-panel.collapsed{width:auto;max-width:260px}#ssr-panel.collapsed .ssr-body,#ssr-panel.collapsed .ssr-lang{display:none}
#ssr-panel .ssr-top{display:flex;align-items:center;background:#1f3349;position:sticky;top:0;z-index:1}
#ssr-panel .ssr-head{flex:1;background:none;border:0;color:#fff;font:700 13px Arial,sans-serif;text-align:left;padding:10px 12px;cursor:pointer}
#ssr-panel .ssr-head span{float:right;margin-left:10px}
#ssr-panel .ssr-lang{display:flex;gap:2px;padding-right:8px}
#ssr-panel .ssr-lang button{font:700 11px Arial,sans-serif;padding:3px 6px;border:1px solid #3f5b72;background:#16202d;color:#9fb6c8;border-radius:4px;cursor:pointer}
#ssr-panel .ssr-lang button.active{background:#2a75bb;color:#fff;border-color:#2a75bb}
#ssr-panel .ssr-body{padding:12px;display:flex;flex-direction:column;gap:9px}
#ssr-panel p{margin:0}#ssr-panel small{display:block;font-size:11px;color:#8ea4b6}
#ssr-panel a{color:#66c0f4}
#ssr-panel .ssr-btn{padding:8px 10px;border:1px solid #3f5b72;border-radius:5px;background:#24384c;color:#fff;cursor:pointer;font:13px Arial,sans-serif}
#ssr-panel .ssr-btn:hover:not(:disabled){filter:brightness(1.15)}
#ssr-panel .ssr-btn:disabled{opacity:.45;cursor:default}
#ssr-panel .ssr-primary{background:linear-gradient(#47a3e0,#2a75bb);border-color:#2a75bb;font-weight:700}
#ssr-panel .ssr-danger{background:#7a3236;border-color:#a5474c}
#ssr-panel .ssr-link{background:none;border:0;color:#66c0f4;cursor:pointer;padding:0;font:12px Arial,sans-serif;text-decoration:underline}
#ssr-panel .ssr-del-link{align-self:center;color:#e08a8a}#ssr-panel .ssr-del-link:disabled{opacity:.4;cursor:default}
#ssr-panel .ssr-stop{align-self:flex-end;color:#c98a8a}
#ssr-panel .ssr-file{display:flex;gap:10px;align-items:flex-start;padding:8px;background:#1c2b3b;border-radius:7px}
#ssr-panel .ssr-file-info{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
#ssr-panel .ssr-file-info .ssr-btn{align-self:flex-start;padding:5px 9px;font-size:12px}
#ssr-panel .ssr-file-label{font-weight:700}
#ssr-panel .ssr-file-name{font-size:11px;color:#8ea4b6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ssr-panel .ssr-thumb{display:inline-flex;align-items:center;justify-content:center;width:54px;height:80px;flex-shrink:0;background:#0d141c;border-radius:4px;overflow:hidden;color:#556b7d;font-size:11px}
#ssr-panel .ssr-thumb img:not([src]){visibility:hidden}
#ssr-panel .ssr-thumb img{width:100%;height:100%;object-fit:cover;object-position:top}
#ssr-panel .ssr-thumb.ssr-side{width:22px}
#ssr-panel .ssr-mgr-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
#ssr-panel .ssr-mgr-link{align-self:flex-start}
#ssr-panel .ssr-set{display:flex;flex-direction:column;gap:5px;padding:7px;background:#1c2b3b;border:2px solid transparent;border-radius:7px;cursor:pointer}
#ssr-panel .ssr-set.on{border-color:#d9534f}
#ssr-panel .ssr-set.ssr-locked{cursor:default;opacity:.85}
#ssr-panel .ssr-set.ssr-inuse:not(.on){border-color:#5a4a2a}
#ssr-panel .ssr-set > span:first-child{display:flex;gap:7px;align-items:center;font-weight:600}
#ssr-panel .ssr-set-strips{display:flex;gap:2px;justify-content:center}
#ssr-panel .ssr-set-strips a{flex:0 1 auto;max-width:19%;display:flex}
#ssr-panel .ssr-thumb.ssr-setthumb{width:auto;max-width:100%;min-width:16px;height:170px;border-radius:2px;background:none}
#ssr-panel .ssr-thumb.ssr-setthumb img{width:auto;max-width:100%;height:100%;object-fit:contain}
#ssr-panel .ssr-thumb.ssr-mini{width:14px;height:60px;border-radius:2px}
#ssr-panel .ssr-tabs{display:flex;gap:4px;background:#0f1822;padding:3px;border-radius:7px}
#ssr-panel .ssr-tabs button{flex:1;padding:6px 4px;border:0;border-radius:5px;background:none;color:#9fb6c8;cursor:pointer;font:600 12px Arial,sans-serif}
#ssr-panel .ssr-tabs button.active{background:#2a75bb;color:#fff}
#ssr-panel .ssr-multi{flex-direction:column}
#ssr-panel .ssr-strips{display:flex;gap:4px;justify-content:center;width:100%}
#ssr-panel .ssr-strip{position:relative;width:44px;height:150px;background:#0d141c;border:2px solid transparent;border-radius:3px;overflow:hidden;display:flex;align-items:flex-end;justify-content:center}
#ssr-panel .ssr-strip.ok{border-color:#3d6b2a}#ssr-panel .ssr-strip.bad{border-color:#ff8a80}
#ssr-panel .ssr-strip img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top}
#ssr-panel .ssr-strip b{position:relative;background:#000b;color:#fff;font-size:11px;padding:0 5px;border-radius:3px;margin-bottom:3px}
#ssr-panel .ssr-ok{color:#8fd16a}#ssr-panel .ssr-bad{color:#ff8a80}#ssr-panel .ssr-warn{color:#ffd27a;font-size:11px}#ssr-panel .ssr-muted{color:#8ea4b6}
#ssr-panel .ssr-check{display:flex;gap:7px;align-items:center;cursor:pointer}
#ssr-panel .ssr-note{padding:8px 10px;background:#22364a;border-left:3px solid #66c0f4;border-radius:4px;overflow-wrap:anywhere}
#ssr-panel .ssr-note-bad{border-left-color:#ff8a80;color:#ffd6d2}
#ssr-panel .ssr-success{font-size:16px;font-weight:700;color:#8fd16a}
#ssr-panel .ssr-steps{display:flex;align-items:center;gap:6px}
#ssr-panel .ssr-steps span{width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;background:#24384c;color:#8ea4b6}
#ssr-panel .ssr-steps span.done{background:#3d6b2a;color:#fff}#ssr-panel .ssr-steps span.now{background:#2a75bb;color:#fff}
#ssr-panel .ssr-steps b{margin-left:4px}
#ssr-panel .ssr-choices{display:flex;flex-direction:column;gap:6px}
#ssr-panel .ssr-choice{display:flex;gap:10px;align-items:center;padding:7px;background:#1c2b3b;border:1px solid transparent;border-radius:7px;cursor:pointer}
#ssr-panel .ssr-choice.sel{border-color:#66c0f4}
#ssr-panel .ssr-pair{display:inline-flex;gap:3px}
#ssr-panel .ssr-group{display:flex;flex-direction:column;gap:5px;padding-top:4px}
#ssr-panel .ssr-group-head{display:flex;justify-content:space-between;align-items:center}
#ssr-panel .ssr-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:7px}
#ssr-panel .ssr-tile{position:relative;display:flex;flex-direction:column;gap:3px;padding:5px;background:#1c2b3b;border:2px solid transparent;border-radius:7px;cursor:pointer;min-width:0}
#ssr-panel .ssr-tile.on{border-color:#66c0f4}
#ssr-panel .ssr-tile.ssr-locked{opacity:.75;cursor:default}
#ssr-panel .ssr-thumb.ssr-card{width:100%;height:120px}
#ssr-panel .ssr-tile-bar{position:absolute;top:8px;left:8px;right:8px;display:flex;justify-content:space-between;align-items:center}
#ssr-panel .ssr-tile-bar input{width:17px;height:17px;margin:0;cursor:pointer}
#ssr-panel .ssr-tile-bar a{background:#000a;border-radius:4px;padding:0 5px;text-decoration:none;font-size:13px}
#ssr-panel .ssr-tile small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ssr-panel .ssr-tile.ssr-big{flex-direction:row;align-items:center;gap:12px}
#ssr-panel .ssr-tile.ssr-big .ssr-thumb{width:70px;height:110px}
#ssr-panel .ssr-ids{font-size:11px;color:#8ea4b6}
#ssr-panel .ssr-ol{margin:0;padding-left:18px}
#ssr-panel .ssr-footer{margin-top:4px;padding-top:8px;border-top:1px solid #2c4256;font-size:10.5px;color:#7d93a5}`;
    try { GM_addStyle(styles); } catch { const e = document.createElement('style'); e.textContent = styles; document.head.append(e); }
    const root = document.createElement('div'); root.id = 'ssr-panel';
    document.body.appendChild(root);
    const j = state();
    open = !!j;
    render();
    auto().catch(e => halt(e.message));
    log('Initialized', VERSION, location.href);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true}); else init();
})();
