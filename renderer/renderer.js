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
  // Proxy/SOCKS failures on a Tor tab = Tor not reachable (daemon stopped, Tor
  // Browser closed). ERR_PROXY_CONNECTION_FAILED (-130), ERR_SOCKS_CONNECTION_FAILED
  // (-120), ERR_SOCKS_CONNECTION_HOST_UNREACHABLE (-121). We branch on these for Tor
  // tabs so they show the Tor onboarding, not the generic offline easter egg.
  const TOR_NET_ERR = new Set([-130, -120, -121]);

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
    cleanSlate: 'subtle', adblock: true, sendDnt: true, blockThirdPartyCookies: true,
    language: 'en', highPerf: false, beautifulMode: false, startMaximized: true,
    torEnabled: true, torPort: 0, torUseBundled: true,
    securityLevel: 'standard', torSecurityLevel: 'safer', onionSecurityLevel: 'safer'
  };
  const searchURL = () => ENGINES[settings.searchEngine] || ENGINES.duckduckgo;

  // ── Onion routing (Tor) live state ────────────────────────────────────────
  // Mirrored from main; { enabled, running, starting, bootstrap, bundled, port,
  // ready }. The banner + omnibox badge + Tor new-tab page read from this, and a
  // poll keeps it fresh while a Tor tab is in front (so "starting -> connected" and
  // "connected -> off" flip on their own).
  let tor = { enabled: true, running: false, starting: false, bootstrap: 100, bundled: false, port: null, ready: false };
  let torPollTimer = null;
  let torBannerDismissed = false; // user dismissed the "connected" confirmation (reset on tab/state change)
  let torConnectStartedAt = 0;    // when the current "connecting" began (for the stalled-bootstrap escape)

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
      lbl_cookies: 'Block cross-site cookies', sub_cookies: 'Stop third-party cookies tracking you between sites',
      find_ph: 'Find in page', find_prev: 'Previous (Shift+Enter)', find_next: 'Next (Enter)', find_close: 'Close (Esc)',
      lbl_counter: 'Show tracker counter', lbl_cleanslate: 'Clean Slate button',
      seg_colour: 'Colour', seg_mono: 'Mono', seg_navy: 'Navy', seg_blue: 'Blue', seg_grey: 'Grey', seg_subtle: 'Subtle', seg_red: 'Red',
      clr_blue: 'Blue', clr_green: 'Green', clr_purple: 'Purple', clr_amber: 'Amber', clr_coral: 'Coral',
      cs_label: 'Clean Slate', tip_newtab: 'New tab (Ctrl+T). Right-click for an onion tab', tip_back: 'Back', tip_forward: 'Forward', tip_reload: 'Reload',
      tip_shield: 'Private session, DNT and GPC sent', tip_tracker: 'Ads and trackers blocked this session',
      tip_cleanslate: 'Clean Slate, wipe everything (Ctrl+Shift+K)', tip_settings: 'Settings (Ctrl+,)',
      toast_cleanslate: 'Clean slate. Cookies, cache and history wiped.',
      confirm_title: 'Are you sure?', confirm_msg: 'This wipes all cookies, cache and history.', btn_yes: 'Yes', btn_no: 'No', wipe_label: 'Cleaning everything',
      quit_title: 'Close Ephemera?', quit_msg: 'This is your last tab. Closing it quits the browser.',
      off_title: 'No internet connection', off_sub: 'Ephemera could not reach the network.', off_retry: 'Retry', off_hint: '← →  move · space fire · enter retry',
      err_title: 'This site can’t be reached', err_sub: 'Check the address, or try again.',
      err_title_broken: 'This page isn’t working', err_title_secure: 'Your connection is not private',
      err_s_dns: 'We can’t find the server for {host}. Check the address for typos.',
      err_s_refused: '{host} refused to connect.', err_s_timeout: '{host} took too long to respond.',
      err_s_reset: 'The connection to {host} was interrupted.', err_s_redirect: '{host} redirected you too many times.',
      err_s_empty: '{host} didn’t send any data.', err_s_url: 'That web address isn’t valid.',
      err_s_proxy: 'The proxy server refused the connection.', err_s_blocked: 'Ephemera blocked this page from loading.',
      err_s_cert: 'Attackers might be trying to steal your information from {host}.',
      err_s_generic: 'Something went wrong while loading {host}.',
      err_hint: 'Press Enter to try again', err_retry: 'Try again', err_back: 'Go back', zoom_reset: 'Reset',
      tip_downloads: 'Downloads', dl_title: 'Downloads', dl_clear: 'Clear', dl_empty: 'No downloads yet', dl_note: 'Files are erased on Clean Slate',
      dl_open: 'Open', dl_folder: 'Show in folder', dl_retry: 'Retry', dl_remove: 'Remove', dl_pause: 'Pause', dl_resume: 'Resume', dl_cancel: 'Cancel', dl_left: 'left',
      st_completed: 'Completed', st_canceled: 'Canceled', st_failed: 'Failed', st_paused: 'Paused',
      cdw_title: 'Downloaded files will be erased', cdw_sub: 'Everything you saved this session is deleted for good.',
      toast_cleanslate_dl: 'Clean slate. Cookies, cache, history and downloads wiped.',
      tor_newtab: 'New Tor tab', tor_tip: 'New Tor tab, anonymous (Ctrl+Shift+N)',
      tor_pill: 'Anonymous. Your traffic is routed over Tor.',
      tor_connected: "You're browsing over Tor. Your traffic is anonymous.",
      tor_off_sub: "Tor isn't running. Start Tor or Tor Browser to browse anonymously.",
      tor_get: 'Get Tor', tor_check: 'Check again', tor_newid: 'New identity',
      tor_stopped: 'Tor stopped. Start it to keep browsing anonymously.',
      tor_newid_done: 'New Tor identity. Session reset.',
      lbl_tor: 'Onion routing (Tor)', sub_tor: 'Open anonymous tabs over the Tor network. Requires Tor running.',
      sec_security: 'Security levels', sub_security: 'Standard: everything on. Safer: no JavaScript on insecure sites. Safest: no JavaScript.',
      lbl_sec_normal: 'Normal browsing', sub_sec_normal: 'JavaScript and active content on regular tabs',
      lbl_sec_tor: 'Tor browsing', sub_sec_tor: 'Clearnet sites opened over Tor',
      lbl_sec_onion: '.onion services', sub_sec_onion: 'Onion sites opened over Tor. Safer = first-party scripts only.',
      seclvl_standard: 'Standard', seclvl_safer: 'Safer', seclvl_safest: 'Safest',
      ctx_normal_tab: 'New tab', ctx_onion_tab: 'New onion tab',
      tor_badge_on: 'Onion', tor_badge_off: 'Tor off',
      tor_omnibox_ph: 'Search or enter address, over Tor',
      tor_unavailable: 'Tor could not start. The onion tab was not opened.',
      tor_connecting: 'Connecting to Tor…', tor_badge_starting: 'Starting',
      tor_trouble: 'Trouble connecting. Your network may be blocking Tor.', tor_retry: 'Retry'
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
      lbl_cookies: 'Bloquear cookies entre sitios', sub_cookies: 'Impide que las cookies de terceros te rastreen entre sitios',
      find_ph: 'Buscar en la página', find_prev: 'Anterior (Mayús+Intro)', find_next: 'Siguiente (Intro)', find_close: 'Cerrar (Esc)',
      lbl_counter: 'Mostrar contador de rastreadores', lbl_cleanslate: 'Botón Clean Slate',
      seg_colour: 'Color', seg_mono: 'Mono', seg_navy: 'Azul marino', seg_blue: 'Azul', seg_grey: 'Gris', seg_subtle: 'Sutil', seg_red: 'Rojo',
      clr_blue: 'Azul', clr_green: 'Verde', clr_purple: 'Púrpura', clr_amber: 'Ámbar', clr_coral: 'Coral',
      cs_label: 'Limpiar', tip_newtab: 'Nueva pestaña (Ctrl+T). Clic derecho para una pestaña onion', tip_back: 'Atrás', tip_forward: 'Adelante', tip_reload: 'Recargar',
      tip_shield: 'Sesión privada, DNT y GPC enviados', tip_tracker: 'Anuncios y rastreadores bloqueados esta sesión',
      tip_cleanslate: 'Limpiar todo (Ctrl+Shift+K)', tip_settings: 'Ajustes (Ctrl+,)',
      toast_cleanslate: 'Borrón nuevo. Cookies, caché e historial borrados.',
      confirm_title: '¿Estás seguro?', confirm_msg: 'Esto borra todas las cookies, caché e historial.', btn_yes: 'Sí', btn_no: 'No', wipe_label: 'Limpiando todo',
      quit_title: '¿Cerrar Ephemera?', quit_msg: 'Es tu última pestaña. Al cerrarla se cierra el navegador.',
      off_title: 'Sin conexión a internet', off_sub: 'Ephemera no pudo conectar con la red.', off_retry: 'Reintentar', off_hint: '← →  mover · espacio disparar · enter reintentar',
      err_title: 'No se puede acceder a este sitio', err_sub: 'Comprueba la dirección o inténtalo de nuevo.',
      err_title_broken: 'Esta página no funciona', err_title_secure: 'Tu conexión no es privada',
      err_s_dns: 'No encontramos el servidor de {host}. Revisa si la dirección tiene errores.',
      err_s_refused: '{host} rechazó la conexión.', err_s_timeout: '{host} tardó demasiado en responder.',
      err_s_reset: 'Se interrumpió la conexión con {host}.', err_s_redirect: '{host} te redirigió demasiadas veces.',
      err_s_empty: '{host} no envió ningún dato.', err_s_url: 'Esa dirección web no es válida.',
      err_s_proxy: 'El servidor proxy rechazó la conexión.', err_s_blocked: 'Ephemera bloqueó la carga de esta página.',
      err_s_cert: 'Algún atacante podría intentar robar tu información de {host}.',
      err_s_generic: 'Algo salió mal al cargar {host}.',
      err_hint: 'Pulsa Enter para reintentar', err_retry: 'Reintentar', err_back: 'Atrás', zoom_reset: 'Restablecer',
      tip_downloads: 'Descargas', dl_title: 'Descargas', dl_clear: 'Borrar', dl_empty: 'Aún no hay descargas', dl_note: 'Los archivos se borran al limpiar',
      dl_open: 'Abrir', dl_folder: 'Mostrar en carpeta', dl_retry: 'Reintentar', dl_remove: 'Quitar', dl_pause: 'Pausar', dl_resume: 'Reanudar', dl_cancel: 'Cancelar', dl_left: 'restante',
      st_completed: 'Completada', st_canceled: 'Cancelada', st_failed: 'Fallida', st_paused: 'En pausa',
      cdw_title: 'Los archivos descargados se borrarán', cdw_sub: 'Todo lo que guardaste esta sesión se elimina definitivamente.',
      toast_cleanslate_dl: 'Borrón nuevo. Cookies, caché, historial y descargas borrados.',
      tor_newtab: 'Nueva pestaña Tor', tor_tip: 'Nueva pestaña Tor, anónima (Ctrl+Shift+N)',
      tor_pill: 'Anónimo. Tu tráfico se enruta por Tor.',
      tor_connected: 'Estás navegando por Tor. Tu tráfico es anónimo.',
      tor_off_sub: 'Tor no está en ejecución. Inicia Tor o Tor Browser para navegar en anonimato.',
      tor_get: 'Obtener Tor', tor_check: 'Comprobar otra vez', tor_newid: 'Nueva identidad',
      tor_stopped: 'Tor se detuvo. Inícialo para seguir navegando en anonimato.',
      tor_newid_done: 'Nueva identidad Tor. Sesión reiniciada.',
      lbl_tor: 'Enrutado cebolla (Tor)', sub_tor: 'Abre pestañas anónimas por la red Tor. Requiere Tor en ejecución.',
      sec_security: 'Niveles de seguridad', sub_security: 'Estándar: todo activo. Más seguro: sin JavaScript en sitios inseguros. El más seguro: sin JavaScript.',
      lbl_sec_normal: 'Navegación normal', sub_sec_normal: 'JavaScript y contenido activo en pestañas normales',
      lbl_sec_tor: 'Navegación por Tor', sub_sec_tor: 'Sitios de la red abierta abiertos por Tor',
      lbl_sec_onion: 'Servicios .onion', sub_sec_onion: 'Sitios onion abiertos por Tor. Más seguro = solo scripts propios.',
      seclvl_standard: 'Estándar', seclvl_safer: 'Más seguro', seclvl_safest: 'El más seguro',
      ctx_normal_tab: 'Nueva pestaña', ctx_onion_tab: 'Nueva pestaña onion',
      tor_badge_on: 'Onion', tor_badge_off: 'Tor apagado',
      tor_omnibox_ph: 'Busca o escribe una dirección, por Tor',
      tor_unavailable: 'Tor no pudo iniciarse. No se abrió la pestaña onion.',
      tor_connecting: 'Conectando a Tor…', tor_badge_starting: 'Iniciando',
      tor_trouble: 'Problemas para conectar. Tu red puede estar bloqueando Tor.', tor_retry: 'Reintentar'
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
      lbl_cookies: 'Блокировать межсайтовые куки', sub_cookies: 'Запрет сторонним куки отслеживать вас между сайтами',
      find_ph: 'Найти на странице', find_prev: 'Предыдущее (Shift+Enter)', find_next: 'Следующее (Enter)', find_close: 'Закрыть (Esc)',
      lbl_counter: 'Показывать счётчик трекеров', lbl_cleanslate: 'Кнопка Clean Slate',
      seg_colour: 'Цвет', seg_mono: 'Моно', seg_navy: 'Тёмный', seg_blue: 'Синий', seg_grey: 'Серый', seg_subtle: 'Скрытая', seg_red: 'Красная',
      clr_blue: 'Синий', clr_green: 'Зелёный', clr_purple: 'Фиолетовый', clr_amber: 'Янтарный', clr_coral: 'Коралловый',
      cs_label: 'Очистить', tip_newtab: 'Новая вкладка (Ctrl+T). Правый клик — onion-вкладка', tip_back: 'Назад', tip_forward: 'Вперёд', tip_reload: 'Обновить',
      tip_shield: 'Приватная сессия, DNT и GPC отправляются', tip_tracker: 'Реклама и трекеры заблокированы за сессию',
      tip_cleanslate: 'Очистить всё (Ctrl+Shift+K)', tip_settings: 'Настройки (Ctrl+,)',
      toast_cleanslate: 'Чистый лист. Куки, кэш и история удалены.',
      confirm_title: 'Вы уверены?', confirm_msg: 'Это удалит все куки, кэш и историю.', btn_yes: 'Да', btn_no: 'Нет', wipe_label: 'Очистка',
      quit_title: 'Закрыть Ephemera?', quit_msg: 'Это последняя вкладка. Её закрытие закроет браузер.',
      off_title: 'Нет подключения к интернету', off_sub: 'Ephemera не удалось подключиться к сети.', off_retry: 'Повторить', off_hint: '← →  движение · пробел огонь · enter повтор',
      err_title: 'Не удаётся открыть этот сайт', err_sub: 'Проверьте адрес или повторите попытку.',
      err_title_broken: 'Страница не работает', err_title_secure: 'Подключение не защищено',
      err_s_dns: 'Не удалось найти сервер {host}. Проверьте адрес на опечатки.',
      err_s_refused: '{host} отклонил подключение.', err_s_timeout: '{host} слишком долго не отвечает.',
      err_s_reset: 'Соединение с {host} было прервано.', err_s_redirect: '{host} слишком много раз перенаправлял запрос.',
      err_s_empty: '{host} не отправил никаких данных.', err_s_url: 'Неверный веб-адрес.',
      err_s_proxy: 'Прокси-сервер отклонил подключение.', err_s_blocked: 'Ephemera заблокировал загрузку этой страницы.',
      err_s_cert: 'Злоумышленники могут пытаться похитить ваши данные с сайта {host}.',
      err_s_generic: 'Не удалось загрузить {host}.',
      err_hint: 'Нажмите Enter, чтобы повторить', err_retry: 'Повторить', err_back: 'Назад', zoom_reset: 'Сбросить',
      tip_downloads: 'Загрузки', dl_title: 'Загрузки', dl_clear: 'Очистить', dl_empty: 'Пока нет загрузок', dl_note: 'Файлы удаляются при очистке',
      dl_open: 'Открыть', dl_folder: 'Показать в папке', dl_retry: 'Повторить', dl_remove: 'Удалить', dl_pause: 'Пауза', dl_resume: 'Продолжить', dl_cancel: 'Отмена', dl_left: 'осталось',
      st_completed: 'Завершено', st_canceled: 'Отменено', st_failed: 'Ошибка', st_paused: 'Пауза',
      cdw_title: 'Загруженные файлы будут удалены', cdw_sub: 'Всё, что вы сохранили за эту сессию, удаляется безвозвратно.',
      toast_cleanslate_dl: 'Чистый лист. Куки, кэш, история и загрузки удалены.',
      tor_newtab: 'Новая вкладка Tor', tor_tip: 'Новая вкладка Tor, анонимно (Ctrl+Shift+N)',
      tor_pill: 'Анонимно. Ваш трафик идёт через Tor.',
      tor_connected: 'Вы просматриваете через Tor. Ваш трафик анонимен.',
      tor_off_sub: 'Tor не запущен. Запустите Tor или Tor Browser для анонимного просмотра.',
      tor_get: 'Установить Tor', tor_check: 'Проверить снова', tor_newid: 'Новая личность',
      tor_stopped: 'Tor остановлен. Запустите его, чтобы продолжить анонимно.',
      tor_newid_done: 'Новая личность Tor. Сессия сброшена.',
      lbl_tor: 'Луковая маршрутизация (Tor)', sub_tor: 'Анонимные вкладки через сеть Tor. Требуется запущенный Tor.',
      sec_security: 'Уровни безопасности', sub_security: 'Стандартный: всё включено. Безопаснее: без JavaScript на небезопасных сайтах. Самый безопасный: без JavaScript.',
      lbl_sec_normal: 'Обычный просмотр', sub_sec_normal: 'JavaScript и активный контент в обычных вкладках',
      lbl_sec_tor: 'Просмотр через Tor', sub_sec_tor: 'Сайты обычного интернета, открытые через Tor',
      lbl_sec_onion: 'Сервисы .onion', sub_sec_onion: 'Onion-сайты через Tor. Безопаснее = только собственные скрипты.',
      seclvl_standard: 'Стандартный', seclvl_safer: 'Безопаснее', seclvl_safest: 'Самый безопасный',
      ctx_normal_tab: 'Новая вкладка', ctx_onion_tab: 'Новая onion-вкладка',
      tor_badge_on: 'Onion', tor_badge_off: 'Tor выкл.',
      tor_omnibox_ph: 'Поиск или адрес, через Tor',
      tor_unavailable: 'Не удалось запустить Tor. Onion-вкладка не открыта.',
      tor_connecting: 'Подключение к Tor…', tor_badge_starting: 'Запуск',
      tor_trouble: 'Не удаётся подключиться. Ваша сеть может блокировать Tor.', tor_retry: 'Повторить'
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
      lbl_startmax: 'Avaa suurennettuna', sub_startmax: 'Täytä näyttö, kun Ephemera käynnistyy',
      lbl_dnt: 'Lähetä DNT ja GPC', sub_dnt: 'Do-Not-Track ja Global Privacy Control',
      lbl_cookies: 'Estä sivustojen väliset evästeet', sub_cookies: 'Estä kolmannen osapuolen evästeitä seuraamasta sinua sivustojen välillä',
      find_ph: 'Etsi sivulta', find_prev: 'Edellinen (Shift+Enter)', find_next: 'Seuraava (Enter)', find_close: 'Sulje (Esc)',
      lbl_counter: 'Näytä seurantalaskuri', lbl_cleanslate: 'Clean Slate -painike',
      seg_colour: 'Väri', seg_mono: 'Mono', seg_navy: 'Tumma', seg_blue: 'Sininen', seg_grey: 'Harmaa', seg_subtle: 'Hillitty', seg_red: 'Punainen',
      clr_blue: 'Sininen', clr_green: 'Vihreä', clr_purple: 'Violetti', clr_amber: 'Keltainen', clr_coral: 'Koralli',
      cs_label: 'Tyhjennä', tip_newtab: 'Uusi välilehti (Ctrl+T). Oikea klikkaus avaa onion-välilehden', tip_back: 'Takaisin', tip_forward: 'Eteenpäin', tip_reload: 'Lataa uudelleen',
      tip_shield: 'Yksityinen istunto, DNT ja GPC lähetetään', tip_tracker: 'Estetyt mainokset ja seuranta tässä istunnossa',
      tip_cleanslate: 'Tyhjennä kaikki (Ctrl+Shift+K)', tip_settings: 'Asetukset (Ctrl+,)',
      toast_cleanslate: 'Puhdas pöytä. Evästeet, välimuisti ja historia tyhjennetty.',
      confirm_title: 'Oletko varma?', confirm_msg: 'Tämä tyhjentää kaikki evästeet, välimuistin ja historian.', btn_yes: 'Kyllä', btn_no: 'Ei', wipe_label: 'Tyhjennetään',
      quit_title: 'Suljetaanko Ephemera?', quit_msg: 'Tämä on viimeinen välilehti. Sen sulkeminen sulkee selaimen.',
      off_title: 'Ei internet-yhteyttä', off_sub: 'Ephemera ei saanut yhteyttä verkkoon.', off_retry: 'Yritä uudelleen', off_hint: '← →  liiku · väli ammu · enter uudelleen',
      err_title: 'Sivustoon ei saada yhteyttä', err_sub: 'Tarkista osoite tai yritä uudelleen.',
      err_title_broken: 'Tämä sivu ei toimi', err_title_secure: 'Yhteytesi ei ole yksityinen',
      err_s_dns: 'Palvelinta {host} ei löytynyt. Tarkista osoite kirjoitusvirheiden varalta.',
      err_s_refused: '{host} hylkäsi yhteyden.', err_s_timeout: '{host} vastasi liian hitaasti.',
      err_s_reset: 'Yhteys palvelimeen {host} katkesi.', err_s_redirect: '{host} ohjasi sinut edelleen liian monta kertaa.',
      err_s_empty: '{host} ei lähettänyt mitään tietoja.', err_s_url: 'Verkko-osoite ei kelpaa.',
      err_s_proxy: 'Välityspalvelin hylkäsi yhteyden.', err_s_blocked: 'Ephemera esti tämän sivun lataamisen.',
      err_s_cert: 'Hyökkääjät voivat yrittää varastaa tietojasi sivustolta {host}.',
      err_s_generic: 'Sivun {host} lataaminen epäonnistui.',
      err_hint: 'Paina Enter yrittääksesi uudelleen', err_retry: 'Yritä uudelleen', err_back: 'Takaisin', zoom_reset: 'Nollaa',
      tip_downloads: 'Lataukset', dl_title: 'Lataukset', dl_clear: 'Tyhjennä', dl_empty: 'Ei vielä latauksia', dl_note: 'Tiedostot poistetaan tyhjennyksessä',
      dl_open: 'Avaa', dl_folder: 'Näytä kansiossa', dl_retry: 'Yritä uudelleen', dl_remove: 'Poista', dl_pause: 'Keskeytä', dl_resume: 'Jatka', dl_cancel: 'Peruuta', dl_left: 'jäljellä',
      st_completed: 'Valmis', st_canceled: 'Peruutettu', st_failed: 'Epäonnistui', st_paused: 'Keskeytetty',
      cdw_title: 'Ladatut tiedostot poistetaan', cdw_sub: 'Kaikki tässä istunnossa tallennettu poistetaan lopullisesti.',
      toast_cleanslate_dl: 'Puhdas pöytä. Evästeet, välimuisti, historia ja lataukset tyhjennetty.',
      tor_newtab: 'Uusi Tor-välilehti', tor_tip: 'Uusi Tor-välilehti, nimetön (Ctrl+Shift+N)',
      tor_pill: 'Nimetön. Liikenteesi reititetään Torin kautta.',
      tor_connected: 'Selaat Torin kautta. Liikenteesi on nimetöntä.',
      tor_off_sub: 'Tor ei ole käynnissä. Käynnistä Tor tai Tor Browser selataksesi nimettömänä.',
      tor_get: 'Hanki Tor', tor_check: 'Tarkista uudelleen', tor_newid: 'Uusi identiteetti',
      tor_stopped: 'Tor pysähtyi. Käynnistä se jatkaaksesi nimettömänä.',
      tor_newid_done: 'Uusi Tor-identiteetti. Istunto nollattu.',
      lbl_tor: 'Sipulireititys (Tor)', sub_tor: 'Avaa nimettömiä välilehtiä Tor-verkon kautta. Vaatii käynnissä olevan Torin.',
      sec_security: 'Turvatasot', sub_security: 'Vakio: kaikki päällä. Turvallisempi: ei JavaScriptiä turvattomilla sivustoilla. Turvallisin: ei JavaScriptiä.',
      lbl_sec_normal: 'Normaali selailu', sub_sec_normal: 'JavaScript ja aktiivinen sisältö tavallisilla välilehdillä',
      lbl_sec_tor: 'Tor-selailu', sub_sec_tor: 'Avoimen verkon sivut Torin kautta',
      lbl_sec_onion: '.onion-palvelut', sub_sec_onion: 'Onion-sivut Torin kautta. Turvallisempi = vain sivuston omat skriptit.',
      seclvl_standard: 'Vakio', seclvl_safer: 'Turvallisempi', seclvl_safest: 'Turvallisin',
      ctx_normal_tab: 'Uusi välilehti', ctx_onion_tab: 'Uusi onion-välilehti',
      tor_badge_on: 'Onion', tor_badge_off: 'Tor pois',
      tor_omnibox_ph: 'Hae tai kirjoita osoite, Torin kautta',
      tor_unavailable: 'Toria ei voitu käynnistää. Onion-välilehteä ei avattu.',
      tor_connecting: 'Yhdistetään Toriin…', tor_badge_starting: 'Käynnistyy',
      tor_trouble: 'Yhteysongelma. Verkkosi voi estää Torin.', tor_retry: 'Yritä uudelleen'
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
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
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
    if (!/\s/.test(s) && hostLike.test(s)) {
      // .onion services are almost always plain-http (a v3 onion address provides
      // its own end-to-end encryption to the hidden service), so forcing https
      // would just fail the handshake. Prefix http:// for .onion, https:// else.
      return (/\.onion\.?(?:[:/?#]|$)/i.test(s) ? 'http://' : 'https://') + s;
    }
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

  function makeWebview(src, opts) {
    const wv = document.createElement('webview');
    // Tor tabs live in their OWN partition (ephemera-tor) so they get a separate
    // proxy + cookie jar from normal tabs; everything else uses the shared
    // in-memory session. Both are non-persistent, so neither touches disk.
    wv.setAttribute('partition', opts && opts.tor ? 'ephemera-tor' : 'ephemera');
    wv.setAttribute('allowpopups', '');        // popups are denied + re-opened as tabs in main
    if (opts && opts.tor) wv.classList.add('tor');
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

  function createTab(url, opts) {
    const id = 'tab-' + ++seq;
    const tor = !!(opts && opts.tor);
    const target = url || NEWTAB_URL;

    // Adopt the pre-warmed page for a plain new tab: it is already loaded, styled
    // and painted, so it appears instantly instead of spinning up from scratch.
    // Tor tabs never adopt the spare - the spare lives on the normal partition.
    const adopt = !tor && !!(spareWebview && spareReady && target === NEWTAB_URL);
    let webview;
    if (adopt) {
      webview = spareWebview;
      spareWebview = null;
      spareReady = false;
    } else {
      webview = makeWebview(target, { tor });
    }

    const tabEl = document.createElement('div');
    tabEl.className = tor ? 'tab tor' : 'tab';
    tabEl.setAttribute('role', 'tab');
    tabEl.innerHTML =
      '<span class="tab-favicon is-default"></span>' +
      '<span class="tab-title">New tab</span>' +
      '<button class="tab-close" title="Close tab" aria-label="Close tab">' +
      '<svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>';
    tabsEl.insertBefore(tabEl, newtabBtn); // tabs sit before the trailing "+" and drag-fill

    const tab = {
      id, webview, tabEl, target, tor,
      title: tor ? t('tor_newtab') : t('newtab'), url: target, favicon: null,
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
      if (!tab.failed) {
        if (tab.offline) { tab.offline = null; if (tab.id === activeId) hideOffline(); }
        if (tab.error)   { tab.error = null;   if (tab.id === activeId) hideError(); }
      }
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
      // Tor tab whose request failed because Tor isn't reachable: don't show the
      // generic offline egg. Snap back to the onion onboarding page, flag Tor down,
      // and the active-tab poll recovers it the moment Tor comes (back) up.
      if (e.isMainFrame && tab.tor && TOR_NET_ERR.has(e.errorCode)) {
        tab.failed = false; tab.offline = null;
        tor.running = false;
        // Always snap to the onion onboarding page: the failed nav left a bare
        // Chromium proxy-error void, and tab.url is the stale last-committed URL,
        // so we can't reliably tell "already on newtab" - just reload it.
        try { tab.webview.src = NEWTAB_URL; } catch (_) {}
        if (tab.id === activeId) {
          updateTorChrome();
          // Don't cry "Tor stopped" while the bundled tor is still bootstrapping -
          // the banner already shows "Connecting…". Only warn on a real drop.
          if (!tor.starting) showToast(t('tor_stopped'));
        }
        renderTab(tab);
        if (tab.id === activeId) syncChrome();
        return;
      }
      // Any main-frame load that failed at the network level raises one of our own
      // screens in place of the bare Chromium error page - which the guest <webview>
      // renders as a blank void otherwise. A genuine network outage gets the
      // no-internet easter egg; a single host that wouldn't load while the
      // connection is fine gets the diagnostic error screen (the real Chromium code
      // set as the hero). HTTP error responses (404/500) are NOT failures here - the
      // server answered - so they render normally; this only fires when no page came
      // back at all.
      if (e.isMainFrame) {
        tab.failed = true;
        const rec = { url: e.validatedURL || tab.url, code: e.errorCode, desc: e.errorDescription || '' };
        if (isOfflineError(e.errorCode)) {
          tab.error = null;
          tab.offline = { ...rec, online: false };
          if (tab.id === activeId) { hideError(); showOffline(tab); }
        } else {
          tab.offline = null;
          tab.error = rec;
          if (tab.id === activeId) { hideOffline(); showError(tab); }
        }
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
      fav.classList.remove('is-default', 'is-newtab', 'is-tor');
      if (tab.tor && isNewtab(tab.url)) {
        fav.classList.add('is-tor'); // onion mark in place of the bug, on a Tor new tab
        fav.style.backgroundImage = '';
      } else if (isNewtab(tab.url)) {
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
      } else if (tab.tor) {
        fav.classList.add('is-tor'); // a Tor page with no favicon still reads as Tor
        fav.style.backgroundImage = '';
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
    syncError();
    updateTorChrome(); // onion pill + Tor banner follow the active tab
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
    // Closing the only remaining tab would leave the window empty. Instead of
    // silently spawning a blank tab, ask whether to close the browser. "No" leaves
    // this tab untouched; "Yes" quits. (The X button, middle-click and Ctrl+W all
    // route through here, so every "close the last tab" path is covered.)
    if (tabs.size === 1) { requestQuit(); return; }
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
    // A live connection that just couldn't load THIS host shows the "can't reach
    // this site" wording; a genuine outage keeps the "no internet" wording.
    const strings = off.online
      ? { title: t('err_title'), sub: t('err_sub'), retry: t('off_retry'), hint: t('off_hint') }
      : { title: t('off_title'), sub: t('off_sub'), retry: t('off_retry'), hint: t('off_hint') };
    window.__ephemeraOffline.show({
      host: hostOf(url),
      code: cleanErr(off.desc, off.code),
      accent,
      strings,
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

  // ── Error screen (per-site load failures: DNS, refused, TLS, timeout, …) ────
  // Map a Chromium net error code to a failure CLASS plus the prominent Chrome-
  // style code to headline: DNS gets the famous DNS_PROBE_FINISHED_NXDOMAIN;
  // everything else headlines its own ERR_ name, exactly like Chrome does.
  function classifyError(code, errName) {
    const mk = (kind, big) => ({ kind, big: big || errName });
    switch (code) {
      case -105: case -137: return mk('dns', 'DNS_PROBE_FINISHED_NXDOMAIN');
      case -102: return mk('refused');
      case -7: case -118: return mk('timeout');
      case -100: case -101: case -103: case -104: case -109: case -21: return mk('reset');
      case -310: return mk('redirect');
      case -324: return mk('empty');
      case -300: case -301: case -302: return mk('url');
      case -131: case -336: return mk('proxy'); // -130 is handled as a Tor-down case above
      case -20: case -27: return mk('blocked');
      default:
        // TLS/cert family: SSL protocol, cipher mismatch, every CERT_* code, insecure response.
        if (code === -107 || code === -113 || code === -501 || (code <= -200 && code >= -219)) return mk('cert');
        return mk('generic');
    }
  }
  // kind → { title key, host-aware sub key, terminal verb, glyph name }.
  const ERROR_KINDS = {
    dns:      { title: 'err_title',        sub: 'err_s_dns',      verb: 'lookup',  glyph: 'dns' },
    refused:  { title: 'err_title',        sub: 'err_s_refused',  verb: 'connect', glyph: 'refused' },
    timeout:  { title: 'err_title',        sub: 'err_s_timeout',  verb: 'connect', glyph: 'timeout' },
    reset:    { title: 'err_title',        sub: 'err_s_reset',    verb: 'connect', glyph: 'reset' },
    redirect: { title: 'err_title_broken', sub: 'err_s_redirect', verb: 'follow',  glyph: 'redirect' },
    empty:    { title: 'err_title_broken', sub: 'err_s_empty',    verb: 'connect', glyph: 'empty' },
    url:      { title: 'err_title',        sub: 'err_s_url',      verb: 'open',    glyph: 'generic' },
    proxy:    { title: 'err_title',        sub: 'err_s_proxy',    verb: 'connect', glyph: 'generic' },
    blocked:  { title: 'err_title_broken', sub: 'err_s_blocked',  verb: 'open',    glyph: 'generic' },
    cert:     { title: 'err_title_secure', sub: 'err_s_cert',     verb: 'openssl', glyph: 'cert' },
    generic:  { title: 'err_title',        sub: 'err_s_generic',  verb: 'connect', glyph: 'generic' },
  };
  function hideError() { if (window.__ephemeraError) window.__ephemeraError.hide(); }
  function showError(tab) {
    const er = tab && tab.error;
    if (!er || !window.__ephemeraError) return;
    const url = er.url;
    const host = hostOf(url) || displayUrl(url) || url || '';
    const cls = classifyError(er.code, cleanErr(er.desc, er.code));
    const meta = ERROR_KINDS[cls.kind] || ERROR_KINDS.generic;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || settings.accent;
    const fill = (s) => (s || '').replace(/\{host\}/g, host);
    window.__ephemeraError.show({
      host, url, code: cls.big, errno: er.code, klass: cls.kind, glyph: meta.glyph, verb: meta.verb,
      accent, canBack: !!tab.canBack,
      strings: { title: t(meta.title), sub: fill(t(meta.sub)), hint: t('err_hint'), retry: t('err_retry'), back: t('err_back') },
      onRetry: () => { if (url) navigateActive(url); },
      onBack: () => { const tb = tabs.get(activeId); if (tb && tb.webview.canGoBack()) tb.webview.goBack(); }
    });
  }
  function syncError() {
    const tab = tabs.get(activeId);
    if (tab && tab.error) showError(tab);
    else hideError();
  }

  // ── Push appearance settings into the new-tab page (it's a sandboxed webview,
  //    so we hand it the config via executeJavaScript). ──────────────────────
  function newtabCfg(extra) {
    return JSON.stringify(Object.assign({
      bg: settings.newtabBg,
      branding: settings.showBranding,
      accent: settings.accent,
      engine: searchURL(),
      searchText: t('search'),
      lang: settings.language,
      highPerf: settings.highPerf,
      beautiful: settings.beautifulMode,
      theme: settings.theme
    }, extra || {}));
  }
  // Push appearance settings into a new-tab guest. The page keeps its logo and
  // search box hidden until these land, so this is also what reveals the content.
  // For a Tor tab we also hand over { tor:true, torRunning } so the page shows the
  // onion (in place of the beetle) and its "connected / start Tor" status line.
  function pushNewtabSettings(wv, torTab) {
    const extra = torTab ? { tor: true, torRunning: !!tor.running } : { tor: false };
    try {
      return wv.executeJavaScript(`window.__ephemeraApplySettings && window.__ephemeraApplySettings(${newtabCfg(extra)});`)
        .catch(() => {});
    } catch (_) { return Promise.resolve(); }
  }
  function applyNewtab(tab) {
    if (!tab || !isNewtab(tab.url)) return;
    pushNewtabSettings(tab.webview, tab.tor);
  }

  // ── Onion routing (Tor): tab creation + live status chrome ─────────────────
  // Open an anonymous tab. We ask main to prepare the Tor session FIRST (so the
  // proxy + hardening are in place before the guest attaches), then create the
  // Tor-partition tab and start the live status poll.
  async function createTorTab(url) {
    if (!settings.torEnabled) return null;
    // Prepare the Tor session FIRST. Fail CLOSED: if prepare throws or comes back
    // not-ready (session/proxy not actually established), DO NOT open a tab - a
    // Tor-labelled tab with no proxy would egress directly while the UI claims
    // anonymity. Better to open nothing and tell the user.
    let st = null;
    try { st = await window.ephemera.tor.prepare(); } catch (_) { st = null; }
    if (!st || !st.ready) { showToast(t('tor_unavailable')); return null; }
    tor = st;
    const tab = createTab(url || NEWTAB_URL, { tor: true });
    updateTorChrome();
    return tab;
  }

  const anyTorTabActive = () => { const a = tabs.get(activeId); return !!(a && a.tor); };

  // Poll for Tor reachability ONLY while a Tor tab is in front, so "start Tor"
  // becomes "connected" on its own the moment the user launches Tor (and the
  // banner recovers if Tor stops). Idle - zero background work - otherwise.
  function startTorPolling() {
    if (torPollTimer) return;
    torPollTimer = setInterval(async () => {
      if (!anyTorTabActive()) { stopTorPolling(); return; }
      const was = tor.running;
      try { tor = (await window.ephemera.tor.check()) || tor; } catch (_) {}
      if (tor.running !== was) updateTorChrome();
      else updateTorBanner(tabs.get(activeId), true); // keep label fresh even if unchanged
    }, 2200);
  }
  function stopTorPolling() {
    if (torPollTimer) { clearInterval(torPollTimer); torPollTimer = null; }
  }

  // Reflect Tor state across the chrome: the body class (drives the omnibox onion
  // pill via CSS), the info-bar banner, the shield tooltip, the poll lifecycle,
  // and a re-push of status into a Tor new-tab page so its headline tracks reality.
  function updateTorChrome() {
    const a = tabs.get(activeId);
    const onTor = !!(a && a.tor);
    const connecting = onTor && !tor.running && !!tor.starting; // bootstrapping bundled tor
    const down = onTor && !tor.running && !connecting;          // genuinely not connected
    torBannerDismissed = false; // a tab switch / status change re-surfaces the bar
    // tor-active flips the WHOLE chrome to the blueviolet onion theme. The onion
    // glyph + badge carry the connection status (LIME connected / RED off /
    // blueviolet connecting). The point is absolute, at-a-glance certainty about
    // which mode you are in AND whether you are actually anonymous - a user must
    // never search a normal tab believing it is onion, nor an onion tab believing
    // Tor is connected.
    document.body.classList.toggle('tor-active', onTor);
    document.body.classList.toggle('tor-connecting', connecting);
    document.body.classList.toggle('tor-down', down);
    const shield = document.getElementById('omnibox-shield');
    if (shield) shield.title = onTor ? (down ? t('tor_badge_off') : connecting ? t('tor_connecting') : t('tor_pill')) : t('tip_shield');
    const badge = document.getElementById('omnibox-tor-badge');
    if (badge) badge.textContent = onTor ? (down ? t('tor_badge_off') : connecting ? t('tor_badge_starting') : t('tor_badge_on')) : '';
    if (address) address.placeholder = onTor ? t('tor_omnibox_ph') : t('omnibox_ph');
    updateTorBanner(a, onTor);
    if (onTor) {
      startTorPolling();
      if (isNewtab(a.url)) pushNewtabSettings(a.webview, true);
    } else {
      stopTorPolling();
    }
  }

  // The Tor info-bar: shown only on a Tor tab. Connected → a calm "anonymous"
  // confirmation with a New-identity action; not running → the friendly onboarding
  // ("start Tor") with Get-Tor + Check-again. Buttons live in the chrome (which
  // holds the privileged bridge), not inside the sandboxed guest page.
  function torActionBtn(act, label, primary) {
    const b = document.createElement('button');
    b.className = primary ? 'tor-act tor-act-primary' : 'tor-act';
    b.dataset.act = act;
    b.textContent = label;
    return b;
  }
  function updateTorBanner(tab, onTor) {
    const banner = document.getElementById('tor-banner');
    if (!banner) return;
    if (!onTor || (tor.running && torBannerDismissed)) {
      banner.classList.remove('show');
      banner.setAttribute('aria-hidden', 'true');
      return;
    }
    const txt = banner.querySelector('.tor-banner-text');
    const acts = banner.querySelector('.tor-banner-actions');
    const prog = banner.querySelector('.tor-banner-progress');
    const connecting = !tor.running && !!tor.starting;
    // Track how long we've been connecting, so a STALLED bootstrap (e.g. a network
    // that blocks Tor) doesn't leave the user staring at a frozen %. After a while
    // we surface "trouble connecting" + a Retry, instead of no escape.
    if (connecting) { if (!torConnectStartedAt) torConnectStartedAt = performance.now(); }
    else torConnectStartedAt = 0;
    const stuck = connecting && torConnectStartedAt && (performance.now() - torConnectStartedAt > 40000);
    banner.classList.toggle('tor-off', !tor.running && !connecting);
    banner.classList.toggle('tor-on', !!tor.running);
    banner.classList.toggle('tor-connecting', connecting);
    banner.classList.toggle('tor-stuck', !!stuck);
    if (prog) prog.style.width = connecting ? (Math.max(2, tor.bootstrap || 0) + '%') : '0%';
    if (txt) {
      txt.textContent = tor.running ? t('tor_connected')
        : stuck ? t('tor_trouble')
        : connecting ? `${t('tor_connecting')} ${tor.bootstrap || 0}%`
        : t('tor_off_sub');
    }
    if (acts) {
      acts.textContent = '';
      if (tor.running) acts.appendChild(torActionBtn('new-identity', t('tor_newid')));
      else if (stuck) acts.appendChild(torActionBtn('restart', t('tor_retry'), true)); // escape a stalled bootstrap
      else if (!connecting) { // genuinely off: offer Get Tor / Check again
        acts.appendChild(torActionBtn('get', t('tor_get'), true));
        acts.appendChild(torActionBtn('check', t('tor_check')));
      }
      // connecting: no buttons - the bundled tor auto-bootstraps with the progress bar
    }
    banner.classList.add('show');
    banner.setAttribute('aria-hidden', 'false');
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
    document.body.classList.toggle('no-tor', !settings.torEnabled); // hide the onion "+" when Tor is off
    applyLang();
    syncSettingsUI();
    syncNotepadUI();
    applyNewtab(tabs.get(activeId));
    updateTorChrome(); // language/enabled changes refresh the Tor banner + pill
    // Keep the pre-warmed spare in step: drop it in engine mode (it loads a remote
    // home instead), otherwise refresh its appearance or warm one if missing.
    if (settings.newtabMode === 'engine') dropSpare();
    else if (spareWebview && spareReady) pushNewtabSettings(spareWebview);
    else scheduleWarmSpare();
    syncOffline(); // live-refresh the offline screen's accent + translated text
    syncError();   // …and the error screen's accent + translated text
  }
  // Ephemeral multi-note state: in memory only (reset on Clean Slate, gone on
  // quit). Each note is { id, title, body }; the active note is mirrored into the
  // title field + textarea. Namespaced np* so it never collides with the browser
  // tab state (tabs / activeId).
  let npNotes = [];
  let npActiveId = null;
  let npSeq = 0;

  // Notepad strings live here (self-contained, not in the shared I18N). No em
  // dashes in English or Finnish. The delete/keep line flips with the toggle.
  const NP_I18N = {
    en: { title: 'Notepad', phOn: 'Jot something down. It gets wiped when you clear.', phOff: 'Jot something down. It is not cleared.', save: 'Save this note (.txt)', saved: 'Saved to',
          delOn: 'Delete the .txt file when you clear your device?', delOff: 'The .txt file will be kept when you clear your device.',
          footOn: 'The notepad is wiped when you clear', footOff: 'The notepad is not cleared', cfTitle: 'Your saved notepad will be deleted', cfSub: 'You exported it to a .txt this session.', keep: 'Keep it', savedToast: 'Notepad saved', saveError: 'Could not save notepad',
          exportZip: 'Export all (.zip)', pw: 'Password (optional)', untitled: 'Untitled note', exportHint: 'Leave the password empty for a plain .zip.', exportedToast: 'Notes exported', exportError: 'Could not export notes', newNote: 'New note' },
    es: { title: 'Bloc de notas', phOn: 'Escribe algo. Se borra cuando limpias.', phOff: 'Escribe algo. No se borra.', save: 'Guardar esta nota (.txt)', saved: 'Guardado en',
          delOn: '¿Eliminar el archivo .txt al limpiar tu dispositivo?', delOff: 'El archivo .txt se conservará al limpiar.',
          footOn: 'El bloc de notas se borra cuando limpias', footOff: 'El bloc de notas no se borra', cfTitle: 'Tu bloc de notas guardado se eliminará', cfSub: 'Lo exportaste a un .txt esta sesión.', keep: 'Conservarlo', savedToast: 'Bloc de notas guardado', saveError: 'No se pudo guardar',
          exportZip: 'Exportar todo (.zip)', pw: 'Contraseña (opcional)', untitled: 'Nota sin título', exportHint: 'Deja la contraseña vacía para un .zip normal.', exportedToast: 'Notas exportadas', exportError: 'No se pudieron exportar', newNote: 'Nueva nota' },
    ru: { title: 'Блокнот', phOn: 'Запишите что-нибудь. Стирается при очистке.', phOff: 'Запишите что-нибудь. Не стирается.', save: 'Сохранить заметку (.txt)', saved: 'Сохранено в',
          delOn: 'Удалять файл .txt при очистке устройства?', delOff: 'Файл .txt будет сохранён при очистке.',
          footOn: 'Блокнот стирается при очистке', footOff: 'Блокнот не стирается', cfTitle: 'Сохранённый блокнот будет удалён', cfSub: 'Вы экспортировали его в .txt в этой сессии.', keep: 'Оставить', savedToast: 'Блокнот сохранён', saveError: 'Не удалось сохранить',
          exportZip: 'Экспортировать всё (.zip)', pw: 'Пароль (необязательно)', untitled: 'Без названия', exportHint: 'Оставьте пароль пустым для обычного .zip.', exportedToast: 'Заметки экспортированы', exportError: 'Не удалось экспортировать', newNote: 'Новая заметка' },
    fi: { title: 'Muistio', phOn: 'Kirjoita jotain. Se pyyhitään kun tyhjennät.', phOff: 'Kirjoita jotain. Sitä ei tyhjennetä.', save: 'Tallenna tämä muistiinpano (.txt)', saved: 'Tallennettu kohteeseen',
          delOn: 'Poistetaanko .txt-tiedosto kun tyhjennät laitteen?', delOff: '.txt-tiedosto säilytetään kun tyhjennät laitteen.',
          footOn: 'Muistio pyyhitään kun tyhjennät', footOff: 'Muistiota ei tyhjennetä', cfTitle: 'Tallennettu muistio poistetaan', cfSub: 'Veit sen .txt-tiedostoon tässä istunnossa.', keep: 'Säilytä se',
          exportZip: 'Vie kaikki (.zip)', pw: 'Salasana (valinnainen)', untitled: 'Nimetön muistiinpano', exportHint: 'Jätä salasana tyhjäksi tavalliselle .zip-tiedostolle.', exportedToast: 'Muistiinpanot viety', exportError: 'Vienti epäonnistui', newNote: 'Uusi muistiinpano' }
  };
  const npT = (k) => { const l = NP_I18N[settings.language] ? settings.language : 'en'; return (NP_I18N[l] && NP_I18N[l][k]) || NP_I18N.en[k] || k; };
  function syncNotepadUI() {
    const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    setTxt('np-title', npT('title'));
    setTxt('np-save', npT('save'));
    setTxt('np-export', npT('exportZip'));
    setTxt('np-export-hint', npT('exportHint'));
    const npPwEl = document.getElementById('np-password'); if (npPwEl) npPwEl.placeholder = npT('pw');
    const npNoteTitleEl = document.getElementById('np-note-title'); if (npNoteTitleEl) npNoteTitleEl.placeholder = npT('untitled');
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
  const quitOverlay = $('#quit-overlay');

  // ── Close-browser confirmation (raised when the last tab is closed) ─────────
  // "No" is focused as the safe default: closing the browser ends the session and
  // takes everything ephemeral with it, so it must never fire on a stray Enter.
  function requestQuit() {
    // One modal at a time. Ctrl+W is dispatched from main (before-input-event), so
    // it reaches closeTab even while the Clean Slate confirm or the wipe loader is
    // up - guard here so the quit card never stacks on top of either.
    if (confirmOverlay.classList.contains('show') || wipeOverlay.classList.contains('show')) return;
    quitOverlay.classList.add('show');
    quitOverlay.setAttribute('aria-hidden', 'false');
    setTimeout(() => $('#quit-no').focus(), 0);
  }
  function hideQuit() {
    quitOverlay.classList.remove('show');
    quitOverlay.setAttribute('aria-hidden', 'true');
  }

  function requestCleanSlate() {
    // Symmetric guard: don't stack the wipe confirm over the close-browser prompt
    // (both are reachable via a main-dispatched shortcut, Ctrl+Shift+K / Ctrl+W).
    if (quitOverlay.classList.contains('show')) return;
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

    // The notepad itself is always wiped (it's ephemeral): drop every note back
    // to a single empty one. The exported .txt/.zip was handled by main per the
    // Keep-it choice above. Guarded in case the panel never initialised.
    try { if (typeof npResetNotes === 'function') npResetNotes(); } catch (_) {}

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
  // Right-click the "+" to choose the tab kind: a normal tab, or an anonymous
  // onion (Tor) tab. Deliberately a CHOICE, not a one-tap button, and the onion
  // item is unmistakably the old-school Tor purple - so the two modes can never be
  // confused (a user must never search thinking they are on Tor when they are not).
  newtabBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items = [{ label: t('ctx_normal_tab'), icon: 'newtab', action: () => { createTab(newtabTarget()); address.focus(); } }];
    // Offer the onion (Tor) tab only when "Onion routing" is enabled in Settings.
    if (settings.torEnabled) items.push({ label: t('ctx_onion_tab'), icon: 'onion', cls: 'ctx-onion', action: () => { createTorTab(); address.focus(); } });
    openCtx(items, e.clientX, e.clientY);
  });
  // Tor info-bar actions: Get Tor / Check again / New identity / dismiss.
  const torBanner = $('#tor-banner');
  if (torBanner) torBanner.addEventListener('click', async (e) => {
    if (e.target.closest('.tor-banner-close')) { torBannerDismissed = true; updateTorBanner(tabs.get(activeId), anyTorTabActive()); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'get') {
      // Tor isn't running, so torproject.org can't be reached over Tor - open it
      // in a normal (direct) tab so the user can download / start Tor.
      createTab('https://www.torproject.org/download/'); address.focus();
    } else if (act === 'check') {
      b.classList.add('busy');
      try { tor = (await window.ephemera.tor.check()) || tor; } catch (_) {}
      b.classList.remove('busy');
      updateTorChrome();
    } else if (act === 'new-identity') {
      b.classList.add('busy');
      try { tor = (await window.ephemera.tor.newIdentity()) || tor; } catch (_) {}
      b.classList.remove('busy');
      const a = tabs.get(activeId);
      if (a && a.tor && !isNewtab(a.url)) { try { a.webview.reload(); } catch (_) {} }
      updateTorChrome();
      showToast(t('tor_newid_done'));
    } else if (act === 'restart') {
      // Stalled bootstrap: tear the bundled tor down and start it fresh.
      b.classList.add('busy');
      torConnectStartedAt = 0; // reset the stall timer for the new attempt
      try { tor = (await window.ephemera.tor.restart()) || tor; } catch (_) {}
      b.classList.remove('busy');
      updateTorChrome();
    }
  });
  trackerPill.addEventListener('click', () => showToast(`${blockedCount} · ${t('tip_tracker')}`));
  cleanBtn.addEventListener('click', requestCleanSlate);
  $('#confirm-yes').addEventListener('click', doCleanSlate);
  confirmOverlay.querySelectorAll('[data-confirm-no]').forEach((el) => el.addEventListener('click', hideConfirm));
  $('#quit-yes').addEventListener('click', () => window.ephemera.close());
  quitOverlay.querySelectorAll('[data-quit-no]').forEach((el) => el.addEventListener('click', hideQuit));

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
    if (quitOverlay.classList.contains('show')) hideQuit();
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
  window.ephemera.onNewTab((url, fromTor) => {
    if (!url) return;
    // fromTor is a real boolean for popups/_blank (main decides by the opener's
    // partition). It's undefined for the local file-drop path - there we inherit
    // the active tab's mode, so a file dropped while in onion mode opens in onion
    // mode (the chrome never flickers back to a normal charcoal tab unexpectedly).
    const useTor = (typeof fromTor === 'boolean') ? fromTor : anyTorTabActive();
    createTab(url, useTor ? { tor: true } : undefined);
  });
  window.ephemera.onWindowState((s) => {
    // main now sends { maximized, inset:{top,right,bottom,left} }. The class drives
    // the maximize/restore glyph; the inset cancels the frameless window's resize-
    // border overflow so the titlebar/controls aren't clipped at the screen edge
    // while maximized. Everything is 0 in a normal window (pixel-identical layout).
    const maxed = !!(s && s.maximized);
    document.body.classList.toggle('maximized', maxed);
    const i = (maxed && s && s.inset) || { top: 0, right: 0, bottom: 0, left: 0 };
    const st = document.documentElement.style;
    st.setProperty('--win-inset-top', (i.top || 0) + 'px');
    st.setProperty('--win-inset-right', (i.right || 0) + 'px');
    st.setProperty('--win-inset-bottom', (i.bottom || 0) + 'px');
    st.setProperty('--win-inset-left', (i.left || 0) + 'px');
  });
  window.ephemera.onSettingsChanged((s) => applySettings(s));
  // Tor status pushed from main (detection flipped). Keep the chrome in sync.
  if (window.ephemera.tor && window.ephemera.tor.onStatus) {
    window.ephemera.tor.onStatus((s) => { if (s) tor = s; updateTorChrome(); });
  }

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
      case 'new-tor-tab':   if (settings.torEnabled) { createTorTab(); address.focus(); } break;
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
    showZoom(next);
  }

  // Chrome-style zoom indicator: shown by adjustZoom on every Ctrl+wheel / Ctrl+/-
  // change, with -/+ nudges and a snap-back-to-100%. Auto-hides after idle.
  const zoomBubble = $('#zoom-bubble');
  const zoomPct = $('#zoom-pct');
  let zoomHideT = 0;
  function hideZoom() {
    if (!zoomBubble) return;
    zoomBubble.classList.remove('show');
    zoomBubble.setAttribute('aria-hidden', 'true');
  }
  function showZoom(factor) {
    if (!zoomBubble) return;
    zoomPct.textContent = Math.round(factor * 100) + '%';
    zoomBubble.classList.add('show');
    zoomBubble.setAttribute('aria-hidden', 'false');
    clearTimeout(zoomHideT);
    zoomHideT = setTimeout(hideZoom, 2600);
  }
  if (zoomBubble) {
    $('#zoom-out').addEventListener('click', () => adjustZoom(tabs.get(activeId), -0.1));
    $('#zoom-in').addEventListener('click', () => adjustZoom(tabs.get(activeId), 0.1));
    $('#zoom-reset').addEventListener('click', () => adjustZoom(tabs.get(activeId), 0));
    // Hovering the bubble keeps it open; leaving restarts the idle countdown.
    zoomBubble.addEventListener('mouseenter', () => clearTimeout(zoomHideT));
    zoomBubble.addEventListener('mouseleave', () => { clearTimeout(zoomHideT); zoomHideT = setTimeout(hideZoom, 2600); });
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
  const npTitleInput = $('#np-note-title');

  // ----- multi-note model (all ephemeral; npNotes/npActiveId declared above) -----
  function npActiveNote() { return npNotes.find((n) => n.id === npActiveId) || null; }
  function npEnsureNote() {
    if (!npNotes.length) { const n = { id: 'n' + (++npSeq), title: '', body: '' }; npNotes.push(n); npActiveId = n.id; }
    if (!npActiveNote()) npActiveId = npNotes[0].id;
  }
  function npRenderTabs() {
    const strip = document.getElementById('np-tabs'); if (!strip) return;
    npEnsureNote();
    strip.textContent = '';
    npNotes.forEach((n) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'np-tab' + (n.id === npActiveId ? ' active' : '');
      chip.setAttribute('role', 'tab');
      const label = document.createElement('span');
      label.className = 'np-tab-label';
      label.textContent = (n.title || '').trim() || npT('untitled');
      chip.appendChild(label);
      const x = document.createElement('span');
      x.className = 'np-tab-x'; x.setAttribute('role', 'button'); x.setAttribute('aria-label', 'Delete note');
      x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
      x.addEventListener('click', (e) => { e.stopPropagation(); npDeleteNote(n.id); });
      chip.appendChild(x);
      chip.addEventListener('click', () => npSelectNote(n.id));
      strip.appendChild(chip);
    });
    const add = document.createElement('button');
    add.type = 'button'; add.id = 'np-add'; add.className = 'np-add';
    add.title = npT('newNote'); add.setAttribute('aria-label', npT('newNote'));
    add.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';
    add.addEventListener('click', () => npCreateNote());
    strip.appendChild(add);
  }
  function npLoadActive() {
    npEnsureNote();
    const n = npActiveNote();
    if (npTitleInput) npTitleInput.value = n ? n.title : '';
    if (npText) npText.value = n ? n.body : '';
  }
  function npSelectNote(id) { npActiveId = id; npRenderTabs(); npLoadActive(); if (npText) setTimeout(() => npText.focus(), 0); }
  function npCreateNote() {
    const n = { id: 'n' + (++npSeq), title: '', body: '' };
    npNotes.push(n); npActiveId = n.id;
    npRenderTabs(); npLoadActive();
    if (npTitleInput) setTimeout(() => npTitleInput.focus(), 0);
  }
  function npDeleteNote(id) {
    const i = npNotes.findIndex((n) => n.id === id); if (i === -1) return;
    npNotes.splice(i, 1);
    if (npActiveId === id) npActiveId = npNotes.length ? npNotes[Math.min(i, npNotes.length - 1)].id : null;
    npEnsureNote(); npRenderTabs(); npLoadActive();
  }
  function npResetNotes() { npNotes = []; npActiveId = null; npSeq = 0; npEnsureNote(); npRenderTabs(); npLoadActive(); }

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
    // Body + title edits write straight into the active note (kept in memory).
    if (npText) npText.addEventListener('input', () => { const n = npActiveNote(); if (n) n.body = npText.value; });
    if (npTitleInput) npTitleInput.addEventListener('input', () => {
      const n = npActiveNote(); if (!n) return;
      n.title = npTitleInput.value;
      const lbl = document.querySelector('#np-tabs .np-tab.active .np-tab-label');
      if (lbl) lbl.textContent = n.title.trim() || npT('untitled');
    });
    // Quick save: the ACTIVE note as a plain .txt.
    $('#np-save').addEventListener('click', async () => {
      try {
        const n = npActiveNote();
        const res = await window.ephemera.notepadSave({ format: 'txt', text: n ? n.body : '' });
        if (res && res.ok) showToast(npT('savedToast'));
        else if (res && res.error) showToast(npT('saveError'));
      } catch (_) {}
    });
    // Export ALL notes into one zip; a non-empty password makes it AES-256 encrypted.
    $('#np-export').addEventListener('click', async () => {
      try {
        const pw = document.getElementById('np-password');
        const password = pw ? pw.value : '';
        const payloadNotes = npNotes.map((n) => ({ title: n.title, body: n.body }));
        const res = await window.ephemera.notepadSave({ format: 'zip', notes: payloadNotes, password });
        if (res && res.ok) { showToast(npT('exportedToast')); if (pw) pw.value = ''; }
        else if (res && res.error) showToast(npT('exportError'));
      } catch (_) {}
    });
    $('#np-del-toggle').addEventListener('click', () => {
      updateSetting({ notepadDeleteOnClear: $('#np-del-toggle').getAttribute('aria-checked') !== 'true' });
    });
    npRenderTabs();
    npLoadActive();
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
      el.className = it.cls ? 'ctx-item ' + it.cls : 'ctx-item';
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
    // If the page is in a Tor tab, any "open in new tab" / "search" must stay on
    // Tor - never spawn a direct tab from anonymous content (deanonymisation).
    const onTor = anyTorTabActive();
    const newTabOpts = onTor ? { tor: true } : undefined;
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
      items.push({ label: ct('open_tab'), icon: 'newtab', action: () => createTab(data.linkURL, newTabOpts) });
      items.push({ label: ct('copy_link'), icon: 'link', action: () => window.ephemera.clipboardWrite(data.linkURL) });
      extra = true;
    }
    if (data.mediaType === 'image' && data.srcURL) {
      items.push({ type: 'sep' });
      items.push({ label: ct('open_img'), icon: 'image', action: () => createTab(data.srcURL, newTabOpts) });
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
      items.push({ label: `${ct('search')} "${snip}"`, icon: 'search', action: () => createTab(searchURL() + encodeURIComponent(data.selectionText), newTabOpts) });
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
