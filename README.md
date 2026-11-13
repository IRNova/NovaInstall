# NovaInstall

> نصب‌کنندهٔ خودکار **Nova Worker** روی Cloudflare با GitHub Actions.
> یک بار اجرا کن؛ Worker نصب می‌شود، فضای KV ساخته و به `KV` بایند می‌شود، رمز مدیریت و کلید رمزنگاری تنظیم می‌شود و در پایان **آدرس ورود + رمز** به تو داده می‌شود.

<p align="center">
  <img src="assets/logo-mark.svg" width="88" alt="Nova Worker" />
</p>

---

## چه چیزی ساخته می‌شود؟

| بخش | نتیجه |
| --- | --- |
| **سورس Worker** | به‌صورت پیش‌فرض **آخرین نسخهٔ `_worker.js`** از `IRNova/NovaWorker` دانلود می‌شود |
| **Worker** | همان سورس روی حساب کلودفلر آپلود و دیپلوی می‌شود |
| **KV** | فضای `nova-worker-kv` ساخته (یا اگر باشد بازاستفاده) می‌شود و با نام `KV` بایند می‌شود |
| **رمز مدیریت** | در `install.json` داخل KV ذخیره می‌شود (همراه با `KEY` رمزنگاری) |
| **آدرس عمومی** | مسیر `workers.dev` فعال می‌شود: `https://<worker>.<subdomain>.workers.dev` |
| **راستی‌آزمایی** | `/install/status`، `/version` و `/login` بررسی می‌شوند |
| **گزارش** | یک صفحهٔ HTML مستقل با QR، دکمهٔ کپی و جزئیات کامل |

هیچ تغییری در سورس Worker داده نمی‌شود؛ فقط آپلود و کانفیگ می‌شود.

---

## پیش‌نیازها

- حساب Cloudflare با دسترسی Workers
- یک توکن API با دسترسی‌های زیر

| Scope | Permission | چرا |
| --- | --- | --- |
| Account → Workers Scripts | **Edit** | آپلود و دیپلوی Worker، فعال‌سازی workers.dev |
| Account → Workers KV Storage | **Edit** | ساخت namespace و نوشتن `install.json` |
| Account → Account Settings | Read | خواندن نام حساب و ساب‌دامین workers.dev |

مسیر ساخت: **Cloudflare Dashboard → My Profile → API Tokens → Create Token → Custom token**.

مخزن را **خصوصی** نگه دار؛ خروجی نصب شامل رمز مدیریت است.

---

## نصب سریع (۵ دقیقه)

### ۱) فایل‌ها را کنار Worker بگذار

```
your-repo/
├─ NovaInstall/
│  ├─ scripts/install.mjs           ← منطق نصب
│  ├─ scripts/lib/                  ← کلاینت API کلودفلر، هویت، رندر
│  ├─ templates/result.html         ← صفحهٔ نتیجه (UI پنل)
│  └─ assets/                       ← لوگو، فونت وزیرمتن، QR
└─ .github/workflows/nova-install.yml
```

> دیگر لازم نیست `_worker.js` را کنار پوشه بگذاری: نصب‌کننده به‌صورت پیش‌فرض سورس را از
> `https://raw.githubusercontent.com/IRNova/NovaWorker/main/_worker.js` می‌گیرد؛ پس با هر
> اجرا، **آخرین نسخه** نصب می‌شود. اگر GitHub در دسترس نبود، به کپی محلی برمی‌گردد.

اگر می‌خواهی نسخهٔ خاصی را پین کنی، ورودی `worker_source` را روی مسیر فایل یا URL آن نسخه بگذار.

### ۲) توکن بساز

با دسترسی‌های جدول بالا. توکن را می‌توانی:

- مستقیم در فرم Run workflow وارد کنی، یا
- در **Settings → Secrets and variables → Actions** با نام `CF_API_TOKEN` ذخیره کنی (پیشنهادی).

### ۳) اجرا

**Actions → Nova Install → Run workflow**

حداقل ورودی لازم `cf_api_token` است. بقیه اختیاری‌اند:

