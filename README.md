# NovaInstall

یک سیستم یکپارچه برای نصب و دیپلوی **NovaWorker** روی Cloudflare (بدون تغییر در ریپوی `IRNova/NovaWorker`).

این مخزن شامل چند روش نصب و ابزارهای جانبی است که همگی به‌سمت سورس رسمی [`IRNova/NovaWorker`](https://github.com/IRNova/NovaWorker) تنظیم شده‌اند و آمار نصب موفق (اختیاری) را می‌توان در هسته آماری داخل همین مخزن GitHub ذخیره کرد.

## معماری نصب وب (GitHub Pages + Proxy پردازش)

- **UI نصب (GitHub Pages):** `index.html` + `assets/*` + `manifest.webmanifest` به‌صورت کامل روی GitHub Pages میزبانی می‌شوند.
- **پردازش نصب (Cloudflare Worker):** `proxy/worker.js` فقط endpointهای پردازشی را ارائه می‌دهد (`/health`, `/preflight`, `/jobs`, `/install`, `/api/*`, `/probe`) و همچنین داشبورد آماری تفکیکی روی همان Worker در `/status` (و `/status.json`).
- **اتصال UI به پردازش:** فقط با **یک خط** در [`assets/proxy-endpoint.js`](assets/proxy-endpoint.js):
  - `window.NOVA_PROXY_ENDPOINT = "https://<your-proxy>.workers.dev";`
- صفحهٔ نصب یک redirect/loader به Worker نیست؛ همه چیز از آدرس GitHub Pages بارگذاری می‌شود و فقط درخواست‌های پردازش به پروکسی ارسال می‌گردند.

## اجزای اصلی

| مسیر | نقش | توضیح |
|---|---|---|
| `index.html`, `assets/`, `manifest.webmanifest`, `sw.js` | UI نصب وب (GitHub Pages) | رابط کاربری کامل نصب روی GitHub. |
| `proxy/` | سرویس پردازش نصب (Cloudflare Worker) | پیش‌بررسی، Job پایدار، نصب/آپلود/پیکربندی، پراکسی API محدود Cloudflare، آمار تفکیکی `/status`. |
| `scripts/install.mjs` + `.github/workflows/nova-install.yml` | نصب CLI / GitHub Actions | نصب با توکن Cloudflare در Runner یا به‌صورت محلی. |
| `desktop/` | نصب دسکتاپ (OAuth Wizard) | ویزارد محلی Python/OAuth برای دیپلوی NovaWorker. |
| `bot/` | ربات تلگرام نصب | دیپلوی NovaWorker به حساب Cloudflare کاربر از طریق ربات (Cloudflare Worker + D1). |
| `stats.json` + `stats.html` + `.github/workflows/record-install-stats.yml` | هسته آمار نصب موفق (داخل GitHub) | ثبت شمارنده نصب‌های موفق بدون وابستگی به سرویس خارجی. |

## راه‌اندازی نصب وب

1. **دیپلوی سرویس پردازش (`proxy/`)** روی Cloudflare Workers.
   - در GitHub Actions: Secrets `CF_API_TOKEN` (و اختیاری `CF_ACCOUNT_ID`) را تنظیم و Workflow **Deploy Installer Proxy** را اجرا کنید.
   - یا به‌صورت دستی: `cd proxy && npx wrangler@4 deploy`
   - جزئیات: [`proxy/README.md`](proxy/README.md)
2. **تنظیم اتصال UI (یک خط):** در [`assets/proxy-endpoint.js`](assets/proxy-endpoint.js) آدرس Worker پردازش را قرار دهید.
3. **فعال‌سازی GitHub Pages** برای همین مخزن تا `index.html` به‌عنوان صفحهٔ اصلی سرو شود.
4. صفحه نصب: **https://irnova.github.io/NovaInstall/**
5. داشبورد آمار (در صورت فعال‌سازی): **https://irnova.github.io/NovaInstall/stats.html**

> نسخه‌های جدید پروکسی از Job پایدار (Durable Object + SQLite) استفاده می‌کنند؛ در صورت قطعی موقت مرورگر، نصب سمت سرور ادامه پیدا می‌کند و UI می‌تواند وضعیت را دوباره دریافت کند. آمار تجمیعی/تفکیکی نصب و خطاها (از جمله 1101) روی همان Worker در مسیر `/status` قابل مشاهده است.

## هسته آمار نصب موفق (GitHub in-repo)

جزئیات کامل در [`STATS-CORE.md`](STATS-CORE.md).

خلاصه:
- داده‌ها در `stats.json` نگه‌داری می‌شوند.
- Workflow `record-install-stats.yml` رویداد `repository_dispatch` (`nova_install_success`) را دریافت و شمارنده را به‌صورت سریالی/با dedupe (`event_id`) به‌روزرسانی می‌کند.
- ارسال رویداد از نصب‌کننده‌ها **اختیاری** است و فقط در صورت تنظیم توکن آمار انجام می‌شود.

### فعال‌سازی ارسال آمار (پروکسی وب / بات / ویزارد دسکتاپ)

- `NOVA_GITHUB_STATS_TOKEN` (Secret): Fine-grained PAT با دسترسی **Contents: Read and write** روی ریپوی آمار
- `NOVA_GITHUB_STATS_REPO` (اختیاری): مقدار `owner/repo` (پیش‌فرض: `IRNova/NovaInstall`)

هیچ توکن/رمز عبور/آدرس پنل/شناسه حساب Cloudflare در آمار ذخیره نمی‌شود.

## نصب از طریق GitHub Actions (CLI Installer)

Workflow: `.github/workflows/nova-install.yml`  
اسکریپت: `scripts/install.mjs`

می‌توانید از `workflow_dispatch` استفاده کنید و ورودی‌های لازم (توکن Cloudflare، نام Worker و ...) را بدهید. خروجی‌ها در artifact ذخیره می‌شوند.

## نصب دسکتاپ (OAuth Wizard)

پوشه: [`desktop/`](desktop/)

- سورس دیپلوی: `IRNova/NovaWorker` (`_worker.js`)
- اجرای محلی: `python3 desktop/nova_wizard.py` (طبق پیش‌نیازهای همان پوشه)
- ارسال آمار اختیاری با `NOVA_GITHUB_STATS_TOKEN` / `NOVA_GITHUB_STATS_REPO`

## ربات تلگرام نصب

پوشه: [`bot/`](bot/)  
راهنمای پیکربندی و دیپلوی: [`bot/README.md`](bot/README.md)

## اعتبارسنجی و شفافیت

- Workflow **Validate Installer Proxy and UI** بررسی سینتکس و ساختار (UI میزبان GitHub + پروکسی پردازشی) را انجام می‌دهد: `.github/workflows/validate-proxy.yml`
- اسکریپت اعتبارسنجی: `scripts/validate-installer-ui.mjs`
- سند شفافیت/بازتولیدپذیری بررسی‌ها: [`VERIFY.md`](VERIFY.md)

## ساختار مخزن

```text
NovaInstall-main/
├── index.html
├── assets/                     # UI نصب، CSS/JS، آیکن‌ها، پیکربندی اتصال پروکسی
├── manifest.webmanifest
├── sw.js
├── stats.html
├── stats.json
├── STATS-CORE.md
├── VERIFY.md
├── proxy/                      # سرویس پردازش Cloudflare Worker
├── scripts/
├── desktop/
├── bot/
└── .github/workflows/
```

## نکات مهم

- هدف نصب/دیپلوی همیشه `https://github.com/IRNova/NovaWorker` است؛ این مخزن نباید تغییری در `NovaWorker` ایجاد کند.
- هسته آمار نصب درون همین مخزن GitHub است (بدون سرویس خارجی قدیمی).
- اسکریپت‌ها و پروکسی باید با سورس NovaWorker سازگار بمانند (`_worker.js`, Worker module format).
- آدرس سرویس پردازش فقط در `assets/proxy-endpoint.js` پیکربندی می‌شود؛ UI اصلی از GitHub Pages بارگذاری می‌گردد.

## لایسنس

MIT (مگر در فایل/پوشه‌ای لایسنس جداگانه ذکر شده باشد)
