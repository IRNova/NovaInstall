(function () {
  "use strict";

  /* همه‌چیز داخل کد ثابت است؛ کاربر فقط توکن می‌دهد. */
  var PROXY_URL = String(window.NOVA_PROXY_ENDPOINT || "").trim().replace(/\/+$/, "");
  /* Worker name is generated randomly on the proxy per install. */
  var PANEL_URL = "https://nova-panel.github.io";
  var COMPAT_DATE = "2025-11-04";
  /* آدرس سورس فقط به پروکسی داده می‌شود؛ مرورگر آن را دانلود نمی‌کند. */
  var WORKER_SOURCE = "https://raw.githubusercontent.com/IRNova/NovaWorker/main/_worker.js";
  var MIN_PROXY_VERSION = "2.4.0";
  
  /* warm edge cache so first install is fast */
  try {
    if (PROXY_URL) fetch(PROXY_URL + "/health?warm=1&_t=" + Date.now(), { cache: "no-store", mode: "cors" }).catch(function () {});
  } catch (e) {}

  function requireProxyConfigured() {
    if (PROXY_URL) return true;
    var msg = "سرویس پردازش تنظیم نشده است. آدرس پروکسی را در فایل assets/proxy-endpoint.js (یک خط) وارد کنید.";
    try { if (typeof showToast === "function") showToast(msg, "error"); } catch (e) {}
    try { if (typeof setStatus === "function") setStatus("config", msg); } catch (e2) {}
    return false;
  }

  var PROXY_TIMEOUT = 45000;
  var INSTALL_TIMEOUT = 240000;


  var STEPS = ["auth", "account", "kv", "source", "upload", "config", "subdomain", "verify"];
  /* UI shows 3 phases; backend still streams fine-grained steps */
  var PHASES = [
    { id: "connect", steps: ["auth", "account"] },
    { id: "build", steps: ["kv", "source", "upload", "config", "subdomain"] },
    { id: "finish", steps: ["verify"] }
  ];
  var STEP_ICON = { ok: "✓", fail: "✕", skip: "–", running: "…", pending: "·" };

  var I18N = {
    fa: {
      brandSub: "نصب‌کنندهٔ خودکار", eyebrow: "نصب در یک دقیقه",
      title: "Nova Worker را نصب کن",
      subtitle: "فقط توکن کلودفلر را وارد کن؛ Worker، فضای KV و رمز مدیریت روی حساب خودت ساخته می‌شود.",
      chipKv: "KV خودکار", chipPanel: "پنل فارسی", chipFree: "بدون هزینه",
      formTitle: "ورود با توکن کلودفلر", tokenLabel: "توکن API کلودفلر", tokenHelp: "ساخت توکن",
      tokenHint: "دسترسی‌های لازم: Workers Scripts:Edit و Workers KV Storage:Edit",
      advanced: "تنظیمات پیشرفته",
      accountIdLabel: "شناسهٔ حساب (اختیاری)",
      accountIdHint: "اگر توکن به چند حساب دسترسی دارد یا فهرست حساب‌ها نمایش داده نمی‌شود، شناسهٔ ۳۲ کاراکتری حساب را اینجا وارد کن.",
      haveTokenTitle: "من توکن دارم — نصب پنل",
      haveTokenSub: "اگر توکن API کلودفلر را از قبل ساخته‌ای، همین‌جا بچسبان و نصب را شروع کن. Worker و KV روی حساب خودت ساخته می‌شود.",
      needTokenTitle: "هنوز توکن ندارم",
      needTokenSub: "یک توکن موقت با حداقل دسترسی لازم بساز. بعد از نصب می‌توانی همان توکن را از داشبورد کلودفلر حذف کنی.",
      permScriptsTitle: "Workers Scripts — Edit",
      permScriptsDesc: "آپلود و انتشار Worker",
      permKvTitle: "Workers KV Storage — Edit",
      permKvDesc: "ساخت فضای KV و ذخیرهٔ تنظیمات",
      permAccountTitle: "Account Settings — Read",
      permAccountDesc: "خواندن نام حساب (اختیاری ولی مفید)",
      tokenStep1: "روی دکمهٔ زیر بزن؛ صفحهٔ ساخت توکن کلودفلر با دسترسی‌های لازم از قبل تیک‌خورده باز می‌شود.",
      tokenStep2: "فقط «Continue to summary» و بعد «Create Token» را بزن — چیزی را دستی انتخاب نکن.",
      tokenStep3: "توکن را کپی کن، برگرد اینجا، در کارت «من توکن دارم» بچسبان و نصب را شروع کن.",
      tokenRevokeNote: "این توکن فقط برای نصب لازم است. بعد از گرفتن لینک ورود و رمز، از My Profile → API Tokens همان توکن را Revoke کن.",
      createTokenBtn: "ساخت توکن آماده در کلودفلر",
      accountRequired: "حساب مقصد مشخص نیست. شناسهٔ حساب را در تنظیمات پیشرفته وارد کن یا توکنی با دسترسی خواندن حساب بساز.",
      proxyOutdated: "نسخهٔ پروکسی نصب قدیمی است.",
      proxyOutdatedHint: "پروکسی باید نسخهٔ 2.0.0 یا بالاتر باشد. پروکسی NovaInstall را یک‌بار دوباره منتشر کن، بعد این صفحه را نوسازی کن.",
      proxyUnreachable: "پروکسی نصب در دسترس نیست.",
      proxyUnreachableHint: "اتصال شبکه یا دسترسی به پروکسی را بررسی کن و صفحه را نوسازی کن.",
      streamClosed: "ارتباط با سرور نصب قطع شد؛ دوباره تلاش کن.",
      retrying: "اتصال قطع شد؛ تلاش دوباره…",
      recovering: "بازیابی نصب از کلودفلر…",
      recoverFailed: "بازیابی نصب ناموفق بود؛ صفحه را نوسازی کن و دوباره تلاش کن.",
      installBtn: "شروع نصب",
      securityNote: "توکن فقط برای فراخوانی API کلودفلر از طریق پراکسی استفاده می‌شود؛ در آمار/گزارش ذخیره نمی‌شود و بعد از شروع نصب از فیلد پاک می‌شود. پس از نصب می‌توانید آن را Revoke کنید.",
      progressTitle: "فرایند نصب", preparing: "در حال آماده‌سازی…",
      resultTitle: "نصب کامل شد", loginLabel: "آدرس ورود", passLabel: "رمز مدیریت",
      passHint: "این رمز را در جای امن نگه دار؛ تنها راه ورود به پنل است.",
      open: "باز کردن", adminBtn: "پنل مدیریت", qrLabel: "اسکن سریع",
      qrHint: "با دوربین گوشی اسکن کن تا صفحهٔ ورود باز شود.",
      errorTitle: "خطا", retry: "تلاش دوباره", copied: "کپی شد", footer: "Nova Worker · نصب آسان",
      again: "نصب روی حساب دیگر",
      elapsedLabel: "زمان سپری‌شده",
      serviceChecking: "در حال بررسی سرویس پردازش…",
      serviceOk: "سرویس پردازش آماده است",
      serviceBad: "سرویس پردازش در دسترس نیست",
      serviceUnconfigured: "سرویس پردازش تنظیم نشده است",
      serviceDegraded: "سرویس پردازش با محدودیت در دسترس است",
      serviceCounts: "موفق/ناموفق",
      copyDetails: "کپی جزئیات خطا",
      copyLog: "کپی گزارش نصب",
      copyReport: "کپی گزارش کامل (JSON)",
      copiedReport: "گزارش کامل کپی شد",
      copyResult: "کپی اطلاعات نصب",
      shareResult: "اشتراک‌گذاری",
      copiedDetails: "جزئیات کپی شد",
      noShare: "اشتراک‌گذاری در این مرورگر پشتیبانی نمی‌شود.",
      statsLink: "آمار",
      helpLink: "راهنما / گزارش مشکل",
      healthBannerTitle: "هشدار وضعیت سرویس",
      healthBannerBody: "در حال حاضر بخشی از نصب‌ها با خطا مواجه هستند (نرخ خطا/1101 بالا). قبل از نصب، وضعیت سرویس را بررسی کنید.",
      healthBannerLink: "مشاهده وضعیت",
      tokenTrustTitle: "شفافیت امنیت توکن",
      tokenTrustBody: "توکن فقط برای فراخوانی API کلودفلر از طریق پراکسی استفاده می‌شود؛ در آمار/گزارش ذخیره نمی‌شود و بعد از شروع نصب از فیلد پاک می‌شود. پس از نصب می‌توانید آن را Revoke کنید.",
      traceLabel: "شناسه پیگیری",
      reasonLabel: "دلیل",
      stepLabel: "مرحله",
      proxyLabel: "سرویس",
      versionLabel: "نسخه",
      emptyToken: "توکن API را وارد کن.", tokenInvalid: "توکن معتبر نیست یا دسترسی لازم را ندارد.",
      authInvalid: "توکن نامعتبر است یا منقضی شده؛ یک توکن جدید با دسترسی Workers Scripts:Edit و Workers KV Storage:Edit بساز.",
      subdomainRequired: "حساب کلودفلر هنوز ساب‌دامین workers.dev ندارد و نصب‌کننده نتوانست خودش بسازد. یک بار در داشبورد Cloudflare منوی Workers را باز کن (تا ساب‌دامین ساخته شود) و دوباره نصب را شروع کن.",
      multiAccountBody: "این توکن به چند حساب دسترسی دارد؛ حسابی که می‌خواهی نصب روی آن انجام شود را انتخاب کن.",
      resume: "ادامه نصب", done: "نصب با موفقیت انجام شد.", verifyPending: "Worker نصب شد اما هنوز لبه پاسخ نمی‌دهد؛ چند دقیقه بعد آدرس ورود را باز کن.",
      details: { worker: "نام Worker", version: "نسخه", build: "بیلد", account: "حساب", kv: "فضای KV", source: "منبع سورس" },
      stepNames: { auth: "اتصال به کلودفلر", account: "انتخاب حساب", kv: "ساخت فضای KV", source: "دانلود سورس Worker", upload: "آپلود Worker", config: "تنظیم رمز و کانفیگ", subdomain: "فعال‌سازی آدرس عمومی", verify: "راستی‌آزمایی نصب" },

      phaseNames: { connect: "اتصال به کلودفلر", build: "ساخت Worker و دیتابیس", finish: "آماده‌سازی نهایی" },
      phasePending: "در انتظار…",
      phaseRunning: "در حال اجرا…",
      chipNames: { kv: "دیتابیس KV", source: "سورس", upload: "آپلود", config: "رمز", subdomain: "آدرس" },
      stepStatus: { pending: "در انتظار", running: "در حال اجرا", ok: "موفق", fail: "ناموفق", skip: "رد شد" },
      errorHints: {
        auth: "توکن باید Workers Scripts:Edit و Workers KV Storage:Edit داشته باشد. توکن را از My Profile → API Tokens بساز.",
        account: "توکن به این حساب دسترسی ندارد؛ حساب دیگری را انتخاب کن یا توکن را با دسترسی درست بساز.",
        kv: "ساخت فضای KV ناموفق بود؛ سهمیهٔ KV یا مجوز توکن را بررسی کن.",
        source: "دانلود سورس Worker از GitHub ناموفق بود؛ اتصال شبکه را بررسی کن.",
        upload: "آپلود Worker ناموفق بود؛ مجوز Workers Scripts و حجم سورس را بررسی کن.",
        config: "نوشتن رمز در KV ناموفق بود.",
        subdomain: "فعال‌سازی workers.dev ناموفق بود؛ شاید حساب به ساب‌دامین نیاز دارد.",
        verify: "Worker بالا آمد اما پاسخ نداد؛ چند دقیقه بعد دوباره تلاش کن."
      }
    },
    en: {
      brandSub: "Automatic installer", eyebrow: "One-minute install",
      title: "Install Nova Worker",
      subtitle: "Only paste your Cloudflare token; the Worker, KV storage and admin password are created in your account.",
      chipKv: "Automatic KV", chipPanel: "Persian panel", chipFree: "No cost",
      formTitle: "Sign in with a Cloudflare token", tokenLabel: "Cloudflare API token", tokenHelp: "Create token",
      tokenHint: "Required scopes: Workers Scripts:Edit and Workers KV Storage:Edit",
      advanced: "Advanced settings",
      accountIdLabel: "Account ID (optional)",
      accountIdHint: "If the token can access several accounts or the account list is not shown, enter the 32-character account ID.",

      haveTokenTitle: "I have a token — install panel",
      haveTokenSub: "Paste your Cloudflare API token and start. The Worker and KV are created on your own account.",
      needTokenTitle: "I don't have a token yet",
      needTokenSub: "Create a temporary token with the minimum permissions. You can revoke it from the Cloudflare dashboard after install.",
      permScriptsTitle: "Workers Scripts — Edit",
      permScriptsDesc: "Upload and deploy the Worker",
      permKvTitle: "Workers KV Storage — Edit",
      permKvDesc: "Create KV namespace and save settings",
      permAccountTitle: "Account Settings — Read",
      permAccountDesc: "Read account name (optional but useful)",
      tokenStep1: "Click the button below; Cloudflare opens with the required permissions already checked.",
      tokenStep2: "Just press Continue to summary, then Create Token — do not pick permissions yourself.",
      tokenStep3: "Copy the token, come back here, paste it in the left card, and start install.",
      tokenRevokeNote: "This token is only needed for install. After you get the login URL and password, revoke it under My Profile → API Tokens.",
      createTokenBtn: "Create ready-made token on Cloudflare",      accountRequired: "The target account is unknown. Enter the account ID under advanced settings or use a token that can read accounts.",
      proxyOutdated: "The installer proxy is outdated.",
      proxyOutdatedHint: "The proxy must be version 2.0.0 or newer. Redeploy the NovaInstall proxy once, then reload this page.",
      proxyUnreachable: "The installer proxy is unreachable.",
      proxyUnreachableHint: "Check your network connection and reload this page.",
      streamClosed: "The connection to the installer was interrupted; try again.",
      retrying: "Connection lost; retrying…",
      recovering: "Recovering the install from Cloudflare…",
      recoverFailed: "Could not recover the install; reload the page and try again.",
      installBtn: "Start install",
      securityNote: "The token stays in this browser and is sent to api.cloudflare.com through the official NovaInstall proxy to perform the install; it is not stored or shown to anyone. Revoke it after the install.",
      progressTitle: "Installing", preparing: "Preparing…",
      resultTitle: "Installation complete", loginLabel: "Login URL", passLabel: "Admin password",
      passHint: "Keep this password safe; it is the only way into the panel.",
      open: "Open", adminBtn: "Admin panel", qrLabel: "Quick scan",
      qrHint: "Scan with your phone camera to open the login page.",
      errorTitle: "Error", retry: "Try again", copied: "Copied", footer: "Nova Worker · easy install",
      again: "Install another account",
      elapsedLabel: "Elapsed time",
      serviceChecking: "Checking processing service…",
      serviceOk: "Processing service is ready",
      serviceBad: "Processing service is unavailable",
      serviceUnconfigured: "Processing service is not configured",
      serviceDegraded: "Processing service is partially available",
      serviceCounts: "Success/Failed",
      copyDetails: "Copy error details",
      copyLog: "Copy install log",
      copyReport: "Copy full report (JSON)",
      copiedReport: "Full report copied",
      copyResult: "Copy install info",
      shareResult: "Share",
      copiedDetails: "Details copied",
      noShare: "Sharing is not supported in this browser.",
      statsLink: "Stats",
      helpLink: "Help / Report",
      healthBannerTitle: "Service status warning",
      healthBannerBody: "Some installs are currently failing (elevated failure/1101 rate). Check service status before installing.",
      healthBannerLink: "View status",
      tokenTrustTitle: "Token security transparency",
      tokenTrustBody: "Your token is used only to call Cloudflare APIs through the proxy; it is not stored in stats/reports and is cleared from the field after install starts. You can revoke it after installation.",
      traceLabel: "Trace ID",
      reasonLabel: "Reason",
      stepLabel: "Step",
      proxyLabel: "Service",
      versionLabel: "Version",
      emptyToken: "Enter your API token.", tokenInvalid: "The token is invalid or lacks permissions.",
      authInvalid: "The token is invalid or expired; create a new one with Workers Scripts:Edit and Workers KV Storage:Edit.",
      subdomainRequired: "Your Cloudflare account has no workers.dev subdomain yet and the installer could not create one. Open the Workers menu in the Cloudflare dashboard once (this creates the subdomain), then start the install again.",
      multiAccountBody: "This token can access several accounts; choose the one to install into.",
      resume: "Continue install", done: "Installed successfully.", verifyPending: "The Worker is deployed but the edge is not answering yet; open the login URL in a minute.",
      details: { worker: "Worker", version: "Version", build: "Build", account: "Account", kv: "KV namespace", source: "Source" },
      stepNames: { auth: "Connecting to Cloudflare", account: "Selecting account", kv: "Creating KV namespace", source: "Downloading Worker source", upload: "Uploading Worker", config: "Writing password and config", subdomain: "Enabling public URL", verify: "Verifying deployment" },

      phaseNames: { connect: "Connect to Cloudflare", build: "Build Worker & database", finish: "Final checks" },
      phasePending: "Waiting…",
      phaseRunning: "In progress…",
      chipNames: { kv: "KV", source: "Source", upload: "Upload", config: "Password", subdomain: "URL" },
      stepStatus: { pending: "Pending", running: "Running", ok: "Done", fail: "Failed", skip: "Skipped" },
      errorHints: {
        auth: "The token needs Workers Scripts:Edit and Workers KV Storage:Edit. Create it under My Profile → API Tokens.",
        account: "The token cannot access this account; pick another one.",
        kv: "KV creation failed; check the KV quota or token permissions.",
        source: "Downloading the Worker source from GitHub failed; check the network.",
        upload: "Uploading the Worker failed; check Workers Scripts permission and source size.",
        config: "Writing the password to KV failed.",
        subdomain: "Enabling workers.dev failed.",
        verify: "The Worker is up but did not answer; try again in a minute."
      }
    },
    ru: {
      brandSub: "Автоматический установщик", eyebrow: "Установка за минуту",
      title: "Установить Nova Worker",
      subtitle: "Вставьте только токен Cloudflare; Worker, хранилище KV и пароль создадутся в вашем аккаунте.",
      chipKv: "Авто KV", chipPanel: "Персидская панель", chipFree: "Бесплатно",
      formTitle: "Вход по токену Cloudflare", tokenLabel: "API-токен Cloudflare", tokenHelp: "Создать токен",
      tokenHint: "Нужны права: Workers Scripts:Edit и Workers KV Storage:Edit",
      advanced: "Дополнительно",
      accountIdLabel: "ID аккаунта (необязательно)",
      accountIdHint: "Если токен имеет доступ к нескольким аккаунтам или список не отображается, введите 32-символьный ID аккаунта.",

      haveTokenTitle: "У меня есть токен — установить панель",
      haveTokenSub: "Вставьте API-токен Cloudflare и начните установку. Worker и KV создаются на вашем аккаунте.",
      needTokenTitle: "У меня ещё нет токена",
      needTokenSub: "Создайте временный токен с минимальными правами. После установки его можно отозвать в панели Cloudflare.",
      permScriptsTitle: "Workers Scripts — Edit",
      permScriptsDesc: "Загрузка и публикация Worker",
      permKvTitle: "Workers KV Storage — Edit",
      permKvDesc: "Создание KV и сохранение настроек",
      permAccountTitle: "Account Settings — Read",
      permAccountDesc: "Чтение имени аккаунта (необязательно)",
      tokenStep1: "Нажмите кнопку ниже — откроется Cloudflare с уже отмеченными правами.",
      tokenStep2: "Просто нажмите Continue to summary, затем Create Token — ничего не выбирайте вручную.",
      tokenStep3: "Скопируйте токен, вернитесь сюда, вставьте в левую карточку и начните установку.",
      tokenRevokeNote: "Токен нужен только для установки. После получения ссылки и пароля отзовите его в My Profile → API Tokens.",
      createTokenBtn: "Создать готовый токен в Cloudflare",      accountRequired: "Целевой аккаунт не определён. Введите ID аккаунта в дополнительных настройках.",
      proxyOutdated: "Прокси установщика устарел.",
      proxyOutdatedHint: "Нужна версия прокси 2.0.0 или новее. Разверните прокси NovaInstall заново и обновите страницу.",
      proxyUnreachable: "Прокси установщика недоступен.",
      proxyUnreachableHint: "Проверьте соединение и обновите страницу.",
      streamClosed: "Соединение с установщиком прервано; повторите попытку.",
      retrying: "Соединение потеряно; повтор…",
      recovering: "Восстановление установки из Cloudflare…",
      recoverFailed: "Не удалось восстановить установку; обновите страницу и повторите.",
      installBtn: "Начать установку",
      securityNote: "Токен остаётся в этом браузере и отправляется на api.cloudflare.com через официальный прокси NovaInstall; он не сохраняется. После установки отзовите токен.",
      progressTitle: "Установка", preparing: "Подготовка…",
      resultTitle: "Установка завершена", loginLabel: "Адрес входа", passLabel: "Пароль администратора",
      passHint: "Храните пароль в надёжном месте.",
      open: "Открыть", adminBtn: "Панель", qrLabel: "Быстрое сканирование",
      qrHint: "Отсканируйте камерой телефона, чтобы открыть страницу входа.",
      errorTitle: "Ошибка", retry: "Повторить", copied: "Скопировано", footer: "Nova Worker · простая установка",
      again: "Установить в другой аккаунт",
      elapsedLabel: "Прошло времени",
      serviceChecking: "Проверка сервиса обработки…",
      serviceOk: "Сервис обработки готов",
      serviceBad: "Сервис обработки недоступен",
      serviceUnconfigured: "Сервис обработки не настроен",
      serviceDegraded: "Сервис обработки доступен частично",
      serviceCounts: "Успех/Ошибки",
      copyDetails: "Копировать детали ошибки",
      copyLog: "Копировать журнал",
      copyReport: "Копировать полный отчёт (JSON)",
      copiedReport: "Полный отчёт скопирован",
      copyResult: "Копировать данные установки",
      shareResult: "Поделиться",
      copiedDetails: "Детали скопированы",
      noShare: "Поделиться в этом браузере нельзя.",
      statsLink: "Статистика",
      helpLink: "Помощь / Отчёт",
      healthBannerTitle: "Предупреждение о статусе сервиса",
      healthBannerBody: "Сейчас часть установок завершается ошибкой (повышенный уровень ошибок/1101). Проверьте статус сервиса перед установкой.",
      healthBannerLink: "Статус сервиса",
      tokenTrustTitle: "Прозрачность безопасности токена",
      tokenTrustBody: "Токен используется только для вызовов Cloudflare API через прокси; он не сохраняется в статистике/отчётах и очищается после начала установки. После установки его можно отозвать.",
      traceLabel: "ID трассировки",
      reasonLabel: "Причина",
      stepLabel: "Шаг",
      proxyLabel: "Сервис",
      versionLabel: "Версия",
      emptyToken: "Введите API-токен.", tokenInvalid: "Токен недействителен или без нужных прав.",
      authInvalid: "Токен недействителен или истёк; создайте новый с правами Workers Scripts:Edit и Workers KV Storage:Edit.",
      subdomainRequired: "У вашего аккаунта Cloudflare ещё нет поддомена workers.dev, и установщик не смог его создать. Один раз откройте раздел Workers в панели Cloudflare (это создаст поддомен) и запустите установку снова.",
      multiAccountBody: "У токена несколько аккаунтов; выберите нужный.",
      resume: "Продолжить", done: "Установка выполнена.", verifyPending: "Worker развёрнут, но edge пока не отвечает; откройте адрес через минуту.",
      details: { worker: "Worker", version: "Версия", build: "Сборка", account: "Аккаунт", kv: "KV", source: "Источник" },
      stepNames: { auth: "Подключение к Cloudflare", account: "Выбор аккаунта", kv: "Создание KV", source: "Загрузка исходника", upload: "Загрузка Worker", config: "Запись пароля", subdomain: "Публичный адрес", verify: "Проверка" },

      phaseNames: { connect: "Подключение к Cloudflare", build: "Worker и база", finish: "Финиш" },
      phasePending: "Ожидание…",
      phaseRunning: "Выполняется…",
      chipNames: { kv: "KV", source: "Исходник", upload: "Загрузка", config: "Пароль", subdomain: "URL" },
      stepStatus: { pending: "Ожидание", running: "Выполняется", ok: "Готово", fail: "Ошибка", skip: "Пропущено" },
      errorHints: {
        auth: "Токену нужны права Workers Scripts:Edit и Workers KV Storage:Edit.",
        account: "Токен не имеет доступа к этому аккаунту.",
        kv: "Не удалось создать KV.",
        source: "Не удалось скачать исходник Worker.",
        upload: "Не удалось загрузить Worker.",
        config: "Не удалось записать пароль в KV.",
        subdomain: "Не удалось включить workers.dev.",
        verify: "Worker запущен, но не отвечает; повторите через минуту."
      }
    }
  };

  var $ = function (id) { return document.getElementById(id); };
  var lang = "fa";
  try { var savedLang = localStorage.getItem("nova-install-lang"); if (savedLang && I18N[savedLang]) lang = savedLang; } catch (e) {}

  var state = { busy: false, steps: {}, token: "", accountId: null, result: null, proxyVersion: "", startedAt: 0, lastError: null, service: null, traceId: "", lastPreflight: null, lastStatusPayload: null };

  function t(key) {
    var parts = String(key).split(".");
    var read = function (root) { var node = root; for (var i = 0; i < parts.length; i++) { if (!node) return undefined; node = node[parts[i]]; } return node; };
    var value = read(I18N[lang]);
    if (value === undefined) value = read(I18N.fa);
    return value === undefined ? "" : value;
  }

  function compareVersion(a, b) {
    var left = String(a || "").replace(/[^0-9.]/g, "").split(".").map(function (part) { return parseInt(part, 10) || 0; });
    var right = String(b || "").replace(/[^0-9.]/g, "").split(".").map(function (part) { return parseInt(part, 10) || 0; });
    var length = Math.max(left.length, right.length);
    for (var i = 0; i < length; i++) {
      var l = left[i] || 0;
      var r = right[i] || 0;
      if (l > r) return 1;
      if (l < r) return -1;
    }
    return 0;
  }

  function fetchTimeout(url, options, timeout) {
    options = options || {};
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeout || 30000);
    options.signal = controller.signal;
    return fetch(url, options).then(function (response) {
      clearTimeout(timer);
      return response;
    }, function (error) {
      clearTimeout(timer);
      throw error;
    });
  }

  function readNdjson(response, onEvent) {
    function handle(event) {
      var r = onEvent(event);
      return r && typeof r.then === "function" ? r : Promise.resolve();
    }
    if (!response.body || !response.body.getReader) {
      return response.text().then(function (text) {
        var chain = Promise.resolve();
        text.split("\n").forEach(function (line) {
          line = line.trim();
          if (!line) return;
          var event;
          try { event = JSON.parse(line); } catch (e) { return; }
          chain = chain.then(function () { return handle(event); });
        });
        return chain;
      });
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";

    function drain() {
      var lines = buffer.split("\n");
      buffer = lines.pop();
      var chain = Promise.resolve();
      lines.forEach(function (line) {
        line = line.trim();
        if (!line) return;
        var event;
        try { event = JSON.parse(line); } catch (e) { return; }
        chain = chain.then(function () { return handle(event); });
      });
      return chain;
    }

    function pump() {
      return reader.read().then(function (result) {
        if (result.done) {
          buffer += decoder.decode();
          return drain();
        }
        buffer += decoder.decode(result.value, { stream: true });
        return drain().then(pump);
      });
    }
    return pump();
  }


  function renderServiceStatus(info) {
    var box = $("serviceStatus");
    if (!box) return;
    var dotText = $("serviceStatusText");
    var meta = $("serviceStatusMeta");
    if (!PROXY_URL) {
      box.setAttribute("data-state", "warn");
      if (dotText) dotText.textContent = t("serviceUnconfigured");
      if (meta) meta.innerHTML = "";
      return;
    }
    var stateAttr = "bad";
    var text = t("serviceBad");
    if (info && info.ok) { stateAttr = "ok"; text = t("serviceOk"); }
    else if (info && info.degraded) { stateAttr = "warn"; text = t("serviceDegraded"); }
    box.setAttribute("data-state", stateAttr);
    if (dotText) dotText.textContent = text;
    if (meta) {
      meta.innerHTML = "";
      var pills = [];
      if (info && info.version) pills.push(t("versionLabel") + ": " + info.version);
      if (info && info.status && info.status.install) {
        var ins = info.status.install;
        var counts = (ins.success_verified || 0) + "/" + (ins.failed || 0);
        pills.push(t("serviceCounts") + ": " + counts);
      }
      if (info && info.url) {
        var a = document.createElement("a");
        a.href = info.url.replace(/\/+$/, "") + "/status";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "status";
        var span = document.createElement("span");
        span.className = "service-pill";
        span.appendChild(a);
        meta.appendChild(span);
      }
      pills.forEach(function (p) {
        var s = document.createElement("span");
        s.className = "service-pill";
        s.textContent = p;
        meta.appendChild(s);
      });
    }
  }

  function updateHealthBanner(statusPayload) {
    var banner = $('healthBanner');
    if (!banner) return;
    var dismissed = false;
    try { dismissed = sessionStorage.getItem('nova-health-banner-dismissed') === '1'; } catch (e) {}
    var stats = statusPayload && statusPayload.stats;
    var inst = stats && stats.install ? stats.install : {};
    var reasons = stats && stats.reasons ? stats.reasons : {};
    var attempts = Number(inst.attempts || 0);
    var failed = Number(inst.failed || 0);
    var e1101 = Number(reasons.cloudflare_1101 || 0);
    var rate = attempts > 0 ? failed / attempts : 0;
    var show = attempts >= 5 && (e1101 >= 1 || rate >= 0.25);
    if (!show || dismissed) { banner.hidden = true; return; }
    var title = $('healthBannerTitle');
    var text = $('healthBannerText');
    var link = $('healthBannerLink');
    if (title) title.textContent = t('healthBannerTitle');
    if (text) text.textContent = t('healthBannerBody') + ' (1101: ' + e1101.toLocaleString('fa-IR') + ' · ' + t('serviceCounts') + ': ' + Number(inst.success_verified||0).toLocaleString('fa-IR') + '/' + failed.toLocaleString('fa-IR') + ')';
    if (link) { link.textContent = t('healthBannerLink'); link.href = PROXY_URL ? (PROXY_URL.replace(/\/+$/, '') + '/status') : link.href; }
    banner.hidden = false;
  }

  function refreshServiceStatus() {
    if (!PROXY_URL) { renderServiceStatus(null); return; }
    var info = { ok: false, degraded: false, version: "", status: null, url: PROXY_URL };
    return fetchTimeout(PROXY_URL + "/health?_t=" + Date.now(), { cache: "no-store", mode: "cors", credentials: "omit" }, PROXY_TIMEOUT)
      .then(function (response) {
        if (!response.ok) throw new Error("bad_status");
        return response.json();
      })
      .then(function (health) {
        info.version = String((health && health.version) || "");
        state.proxyVersion = info.version || state.proxyVersion;
        info.ok = Boolean(health && health.ok);
        info.degraded = Boolean(health && health.components && (health.components.durableJobs === "missing" || health.components.statsStore === "missing"));
        return fetchTimeout(PROXY_URL + "/status.json?_t=" + Date.now(), { cache: "no-store", mode: "cors", credentials: "omit" }, PROXY_TIMEOUT)
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; });
      })
      .then(function (st) { info.status = st; })
      .catch(function () { info.ok = false; })
      .then(function () { state.lastStatusPayload = info.status; renderServiceStatus(info); updateHealthBanner(info.status); return info; });
  }

  function detectProxy() {
    if (!PROXY_URL) {
      renderServiceStatus(null);
      return Promise.resolve({ version: "", install: false, ok: false, softFail: false });
    }
    return fetchTimeout(
      PROXY_URL + "/health?_t=" + Date.now(),
      { cache: "no-store", mode: "cors", credentials: "omit" },
      PROXY_TIMEOUT
    )
      .then(function (response) {
        if (!response.ok) throw new Error("bad_status");
        return response.json();
      })
      .then(function (data) {
        var version = String((data && data.version) || "");
        state.proxyVersion = version;
        var install = !(data && data.capabilities && data.capabilities.install === false);
        var ok = compareVersion(version, MIN_PROXY_VERSION) >= 0 && install;
        refreshServiceStatus();
        return { version: version, install: install, ok: ok, softFail: false };
      })
      .catch(function () {
        // Network/filter timeout: do not block install — streamInstall will surface real errors.
        state.proxyVersion = state.proxyVersion || "";
        renderServiceStatus({ ok: false, degraded: true, version: state.proxyVersion || "", status: null, url: PROXY_URL });
        try { termWrite("skip", t("proxyUnreachable") + " — continue install"); } catch (e) {}
        return { version: state.proxyVersion || "unknown", install: true, ok: true, softFail: true };
      });
  }

  function proxyError(message, hint) {
    var error = new Error(message || t("proxyOutdated"));
    error.hint = hint || (t("proxyOutdatedHint") + (state.proxyVersion ? " (" + state.proxyVersion + ")" : ""));
    return error;
  }

  function eventError(event) {
    var codes = Array.isArray(event.codes) ? event.codes : [];
    var invalid = codes.indexOf(1000) !== -1 || codes.indexOf(9109) !== -1 || codes.indexOf(6003) !== -1;
    var needsSubdomain = codes.indexOf(10063) !== -1;
    var message;
    if (event.needAccountId) message = t("accountRequired");
    else if (invalid || event.step === "auth") message = t("authInvalid");
    else if (needsSubdomain) message = t("subdomainRequired");
    else message = event.message || t("tokenInvalid");

    var error = new Error(message);
    error.step = event.step || event.errorStep || "auth";
    error.codes = codes;
    error.needAccountId = Boolean(event.needAccountId);
    error.accounts = Array.isArray(event.accounts) ? event.accounts : null;
    error.reason = event.reason || "";
    error.hint = event.hint || "";
    error.traceId = event.traceId || state.traceId || "";
    error.raw = event;
    return error;
  }

  function toast(message) {
    var node = $("toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { node.classList.remove("show"); }, 1800);
  }

  function copy(text) {
    var value = String(text || "");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () { toast(t("copied")); }).catch(function () { fallbackCopy(value); });
    } else fallbackCopy(value);
  }

  function fallbackCopy(value) {
    var area = document.createElement("textarea");
    area.value = value; area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.select();
    try { document.execCommand("copy"); toast(t("copied")); } catch (e) {}
    document.body.removeChild(area);
  }

  /* ------------------------------------------------------------ progress UI */

  function resetSteps() {
    state.steps = {};
    state.startedAt = Date.now();
    clearTerm();
    termWrite("info", "nova-install session started");
    STEPS.forEach(function (id) { state.steps[id] = { status: "pending", detail: "" }; });
    $("accountPicker").hidden = true;
    renderSteps();
    updateProgress();
  }


  function formatElapsed(ms) {
    var sec = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  function tickTimer() {
    if (!state.startedAt) return;
    var text = formatElapsed(Date.now() - state.startedAt);
    var big = $("elapsedBig");
    var term = $("elapsedTerm");
    if (big) big.textContent = text;
    if (term) term.textContent = text;
  }

  function termWrite(kind, message) {
    var log = $("termLog");
    if (!log) return;
    var line = document.createElement("div");
    line.className = "line " + (kind || "info");
    var ts = formatElapsed(state.startedAt ? Date.now() - state.startedAt : 0);
    line.innerHTML = '<span class="ts">[' + ts + ']</span><span class="prompt">$</span> ' + String(message || "").replace(/[<>&]/g, function (c) {
      return ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c];
    });
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function clearTerm() {
    var log = $("termLog");
    if (log) log.innerHTML = "";
    var big = $("elapsedBig");
    var term = $("elapsedTerm");
    if (big) big.textContent = "00:00";
    if (term) term.textContent = "00:00";
  }

  function phaseStatus(phase) {
    var steps = phase.steps;
    var hasFail = steps.some(function (id) { return state.steps[id] && state.steps[id].status === "fail"; });
    if (hasFail) return "fail";
    var hasRun = steps.some(function (id) { return state.steps[id] && state.steps[id].status === "running"; });
    if (hasRun) return "running";
    var allDone = steps.every(function (id) {
      var s = state.steps[id] && state.steps[id].status;
      return s === "ok" || s === "skip";
    });
    if (allDone) return "ok";
    var any = steps.some(function (id) { return state.steps[id]; });
    if (any) return "running";
    return "pending";
  }

  function phaseDetail(phase) {
    var steps = phase.steps;
    for (var i = steps.length - 1; i >= 0; i--) {
      var item = state.steps[steps[i]];
      if (item && item.detail && (item.status === "running" || item.status === "ok" || item.status === "fail" || item.status === "skip")) {
        return item.detail;
      }
    }
    return "";
  }

  function setStep(id, status, detail) {
    state.steps[id] = { status: status, detail: detail || "" };
    var name = t("stepNames." + id) || id;
    var msg = name;
    if (detail) msg += " — " + detail;
    if (status === "running") termWrite("run", msg + " …");
    else if (status === "ok") termWrite("ok", msg + " ✓");
    else if (status === "fail") termWrite("fail", msg + " ✕");
    else if (status === "skip") termWrite("skip", msg + " (skip)");
    renderSteps();
    updateProgress();
    tickTimer();
  }

  function renderSteps() {
    var list = $("stepsList");
    list.innerHTML = "";
    PHASES.forEach(function (phase, index) {
      var status = phaseStatus(phase);
      var li = document.createElement("li");
      li.className = "phase";
      li.setAttribute("data-status", status);
      var num = document.createElement("div");
      num.className = "phase-num";
      if (status === "running") {
        var spin = document.createElement("div");
        spin.className = "spin-sm";
        num.appendChild(spin);
      } else if (status === "ok") {
        num.textContent = "✓";
      } else if (status === "fail") {
        num.textContent = "✕";
      } else {
        num.textContent = String(index + 1);
      }
      var body = document.createElement("div");
      var title = document.createElement("div");
      title.className = "phase-title";
      title.textContent = t("phaseNames." + phase.id) || phase.id;
      var detail = document.createElement("div");
      detail.className = "phase-detail";
      detail.textContent = phaseDetail(phase) || (status === "pending" ? t("phasePending") : status === "running" ? t("phaseRunning") : "");
      body.appendChild(title);
      body.appendChild(detail);
      // micro chips for build phase
      if (phase.id === "build") {
        var sub = document.createElement("div");
        sub.className = "phase-sub";
        ["kv", "source", "upload", "config", "subdomain"].forEach(function (sid) {
          var chip = document.createElement("span");
          chip.className = "phase-chip";
          var st = state.steps[sid] && state.steps[sid].status;
          if (st === "ok" || st === "skip") chip.className += " on";
          else if (st === "running") chip.className += " run";
          chip.textContent = t("chipNames." + sid) || sid;
          sub.appendChild(chip);
        });
        body.appendChild(sub);
      }
      li.appendChild(num);
      li.appendChild(body);
      list.appendChild(li);
    });
  }

  function updateProgress() {
    var done = 0;
    PHASES.forEach(function (phase) {
      var st = phaseStatus(phase);
      if (st === "ok") done += 1;
      else if (st === "running") done += 0.45;
    });
    var percent = Math.min(99, Math.round((done / PHASES.length) * 100));
    var allFine = STEPS.every(function (id) {
      var s = state.steps[id] && state.steps[id].status;
      return s === "ok" || s === "skip";
    });
    if (allFine) percent = 100;
    $("barFill").style.width = percent + "%";
    var elapsed = "";
    if (state.startedAt) {
      var sec = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
      elapsed = " · " + sec + "s";
    }
    $("progressPercent").textContent = percent + "%" + elapsed;
    var runningPhase = PHASES.find(function (p) { return phaseStatus(p) === "running"; });
    var label = runningPhase ? (t("phaseNames." + runningPhase.id) || "") : t("preparing");
    $("progressLabel").textContent = label;
    tickTimer();
  }


  function setBusy(busy) {
    state.busy = busy;
    var button = $("installBtn");
    button.disabled = busy;
    button.classList.toggle("loading", busy);
    $("resumeBtn").disabled = busy;
  }

  function renderErrorMeta(error, stepId) {
    var meta = $("errorMeta");
    if (!meta) return;
    meta.innerHTML = "";
    var chips = [];
    var step = (error && error.step) || stepId || "";
    if (step) chips.push({ label: t("stepLabel"), value: step });
    if (error && error.reason) chips.push({ label: t("reasonLabel"), value: error.reason, cls: "warn" });
    if (error && (error.traceId || state.traceId)) chips.push({ label: t("traceLabel"), value: error.traceId || state.traceId });
    if (error && error.status) chips.push({ label: "HTTP", value: String(error.status) });
    chips.forEach(function (c) {
      var span = document.createElement("span");
      span.className = "meta-chip" + (c.cls ? " " + c.cls : "");
      span.textContent = c.label + ": " + c.value;
      meta.appendChild(span);
    });
    meta.hidden = chips.length === 0;
  }

  function getLogText() {
    var log = $("termLog");
    if (!log) return "";
    return (log.innerText || log.textContent || "").trim();
  }

  function buildErrorDiagnostics(error, stepId) {
    var lines = [];
    lines.push("NovaInstall error diagnostics");
    lines.push("time: " + new Date().toISOString());
    if (state.proxyVersion) lines.push("proxy_version: " + state.proxyVersion);
    if (error && error.message) lines.push("message: " + error.message);
    if (stepId || (error && error.step)) lines.push("step: " + (error && error.step || stepId));
    if (error && error.reason) lines.push("reason: " + error.reason);
    if (error && error.hint) lines.push("hint: " + error.hint);
    if (error && error.status) lines.push("http_status: " + error.status);
    if (error && (error.traceId || state.traceId)) lines.push("trace_id: " + (error.traceId || state.traceId));
    if (error && error.codes && error.codes.length) lines.push("codes: " + error.codes.join(","));
    var log = getLogText();
    if (log) {
      lines.push("");
      lines.push("log:");
      lines.push(log.slice(-4000));
    }
    return lines.join("\n");
  }

  function showError(error, stepId) {
    state.lastError = { error: error, stepId: stepId || (error && error.step) || "" };
    if (error && error.traceId) state.traceId = error.traceId;
    document.documentElement.setAttribute("data-state", "failed");
    $("errorCard").hidden = false;
    $("errorText").textContent = (error && error.message) || String(error);
    var hint = (error && error.hint) || "";
    if (!hint && stepId) hint = t("errorHints." + stepId);
    if (!hint && error && error.step) hint = t("errorHints." + error.step);
    if (error && error.needAccountId) hint = t("accountIdHint");
    $("errorHint").hidden = !hint;
    $("errorHint").textContent = hint || "";
    renderErrorMeta(error, stepId);
    $("formCard").hidden = false;
    if (error && error.needAccountId) {
      var box = $("advBox");
      if (box) box.open = true;
      var input = $("accountId");
      if (input) { try { input.focus(); } catch (e) {} }
    }
    setBusy(false);
    var top = $("errorCard").getBoundingClientRect().top + window.scrollY - 20;
    window.scrollTo({ top: top, behavior: "smooth" });
  }

  function failStep(error) {
    var stepId = STEPS.find(function (id) { return state.steps[id] && state.steps[id].status === "running"; });
    if (stepId) setStep(stepId, "fail", error && error.message ? error.message : String(error));
    showError(error, stepId);
    $("progressLabel").textContent = t("errorTitle");
  }

  /* ---------------------------------------------------------------- install */

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function randomWorkerName() {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var out = 'w';
    var bytes = new Uint8Array(10);
    try { crypto.getRandomValues(bytes); } catch (e) { for (var i=0;i<bytes.length;i++) bytes[i]=Math.floor(Math.random()*256); }
    for (var i = 0; i < 10; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  function panelPill(health) {
    if (!health) return '<span class="pill warn">نامشخص</span>';
    if (health.cloudflare1101) return '<span class="pill bad">1101</span>';
    if (health.ok) return '<span class="pill ok">قابل دسترس</span>';
    if (health.reason === 'timeout' || health.reason === 'network_error') return '<span class="pill warn">بررسی ناموفق</span>';
    return '<span class="pill warn">' + escapeHtml(String(health.reason || 'unknown')) + '</span>';
  }

  function showPanelDecision(preflight) {
    return new Promise(function (resolve) {
      var modal = $('panelModal');
      var body = $('panelModalBody');
      var actions = $('panelModalActions');
      var icon = $('panelModalIcon');
      var title = $('panelModalTitle');
      var desc = $('panelModalDesc');
      var panels = Array.isArray(preflight.existingPanels) ? preflight.existingPanels : [];
      var decision = preflight.panelDecision || {};
      var same = panels.find(function (p) { return p && p.isConfiguredName; });
      var broken = panels.filter(function (p) { return p && p.health && p.health.cloudflare1101; });
      var has1101 = broken.length > 0;

      icon.className = 'modal-icon' + (has1101 ? ' danger' : (decision.action === 'install_new' ? ' ok' : ''));
      icon.textContent = has1101 ? '!' : (decision.action === 'install_new' ? '✓' : 'i');

      if (has1101) {
        title.textContent = 'پنل موجود با مشکل شناسایی شد';
        desc.textContent = 'روی این اکانت پنل Nova پیدا شد که احتمال مشکل Cloudflare 1101 دارد. نصب مجدد روی همان وضعیت ممکن است همان خطا را تکرار کند.';
      } else if (decision.action === 'existing_same_name') {
        title.textContent = 'پنل موجود روی این نام پیدا شد';
        desc.textContent = 'یک پنل با همین نام Worker روی این اکانت وجود دارد. می‌توانید روی همان پنل نصب/بروزرسانی کنید یا یک پنل جدید با نام تصادفی بسازید.';
      } else {
        title.textContent = 'پنل‌های Nova روی این اکانت شناسایی شد';
        desc.textContent = 'برای جلوگیری از تداخل یا خطای تکراری، یکی از گزینه‌های زیر را انتخاب کنید.';
      }

      var items = panels.map(function (p) {
        var h = p.health || {};
        var url = p.url ? '<div class="panel-url">' + escapeHtml(p.url) + '</div>' : '';
        var flags = [];
        if (p.isConfiguredName) flags.push('<span class="pill">نام انتخاب‌شده</span>');
        if (p.hasKvBinding) flags.push('<span class="pill">KV</span>');
        flags.push(panelPill(h));
        return '<div class="panel-item">' +
          '<div class="panel-item-head"><div class="panel-name">' + escapeHtml(p.workerName || '-') + '</div><div class="panel-badges">' + flags.join('') + '</div></div>' +
          url +
        '</div>';
      }).join('');

      var note = '';
      if (has1101) {
        note = '<div class="modal-note"><strong>پیشنهاد:</strong> برای جلوگیری از تکرار 1101، بهتر است از یک اکانت/توکن Cloudflare جدید استفاده کنید. اگر می‌دانید مشکل پنل برطرف شده، می‌توانید روی همین پنل نصب مجدد را امتحان کنید.</div>';
      } else if (panels.length) {
        note = '<div class="modal-note">می‌توانید روی پنل موجود نصب/بروزرسانی انجام دهید یا یک پنل جدید با نام تصادفی بسازید. اطلاعات نصب پس از اتمام نمایش داده می‌شود.</div>';
      }
      body.innerHTML = items + note;

      function close(result) {
        modal.hidden = true;
        modal.onclick = null;
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      function onKey(e) { if (e.key === 'Escape') close({ action: 'cancel' }); }
      document.addEventListener('keydown', onKey);
      modal.onclick = function (e) { if (e.target === modal) close({ action: 'cancel' }); };

      var btns = [];
      if (same) {
        btns.push({ label: has1101 ? 'نصب مجدد روی همین پنل (ریسک)' : 'نصب/بروزرسانی روی همین پنل', cls: has1101 ? 'btn danger' : 'btn primary', run: function () { close({ action: 'continue', workerName: same.workerName }); } });
      }
      btns.push({ label: has1101 ? 'ساخت پنل جدید با نام تصادفی (ریسک همین اکانت)' : 'ساخت پنل جدید با نام تصادفی', cls: has1101 ? 'btn' : (same ? 'btn' : 'btn primary'), run: function () { close({ action: 'continue', workerName: randomWorkerName() }); } });
      if (!same && panels.length) {
        // allow installing on first detected healthy panel
        var target = panels.find(function(p){ return p.health && p.health.ok && !p.health.cloudflare1101; }) || panels[0];
        btns.push({ label: 'نصب روی پنل شناسایی‌شده: ' + target.workerName, cls: 'btn', run: function () { close({ action: 'continue', workerName: target.workerName }); } });
      }
      btns.push({ label: has1101 ? 'استفاده از اکانت/توکن دیگر' : 'انصراف', cls: 'btn ghost', run: function () { close({ action: 'cancel' }); } });

      actions.innerHTML = '';
      btns.forEach(function (b) {
        var el = document.createElement('button');
        el.type = 'button';
        el.className = b.cls;
        el.textContent = b.label;
        el.onclick = b.run;
        actions.appendChild(el);
      });

      modal.hidden = false;
      var first = actions.querySelector('.primary') || actions.querySelector('button');
      if (first) try { first.focus(); } catch (e) {}
    });
  }

  async function begin(chosenAccount) {
    if (!requireProxyConfigured()) return;
    if (state.busy) return;
    var pendingJobId = "";
    try { pendingJobId = localStorage.getItem("nova-install-job-id") || ""; } catch (e) {}
    var token = ($("token").value || "").trim();
    if (!token && !pendingJobId) { showError(new Error(t("emptyToken"))); return; }

    var manualId = ($("accountId").value || "").trim().toLowerCase();
    if (manualId && !/^[a-f0-9]{32}$/.test(manualId)) {
      var idError = new Error(t("accountIdHint"));
      idError.needAccountId = true;
      showError(idError);
      return;
    }

    state.token = token;
    state.accountId = chosenAccount || manualId || state.accountId || null;
    $("errorCard").hidden = true;
    $("resultCard").hidden = true;
    $("progressCard").hidden = false;
    $("formCard").hidden = true;
    $("accountPicker").hidden = true;
    document.documentElement.setAttribute("data-state", "working");
    if (state._tick) clearInterval(state._tick);
    state._tick = setInterval(function () { tickTimer(); updateProgress(); }, 250);
    resetSteps();
    setBusy(true);
    $("progressCard").scrollIntoView({ behavior: "smooth", block: "start" });

    try {
      setStep("auth", "running", t("preparing"));
      var proxy = await detectProxy();
      if (!proxy.ok) { showError(proxyError()); return; }
      if (proxy.softFail) setStep("auth", "running", "proxy health skipped");
      else setStep("auth", "running", "proxy " + (proxy.version || ""));

      if (pendingJobId) {
  await pollDurableJob(pendingJobId);
  return;
}
var preflight = await runPreflight(token, state.accountId);
state.lastPreflight = preflight;
state.workerName = preflight.workerName;
state.accountId = preflight.account.id;

var decision = preflight.panelDecision || {};
var panels = Array.isArray(preflight.existingPanels) ? preflight.existingPanels : [];
if (panels.length > 0 || (decision.action && decision.action !== 'install_new')) {
  termWrite('run', 'existing panel check: ' + (decision.action || 'detected') + (decision.has1101 ? ' (1101 risk)' : ''));
  var choice = await showPanelDecision(preflight);
  if (!choice || choice.action === 'cancel') {
    if (state._tick) { clearInterval(state._tick); state._tick = null; }
    setStep('auth', 'ok', 'preflight passed');
    setStep('account', 'ok', (preflight.account.name || preflight.account.id) + ' · ready');
    $('progressCard').hidden = true;
    $('formCard').hidden = false;
    document.documentElement.setAttribute('data-state', 'idle');
    setBusy(false);
    termWrite('run', 'install cancelled by user after panel check');
    return;
  }
  if (choice.workerName) state.workerName = choice.workerName;
}

setStep("auth", "ok", "token active · preflight passed");
setStep("account", "ok", (preflight.account.name || preflight.account.id) + " · ready");
setStep("source", "running", "GitHub source will be downloaded and verified in the background job");
termWrite("ok", "preflight passed · " + preflight.resources.workerCountVisible + " Workers visible · " + preflight.resources.kvCountVisible + " KV namespaces visible");
termWrite("run", "target worker: " + state.workerName);
      await startDurableInstall(token, preflight.account.id, preflight.account);
    } catch (error) {
      if (error && error.needAccountId && error.accounts && error.accounts.length) {
        renderAccounts(error.accounts);
        setStep("account", "running", t("multiAccountBody"));
        $("accountPicker").hidden = false;
        $("progressCard").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (error && error.needAccountId) {
        setStep("account", "fail", t("accountRequired"));
        showError(error, "account");
        return;
      }
      failStep(error);
    } finally {
      setBusy(false);
    }
  }

  function renderAccounts(accounts) {
    var select = $("accountSelect");
    select.innerHTML = "";
    accounts.forEach(function (item) {
      var option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name + " — " + item.id.slice(0, 8);
      select.appendChild(option);
    });
    if (state.accountId) select.value = state.accountId;
  }

  async function runPreflight(token, accountId) {
  var payload = { panelUrl: PANEL_URL, compatibilityDate: COMPAT_DATE, sourceUrl: WORKER_SOURCE };
  if (accountId) payload.accountId = accountId;
  setStep("auth", "running", "checking token, account and Cloudflare API access…");
  setStep("source", "running", "checking GitHub source from installer server…");
  var response;
  try {
    response = await fetchTimeout(PROXY_URL + "/preflight", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload), cache: "no-store"
    }, 90000);
  } catch (error) {
    var network = new Error("ارتباط با سرویس بررسی اولیه برقرار نشد؛ دوباره تلاش کن.");
    network.step = "auth";
    throw network;
  }
  var data = null;
  try { data = await response.json(); } catch (e) {}
  var traceId = (data && data.traceId) || response.headers.get("X-Request-Id") || "";
  if (traceId) state.traceId = traceId;
  if (!response.ok || !data || !data.ok) {
    var failure = new Error((data && data.message) || (data && data.error) || ("Preflight HTTP " + response.status));
    failure.step = (data && data.step) || "auth";
    failure.reason = (data && data.reason) || "";
    failure.hint = (data && data.hint) || "";
    failure.traceId = traceId;
    failure.status = response.status;
    failure.needAccountId = Boolean(data && data.needAccountId);
    failure.accounts = data && Array.isArray(data.accounts) ? data.accounts : null;
    failure.fatal = response.status >= 400 && response.status < 500;
    throw failure;
  }
  return data;
}

function makeClientJobId() {
  var bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  var out = "";
  for (var i = 0; i < 32; i++) out += alphabet[bytes[i % bytes.length] % alphabet.length];
  return out;
}

async function startDurableInstall(token, accountId, account) {
  var jobId = makeClientJobId();
  try { localStorage.setItem("nova-install-job-id", jobId); } catch (e) {}
  var payload = {
    panelUrl: PANEL_URL,
    compatibilityDate: COMPAT_DATE,
    sourceUrl: WORKER_SOURCE,
    workerName: state.workerName,
    accountName: account && account.name ? account.name : ""
  };
  if (accountId) payload.accountId = accountId;

  var started = false;
  for (var attempt = 0; attempt < 2 && !started; attempt++) {
    try {
      var response = await fetchTimeout(PROXY_URL + "/jobs", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-Nova-Job-Id": jobId
        },
        body: JSON.stringify(payload),
        cache: "no-store"
      }, 30000);
      var data = null;
      try { data = await response.json(); } catch (e) {}
      var jtrace = (data && data.traceId) || response.headers.get("X-Request-Id") || "";
      if (jtrace) state.traceId = jtrace;
      if (response.ok && data && data.ok) {
        started = true;
      } else if (response.status === 409 && data && data.error === "job_already_started") {
        started = true;
      } else if (response.status === 503 && data && data.error === "durable_jobs_not_configured") {
        try { localStorage.removeItem("nova-install-job-id"); } catch (e) {}
        termWrite("run", "durable jobs unavailable · falling back to streaming install");
        state.token = "";
        $("token").value = "";
        return streamInstall(token, accountId);
      } else {
        var jerr = new Error((data && data.message) || (data && data.error) || ("Job HTTP " + response.status));
        jerr.step = (data && data.step) || "upload";
        jerr.reason = data && data.reason;
        jerr.hint = data && data.hint;
        jerr.traceId = jtrace;
        jerr.status = response.status;
        throw jerr;
      }
    } catch (error) {
      if (attempt === 1) {
        // The POST may have reached the server even if the mobile connection
        // dropped before its response arrived. Poll the same client-known ID.
        try {
          var probe = await fetchTimeout(PROXY_URL + "/jobs/" + jobId, { cache: "no-store" }, 12000);
          if (probe.ok) started = true;
        } catch (e) {}
      }
      if (!started && attempt === 1) throw error;
    }
  }
  if (!started) throw new Error("شروع کار نصب در سرور تأیید نشد.");
  state.token = "";
  $("token").value = "";
  await pollDurableJob(jobId);
}

async function pollDurableJob(jobId) {
  var cursor = 0;
  setStep("upload", "running", "installation is running on Cloudflare; browser can reconnect safely");
  while (true) {
    var response;
    try {
      response = await fetchTimeout(PROXY_URL + "/jobs/" + jobId + "?after=" + cursor, {
        cache: "no-store", mode: "cors", credentials: "omit"
      }, 20000);
    } catch (error) {
      termWrite("run", "connection interrupted · server job continues; reconnecting…");
      await sleep(2000);
      continue;
    }
    if (response.status === 404) {
      try { localStorage.removeItem("nova-install-job-id"); } catch (e) {}
      var missing = new Error("شناسهٔ فرایند نصب در سرور پیدا نشد؛ دوباره نصب را شروع کن.");
      missing.step = "verify";
      throw missing;
    }
    var data = null;
    try { data = await response.json(); } catch (e) {}
    var ptrace = (data && data.traceId) || response.headers.get("X-Request-Id") || "";
    if (ptrace) state.traceId = ptrace;
    if (!response.ok || !data || !data.ok) {
      await sleep(2000);
      continue;
    }
    var events = Array.isArray(data.events) ? data.events : [];
    for (var i = 0; i < events.length; i++) {
      var event = events[i];
      if (!event) continue;
      if (event.type === "step") setStep(event.step, event.status, event.detail);
      else if (event.type === "error") {
        try { localStorage.removeItem("nova-install-job-id"); } catch (e) {}
        throw eventError(event);
      } else if (event.type === "result") {
        try { localStorage.removeItem("nova-install-job-id"); } catch (e) {}
        finishInstall(event.result);
        return event.result;
      }
    }
    cursor = Number(data.cursor || cursor);
    if (data.status === "completed" && data.result) {
      try { localStorage.removeItem("nova-install-job-id"); } catch (e) {}
      finishInstall(data.result);
      return data.result;
    }
    if (data.status === "failed") {
      try { localStorage.removeItem("nova-install-job-id"); } catch (e) {}
      var derr = data.error || { step: "install", message: "نصب در سرور ناموفق شد." };
      if (!derr.traceId) derr.traceId = ptrace || state.traceId || "";
      throw eventError(derr);
    }
    await sleep(1500);
  }
}

async function streamInstall(token, accountId) {
    var attempt = 0;
    while (true) {
      attempt += 1;
      try {
        return await streamOnce(token, accountId);
      } catch (error) {
        if (error && (error.step || error.fatal)) throw error;
        // Never restart a whole install after the proxy already created
        // resources: a retry would create a second Worker and KV namespace.
        var startedWork = ["kv", "source", "upload", "config", "subdomain"].some(function (id) {
          return state.steps[id] && state.steps[id].status && state.steps[id].status !== "pending";
        });
        if (startedWork) {
          error.step = error.step || "upload";
          throw error;
        }
        if (attempt >= 2) throw error;
        setStep("auth", "running", t("retrying"));
        await new Promise(function (resolve) { setTimeout(resolve, 1200); });
      }
    }
  }

  async function streamOnce(token, accountId) {
    var payload = {
      panelUrl: PANEL_URL,
      compatibilityDate: COMPAT_DATE,
      sourceUrl: WORKER_SOURCE
    };
    if (accountId) payload.accountId = accountId;
    if (state.workerName) payload.workerName = state.workerName;

    var response;
    try {
      response = await fetchTimeout(PROXY_URL + "/install", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json",
          "Accept": "application/x-ndjson"
        },
        body: JSON.stringify(payload),
        cache: "no-store"
      }, INSTALL_TIMEOUT);
    } catch (error) {
      var netError = new Error(t("streamClosed"));
      netError.cause = error;
      throw netError;
    }

    var streamTrace = response.headers.get("X-Request-Id") || "";
    if (streamTrace) state.traceId = streamTrace;
    if (!response.ok) {
      var text = "";
      try { text = await response.text(); } catch (e) {}
      var httpError = new Error(text || ("HTTP " + response.status));
      httpError.status = response.status;
      httpError.fatal = response.status >= 400 && response.status < 500;
      httpError.traceId = streamTrace;
      throw httpError;
    }

    var outcome = null;
    var lastEvent = Date.now();
    // Long Cloudflare calls leave the stream silent. The proxy sends a ping
    // every 1.5s; if nothing at all arrives for 25s the connection is dead.
    var watchdog = new Promise(function (resolve, reject) {
      state._stallTimer = setInterval(function () {
        if (Date.now() - lastEvent > 25000) {
          clearInterval(state._stallTimer);
          state._stallTimer = null;
          reject(new Error("stream_stalled"));
        }
      }, 2000);
    });
    try {
      await Promise.race([readNdjson(response, async function (event) {
      if (!event || !event.type || state.result) return;
      lastEvent = Date.now();
      if (event.type === "step") {
        setStep(event.step, event.status, event.detail);
        return;
      }
      if (event.type === "result") {
        outcome = event.result;
        return;
      }
      if (event.type === "error") { if (!event.traceId && streamTrace) event.traceId = streamTrace; throw eventError(event); }
      }), watchdog]);
    } catch (error) {
      if (!error || error.message !== "stream_stalled") throw error;
      termWrite("run", t("streamClosed"));
    } finally {
      if (state._stallTimer) { clearInterval(state._stallTimer); state._stallTimer = null; }
    }

    if (!outcome) {
      var recovered = null;
      try {
        recovered = await recoverInstall(token);
      } catch (error) {
        termWrite("fail", (error && error.message) || String(error));
      }
      if (!recovered) {
        var lost = new Error(t("recoverFailed"));
        lost.step = "verify";
        throw lost;
      }
      outcome = recovered;
    }

    finishInstall(outcome);
    return outcome;
  }

  /* ------------------------------------------------------------- recovery */

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Thin wrapper around the proxy's /api passthrough so recovery can use the
  // user's own token without hitting Cloudflare CORS limits.
  function apiJson(token, path, method, body) {
    var options = {
      method: method || "GET",
      headers: { "Authorization": "Bearer " + token, "Accept": "application/json" },
      cache: "no-store"
    };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetchTimeout(PROXY_URL + "/api" + path, options, 30000).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) {}
        if (!response.ok || (data && data.success === false)) {
          var first = data && data.errors && data.errors[0];
          var error = new Error((first && first.message) || ("HTTP " + response.status));
          error.status = response.status;
          error.codes = ((data && data.errors) || []).map(function (item) { return item.code; });
          throw error;
        }
        return data ? data.result : null;
      });
    });
  }

  function apiText(token, path) {
    return fetchTimeout(PROXY_URL + "/api" + path, {
      headers: { "Authorization": "Bearer " + token },
      cache: "no-store"
    }, 30000).then(function (response) {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.text();
    });
  }

  function kvValue(token, accountId, namespaceId, key) {
    return apiText(
      token,
      "/accounts/" + accountId + "/storage/kv/namespaces/" + namespaceId +
        "/values/" + encodeURIComponent(key)
    );
  }

  function workerFromSteps() {
    var detail = (state.steps.kv && state.steps.kv.detail) || "";
    return String(detail).replace(/\s*·.*$/, "").replace(/-kv$/, "").trim();
  }

  // The progress stream can be dropped by the edge while the proxy keeps
  // working. Instead of failing the whole install, find the resources the
  // proxy already created and finish the activation from the browser.
  async function recoverInstall(token) {
    var workerName = workerFromSteps();
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)) return null;

    setStep("verify", "running", t("recovering"));
    termWrite("run", t("recovering"));

    var accountIds = state.accountId ? [state.accountId] : [];
    var accountId = null;
    var namespace = null;

    async function findNamespace() {
      for (var i = 0; i < accountIds.length && !namespace; i++) {
        try {
          var list = await apiJson(
            token,
            "/accounts/" + accountIds[i] + "/storage/kv/namespaces?per_page=100"
          );
          var found = (list || []).find(function (item) {
            return item.title === workerName + "-kv";
          });
          if (found) { accountId = accountIds[i]; namespace = found; }
        } catch (e) {}
      }
    }

    await findNamespace();
    if (!namespace) {
      try {
        var accounts = await apiJson(token, "/accounts?per_page=50");
        (accounts || []).forEach(function (item) {
          if (item && item.id && accountIds.indexOf(item.id) < 0) accountIds.push(item.id);
        });
        await findNamespace();
      } catch (e) {}
    }
    if (!namespace) return null;

    var installText = await apiText(
      token,
      "/accounts/" + accountId + "/storage/kv/namespaces/" + namespace.id + "/values/install.json"
    ).catch(function () { return null; });
    if (!installText) return null;

    var data = {};
    try { data = JSON.parse(installText); } catch (e) {}
    if (!data || !data.ADMIN) return null;

    var accountName = data.account || accountId;
    if (!data.account) {
      try {
        var accountInfo = await apiJson(token, "/accounts/" + accountId);
        accountName = (accountInfo && accountInfo.name) || accountName;
      } catch (e) {}
    }

    var subdomain = "";
    try {
      var sub = await apiJson(token, "/accounts/" + accountId + "/workers/subdomain");
      subdomain = (sub && sub.subdomain) || "";
    } catch (e) {}

    var base = subdomain ? "https://" + workerName + "." + subdomain + ".workers.dev" : "";
    return {
      worker: data.worker || workerName,
      account: accountName,
      accountId: data.accountId || accountId,
      kv: data.kv || namespace.title || (workerName + "-kv"),
      kvId: data.kvId || namespace.id,
      source: data.source || WORKER_SOURCE,
      loginUrl: base + "/login",
      adminUrl: base + "/admin",
      password: data.ADMIN,
      verified: Boolean(base),
      version: data.version || "نامشخص",
      build: data.build || "نسخه نصب‌شده قبلی"
    };
  }


  function finishInstall(result) {
    state.result = result;
    renderResult(result);
    $("token").value = "";
    if (state._tick) { clearInterval(state._tick); state._tick = null; }
    termWrite("ok", "install complete");
    document.documentElement.setAttribute("data-state", "done");
    $("resultCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ----------------------------------------------------------------- result */

  function renderResult(result) {
    $("resultCard").hidden = false;
    $("loginUrl").textContent = result.loginUrl;
    $("loginUrl").href = result.loginUrl;
    $("openLogin").href = result.loginUrl;
    $("openAdmin").href = result.adminUrl;
    $("resultPassword").value = result.password;

    var box = $("qrBox");
    box.innerHTML = "";
    var qrRow = box.closest(".qr-row");
    try {
      var img = document.createElement("img");
      img.alt = "QR";
      img.width = 150;
      img.height = 150;
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      // Public QR image APIs — no JS library needed
      var data = encodeURIComponent(result.loginUrl);
      img.src = "https://api.qrserver.com/v1/create-qr-code/?size=150x150&margin=8&data=" + data;
      img.onerror = function () {
        img.onerror = null;
        img.src = "https://quickchart.io/qr?size=150&margin=1&text=" + data;
      };
      box.appendChild(img);
      if (qrRow) qrRow.hidden = false;
    } catch (e) {
      if (qrRow) qrRow.hidden = true;
    }

    var labels = t("details");
    var list = $("detailsList");
    list.innerHTML = "";
    var rows = [
      [labels.worker, result.worker],
      [labels.version, result.version || "-"],
      [labels.build, result.build || "-"],
      [labels.account, result.account],
      [labels.kv, result.kv],
      [labels.source, result.source]
    ];
    if (state.proxyVersion) rows.push([t("proxyLabel") || "Proxy", state.proxyVersion]);
    if (state.traceId) rows.push([t("traceLabel") || "Trace", state.traceId]);
    rows.forEach(function (row) {
      var wrap = document.createElement("div");
      wrap.className = "detail";
      var dt = document.createElement("dt"); dt.textContent = row[0];
      var dd = document.createElement("dd"); dd.textContent = row[1] || "-";
      wrap.appendChild(dt); wrap.appendChild(dd);
      list.appendChild(wrap);
    });

    var note = result.verified ? t("done") : ((result.verification && result.verification.detail === "cloudflare_1101") ? (lang === "fa" ? "خطای Cloudflare 1101: Worker ساخته شده اما لبهٔ شبکه ممکن است چند دقیقه بعد آماده شود؛ کمی بعد آدرس ورود را باز کن." : "Cloudflare 1101: Worker is deployed but the edge may need a few minutes; open the login URL shortly.") : t("verifyPending"));
    $("resultNote").textContent = note;
    $("resultNote").className = result.verified ? "hint" : "hint warn";
  }

  /* ------------------------------------------------------------------- i18n */

  function applyLang() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
    document.querySelectorAll("[data-lang]").forEach(function (button) {
      button.classList.toggle("on", button.getAttribute("data-lang") === lang);
    });
    document.querySelectorAll("[data-i18n]").forEach(function (node) {
      var value = t(node.getAttribute("data-i18n"));
      if (value) node.textContent = value;
    });
    if (Object.keys(state.steps).length) { renderSteps(); updateProgress(); }
    if (state.result) renderResult(state.result);
    var ttt = $("tokenTrustTitle"); if (ttt) ttt.textContent = t("tokenTrustTitle");
    var hbt = $("healthBannerTitle"); if (hbt) hbt.textContent = t("healthBannerTitle");
    var hbl = $("healthBannerLink"); if (hbl) hbl.textContent = t("healthBannerLink");
    if (state.lastStatusPayload) updateHealthBanner(state.lastStatusPayload);
  }

  /* ------------------------------------------------------------------- bind */

  document.querySelectorAll("[data-lang]").forEach(function (button) {
    button.addEventListener("click", function () {
      var next = button.getAttribute("data-lang");
      if (!I18N[next] || next === lang) return;
      lang = next;
      try { localStorage.setItem("nova-install-lang", lang); } catch (e) {}
      applyLang();
    });
  });

  $("tokenEye").addEventListener("click", function () {
    var input = $("token");
    input.type = input.type === "password" ? "text" : "password";
  });

  $("installBtn").addEventListener("click", function () { begin(null); });

  $("resumeBtn").addEventListener("click", function () { begin($("accountSelect").value); });

  $("retryBtn").addEventListener("click", function () {
    $("errorCard").hidden = true;
    $("progressCard").hidden = true;
    $("formCard").hidden = false;
    document.documentElement.setAttribute("data-state", "idle");
  });

  $("againBtn").addEventListener("click", function () { location.reload(); });

  function buildResultText(result) {
    if (!result) return "";
    var labels = t("details") || {};
    var lines = [];
    lines.push("Nova Worker install");
    if (result.loginUrl) lines.push((t("loginLabel") || "Login URL") + ": " + result.loginUrl);
    if (result.adminUrl) lines.push((t("adminBtn") || "Admin") + ": " + result.adminUrl);
    if (result.password) lines.push((t("passLabel") || "Password") + ": " + result.password);
    if (result.worker) lines.push((labels.worker || "Worker") + ": " + result.worker);
    if (result.account) lines.push((labels.account || "Account") + ": " + result.account);
    if (result.version) lines.push((labels.version || "Version") + ": " + result.version);
    if (result.kv) lines.push((labels.kv || "KV") + ": " + result.kv);
    if (state.proxyVersion) lines.push((t("versionLabel") || "Proxy") + ": " + state.proxyVersion);
    if (state.traceId) lines.push((t("traceLabel") || "Trace") + ": " + state.traceId);
    return lines.join("\n");
  }

  if ($("copyErrorBtn")) $("copyErrorBtn").addEventListener("click", function () {
    var last = state.lastError || {};
    copy(buildErrorDiagnostics(last.error || {}, last.stepId || ""));
  });
  if ($("copyLogBtn")) $("copyLogBtn").addEventListener("click", function () {
    var text = getLogText() || "(no log)";
    copy(text);
  });
  if ($("copyReportBtn")) $("copyReportBtn").addEventListener("click", function () {
    var last = state.lastError || {};
    var err = last.error || {};
    var report = {
      schema: "nova-install-error-report/v1",
      time: new Date().toISOString(),
      proxyVersion: state.proxyVersion || "",
      traceId: err.traceId || state.traceId || "",
      step: err.step || last.stepId || "",
      reason: err.reason || "",
      status: err.status || 0,
      message: String(err.message || ""),
      hint: String(err.hint || ""),
      codes: Array.isArray(err.codes) ? err.codes.slice(0, 20) : [],
      workerName: state.workerName || "",
      panelAction: (state.lastPreflight && state.lastPreflight.panelDecision && state.lastPreflight.panelDecision.action) || "",
      has1101: Boolean(state.lastPreflight && state.lastPreflight.panelDecision && state.lastPreflight.panelDecision.has1101),
      userAgent: navigator.userAgent || ""
    };
    copy(JSON.stringify(report, null, 2));
    toast(t("copiedReport") || "Copied");
  });
  if ($("copyResultBtn")) $("copyResultBtn").addEventListener("click", function () {
    copy(buildResultText(state.result));
  });
  if ($("shareResultBtn")) $("shareResultBtn").addEventListener("click", function () {
    var text = buildResultText(state.result);
    if (navigator.share) {
      navigator.share({ title: "Nova Worker", text: text, url: state.result && state.result.loginUrl ? state.result.loginUrl : undefined }).catch(function () {});
    } else {
      copy(text);
      toast(t("noShare") || text ? t("copied") : "");
    }
  });

  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-copy]");
    if (!button) return;
    var node = $(button.getAttribute("data-copy"));
    if (node) copy(node.value !== undefined ? node.value : node.textContent);
  });

  /* ------------------------------------------------------------------- init */

  var hbd = $("healthBannerDismiss");
  if (hbd) hbd.addEventListener("click", function () { try { sessionStorage.setItem('nova-health-banner-dismissed','1'); } catch(e) {} var b=$("healthBanner"); if(b) b.hidden=true; });
  $("token").addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); begin(null); }
  });

  applyLang();
  refreshServiceStatus();
})();