| ورودی | پیش‌فرض | توضیح |
| --- | --- | --- |
| `cf_api_token` | — | توکن API (اگر خالی باشد `CF_API_TOKEN` از secrets خوانده می‌شود) |
| `cf_email` + `cf_api_key` | — | روش جایگزین: Global API Key |
| `account_id` | خودکار | اگر توکن به چند حساب دسترسی دارد، اجباری است |
| `worker_name` | `nova-worker` | نام Worker و پیشوند namespace |
| `admin_password` | خودکار | رمز پنل؛ خالی = ساخت رمز قوی ۲۰ نویسه‌ای |
| `panel_url` | `https://nova-panel.github.io` | آدرس پنل استاتیک |
| `custom_url` | — | اگر Worker را روی دامنهٔ شخصی/Route می‌گذاری |
| `worker_source` | آخرین نسخه از GitHub | مسیر فایل Worker یا URL آن (برای پین کردن نسخه) |
| `enable_workers_dev` | `true` | فعال‌سازی مسیر workers.dev |

> محدودیت GitHub: هر workflow حداکثر ۱۰ ورودی می‌پذیرد؛ به همین دلیل `workers_subdomain` و `compatibility_date` به‌صورت ورودی نیستند. ساب‌دامین به‌صورت خودکار انتخاب می‌شود و تاریخ سازگاری پیش‌فرض `2025-11-04` است (برای اجرای محلی با متغیر محیطی قابل تغییر است).

### ۴) خروجی را بردار

بعد از پایان:

1. **Step Summary** همین اجرا: آدرس ورود، رمز، جدول گام‌ها و جزئیات.
2. **Artifact** با نام `nova-install-result`:
   - `result.html` — صفحهٔ نتیجهٔ گرافیکی (فونت و QR داخلش embed است؛ آفلاین باز می‌شود)
   - `result.json` — گزارش ماشین‌خوان
   - `summary.md` — همان گزارش متنی

آدرس ورود به شکل زیر است:

```
https://<worker-name>.<account-subdomain>.workers.dev/login
https://<worker-name>.<account-subdomain>.workers.dev/admin
```

---

## نصب دوباره و به‌روزرسانی (idempotent)

هر بار اجرای workflow، **آخرین `_worker.js` را از مخزن رسمی دانلود می‌کند**؛ پس برای آپدیت Worker کافی است دوباره Run workflow بزنی. نسخهٔ نصب‌شده (`Version`)، `Build` و هش `SHA-256` سورس در گزارش ثبت می‌شود تا بدانی کدام نسخه روی کلودفلر است.

اگر می‌خواهی روی نسخهٔ خاصی قفل شوی، `worker_source` را به مسیر یا URL همان نسخه بده. برای اجرای محلی/آفلاین، `WORKER_PREFER_LOCAL=1` بگذار تا از کپی موجود در checkout استفاده شود.

نصب دوباره امن است:

اجرای دوبارهٔ workflow امن است:

- namespace موجود با همان عنوان بازاستفاده می‌شود،
- اگر رمز را خالی بگذاری، **رمز قبلی** از `install.json` خوانده و حفظ می‌شود،
- `KEY` هم اگر موجود باشد حفظ می‌شود،
- Worker با همان نام به‌روزرسانی می‌شود (نه تکراری).

اگر رمز یا `KEY` را عوض کنی، **UUID و همهٔ لینک‌های اتصال تغییر می‌کنند**؛ این هشدار در گزارش نمایش داده می‌شود.

همچنین هنگام آپلود، متغیرهای متنی (plain-text) قبلی Worker در صورت دسترسی به تنظیمات آن‌ها حفظ می‌شوند و secretها دست‌نخورده می‌مانند.

---

## معماری

