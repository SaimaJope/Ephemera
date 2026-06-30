'use strict';

/**
 * renderer.js - Ephemera chrome logic.
 *
 * Owns tabs, navigation, the omnibox, the live tracker counter and the
 * Clean Slate flow. Each tab is backed by one <webview> living in #views;
 * only the active one is visible. The renderer is sandboxed - it reaches the
 * main process exclusively through window.ephemera (see preload.js).
 */

(() => {
  const $ = (sel) => document.querySelector(sel);

  const views        = $('#views');
  const tabsEl       = $('#tabs');
  const omnibox      = $('#omnibox');
  const address      = $('#address');
  const backBtn      = $('#nav-back');
  const fwdBtn       = $('#nav-forward');
  const reloadBtn    = $('#nav-reload');
  const newtabBtn    = $('#newtab-btn');
  const trackerCount = $('#tracker-count');
  const trackerPill  = $('#tracker-pill');
  const cleanBtn     = $('#clean-slate');
  const toast        = $('#toast');
  const toastText    = $('#toast-text');

  const NEWTAB_URL = new URL('newtab.html', location.href).href;
  const ENGINES = {
    duckduckgo: 'https://duckduckgo.com/?q=',
    startpage:  'https://www.startpage.com/sp/search?query=',
    brave:      'https://search.brave.com/search?q=',
    google:     'https://www.google.com/search?q='
  };
  // Home page per engine, used when "new tab" is set to open the engine instead of
  // the Ephemera page. Google follows the chosen language to its country TLD
  // (google.fi, google.es, ...), everyone else has a single home.
  const ENGINE_HOMES = {
    duckduckgo: () => 'https://duckduckgo.com/',
    startpage:  () => 'https://www.startpage.com/',
    brave:      () => 'https://search.brave.com/',
    google:     () => `https://www.google.${({ fi: 'fi', es: 'es', ru: 'ru' }[settings.language] || 'com')}/`
  };
  // Where a fresh "new tab" should point: the local Ephemera page, or the engine home.
  const newtabTarget = () =>
    settings.newtabMode === 'engine'
      ? (ENGINE_HOMES[settings.searchEngine] || ENGINE_HOMES.duckduckgo)()
      : NEWTAB_URL;

  // Network-down error codes. -106 (ERR_INTERNET_DISCONNECTED) is unambiguous;
  // the rest (DNS, timeouts, unreachable, proxy, connection drops) only count as
  // "offline" when the OS itself reports it is, so a single dud host never trips
  // the easter egg while the connection is fine.
  const NET_DOWN = new Set([-2, -21, -100, -101, -102, -104, -105, -106, -109, -118, -130, -137, -138]);
  const isOfflineError = (code) => code === -106 || (!navigator.onLine && NET_DOWN.has(code));

  /** @type {Map<string, any>} */
  const tabs = new Map();
  let activeId = null;
  let seq = 0;
  let blockedCount = 0;

  // Downloads: the live list mirrored from main drives the toolbar arrow button
  // and the drop panel. Everything here is ephemeral - Clean Slate deletes the
  // files on disk and clears this state.
  let dlItems = [];
  const dlRate = new Map();    // id -> { bytes, time, speed } for live speed/ETA
  let dlSeenIds = new Set();   // ids seen last tick (detects a brand-new download)
  const dlDoneIds = new Set(); // ids already flashed as complete
  let dlPanelOpen = false;

  // Mirrors main's defaults; replaced by the persisted values on boot.
  let settings = {
    windowControls: 'traffic', accent: '#b07cff', searchEngine: 'google', theme: 'normal',
    newtabMode: 'page', newtabBg: 'blue', showBranding: true, showCounter: true,
    cleanSlate: 'subtle', adblock: true, sendDnt: true, language: 'en', highPerf: false,
    beautifulMode: false, startMaximized: true
  };
  const searchURL = () => ENGINES[settings.searchEngine] || ENGINES.duckduckgo;

  // ── Localization (English / Spanish / Russian / Finnish) ──────────────────
  const I18N = {
    en: {
      newtab: 'New tab', omnibox_ph: 'Search privately or enter an address', search: 'Search',
      settings: 'Settings', sec_general: 'General', sec_appearance: 'Appearance', sec_privacy: 'Privacy', sec_toolbar: 'Toolbar',
      lbl_language: 'Language', lbl_engine: 'Search engine', sub_engine: 'Used for non-URL queries',
      lbl_newtab_opens: 'New tab opens', sub_newtab_opens: "Ephemera page or your search engine's home", opt_newtab_page: 'Ephemera page', opt_newtab_engine: 'Search engine home',
      lbl_accent: 'Accent colour', lbl_winctl: 'Window controls', lbl_newtabbg: 'New-tab background',
      lbl_branding: 'Logo on new tab', lbl_adblock: 'Block ads and trackers',
      sec_performance: 'Performance', lbl_highperf: 'High performance mode', sub_highperf: 'Fewer animations, lighter page filtering',
      lbl_beautiful: 'Beautiful mode', sub_beautiful: 'Extra motion, mouse-reactive dust, animated tabs', koan: 'Nothing to remember.',
      lbl_startmax: 'Open maximised', sub_startmax: 'Fill the screen when Ephemera launches',
      lbl_dnt: 'Send DNT and GPC', sub_dnt: 'Do-Not-Track and Global Privacy Control',
      lbl_counter: 'Show tracker counter', lbl_cleanslate: 'Clean Slate button',
      seg_colour: 'Colour', seg_mono: 'Mono', seg_navy: 'Navy', seg_blue: 'Blue', seg_grey: 'Grey', seg_subtle: 'Subtle', seg_red: 'Red',
      clr_blue: 'Blue', clr_green: 'Green', clr_purple: 'Purple', clr_amber: 'Amber', clr_coral: 'Coral',
      cs_label: 'Clean Slate', tip_newtab: 'New tab (Ctrl+T)', tip_back: 'Back', tip_forward: 'Forward', tip_reload: 'Reload',
      tip_shield: 'Private session, DNT and GPC sent', tip_tracker: 'Ads and trackers blocked this session',
      tip_cleanslate: 'Clean Slate, wipe everything (Ctrl+Shift+K)', tip_settings: 'Settings (Ctrl+,)',
      toast_cleanslate: 'Clean slate. Cookies, cache and history wiped.',
      confirm_title: 'Are you sure?', confirm_msg: 'This wipes all cookies, cache and history.', btn_yes: 'Yes', btn_no: 'No', wipe_label: 'Cleaning everything',
      off_title: 'No internet connection', off_sub: 'Ephemera could not reach the network.', off_retry: 'Retry', off_hint: '← →  move · space fire · enter retry',
      tip_downloads: 'Downloads', dl_title: 'Downloads', dl_clear: 'Clear', dl_empty: 'No downloads yet', dl_note: 'Files are erased on Clean Slate',
      dl_open: 'Open', dl_folder: 'Show in folder', dl_retry: 'Retry', dl_remove: 'Remove', dl_pause: 'Pause', dl_resume: 'Resume', dl_cancel: 'Cancel', dl_left: 'left',
      st_completed: 'Completed', st_canceled: 'Canceled', st_failed: 'Failed', st_paused: 'Paused',
      cdw_title: 'Downloaded files will be erased', cdw_sub: 'Everything you saved this session is deleted for good.',
      toast_cleanslate_dl: 'Clean slate. Cookies, cache, history and downloads wiped.'
    },
    es: {
      newtab: 'Nueva pestaña', omnibox_ph: 'Busca en privado o escribe una dirección', search: 'Buscar',
      settings: 'Ajustes', sec_general: 'General', sec_appearance: 'Apariencia', sec_privacy: 'Privacidad', sec_toolbar: 'Barra de herramientas',
      lbl_language: 'Idioma', lbl_engine: 'Motor de búsqueda', sub_engine: 'Para búsquedas que no son URL',
      lbl_newtab_opens: 'La pestaña nueva abre', sub_newtab_opens: 'La página de Ephemera o el inicio de tu buscador', opt_newtab_page: 'Página de Ephemera', opt_newtab_engine: 'Inicio del buscador',
      lbl_accent: 'Color de acento', lbl_winctl: 'Controles de ventana', lbl_newtabbg: 'Fondo de nueva pestaña',
      lbl_branding: 'Logo en nueva pestaña', lbl_adblock: 'Bloquear anuncios y rastreadores',
      sec_performance: 'Rendimiento', lbl_highperf: 'Modo de alto rendimiento', sub_highperf: 'Menos animaciones, filtrado más ligero',
      lbl_beautiful: 'Modo bonito', sub_beautiful: 'Más movimiento, polvo reactivo al ratón, pestañas animadas', koan: 'Nada que recordar.',
      lbl_startmax: 'Abrir maximizado', sub_startmax: 'Llena la pantalla al iniciar Ephemera',
      lbl_dnt: 'Enviar DNT y GPC', sub_dnt: 'Do-Not-Track y Global Privacy Control',
      lbl_counter: 'Mostrar contador de rastreadores', lbl_cleanslate: 'Botón Clean Slate',
      seg_colour: 'Color', seg_mono: 'Mono', seg_navy: 'Azul marino', seg_blue: 'Azul', seg_grey: 'Gris', seg_subtle: 'Sutil', seg_red: 'Rojo',
      clr_blue: 'Azul', clr_green: 'Verde', clr_purple: 'Púrpura', clr_amber: 'Ámbar', clr_coral: 'Coral',
      cs_label: 'Limpiar', tip_newtab: 'Nueva pestaña (Ctrl+T)', tip_back: 'Atrás', tip_forward: 'Adelante', tip_reload: 'Recargar',
      tip_shield: 'Sesión privada, DNT y GPC enviados', tip_tracker: 'Anuncios y rastreadores bloqueados esta sesión',
      tip_cleanslate: 'Limpiar todo (Ctrl+Shift+K)', tip_settings: 'Ajustes (Ctrl+,)',
      toast_cleanslate: 'Borrón nuevo. Cookies, caché e historial borrados.',
      confirm_title: '¿Estás seguro?', confirm_msg: 'Esto borra todas las cookies, caché e historial.', btn_yes: 'Sí', btn_no: 'No', wipe_label: 'Limpiando todo',
      off_title: 'Sin conexión a internet', off_sub: 'Ephemera no pudo conectar con la red.', off_retry: 'Reintentar', off_hint: '← →  mover · espacio disparar · enter reintentar',
      tip_downloads: 'Descargas', dl_title: 'Descargas', dl_clear: 'Borrar', dl_empty: 'Aún no hay descargas', dl_note: 'Los archivos se borran al limpiar',
      dl_open: 'Abrir', dl_folder: 'Mostrar en carpeta', dl_retry: 'Reintentar', dl_remove: 'Quitar', dl_pause: 'Pausar', dl_resume: 'Reanudar', dl_cancel: 'Cancelar', dl_left: 'restante',
      st_completed: 'Completada', st_canceled: 'Cancelada', st_failed: 'Fallida', st_paused: 'En pausa',
      cdw_title: 'Los archivos descargados se borrarán', cdw_sub: 'Todo lo que guardaste esta sesión se elimina definitivamente.',
      toast_cleanslate_dl: 'Borrón nuevo. Cookies, caché, historial y descargas borrados.'
    },
    ru: {
      newtab: 'Новая вкладка', omnibox_ph: 'Приватный поиск или введите адрес', search: 'Поиск',
      settings: 'Настройки', sec_general: 'Общие', sec_appearance: 'Внешний вид', sec_privacy: 'Конфиденциальность', sec_toolbar: 'Панель инструментов',
      lbl_language: 'Язык', lbl_engine: 'Поисковая система', sub_engine: 'Для запросов, не являющихся URL',
      lbl_newtab_opens: 'Новая вкладка открывает', sub_newtab_opens: 'Страницу Ephemera или главную вашей поисковой системы', opt_newtab_page: 'Страница Ephemera', opt_newtab_engine: 'Главная поисковика',
      lbl_accent: 'Акцентный цвет', lbl_winctl: 'Кнопки окна', lbl_newtabbg: 'Фон новой вкладки',
      lbl_branding: 'Логотип на новой вкладке', lbl_adblock: 'Блокировать рекламу и трекеры',
      sec_performance: 'Производительность', lbl_highperf: 'Режим высокой производительности', sub_highperf: 'Меньше анимаций, лёгкая фильтрация',
      lbl_beautiful: 'Красивый режим', sub_beautiful: 'Больше анимации, реагирующая на курсор пыль, анимация вкладок', koan: 'Нечего запоминать.',
      lbl_startmax: 'Открывать развёрнутым', sub_startmax: 'Разворачивать на весь экран при запуске Ephemera',
      lbl_dnt: 'Отправлять DNT и GPC', sub_dnt: 'Do-Not-Track и Global Privacy Control',
      lbl_counter: 'Показывать счётчик трекеров', lbl_cleanslate: 'Кнопка Clean Slate',
      seg_colour: 'Цвет', seg_mono: 'Моно', seg_navy: 'Тёмный', seg_blue: 'Синий', seg_grey: 'Серый', seg_subtle: 'Скрытая', seg_red: 'Красная',
      clr_blue: 'Синий', clr_green: 'Зелёный', clr_purple: 'Фиолетовый', clr_amber: 'Янтарный', clr_coral: 'Коралловый',
      cs_label: 'Очистить', tip_newtab: 'Новая вкладка (Ctrl+T)', tip_back: 'Назад', tip_forward: 'Вперёд', tip_reload: 'Обновить',
      tip_shield: 'Приватная сессия, DNT и GPC отправляются', tip_tracker: 'Реклама и трекеры заблокированы за сессию',
      tip_cleanslate: 'Очистить всё (Ctrl+Shift+K)', tip_settings: 'Настройки (Ctrl+,)',
      toast_cleanslate: 'Чистый лист. Куки, кэш и история удалены.',
      confirm_title: 'Вы уверены?', confirm_msg: 'Это удалит все куки, кэш и историю.', btn_yes: 'Да', btn_no: 'Нет', wipe_label: 'Очистка',
      off_title: 'Нет подключения к интернету', off_sub: 'Ephemera не удалось подключиться к сети.', off_retry: 'Повторить', off_hint: '← →  движение · пробел огонь · enter повтор',
      tip_downloads: 'Загрузки', dl_title: 'Загрузки', dl_clear: 'Очистить', dl_empty: 'Пока нет загрузок', dl_note: 'Файлы удаляются при очистке',
      dl_open: 'Открыть', dl_folder: 'Показать в папке', dl_retry: 'Повторить', dl_remove: 'Удалить', dl_pause: 'Пауза', dl_resume: 'Продолжить', dl_cancel: 'Отмена', dl_left: 'осталось',
      st_completed: 'Завершено', st_canceled: 'Отменено', st_failed: 'Ошибка', st_paused: 'Пауза',
      cdw_title: 'Загруженные файлы будут удалены', cdw_sub: 'Всё, что вы сохранили за эту сессию, удаляется безвозвратно.',
      toast_cleanslate_dl: 'Чистый лист. Куки, кэш, история и загрузки удалены.'
    },
    fi: {
      newtab: 'Uusi välilehti', omnibox_ph: 'Hae yksityisesti tai kirjoita osoite', search: 'Hae',
      settings: 'Asetukset', sec_general: 'Yleiset', sec_appearance: 'Ulkoasu', sec_privacy: 'Yksityisyys', sec_toolbar: 'Työkalupalkki',
      lbl_language: 'Kieli', lbl_engine: 'Hakukone', sub_engine: 'Käytetään muille kuin URL-hauille',
      lbl_newtab_opens: 'Uusi välilehti avaa', sub_newtab_opens: 'Ephemeran sivun tai hakukoneesi etusivun', opt_newtab_page: 'Ephemeran sivu', opt_newtab_engine: 'Hakukoneen etusivu',
      lbl_accent: 'Korostusväri', lbl_winctl: 'Ikkunan painikkeet', lbl_newtabbg: 'Uuden välilehden tausta',
      lbl_branding: 'Logo uudella välilehdellä', lbl_adblock: 'Estä mainokset ja seuranta',
      sec_performance: 'Suorituskyky', lbl_highperf: 'Suorituskykytila', sub_highperf: 'Vähemmän animaatioita, kevyempi suodatus',
      lbl_beautiful: 'Kaunis tila', sub_beautiful: 'Enemmän liikettä, hiireen reagoiva pöly, animoidut välilehdet', koan: 'Ei mitään muistettavaa.',
      lbl_dnt: 'Lähetä DNT ja GPC', sub_dnt: 'Do-Not-Track ja Global Privacy Control',
      lbl_counter: 'Näytä seurantalaskuri', lbl_cleanslate: 'Clean Slate -painike',
      seg_colour: 'Väri', seg_mono: 'Mono', seg_navy: 'Tumma', seg_blue: 'Sininen', seg_grey: 'Harmaa', seg_subtle: 'Hillitty', seg_red: 'Punainen',
      clr_blue: 'Sininen', clr_green: 'Vihreä', clr_purple: 'Violetti', clr_amber: 'Keltainen', clr_coral: 'Koralli',
      cs_label: 'Tyhjennä', tip_newtab: 'Uusi välilehti (Ctrl+T)', tip_back: 'Takaisin', tip_forward: 'Eteenpäin', tip_reload: 'Lataa uudelleen',
      tip_shield: 'Yksityinen istunto, DNT ja GPC lähetetään', tip_tracker: 'Estetyt mainokset ja seuranta tässä istunnossa',
      tip_cleanslate: 'Tyhjennä kaikki (Ctrl+Shift+K)', tip_settings: 'Asetukset (Ctrl+,)',
      toast_cleanslate: 'Puhdas pöytä. Evästeet, välimuisti ja historia tyhjennetty.',
      confirm_title: 'Oletko varma?', confirm_msg: 'Tämä tyhjentää kaikki evästeet, välimuistin ja historian.', btn_yes: 'Kyllä', btn_no: 'Ei', wipe_label: 'Tyhjennetään',
      off_title: 'Ei internet-yhteyttä', off_sub: 'Ephemera ei saanut yhteyttä verkkoon.', off_retry: 'Yritä uudelleen', off_hint: '← →  liiku · väli ammu · enter uudelleen',
      tip_downloads: 'Lataukset', dl_title: 'Lataukset', dl_clear: 'Tyhjennä', dl_empty: 'Ei vielä latauksia', dl_note: 'Tiedostot poistetaan tyhjennyksessä',
      dl_open: 'Avaa', dl_folder: 'Näytä kansiossa', dl_retry: 'Yritä uudelleen', dl_remove: 'Poista', dl_pause: 'Keskeytä', dl_resume: 'Jatka', dl_cancel: 'Peruuta', dl_left: 'jäljellä',
      st_completed: 'Valmis', st_canceled: 'Peruutettu', st_failed: 'Epäonnistui', st_paused: 'Keskeytetty',
      cdw_title: 'Ladatut tiedostot poistetaan', cdw_sub: 'Kaikki tässä istunnossa tallennettu poistetaan lopullisesti.',
      toast_cleanslate_dl: 'Puhdas pöytä. Evästeet, välimuisti, historia ja lataukset tyhjennetty.'
    }
  };
  const t = (k) => (I18N[settings.language] && I18N[settings.language][k]) || I18N.en[k] || k;

  // The "Colour" new-tab-background button is labelled with the active accent's
  // name — Blue in blue mode, Coral in coral mode, etc.
  const ACCENT_NAMES = {
    '#5ca7fb': 'clr_blue', '#2ec27e': 'clr_green', '#b07cff': 'clr_purple',
    '#f5a623': 'clr_amber', '#ff6b6b': 'clr_coral'
  };
  function updateColourBgLabel() {
    const btn = document.getElementById('bg-colour-btn');
    if (!btn) return;
    const key = ACCENT_NAMES[String(settings.accent || '').toLowerCase()];
    btn.textContent = key ? t(key) : t('seg_blue');
  }

  function applyLang() {
    const lang = I18N[settings.language] ? settings.language : 'en';
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    // re-title open new-tab tabs, refresh chrome + the active new-tab page
    tabs.forEach((tab) => { if (isNewtab(tab.url)) { tab.title = t('newtab'); renderTab(tab); } });
    updateColourBgLabel();
    renderDownloads(); // re-render the panel/button labels in the active language
  }

  // ── Input resolution: URL-ish → navigate, otherwise → private search ──────
  function resolveInput(raw) {
    const s = raw.trim();
    if (!s) return null;
    if (/^(https?|file|about|data):/i.test(s)) return s;
    const hostLike = /^(localhost(:\d+)?|[^\s/?#]+\.[^\s/?#]{2,})(:\d+)?([/?#].*)?$/i;
    if (!/\s/.test(s) && hostLike.test(s)) return 'https://' + s;
    return searchURL() + encodeURIComponent(s);
  }

  const isNewtab = (url) =>
    !url || url === NEWTAB_URL || url === 'about:blank' || /(^|\/)newtab\.html(\?|#|$)/.test(url);
  const displayUrl = (url) => (isNewtab(url) ? '' : url);

  // ── Tabs ──────────────────────────────────────────────────────────────────
  // Chrome-style tab density: collapse titles/close buttons as tabs get narrow,
  // driven by the measured per-tab width (recomputed on tab add/remove + resize).
  function updateTabDensity() {
    // Skip a tab that is mid-close (collapsing to 0 width in beautiful mode), so
    // its shrinking width never trips the narrow/mini thresholds for everyone else.
    const first = tabsEl.querySelector('.tab:not(.closing)');
    const w = first ? first.getBoundingClientRect().width : 999; // forces layout -> accurate now
    tabsEl.classList.toggle('tabs-narrow', w < 124);
    tabsEl.classList.toggle('tabs-mini', w < 66);
  }

  function makeWebview(src) {
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'ephemera'); // shared in-memory session
    wv.setAttribute('allowpopups', '');        // popups are denied + re-opened as tabs in main
    wv.src = src;
    views.appendChild(wv);
    return wv;
  }

  // ── Pre-warmed new tab ──────────────────────────────────────────────────────
  // Opening a tab used to spin up a fresh guest, load the page, block on the font
  // and fade the content in, so the new tab sat dark for ~0.2s. Instead we keep ONE
  // local new-tab page loaded, settings-applied and painted, hidden in the pool; the
  // "+"/Ctrl+T path adopts it instantly and a replacement is warmed on idle. Only
  // the local page is pre-warmed - the engine-home option loads a remote URL.
  let spareWebview = null;
  let spareReady = false;

  function warmSpare() {
    if (spareWebview || settings.newtabMode === 'engine') return;
    spareReady = false;
    const wv = makeWebview(NEWTAB_URL);
    const prime = async () => {                 // run once, on whichever load event fires first
      wv.removeEventListener('dom-ready', prime);
      wv.removeEventListener('did-stop-loading', prime);
      await pushNewtabSettings(wv);             // wait until the guest has revealed its logo + search
      wv.classList.add('ready');                // revealed while hidden; adopting it shows instantly
      if (wv === spareWebview) spareReady = true; // (guard: dropSpare() during the await nulls spareWebview)
    };
    wv.addEventListener('dom-ready', prime);
    wv.addEventListener('did-stop-loading', prime);
    spareWebview = wv;
  }

  // Warm the next spare off the critical path so it never competes with the tab the
  // user just opened.
  function scheduleWarmSpare() {
    if (settings.newtabMode === 'engine' || spareWebview) return;
    if (window.requestIdleCallback) requestIdleCallback(() => warmSpare(), { timeout: 1500 });
    else setTimeout(() => warmSpare(), 250);
  }

  function dropSpare() {
    if (spareWebview) { try { spareWebview.remove(); } catch (_) {} }
    spareWebview = null;
    spareReady = false;
  }

  function createTab(url) {
    const id = 'tab-' + ++seq;
    const target = url || NEWTAB_URL;

    // Adopt the pre-warmed page for a plain new tab: it is already loaded, styled
    // and painted, so it appears instantly instead of spinning up from scratch.
    const adopt = !!(spareWebview && spareReady && target === NEWTAB_URL);
    let webview;
    if (adopt) {
      webview = spareWebview;
      spareWebview = null;
      spareReady = false;
    } else {
      webview = makeWebview(target);
    }

    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.setAttribute('role', 'tab');
    tabEl.innerHTML =
      '<span class="tab-favicon is-default"></span>' +
      '<span class="tab-title">New tab</span>' +
      '<button class="tab-close" title="Close tab" aria-label="Close tab">' +
      '<svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>';
    tabsEl.insertBefore(tabEl, newtabBtn); // tabs sit before the trailing "+" and drag-fill

    const tab = {
      id, webview, tabEl, target,
      title: t('newtab'), url: target, favicon: null,
      loading: false, canBack: false, canFwd: false
    };
    tabs.set(id, tab);

    tabEl.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      activateTab(id);
    });
    tabEl.addEventListener('auxclick', (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(id); }
    });
    tabEl.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(id);
    });

    wireWebview(tab);
    renderTab(tab); // apply the localized title now (markup ships a literal "New tab")
    // An adopted spare already loaded and painted while warming, so its load events
    // fired before wireWebview attached. Carry over its painted state and re-push
    // current settings (activateTab does this too, in case they changed since).
    if (adopt) { tab.loading = false; webview.classList.add('ready'); }
    activateTab(id);
    updateTabDensity();
    scheduleWarmSpare(); // refill the pool so the next new tab is instant too
    return tab;
  }

  // Reveal a webview only after its guest has produced a frame. A new tab is
  // appended hidden (CSS hides it until .active.ready), so until the page paints
  // the dark #views backdrop shows instead of Chromium's white pre-paint surface,
  // which is what used to flash grey for a frame on every new tab. The rAF biases
  // the flip a frame late, so we never reveal a still-blank surface.
  const revealWhenPainted = (wv) =>
    requestAnimationFrame(() => { try { wv.classList.add('ready'); } catch (_) {} });

  function wireWebview(tab) {
    const wv = tab.webview;

    const refreshNav = () => {
      tab.url = wv.getURL();
      try { tab.canBack = wv.canGoBack(); tab.canFwd = wv.canGoForward(); } catch (_) {}
      if (isNewtab(tab.url)) { tab.title = t('newtab'); tab.favicon = null; }
      renderTab(tab);
      if (tab.id === activeId) syncChrome();
    };

    wv.addEventListener('did-start-loading', () => { tab.loading = true; tab.failed = false; renderTab(tab); if (tab.id === activeId) syncChrome(); });
    wv.addEventListener('found-in-page', (e) => {
      if (tab.id !== activeId || !findbar || !findbar.classList.contains('show')) return;
      const r = (e && e.result) || {};
      if (typeof r.matches === 'number') findCount.textContent = r.matches ? `${r.activeMatchOrdinal || 0}/${r.matches}` : '0/0';
    });
    wv.addEventListener('did-stop-loading',  () => {
      tab.loading = false; refreshNav(); applyNewtab(tab);
      revealWhenPainted(wv); // backstop: a load that never fired dom-ready still reveals
      // A load that finished without a network failure clears any offline state
      // and drops the screen (we keep it up during an in-flight retry, so the
      // page never flashes through the bare Chromium error page).
      if (!tab.failed && tab.offline) { tab.offline = null; if (tab.id === activeId) hideOffline(); }
    });
    wv.addEventListener('did-navigate',          refreshNav);
    wv.addEventListener('did-navigate-in-page',  refreshNav);
    wv.addEventListener('dom-ready', () => {
      refreshNav(); applyNewtab(tab); revealWhenPainted(wv);
      if (tab.zoom && tab.zoom !== 1) { try { wv.setZoomFactor(tab.zoom); } catch (_) {} } // webviews reset zoom per navigation
    });

    wv.addEventListener('page-title-updated', (e) => {
      tab.title = isNewtab(tab.url) ? t('newtab') : (e.title || tab.url || 'Untitled');
      renderTab(tab);
    });
    wv.addEventListener('page-favicon-updated', (e) => {
      tab.favicon = (e.favicons && e.favicons[0]) || null;
      renderTab(tab);
    });
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return; // ERR_ABORTED - navigation superseded
      tab.loading = false;
      // A main-frame load that failed because we're offline raises the easter-egg
      // offline screen in place of Chromium's default error page.
      if (e.isMainFrame && isOfflineError(e.errorCode)) {
        tab.failed = true;
        tab.offline = { url: e.validatedURL || tab.url, code: e.errorCode, desc: e.errorDescription || '' };
        if (tab.id === activeId) showOffline(tab);
      }
      renderTab(tab);
      if (tab.id === activeId) syncChrome();
    });
    // Ctrl + mouse wheel zoom. The wheel fires inside the guest (page content), so
    // the guest preload catches it and forwards the direction here; the chrome owns
    // the per-tab zoom factor, so wheel zoom stays in sync with Ctrl +/-/0.
    wv.addEventListener('ipc-message', (e) => {
      if (e.channel === 'ephemera:zoom') {
        const dir = e.args && e.args[0];
        if (dir) adjustZoom(tab, dir > 0 ? 0.1 : -0.1);
      }
    });
  }

  function renderTab(tab) {
    const el = tab.tabEl;
    el.classList.toggle('active', tab.id === activeId);

    const titleEl = el.querySelector('.tab-title');
    titleEl.textContent = tab.title || t('newtab');
    el.title = tab.title || '';

    const slot = el.querySelector('.tab-favicon, .tab-spinner');
    if (tab.loading) {
      if (!slot.classList.contains('tab-spinner')) {
        const sp = document.createElement('span');
        sp.className = 'tab-spinner';
        slot.replaceWith(sp);
      }
    } else {
      let fav = slot;
      if (slot.classList.contains('tab-spinner')) {
        fav = document.createElement('span');
        fav.className = 'tab-favicon';
        slot.replaceWith(fav);
      }
      fav.classList.remove('is-default', 'is-newtab');
      if (isNewtab(tab.url)) {
        fav.classList.add('is-newtab'); // white bug mark
        fav.style.backgroundImage = '';
      } else if (tab.favicon && /^(https?:|data:)/i.test(tab.favicon)) {
        // The favicon URL comes from the untrusted page. Pin the scheme and escape
        // the value for the CSS url("...") context so a crafted favicon can't break
        // out of the string and inject CSS into the privileged chrome (e.g. an
        // exfiltrating background:url(...) under our img-src allowance). We escape
        // backslash/quote and strip ALL C0 control chars (newline, CR, form feed,
        // tab, NUL) - any of which can terminate a CSS string. Real favicon URLs
        // are already URL-serialized, so none of these appear in practice.
        const safe = String(tab.favicon).replace(/[\\"]/g, '\\$&').replace(/[\u0000-\u001f]/g, '');
        fav.style.backgroundImage = `url("${safe}")`;
      } else {
        fav.classList.add('is-default');
        fav.style.backgroundImage = '';
      }
    }
  }

  function activateTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    const prev = tabs.get(activeId);
    activeId = id;
    tabs.forEach((t) => {
      const on = t.id === id;
      t.webview.classList.toggle('active', on);
      t.tabEl.classList.toggle('active', on);
    });
    syncChrome();
    applyNewtab(tab);
    syncOffline();
    // The find bar is one shared control; reconcile it across the switch so the
    // old tab's highlights/count don't linger over the newly active tab.
    if (findbar && findbar.classList.contains('show')) {
      if (prev && prev !== tab) { try { prev.webview.stopFindInPage('clearSelection'); } catch (_) {} }
      findCount.textContent = '';
      if (findInput.value.trim()) runFind(findInput.value);
    }
  }

  function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    recordClosed(tab); // so Ctrl+Shift+T can bring it back (in-memory only)
    const ids = [...tabs.keys()];
    const idx = ids.indexOf(id);

    tab.webview.remove();
    // Beautiful mode: let the tab collapse out (CSS .closing) instead of vanishing.
    // The webview is already gone and the next tab is activated below, so the empty
    // label just animates away; a timeout backstops the transitionend.
    const el = tab.tabEl;
    const animateClose = settings.beautifulMode &&
      !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (animateClose && el) {
      el.classList.add('closing');
      el.style.pointerEvents = 'none';
      let dropped = false;
      const drop = () => { if (dropped) return; dropped = true; el.remove(); updateTabDensity(); };
      el.addEventListener('transitionend', drop, { once: true });
      setTimeout(drop, 280);
    } else if (el) {
      el.remove();
    }
    tabs.delete(id);
    updateTabDensity();

    if (tabs.size === 0) { createTab(newtabTarget()); return; } // always keep ≥1 tab
    if (activeId === id) {
      const nextId = ids[idx + 1] || ids[idx - 1];
      activateTab(tabs.has(nextId) ? nextId : [...tabs.keys()][0]);
    }
  }

  function cycleTab(dir) {
    const ids = [...tabs.keys()];
    if (ids.length < 2) return;
    let i = ids.indexOf(activeId);
    i = (i + dir + ids.length) % ids.length;
    activateTab(ids[i]);
  }

  // ── Chrome sync (omnibox + nav buttons reflect the active tab) ────────────
  function syncChrome() {
    const tab = tabs.get(activeId);
    if (!tab) return;
    if (document.activeElement !== address) address.value = displayUrl(tab.url);
    backBtn.disabled = !tab.canBack;
    fwdBtn.disabled = !tab.canFwd;
    reloadBtn.classList.toggle('loading', !!tab.loading);
  }

  function navigateActive(url) {
    const tab = tabs.get(activeId);
    if (tab) tab.webview.src = url;
  }

  // ── Offline screen (the no-internet easter egg) ────────────────────────────
  const hostOf = (url) => { try { return new URL(url).hostname || ''; } catch (_) { return ''; } };
  const cleanErr = (desc, code) => ((desc || '').replace(/^net::/, '').trim() || ('ERR ' + code));
  function hideOffline() { if (window.__ephemeraOffline) window.__ephemeraOffline.hide(); }
  function showOffline(tab) {
    const off = tab && tab.offline;
    if (!off || !window.__ephemeraOffline) return;
    const url = off.url;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || settings.accent;
    window.__ephemeraOffline.show({
      host: hostOf(url),
      code: cleanErr(off.desc, off.code),
      accent,
      strings: { title: t('off_title'), sub: t('off_sub'), retry: t('off_retry'), hint: t('off_hint') },
      onRetry: () => { if (url) navigateActive(url); }
    });
  }
  // Match the screen to whichever tab is in front: shown for an offline tab,
  // hidden otherwise. Also refreshes its text/accent when settings change.
  function syncOffline() {
    const tab = tabs.get(activeId);
    if (tab && tab.offline) showOffline(tab);
    else hideOffline();
  }

  // ── Push appearance settings into the new-tab page (it's a sandboxed webview,
  //    so we hand it the config via executeJavaScript). ──────────────────────
  function newtabCfg() {
    return JSON.stringify({
      bg: settings.newtabBg,
      branding: settings.showBranding,
      accent: settings.accent,
      engine: searchURL(),
      searchText: t('search'),
      lang: settings.language,
      highPerf: settings.highPerf,
      beautiful: settings.beautifulMode,
      theme: settings.theme
    });
  }
  // Push appearance settings into a new-tab guest. The page keeps its logo and
  // search box hidden until these land, so this is also what reveals the content.
  function pushNewtabSettings(wv) {
    try {
      return wv.executeJavaScript(`window.__ephemeraApplySettings && window.__ephemeraApplySettings(${newtabCfg()});`)
        .catch(() => {});
    } catch (_) { return Promise.resolve(); }
  }
  function applyNewtab(tab) {
    if (!tab || !isNewtab(tab.url)) return;
    pushNewtabSettings(tab.webview);
  }

  // ── Settings: apply to the chrome, sync the panel UI ──────────────────────
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '92, 167, 251';
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  }
  function applySettings(s) {
    settings = { ...settings, ...(s || {}) };
    const root = document.documentElement.style;
    root.setProperty('--accent', settings.accent);
    root.setProperty('--accent-rgb', hexToRgb(settings.accent));
    root.setProperty('--accent-soft', `rgba(${hexToRgb(settings.accent)}, 0.14)`);
    document.body.classList.toggle('winctl-mono', settings.windowControls === 'mono');
    document.body.classList.toggle('cleanslate-button', settings.cleanSlate === 'button');
    document.body.classList.toggle('no-counter', !settings.showCounter);
    document.body.classList.toggle('high-perf', !!settings.highPerf);
    document.body.classList.toggle('beautiful', !!settings.beautifulMode);
    // Semi-hidden Normal/Dark/Light theme (default 'normal' = the signature
    // charcoal). 'normal' carries no class (the :root tokens win); the other two
    // swap the colour tokens via body.theme-dark / body.theme-light.
    document.body.classList.toggle('theme-dark', settings.theme === 'dark');
    document.body.classList.toggle('theme-light', settings.theme === 'light');
    applyLang();
    syncSettingsUI();
    syncNotepadUI();
    applyNewtab(tabs.get(activeId));
    // Keep the pre-warmed spare in step: drop it in engine mode (it loads a remote
    // home instead), otherwise refresh its appearance or warm one if missing.
    if (settings.newtabMode === 'engine') dropSpare();
    else if (spareWebview && spareReady) pushNewtabSettings(spareWebview);
    else scheduleWarmSpare();
    syncOffline(); // live-refresh the offline screen's accent + translated text
  }
  // Notepad strings live here (self-contained, not in the shared I18N). No em
  // dashes in English or Finnish. The delete/keep line flips with the toggle.
  const NP_I18N = {
    en: { title: 'Notepad', phOn: 'Jot something down. It gets wiped when you clear.', phOff: 'Jot something down. It is not cleared.', save: 'Save to .txt', saved: 'Saved to',
          delOn: 'Delete the .txt file when you clear your device?', delOff: 'The .txt file will be kept when you clear your device.',
          footOn: 'The notepad is wiped when you clear', footOff: 'The notepad is not cleared', cfTitle: 'Your saved notepad will be deleted', cfSub: 'You exported it to a .txt this session.', keep: 'Keep it', savedToast: 'Notepad saved', saveError: 'Could not save notepad' },
    es: { title: 'Bloc de notas', phOn: 'Escribe algo. Se borra cuando limpias.', phOff: 'Escribe algo. No se borra.', save: 'Guardar como .txt', saved: 'Guardado en',
          delOn: '¿Eliminar el archivo .txt al limpiar tu dispositivo?', delOff: 'El archivo .txt se conservará al limpiar.',
          footOn: 'El bloc de notas se borra cuando limpias', footOff: 'El bloc de notas no se borra', cfTitle: 'Tu bloc de notas guardado se eliminará', cfSub: 'Lo exportaste a un .txt esta sesión.', keep: 'Conservarlo', savedToast: 'Bloc de notas guardado', saveError: 'No se pudo guardar' },
    ru: { title: 'Блокнот', phOn: 'Запишите что-нибудь. Стирается при очистке.', phOff: 'Запишите что-нибудь. Не стирается.', save: 'Сохранить в .txt', saved: 'Сохранено в',
          delOn: 'Удалять файл .txt при очистке устройства?', delOff: 'Файл .txt будет сохранён при очистке.',
          footOn: 'Блокнот стирается при очистке', footOff: 'Блокнот не стирается', cfTitle: 'Сохранённый блокнот будет удалён', cfSub: 'Вы экспортировали его в .txt в этой сессии.', keep: 'Оставить', savedToast: 'Блокнот сохранён', saveError: 'Не удалось сохранить' },
    fi: { title: 'Muistio', phOn: 'Kirjoita jotain. Se pyyhitään kun tyhjennät.', phOff: 'Kirjoita jotain. Sitä ei tyhjennetä.', save: 'Tallenna .txt-tiedostoksi', saved: 'Tallennettu kohteeseen',
          delOn: 'Poistetaanko .txt-tiedosto kun tyhjennät laitteen?', delOff: '.txt-tiedosto säilytetään kun tyhjennät laitteen.',
          footOn: 'Muistio pyyhitään kun tyhjennät', footOff: 'Muistiota ei tyhjennetä', cfTitle: 'Tallennettu muistio poistetaan', cfSub: 'Veit sen .txt-tiedostoon tässä istunnossa.', keep: 'Säilytä se' }
  };
  const npT = (k) => { const l = NP_I18N[settings.language] ? settings.language : 'en'; return (NP_I18N[l] && NP_I18N[l][k]) || NP_I18N.en[k] || k; };
  function syncNotepadUI() {
    const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    setTxt('np-title', npT('title'));
    setTxt('np-save', npT('save'));
    setTxt('np-saved-label', npT('saved'));
    setTxt('np-foot-text', npT(settings.notepadDeleteOnClear ? 'footOn' : 'footOff'));
    setTxt('np-cf-title', npT('cfTitle'));
    setTxt('np-cf-sub', npT('cfSub'));
    setTxt('confirm-np-keep', npT('keep'));
    const txtEl = document.getElementById('np-text'); if (txtEl) txtEl.placeholder = npT(settings.notepadDeleteOnClear ? 'phOn' : 'phOff');
    const btn = document.getElementById('notepad-btn'); if (btn) btn.title = npT('title');
    const warn = document.getElementById('np-warn');
    if (warn) warn.textContent = settings.notepadDeleteOnClear ? npT('delOn') : npT('delOff');
    const npDel = document.getElementById('np-del-toggle');
    if (npDel) npDel.setAttribute('aria-checked', settings.notepadDeleteOnClear ? 'true' : 'false');
    const npSaved = document.getElementById('np-saved'), npPathEl = document.getElementById('np-path');
    if (npSaved && npPathEl) {
      if (settings.notepadPath) { npPathEl.textContent = settings.notepadPath; npSaved.hidden = false; }
      else npSaved.hidden = true;
    }
  }
  function syncSettingsUI() {
    document.querySelectorAll('.seg[data-key]').forEach((seg) => {
      const v = String(settings[seg.dataset.key]);
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.val === v));
    });
    document.querySelectorAll('.swatches[data-key]').forEach((sw) => {
      const v = String(settings[sw.dataset.key]).toLowerCase();
      sw.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', b.dataset.val.toLowerCase() === v));
    });
    document.querySelectorAll('.toggle[data-key]').forEach((t) => {
      t.setAttribute('aria-checked', settings[t.dataset.key] ? 'true' : 'false');
    });
    document.querySelectorAll('.select[data-key]').forEach((sel) => { sel.value = settings[sel.dataset.key]; });
  }

  // ── Clean Slate (the headline feature) ────────────────────────────────────
  let toastTimer = null;
  function showToast(msg) {
    toastText.textContent = msg;
    toast.classList.add('show');
    toast.setAttribute('aria-hidden', 'false');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      toast.setAttribute('aria-hidden', 'true');
    }, 2800);
  }

  const confirmOverlay = $('#confirm-overlay');
  const wipeOverlay = $('#wipe-overlay');

  function requestCleanSlate() {
    // Surface the "downloaded files will be erased too" callout whenever any
    // downloaded bytes are sitting in the ephemeral folder.
    const fileCount = dlItems.filter((d) => d.state !== 'cancelled').length;
    const warn = document.getElementById('confirm-dl-warn');
    if (warn) {
      warn.hidden = fileCount === 0;
      const cnt = warn.querySelector('.cdw-count');
      if (cnt && fileCount) cnt.textContent = String(fileCount);
    }
    // The notepad .txt is only at risk when one was exported AND delete-on-clear
    // is on; reset the "Keep it" button each time the dialog opens.
    const npWarn = document.getElementById('confirm-np-warn');
    if (npWarn) {
      npWarn.hidden = !(settings.notepadPath && settings.notepadDeleteOnClear);
      const kb = document.getElementById('confirm-np-keep');
      if (kb) { kb.setAttribute('aria-pressed', 'false'); kb.classList.remove('active'); }
    }
    confirmOverlay.classList.add('show');
    confirmOverlay.setAttribute('aria-hidden', 'false');
    setTimeout(() => $('#confirm-no').focus(), 0);
  }
  function hideConfirm() {
    confirmOverlay.classList.remove('show');
    confirmOverlay.setAttribute('aria-hidden', 'true');
  }
  async function doCleanSlate() {
    const kb = document.getElementById('confirm-np-keep');
    const keepNotepad = !!(kb && kb.getAttribute('aria-pressed') === 'true');
    hideConfirm();
    const hadDownloads = dlItems.some((d) => d.state !== 'cancelled');
    cleanBtn.classList.remove('firing');
    void cleanBtn.offsetWidth;
    cleanBtn.classList.add('firing');
    views.classList.add('wiping'); // dim the page area behind the wipe loader
    wipeOverlay.classList.add('show');
    wipeOverlay.setAttribute('aria-hidden', 'false');

    try { await window.ephemera.cleanSlate({ keepNotepad }); } catch (_) {}

    // The notepad itself is always wiped (it's ephemeral); the .txt was handled
    // by main per the Keep-it choice above.
    const npEl = document.getElementById('np-text'); if (npEl) npEl.value = '';

    tabs.forEach((tab) => { tab.webview.remove(); tab.tabEl.remove(); });
    tabs.clear();
    dropSpare(); // the wiped session takes the pre-warmed page with it; createTab re-warms
    closedStack.length = 0; // a wipe forgets recently-closed tab URLs too
    activeId = null;
    blockedCount = 0;
    trackerCount.textContent = '0';
    // Main has deleted every downloaded file; clear the UI to match.
    dlItems = [];
    dlSeenIds = new Set();
    dlDoneIds.clear();
    dlRate.clear();
    closeDownloads();
    renderDownloads();
    createTab(newtabTarget()); // back to a fresh new tab, ready behind the loader

    // Hold the elegant loader briefly, then reveal the clean new tab.
    setTimeout(() => {
      wipeOverlay.classList.remove('show');
      wipeOverlay.setAttribute('aria-hidden', 'true');
      views.classList.remove('wiping');
      showToast(hadDownloads ? t('toast_cleanslate_dl') : t('toast_cleanslate'));
    }, 850);
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  // Quiet easter egg: type just the browser's own name and press Enter and the
  // omnibox answers with a single localised line, then forgets it. It never
  // navigates and (this being Ephemera) is never logged anywhere.
  let koanTimer = null;
  function showKoan() {
    if (koanTimer) clearTimeout(koanTimer);
    address.value = t('koan');
    address.classList.add('koan');
    address.select(); // a fresh keystroke replaces the line
    koanTimer = setTimeout(() => {
      koanTimer = null;
      address.classList.remove('koan');
      if (address.value === t('koan')) address.value = '';
      syncChrome();
    }, 2200);
  }
  address.addEventListener('input', () => {
    if (!koanTimer) return;
    clearTimeout(koanTimer); koanTimer = null;
    address.classList.remove('koan');
  });

  omnibox.addEventListener('submit', (e) => {
    e.preventDefault();
    if (koanTimer) return;                                  // ignore Enter while the koan lingers
    if (/^\s*ephemera\s*$/i.test(address.value)) { showKoan(); return; }
    const url = resolveInput(address.value);
    if (url) { navigateActive(url); address.blur(); }
  });
  address.addEventListener('focus', () => {
    const tab = tabs.get(activeId);
    if (tab && !isNewtab(tab.url)) address.value = tab.url;
    setTimeout(() => address.select(), 0);
  });
  address.addEventListener('blur', syncChrome);
  address.addEventListener('keydown', (e) => { if (e.key === 'Escape') { syncChrome(); address.blur(); } });

  backBtn.addEventListener('click', () => { const t = tabs.get(activeId); if (t && t.webview.canGoBack()) t.webview.goBack(); });
  fwdBtn.addEventListener('click',  () => { const t = tabs.get(activeId); if (t && t.webview.canGoForward()) t.webview.goForward(); });
  reloadBtn.addEventListener('click', () => {
    const t = tabs.get(activeId);
    if (!t) return;
    if (t.loading) t.webview.stop(); else t.webview.reload();
  });
  newtabBtn.addEventListener('click', () => { createTab(newtabTarget()); address.focus(); });
  trackerPill.addEventListener('click', () => showToast(`${blockedCount} · ${t('tip_tracker')}`));
  cleanBtn.addEventListener('click', requestCleanSlate);
  $('#confirm-yes').addEventListener('click', doCleanSlate);
  confirmOverlay.querySelectorAll('[data-confirm-no]').forEach((el) => el.addEventListener('click', hideConfirm));

  $('#win-min').addEventListener('click', () => window.ephemera.minimize());
  $('#win-max').addEventListener('click', () => window.ephemera.maximize());
  $('#win-close').addEventListener('click', () => window.ephemera.close());

  // ── Semi-hidden theme switch ──────────────────────────────────────────────
  // Clicking the Ephemera wordmark in the titlebar cycles Normal -> Dark -> Light.
  // No label and no Settings row (discoverable, not advertised); the pointer
  // cursor on the wordmark is the only hint. Persisted like any other preference.
  const THEME_CYCLE = ['normal', 'dark', 'light'];
  const THEME_NAMES = {
    en: { normal: 'Normal mode', dark: 'Dark mode', light: 'Light mode' },
    es: { normal: 'Modo normal', dark: 'Modo oscuro', light: 'Modo claro' },
    ru: { normal: 'Обычный режим', dark: 'Тёмный режим', light: 'Светлый режим' },
    fi: { normal: 'Normaali tila', dark: 'Tumma tila', light: 'Vaalea tila' }
  };
  const brandEl = $('.brand');
  if (brandEl) brandEl.addEventListener('click', () => {
    const i = THEME_CYCLE.indexOf(settings.theme);
    const next = THEME_CYCLE[(i + 1) % THEME_CYCLE.length];
    const names = THEME_NAMES[settings.language] || THEME_NAMES.en;
    updateSetting({ theme: next });
    showToast(names[next] || next);
  });

  // ── Settings panel ────────────────────────────────────────────────────────
  const settingsOverlay = $('#settings-overlay');
  const openSettings = () => { settingsOverlay.classList.add('open'); settingsOverlay.setAttribute('aria-hidden', 'false'); };
  const closeSettings = () => { settingsOverlay.classList.remove('open'); settingsOverlay.setAttribute('aria-hidden', 'true'); };
  $('#settings-btn').addEventListener('click', openSettings);
  settingsOverlay.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeSettings));
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (settingsOverlay.classList.contains('open')) closeSettings();
    if (confirmOverlay.classList.contains('show')) hideConfirm();
  });
  // All resize-driven work is coalesced into one layout pass per frame: the
  // context menu is dismissed immediately (cheap), then tab density is measured
  // and the downloads panel repositioned once per animation frame instead of on
  // every resize tick - collapsing repeated forced reflows during a window drag.
  let resizeRaf = 0;
  function onResizeFrame() {
    resizeRaf = 0;
    updateTabDensity();
    if (dlPanelOpen) positionDownloads();
  }
  window.addEventListener('resize', () => {
    closeCtx();
    if (!resizeRaf) resizeRaf = requestAnimationFrame(onResizeFrame);
  });
  // Ctrl + wheel over the chrome (toolbar, tab strip) zooms the active page too, and
  // keeps the chrome UI itself from ever zooming. Wheel over page content is handled
  // inside the guest (it never reaches here), so the two paths don't overlap.
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || e.deltaY === 0) return;
    e.preventDefault();
    adjustZoom(tabs.get(activeId), e.deltaY < 0 ? 0.1 : -0.1);
  }, { passive: false });

  async function updateSetting(patch) {
    try { applySettings(await window.ephemera.setSettings(patch)); }
    catch (_) { applySettings(patch); }
  }
  document.querySelectorAll('.seg[data-key] button, .swatches[data-key] .swatch').forEach((btn) => {
    btn.addEventListener('click', () => updateSetting({ [btn.closest('[data-key]').dataset.key]: btn.dataset.val }));
  });
  document.querySelectorAll('.toggle[data-key]').forEach((t) => {
    t.addEventListener('click', () => updateSetting({ [t.dataset.key]: t.getAttribute('aria-checked') !== 'true' }));
  });
  document.querySelectorAll('.select[data-key]').forEach((sel) => {
    sel.addEventListener('change', () => updateSetting({ [sel.dataset.key]: sel.value }));
  });

  // ── IPC from main ─────────────────────────────────────────────────────────
  window.ephemera.onBlockedCount((n) => {
    const jumped = n > blockedCount; // a fresh block just landed
    blockedCount = n;
    trackerCount.textContent = String(n);
    trackerPill.classList.toggle('has-blocks', n > 0);
    // Beautiful mode: every newly blocked tracker gives the counter a satisfying
    // pop and sends an accent ring out from the pill. Re-trigger by removing the
    // class, forcing reflow, then re-adding (same trick as the logo wobble).
    if (jumped && document.body.classList.contains('beautiful')) {
      trackerCount.classList.remove('tk-bump'); void trackerCount.offsetWidth; trackerCount.classList.add('tk-bump');
      trackerPill.classList.remove('tk-tick'); void trackerPill.offsetWidth; trackerPill.classList.add('tk-tick');
    }
  });
  window.ephemera.onNewTab((url) => { if (url) createTab(url); });
  window.ephemera.onWindowState((s) => document.body.classList.toggle('maximized', s === 'maximized'));
  window.ephemera.onSettingsChanged((s) => applySettings(s));

  // ── Keyboard shortcuts (dispatched from main via before-input-event, so they
  //    fire even while a <webview> holds focus) ──────────────────────────────
  window.ephemera.onShortcut((action) => {
    const t = tabs.get(activeId);
    switch (action) {
      case 'new-tab':       createTab(newtabTarget()); address.focus(); break;
      case 'close-tab':     if (activeId) closeTab(activeId); break;
      case 'focus-address': address.focus(); break;
      case 'reload':        if (t) { if (t.loading) t.webview.stop(); else t.webview.reload(); } break;
      case 'find':          openFind(); break;
      case 'reopen-tab':    reopenClosedTab(); break;
      case 'zoom-in':       adjustZoom(t, 0.1); break;
      case 'zoom-out':      adjustZoom(t, -0.1); break;
      case 'zoom-reset':    adjustZoom(t, 0); break;
      case 'clean-slate':   requestCleanSlate(); break;
      case 'next-tab':      cycleTab(1); break;
      case 'prev-tab':      cycleTab(-1); break;
      case 'settings':      openSettings(); break;
    }
  });

  // ── Per-tab page zoom (Ctrl +/-/0). Webviews reset zoom on navigation, so the
  //    factor is stored on the tab and re-applied on dom-ready. ────────────────
  function adjustZoom(tab, delta) {
    if (!tab) return;
    const next = delta === 0 ? 1 : Math.max(0.3, Math.min(3, (tab.zoom || 1) + delta));
    tab.zoom = next;
    try { tab.webview.setZoomFactor(next); } catch (_) {}
    if (next !== 1) showToast(Math.round(next * 100) + '%');
  }

  // ── Recently-closed tabs (in-memory only, dies with the session / Clean Slate).
  const closedStack = [];
  function recordClosed(tab) {
    if (!tab || isNewtab(tab.url)) return; // a blank new tab isn't worth restoring
    closedStack.push({ url: tab.url });
    if (closedStack.length > 25) closedStack.shift();
  }
  function reopenClosedTab() {
    const last = closedStack.pop();
    if (last && last.url) createTab(last.url);
  }

  // ── Find in page (Ctrl+F) ─────────────────────────────────────────────────
  const findbar = $('#findbar');
  const findInput = $('#find-input');
  const findCount = $('#find-count');
  const findWv = () => { const tb = tabs.get(activeId); return tb ? tb.webview : null; };
  function runFind(text, opts) {
    const wv = findWv();
    const q = (text || '').trim();
    if (!wv || !q) { if (wv) { try { wv.stopFindInPage('clearSelection'); } catch (_) {} } findCount.textContent = ''; return; }
    try { wv.findInPage(q, opts || {}); } catch (_) {}
  }
  function openFind() {
    if (!findbar) return;
    findbar.classList.add('show');
    findbar.setAttribute('aria-hidden', 'false');
    findInput.focus(); findInput.select();
    if (findInput.value.trim()) runFind(findInput.value);
  }
  function closeFind() {
    if (!findbar) return;
    findbar.classList.remove('show');
    findbar.setAttribute('aria-hidden', 'true');
    findCount.textContent = '';
    const wv = findWv();
    if (wv) { try { wv.stopFindInPage('clearSelection'); } catch (_) {} try { wv.focus(); } catch (_) {} }
  }
  if (findbar) {
    findInput.addEventListener('input', () => runFind(findInput.value));
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runFind(findInput.value, { findNext: true, forward: !e.shiftKey }); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    $('#find-prev').addEventListener('click', () => { runFind(findInput.value, { findNext: true, forward: false }); findInput.focus(); });
    $('#find-next').addEventListener('click', () => { runFind(findInput.value, { findNext: true, forward: true }); findInput.focus(); });
    $('#find-close').addEventListener('click', closeFind);
  }

  // ── Notepad (ephemeral text; export to .txt with optional keep-on-clear) ───
  const npPanel = $('#notepad-panel');
  const npText = $('#np-text');
  function openNotepad() {
    if (!npPanel) return;
    try { closeSettings(); } catch (_) {}
    try { closeDownloads(); } catch (_) {}
    npPanel.classList.add('open');
    npPanel.setAttribute('aria-hidden', 'false');
    setTimeout(() => { if (npText) npText.focus(); }, 0);
  }
  function closeNotepad() {
    if (!npPanel) return;
    const hadFocus = npPanel.contains(document.activeElement); // keyboard close -> hand focus back
    npPanel.classList.remove('open');
    npPanel.setAttribute('aria-hidden', 'true');
    if (hadFocus) { const b = document.getElementById('notepad-btn'); if (b) b.focus(); }
  }
  if (npPanel) {
    $('#notepad-btn').addEventListener('click', () => {
      if (npPanel.classList.contains('open')) closeNotepad(); else openNotepad();
    });
    $('#np-close').addEventListener('click', closeNotepad);
    npPanel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeNotepad(); } });
    $('#np-gear').addEventListener('click', () => { const s = $('#np-settings'); if (s) s.hidden = !s.hidden; });
    $('#np-save').addEventListener('click', async () => {
      try {
        const res = await window.ephemera.notepadSave(npText.value);
        if (res && res.ok) showToast(npT('savedToast'));
        else if (res && res.error) showToast(npT('saveError'));
      } catch (_) {}
    });
    $('#np-del-toggle').addEventListener('click', () => {
      updateSetting({ notepadDeleteOnClear: $('#np-del-toggle').getAttribute('aria-checked') !== 'true' });
    });
  }
  const npKeepBtn = $('#confirm-np-keep');
  if (npKeepBtn) npKeepBtn.addEventListener('click', () => {
    const on = npKeepBtn.getAttribute('aria-pressed') === 'true';
    npKeepBtn.setAttribute('aria-pressed', on ? 'false' : 'true');
    npKeepBtn.classList.toggle('active', !on);
  });

  // ── Launch splash (Discord-style pop + bounce, shown once on startup) ──────
  (function launchSplash() {
    const overlay = document.getElementById('launch-overlay');
    if (!overlay) return;
    const slot = overlay.querySelector('.launch-logo');
    const mark = document.querySelector('.brand-mark');
    if (slot && mark && !slot.childElementCount) slot.appendChild(mark.cloneNode(true));
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => {
      overlay.classList.add('hide');
      setTimeout(() => overlay.classList.add('gone'), 460);
    }, reduce ? 700 : 1450);
  })();

  // ── Right-click context menu ──────────────────────────────────────────────
  const ctxMenu = $('#ctx-menu');
  // A full-window scrim sits under the menu (over the webview too) so a click
  // anywhere — including inside a guest page — dismisses the menu. The chrome's
  // own mousedown listener never sees clicks that land in the <webview>.
  const ctxScrim = document.createElement('div');
  ctxScrim.id = 'ctx-scrim';
  document.body.appendChild(ctxScrim);
  ctxScrim.addEventListener('mousedown', () => closeCtx());
  ctxScrim.addEventListener('contextmenu', (e) => e.preventDefault());
  const CTX = {
    en: { open_tab: 'Open link in new tab', copy_link: 'Copy link', open_img: 'Open image in new tab', save_img: 'Save image', copy_img: 'Copy image address', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectall: 'Select all', search: 'Search for' },
    es: { open_tab: 'Abrir enlace en pestaña nueva', copy_link: 'Copiar enlace', open_img: 'Abrir imagen en pestaña nueva', save_img: 'Guardar imagen', copy_img: 'Copiar dirección de imagen', cut: 'Cortar', copy: 'Copiar', paste: 'Pegar', selectall: 'Seleccionar todo', search: 'Buscar' },
    ru: { open_tab: 'Открыть ссылку в новой вкладке', copy_link: 'Копировать ссылку', open_img: 'Открыть изображение в новой вкладке', save_img: 'Сохранить изображение', copy_img: 'Копировать адрес изображения', cut: 'Вырезать', copy: 'Копировать', paste: 'Вставить', selectall: 'Выделить всё', search: 'Искать' },
    fi: { open_tab: 'Avaa linkki uudessa välilehdessä', copy_link: 'Kopioi linkki', open_img: 'Avaa kuva uudessa välilehdessä', save_img: 'Tallenna kuva', copy_img: 'Kopioi kuvan osoite', cut: 'Leikkaa', copy: 'Kopioi', paste: 'Liitä', selectall: 'Valitse kaikki', search: 'Hae' }
  };
  const ct = (k) => (CTX[settings.language] && CTX[settings.language][k]) || CTX.en[k] || k;
  const CTX_ICON = {
    newtab: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    save: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88"/><path d="M14.47 14.48 20 20"/><path d="M8.12 8.12 12 12"/>',
    paste: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
    selectall: '<path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="m8 12 3 3 5-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    forward: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    reload: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>'
  };
  const icoSvg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${CTX_ICON[k] || ''}</svg>`;

  function closeCtx() {
    ctxMenu.classList.remove('show');
    ctxScrim.classList.remove('show');
    ctxMenu.setAttribute('aria-hidden', 'true');
    ctxMenu.innerHTML = '';
  }
  function openCtx(items, x, y) {
    ctxMenu.innerHTML = '';
    items.filter(Boolean).forEach((it) => {
      if (it.type === 'sep') { const s = document.createElement('div'); s.className = 'ctx-sep'; ctxMenu.appendChild(s); return; }
      if (it.type === 'nav') {
        const row = document.createElement('div'); row.className = 'ctx-nav';
        it.buttons.forEach((b) => {
          const btn = document.createElement('button');
          btn.innerHTML = icoSvg(b.icon);
          btn.disabled = !!b.disabled;
          if (!b.disabled) btn.addEventListener('click', () => { closeCtx(); b.action(); });
          row.appendChild(btn);
        });
        ctxMenu.appendChild(row); return;
      }
      const el = document.createElement('button');
      el.className = 'ctx-item';
      el.innerHTML = `<span class="ctx-ico">${icoSvg(it.icon)}</span><span class="ctx-label"></span>`;
      el.querySelector('.ctx-label').textContent = it.label;
      el.addEventListener('click', () => { closeCtx(); it.action(); });
      ctxMenu.appendChild(el);
    });
    ctxScrim.classList.add('show');
    ctxMenu.classList.add('show');
    ctxMenu.setAttribute('aria-hidden', 'false');
    const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.max(6, Math.min(x, window.innerWidth - mw - 6)) + 'px';
    ctxMenu.style.top = Math.max(6, Math.min(y, window.innerHeight - mh - 6)) + 'px';
  }
  const activeWebview = () => { const tb = tabs.get(activeId); return tb ? tb.webview : null; };

  // Right-click inside a page (forwarded from main).
  window.ephemera.onContextMenu((data) => {
    const wv = activeWebview();
    if (!wv) return;
    const items = [];
    let canBack = false, canFwd = false;
    try { canBack = wv.canGoBack(); canFwd = wv.canGoForward(); } catch (_) {}
    items.push({ type: 'nav', buttons: [
      { icon: 'back', disabled: !canBack, action: () => { try { wv.goBack(); } catch (_) {} } },
      { icon: 'forward', disabled: !canFwd, action: () => { try { wv.goForward(); } catch (_) {} } },
      { icon: 'reload', action: () => { try { wv.reload(); } catch (_) {} } }
    ] });
    let extra = false;
    if (data.linkURL) {
      items.push({ type: 'sep' });
      items.push({ label: ct('open_tab'), icon: 'newtab', action: () => createTab(data.linkURL) });
      items.push({ label: ct('copy_link'), icon: 'link', action: () => window.ephemera.clipboardWrite(data.linkURL) });
      extra = true;
    }
    if (data.mediaType === 'image' && data.srcURL) {
      items.push({ type: 'sep' });
      items.push({ label: ct('open_img'), icon: 'image', action: () => createTab(data.srcURL) });
      items.push({ label: ct('save_img'), icon: 'save', action: () => { let id = 0; try { id = wv.getWebContentsId(); } catch (_) {} window.ephemera.downloads.start(data.srcURL, id); } });
      items.push({ label: ct('copy_img'), icon: 'copy', action: () => window.ephemera.clipboardWrite(data.srcURL) });
      extra = true;
    }
    if (data.isEditable) {
      items.push({ type: 'sep' });
      const ef = data.editFlags || {};
      if (ef.canCut !== false) items.push({ label: ct('cut'), icon: 'cut', action: () => { try { wv.focus(); wv.cut(); } catch (_) {} } });
      items.push({ label: ct('copy'), icon: 'copy', action: () => { try { wv.focus(); wv.copy(); } catch (_) {} } });
      if (ef.canPaste !== false) items.push({ label: ct('paste'), icon: 'paste', action: () => { try { wv.focus(); wv.paste(); } catch (_) {} } });
      items.push({ label: ct('selectall'), icon: 'selectall', action: () => { try { wv.focus(); wv.selectAll(); } catch (_) {} } });
      extra = true;
    } else if (data.selectionText) {
      const snip = data.selectionText.length > 24 ? data.selectionText.slice(0, 24) + '...' : data.selectionText;
      items.push({ type: 'sep' });
      items.push({ label: ct('copy'), icon: 'copy', action: () => { try { wv.focus(); wv.copy(); } catch (_) {} } });
      items.push({ label: `${ct('search')} "${snip}"`, icon: 'search', action: () => createTab(searchURL() + encodeURIComponent(data.selectionText)) });
      extra = true;
    }
    if (!extra) {
      items.push({ type: 'sep' });
      items.push({ label: ct('selectall'), icon: 'selectall', action: () => { try { wv.focus(); wv.selectAll(); } catch (_) {} } });
    }
    openCtx(items, data.x || 0, data.y || 0);
  });

  // Right-click in the omnibox: a text-edit menu.
  address.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sel = () => address.value.slice(address.selectionStart, address.selectionEnd);
    openCtx([
      { label: ct('cut'), icon: 'cut', action: () => { const s = sel(); if (s) { window.ephemera.clipboardWrite(s); address.setRangeText('', address.selectionStart, address.selectionEnd, 'end'); } } },
      { label: ct('copy'), icon: 'copy', action: () => { const s = sel(); if (s) window.ephemera.clipboardWrite(s); } },
      { label: ct('paste'), icon: 'paste', action: async () => { try { const txt = await window.ephemera.clipboardRead(); if (txt) { address.focus(); address.setRangeText(txt, address.selectionStart, address.selectionEnd, 'end'); } } catch (_) {} } },
      { type: 'sep' },
      { label: ct('selectall'), icon: 'selectall', action: () => address.select() }
    ], e.clientX, e.clientY);
  });

  // Dismiss the menu on any outside interaction.
  window.addEventListener('mousedown', (e) => { if (!ctxMenu.contains(e.target)) closeCtx(); }, true);
  window.addEventListener('blur', closeCtx);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });

  // ── Downloads (Firefox-style arrow button + drop panel; files are ephemeral) ─
  const downloadsBtn   = $('#downloads-btn');
  const downloadsPanel = $('#downloads-panel');
  const dlListEl       = downloadsPanel.querySelector('.dl-list');
  const dlBtnFill      = downloadsBtn.querySelector('.dl-btn-bar > i');

  const DL_ICONS = {
    pause:  '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
    play:   '<path d="M7 4v16l13-8z"/>',
    x:      '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    open:   '<path d="M14 3h7v7"/><path d="M21 3 10 14"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
    folder: '<path d="M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-8l-2-2H4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1z"/>',
    trash:  '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    retry:  '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>'
  };
  const DL_FILE_ICONS = {
    done:   '<path d="M20 6 9 17l-5-5"/>',
    failed: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    file:   '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'
  };
  const dlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function dlFmtBytes(n) {
    if (!n || n < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
  }
  function dlFmtEta(sec) {
    if (!isFinite(sec) || sec < 0) return '';
    if (sec < 60) return Math.max(1, Math.round(sec)) + 's';
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    return Math.round(sec / 3600) + 'h';
  }
  // Smoothed instantaneous speed (bytes/sec) from successive byte counts.
  function dlSpeed(d) {
    const now = performance.now();
    const prev = dlRate.get(d.id);
    if (!prev) { dlRate.set(d.id, { bytes: d.receivedBytes, time: now, speed: 0 }); return 0; }
    const dt = (now - prev.time) / 1000;
    if (dt < 0.12) return prev.speed;
    const inst = Math.max(0, d.receivedBytes - prev.bytes) / dt;
    const speed = prev.speed ? prev.speed * 0.6 + inst * 0.4 : inst;
    dlRate.set(d.id, { bytes: d.receivedBytes, time: now, speed });
    return speed;
  }
  function dlStatusLine(d, speed) {
    const got = dlFmtBytes(d.receivedBytes);
    const total = d.totalBytes > 0 ? dlFmtBytes(d.totalBytes) : '';
    if (d.state === 'completed') return total || got;
    if (d.state === 'cancelled') return t('st_canceled');
    if (d.state === 'interrupted') return t('st_failed');
    const size = total ? got + ' / ' + total : got;
    if (d.state === 'paused') return size + ' · ' + t('st_paused');
    const parts = [size];
    if (speed > 0) parts.push(dlFmtBytes(speed) + '/s');
    if (d.totalBytes > 0 && speed > 0) {
      const eta = dlFmtEta((d.totalBytes - d.receivedBytes) / speed);
      if (eta) parts.push(eta + ' ' + t('dl_left'));
    }
    return parts.join(' · ');
  }
  function dlFileIcon(d) {
    const key = d.state === 'completed' ? 'done' : d.state === 'interrupted' ? 'failed' : 'file';
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${DL_FILE_ICONS[key]}</svg>`;
  }
  function dlActBtn(act, icon, label, danger) {
    return `<button class="dl-act${danger ? ' danger' : ''}" data-act="${act}" title="${dlEsc(label)}" aria-label="${dlEsc(label)}"><svg viewBox="0 0 24 24" aria-hidden="true">${DL_ICONS[icon]}</svg></button>`;
  }
  function dlActions(d) {
    if (d.state === 'progressing') return dlActBtn('pause', 'pause', t('dl_pause')) + dlActBtn('cancel', 'x', t('dl_cancel'), true);
    if (d.state === 'paused')      return dlActBtn('resume', 'play', t('dl_resume')) + dlActBtn('cancel', 'x', t('dl_cancel'), true);
    if (d.state === 'completed')   return dlActBtn('open', 'open', t('dl_open')) + dlActBtn('reveal', 'folder', t('dl_folder')) + dlActBtn('remove', 'trash', t('dl_remove'), true);
    if (d.state === 'interrupted') return dlActBtn('retry', 'retry', t('dl_retry')) + dlActBtn('remove', 'trash', t('dl_remove'), true);
    return dlActBtn('remove', 'trash', t('dl_remove'), true); // cancelled
  }

  function dlMakeRow(d) {
    const el = document.createElement('div');
    el.className = 'dl-item';
    el.dataset.id = d.id;
    el.innerHTML =
      '<span class="dl-ico"></span>' +
      '<div class="dl-main">' +
        '<div class="dl-name"></div>' +
        '<div class="dl-meta"></div>' +
        '<div class="dl-bar"><i></i></div>' +
      '</div>' +
      '<div class="dl-actions"></div>';
    return el;
  }
  function dlUpdateRow(el, d) {
    el.className = 'dl-item' + (d.state === 'completed' ? ' done' : '') + (d.state === 'interrupted' ? ' failed' : '');
    const speed = d.state === 'progressing' ? dlSpeed(d) : 0;
    // The row structure is fixed (built once in dlMakeRow), so cache the child
    // refs on first update instead of walking the subtree with six querySelectors
    // on every progress tick. Output DOM is identical.
    const refs = el.__dlRefs || (el.__dlRefs = {
      name: el.querySelector('.dl-name'), meta: el.querySelector('.dl-meta'),
      ico: el.querySelector('.dl-ico'), bar: el.querySelector('.dl-bar'),
      actions: el.querySelector('.dl-actions')
    });
    refs.name.textContent = d.filename;
    refs.name.title = d.filename;
    refs.meta.textContent = dlStatusLine(d, speed);
    refs.ico.innerHTML = dlFileIcon(d);
    const bar = refs.bar;
    const active = d.state === 'progressing' || d.state === 'paused';
    bar.style.display = active ? 'block' : 'none';
    const indet = active && !(d.totalBytes > 0);
    bar.classList.toggle('indeterminate', indet);
    if (!indet) bar.querySelector('i').style.width = (d.totalBytes > 0 ? Math.min(100, (d.receivedBytes / d.totalBytes) * 100) : 0) + '%';
    refs.actions.innerHTML = dlActions(d);
  }
  function renderDownloadPanel() {
    if (!dlItems.length) {
      dlListEl.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'dl-empty';
      empty.textContent = t('dl_empty');
      dlListEl.appendChild(empty);
      return;
    }
    const ids = new Set(dlItems.map((d) => d.id));
    Array.from(dlListEl.querySelectorAll('.dl-item')).forEach((el) => { if (!ids.has(el.dataset.id)) el.remove(); });
    const emptyEl = dlListEl.querySelector('.dl-empty');
    if (emptyEl) emptyEl.remove();
    for (let i = dlItems.length - 1; i >= 0; i--) { // newest first
      const d = dlItems[i];
      let el = dlListEl.querySelector(`.dl-item[data-id="${d.id}"]`);
      if (!el) { el = dlMakeRow(d); dlListEl.insertBefore(el, dlListEl.firstChild); }
      dlUpdateRow(el, d);
    }
  }
  function renderDownloadsButton() {
    const has = dlItems.length > 0;
    downloadsBtn.hidden = !has;
    downloadsBtn.classList.toggle('has-items', has);
    const anyActive = dlItems.some((d) => d.state === 'progressing');
    downloadsBtn.classList.toggle('active', anyActive);
    let recv = 0, tot = 0, known = true;
    dlItems.forEach((d) => {
      if (d.state === 'progressing' || d.state === 'paused') {
        recv += d.receivedBytes;
        if (d.totalBytes > 0) tot += d.totalBytes; else known = false;
      }
    });
    if (anyActive && known && tot > 0) dlBtnFill.style.width = Math.min(100, (recv / tot) * 100) + '%';
    else if (anyActive) dlBtnFill.style.width = '45%';
    else dlBtnFill.style.width = '0%';
  }
  function renderDownloads() {
    renderDownloadsButton();
    if (dlPanelOpen) renderDownloadPanel();
  }

  function positionDownloads() {
    const r = downloadsBtn.getBoundingClientRect();
    const w = Math.min(360, window.innerWidth * 0.92);
    let left = r.right - w;
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    downloadsPanel.style.left = left + 'px';
    downloadsPanel.style.top = (r.bottom + 6) + 'px';
  }
  function openDownloads() {
    if (downloadsBtn.hidden) return;
    dlPanelOpen = true;
    positionDownloads();
    downloadsPanel.classList.add('show');
    downloadsPanel.setAttribute('aria-hidden', 'false');
    renderDownloadPanel();
  }
  function closeDownloads() {
    dlPanelOpen = false;
    downloadsPanel.classList.remove('show');
    downloadsPanel.setAttribute('aria-hidden', 'true');
  }
  function flashDownloadsBtn() {
    downloadsBtn.classList.remove('done-flash');
    void downloadsBtn.offsetWidth;
    downloadsBtn.classList.add('done-flash');
  }

  downloadsBtn.addEventListener('click', () => { dlPanelOpen ? closeDownloads() : openDownloads(); });
  downloadsPanel.querySelector('.dl-clear').addEventListener('click', () => { window.ephemera.downloads.clear(); });
  dlListEl.addEventListener('click', (e) => {
    const row = e.target.closest('.dl-item');
    if (!row) return;
    const id = row.dataset.id;
    const api = window.ephemera.downloads;
    const btn = e.target.closest('[data-act]');
    if (!btn) { // clicking the body of a finished row opens the file
      const d = dlItems.find((x) => x.id === id);
      if (d && d.state === 'completed') api.open(id);
      return;
    }
    const act = btn.dataset.act;
    if (typeof api[act] === 'function') api[act](id);
  });
  // Outside-click / Escape / resize for the panel.
  window.addEventListener('mousedown', (e) => {
    if (dlPanelOpen && !downloadsPanel.contains(e.target) && !downloadsBtn.contains(e.target)) closeDownloads();
  }, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dlPanelOpen) closeDownloads(); });
  // (resize repositioning is handled by the single coalesced resize handler above)

  window.ephemera.downloads.onUpdate((list) => {
    const incoming = Array.isArray(list) ? list : [];
    const prevIds = dlSeenIds;
    const nextIds = new Set(incoming.map((d) => d.id));
    let isNew = false;
    incoming.forEach((d) => { if (!prevIds.has(d.id)) isNew = true; });
    incoming.forEach((d) => {
      if (d.state === 'completed' && !dlDoneIds.has(d.id)) { dlDoneIds.add(d.id); flashDownloadsBtn(); }
    });
    Array.from(dlRate.keys()).forEach((id) => { if (!nextIds.has(id)) dlRate.delete(id); });
    Array.from(dlDoneIds).forEach((id) => { if (!nextIds.has(id)) dlDoneIds.delete(id); });
    dlSeenIds = nextIds;
    dlItems = incoming;
    renderDownloads();
    if (isNew) { openDownloads(); flashDownloadsBtn(); } // a new download pops the panel, Firefox-style
  });

  // ── Boot ────────────────────────────────────────────────────────────────
  (async () => {
    try {
      const s = await window.ephemera.getSettings();
      if (s) applySettings(s);
    } catch (_) {}
    try {
      const list = await window.ephemera.downloads.getAll();
      if (Array.isArray(list) && list.length) {
        dlItems = list;
        dlSeenIds = new Set(list.map((d) => d.id));
        list.forEach((d) => { if (d.state === 'completed') dlDoneIds.add(d.id); });
        renderDownloads();
      }
    } catch (_) {}
    createTab(newtabTarget());
  })();
})();
