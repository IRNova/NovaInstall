# NovaInstall

نصب و پشتیبانی **Nova** روی Cloudflare — وب، دسکتاپ، و بات تلگرام.

این ریپو **منبع واحد** برای سه کانال نصب است:

| پوشه / بخش | سابق | کاربرد |
|------------|------|--------|
| ریشه + `proxy/` + `index.html` | NovaInstall | نصب **وب** از GitHub Pages |
| `desktop/` | [Nova-Wizard](https://github.com/IRNova/Nova-Wizard) | نصب **دسکتاپ** با OAuth (Python / EXE) |
| `bot/` | [nova-install-bot](https://github.com/IRNova/nova-install-bot) | **بات تلگرام** نصب و پشتیبانی |

سورس Worker هدف: [`IRNova/NovaWorker`](https://github.com/IRNova/NovaWorker)

## نصب وب

**https://irnova.github.io/NovaInstall/**

## نصب وب — معماری جدید

نصب‌کنندهٔ وب از نسخهٔ 2.4.0 به بعد ابتدا یک بررسی فقط‌خواندنی انجام می‌دهد و سپس نصب را به‌صورت Job پایدار در SQLite-backed Durable Object اجرا می‌کند. قطع شدن مرورگر یا اینترنت کاربر نباید اجرای Job را متوقف کند؛ صفحه با شناسهٔ Job دوباره به وضعیت نصب متصل می‌شود.

### انتشار پروکسی

برای انتشار نسخهٔ جدید پروکسی:

1. در مخزن GitHub به **Settings → Secrets and variables → Actions** برو و `CF_API_TOKEN` را با دسترسی `Workers Scripts:Edit` برای حساب میزبان پروکسی تنظیم کن.
2. مقدار `CF_ACCOUNT_ID` را نیز در صورت نیاز تنظیم کن.
3. از **Actions → Deploy Installer Proxy → Run workflow** انتشار را اجرا کن.

Workflow از `proxy/wrangler.toml` استفاده می‌کند و Migration مربوط به `InstallJob` را همراه Deploy اعمال می‌کند. برای حساب‌های Workers Free از SQLite-backed Durable Object استفاده شده است؛ این backend در پلن Free پشتیبانی می‌شود. هر Job توکن Cloudflare کاربر را فقط تا پایان نصب به‌صورت موقت در فضای ذخیره‌سازی Durable Object نگه می‌دارد و پس از اتمام یا شکست حذف می‌کند. نتیجهٔ نصب و رمز تحویلی حداکثر ۲۴ ساعت برای اتصال مجدد باقی می‌ماند و سپس خودکار پاک می‌شود.

### آمار نصب‌های موفق (GitHub-only)

صفحهٔ عمومی آمار: **https://irnova.github.io/NovaInstall/stats.html**

- دادهٔ شمارنده فقط در فایل `stats.json` همین مخزن ذخیره می‌شود؛ Durable Object یا سرویس آماری جداگانه استفاده نمی‌شود.
- نصب‌کننده فقط پس از تأیید اجرای Worker و وجود آدرس ورود، آدرس مدیریت و رمز تولیدشده، رویداد موفقیت را به GitHub ارسال می‌کند.
- GitHub Actions رویدادها را به‌صورت سریالی پردازش می‌کند، شناسهٔ رویداد را برای جلوگیری از شمارش تکراری بررسی می‌کند و `stats.json` را به‌روزرسانی می‌کند.
- هیچ رمز، توکن Cloudflare، آدرس پنل یا شناسهٔ حسابی در فایل آمار ارسال یا ذخیره نمی‌شود.

**تنظیم یک‌بارهٔ دسترسی GitHub برای Worker:**

1. یک Fine-grained Personal Access Token فقط برای مخزن `IRNova/NovaInstall` بساز.
2. دسترسی Repository permissions → **Contents: Read and write** را فعال کن.
3. این توکن را به‌صورت Secret در تنظیمات Worker پروکسی با نام `NOVA_GITHUB_STATS_TOKEN` ثبت کن (از داشبورد Cloudflare یا دستور `wrangler secret put NOVA_GITHUB_STATS_TOKEN` در پوشهٔ `proxy`).
4. توکن را در کد، GitHub Pages یا چت قرار نده. این توکن فقط سمت Worker نگهداری می‌شود.

برای ثبت آمار، GitHub Actions از `GITHUB_TOKEN` داخلی با مجوز `contents: write` استفاده می‌کند. صفحهٔ آمار دادهٔ عمومی `stats.json` را مستقیماً از GitHub Pages می‌خواند.

### روند نصب

- `POST /preflight`: اعتبار توکن، حساب و دسترسی APIهای Workers و KV را بدون ساخت منبع بررسی می‌کند؛ دریافت و اعتبارسنجی سورس GitHub داخل Job پس‌زمینه و پیش از ساخت KV انجام می‌شود.
- `POST /jobs`: Job نصب را ایجاد می‌کند.
- `GET /jobs/{jobId}`: وضعیت و رویدادهای Job را برای اتصال مجدد صفحه برمی‌گرداند.
- `POST /install`: مسیر استریم قدیمی برای سازگاری باقی مانده است.

**محدودیت تشخیص خطای 1101:** هیچ API فقط‌خواندنی نمی‌تواند تضمین کند که Worker آینده در زمان اجرا خطای 1101 نمی‌دهد. نصب‌کننده بعد از Deploy، خود Worker را از لبهٔ Cloudflare چند بار بررسی می‌کند و در صورت مشاهدهٔ 1101 آن را صریح گزارش می‌دهد.

## نصب دسکتاپ

```bash
cd desktop && python3 nova_wizard.py
```

## بات تلگرام

کد کامل در `bot/` — دیپلوی با Wrangler روی حساب Cloudflare مربوط به بات.

## ساختار

```
NovaInstall/
├── index.html          # UI نصب وب (GitHub Pages)
├── proxy/              # پروکسی نصب وب
├── desktop/            # ویزارد OAuth (ادغام‌شده از Nova-Wizard)
├── bot/                # بات تلگرام (ادغام‌شده از nova-install-bot)
├── scripts/
└── assets/
```

## ادغام

ریپوهای `Nova-Wizard` و `nova-install-bot` می‌توانند آرشیو/حذف شوند؛ کپی کامل کد داخل همین ریپو نگه داشته شده است.

جزئیات: [MERGE-SOURCES.md](./MERGE-SOURCES.md)

## لایسنس

MIT (جزئیات هر زیرپوشه در صورت تفاوت ذکر شده)