```
GitHub Actions
   │
   ├─ scripts/install.mjs
   │     ├─ lib/cf.mjs              کلاینت Cloudflare API v4 (بدون وابستگی)
   │     ├─ lib/worker-source.mjs   دانلود آخرین _worker.js از GitHub + اعتبارسنجی (کپی محلی به‌عنوان جایگزین)
   │     ├─ lib/identity.mjs        MD5MD5، UUID مشتق‌شده، تولید رمز/کلید
   │     └─ lib/render.mjs          ساخت result.html / result.json / summary.md
   │
   └─ Cloudflare API
         ├─ GET  /user/tokens/verify
         ├─ GET  /accounts
         ├─ GET  /accounts/{id}/storage/kv/namespaces
         ├─ POST /accounts/{id}/storage/kv/namespaces
         ├─ PUT  /accounts/{id}/workers/scripts/{name}          (multipart + KV binding)
         ├─ PUT  /accounts/{id}/storage/kv/namespaces/{kv}/values/install.json
         ├─ PUT  /accounts/{id}/workers/scripts/{name}/subdomain
         └─ GET  https://<worker>.workers.dev/install/status
```

نکته‌های پیاده‌سازی:

- رمز و `KEY` **در secrets ورکر ذخیره نمی‌شوند**؛ مطابق طرح خود Worker در `install.json` داخل KV نوشته می‌شوند.
- `PANEL_URL` به‌صورت plain-text binding روی Worker تنظیم می‌شود.
- UUID با همان الگوریتم `MD5MD5(ADMIN + KEY)` ورکر محاسبه می‌شود تا لینک اشتراک و بررسی نسخه دقیق باشد.
- رمز، توکن و کلید هرگز در لاگ چاپ نمی‌شوند (`::add-mask::`).

---

## امنیت

- **مخزن خصوصی**: Summary و artifact شامل رمز مدیریت هستند. اگر مخزن عمومی باشد، هشدار در گزارش درج می‌شود.
- توکن را با حداقل دسترسی بساز و بعد از نصب **Revoke** کن.
- رمز پیشنهادی ۲۰ نویسه‌ای تصادفی است؛ آن را در مدیریت رمز ذخیره کن.
- `KEY` را عوض نکن مگر اینکه بخواهی همهٔ نشست‌ها و UUID عوض شوند.
- صفحهٔ result را جایی آپلود نکن.

---

## عیب‌یابی

| خطا | علت | راه‌حل |
| --- | --- | --- |
| `[10000] Authentication error` / HTTP 403 | توکن دسترسی ندارد | Scopeهای Workers Scripts:Edit و KV:Edit را اضافه کن |
| چند حساب پیدا شد | توکن به بیش از یک حساب دسترسی دارد | `account_id` را وارد کن |
| `no_kv` / `kv_write_failed` | KV ساخته نشد | سهمیهٔ KV یا مجوز توکن را بررسی کن |
| `HTTP 404` روی workers.dev subdomain | حساب ساب‌دامین ندارد | `workers_subdomain` بده یا یک‌بار از داشبورد فعال کن |
| `Worker did not answer` | انتشار لبه طول کشیده | چند دقیقه بعد دوباره اجرا کن؛ گزارش گام‌ها را ببین |
| دانلود سورس Worker ناموفق | اینترنت یا آدرس مخزن | `worker_source` را به مسیر/URL معتبر بده؛ نصب‌کننده به کپی محلی برمی‌گردد |
| رمز کار نمی‌کند | `ADMIN` در env ورکر ست شده | env `ADMIN` را حذف کن؛ اولویت با env است |

---

## توسعه و پیش‌نمایش

بدون کلودفلر می‌توانی UI را ببینی:

```bash
node NovaInstall/scripts/preview.mjs
# NovaInstall/preview/success/result.html
# NovaInstall/preview/failure/result.html
```

اجرای دستی نصب (خارج از Actions):

```bash
CF_API_TOKEN=... WORKER_NAME=nova-worker ADMIN_PASSWORD='...' \
  node NovaInstall/scripts/install.mjs
```

ساختار گزارش `result.json`:

```json
{
  "ok": true,
  "worker": { "name": "nova-worker", "version": "Beta-0.0.1" },
  "kv": { "id": "…", "title": "nova-worker-kv" },
  "urls": { "login": "…", "admin": "…", "sub": "…" },
  "credentials": { "password": "…", "userID": "…" },
  "steps": [{ "id": "auth", "status": "ok", "detail": "…" }]
}
```

---

## مجوز

کد این پوشه (NovaInstall) تحت **MIT** منتشر می‌شود. خود Worker تابع لایسنس پروژهٔ اصلی است (GNU GPL v2 — فایل `Worker/LICENSE`).
