# NovaInstall Stats Core (GitHub, in-repo)

این هسته برای ثبت «تعداد/رویداد نصب‌های موفق» بدون وابستگی به سرویس خارجی طراحی شده و به‌صورت پیش‌فرض داخل همین مخزن GitHub نگه داشته می‌شود.

## اجزا

- `stats.json` — منبع حقیقت شمارنده و متادیتای عمومی (بدون ذخیره توکن/رمز/آدرس پنل/شناسه اکانت).
- `.github/workflows/record-install-stats.yml` — دریافت رویداد `repository_dispatch` با نوع `nova_install_success` و به‌روزرسانی سریالی `stats.json` (با dedupe بر اساس `event_id`).
- `stats.html` — صفحه نمایش عمومی آمار (خواندن `stats.json` از GitHub Pages).
- ارسال رویداد از نصب‌کننده‌ها (اختیاری، فقط در صورت تنظیم توکن):
  - `proxy/worker.js` (نصب وب) پس از تأیید موفق نصب.
  - `bot/` (ربات تلگرام) پس از دیپلوی موفق.
  - `desktop/nova_wizard.py` (ویزارد دسکتاپ) پس از دیپلوی موفق.

## قرارداد رویداد

- Event type: `nova_install_success`
- `client_payload`:
  - `event_id` (string, یکتا برای جلوگیری از شمارش تکراری)
  - `version` (اختیاری)
  - `build` (اختیاری)
  - `source` (اختیاری؛ مثلا `telegram-bot`, `desktop-wizard`)

> فقط پس از موفقیت واقعی نصب/دیپلوی باید رویداد ارسال شود.

## پیکربندی (نصب‌کننده‌ها)

در محیط/Secrets مربوط به هر نصب‌کننده:

- `NOVA_GITHUB_STATS_TOKEN` (الزامی برای ارسال): Fine-grained PAT با دسترسی **Contents: Read and write** روی ریپوی آمار.
- `NOVA_GITHUB_STATS_REPO` (اختیاری): ریپوی مقصد به شکل `owner/repo`. پیش‌فرض: `IRNova/NovaInstall`.

نکات امنیتی:
- توکن آماری فقط در Secret سمت سرویس/محیط اجرا نگه داشته شود (نه در Pages، نه در کد کلاینت، نه در لاگ).
- فقط شمارش و متادیتای غیرحساس (مانند نسخه/بیلد/منبع کانال) ارسال/ذخیره شود.

## پیکربندی (GitHub Actions)

- Workflow `record-install-stats.yml` برای commit به `stats.json` از `GITHUB_TOKEN` با مجوز `contents: write` استفاده می‌کند.
- همزمانی با `concurrency.group: nova-install-stats` کنترل می‌شود تا رقابت commit و شمارش تکراری کاهش یابد.

## گزینه جایگزین (Cloudflare Worker Collector)

در صورت نیاز می‌توان یک Worker جمع‌آوری‌کننده سبک (داخل همین ریپو) اضافه کرد که رویدادها را دریافت و به GitHub Dispatch منتقل کند؛ اما هسته پیش‌فرض و اولویت این پروژه، **GitHub in-repo** است.
