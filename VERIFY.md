# Verify NovaInstall

این سند برای بررسی شفاف و قابل‌بازتولید اجزای عمومی این مخزن است (بدون نیاز به Secret یا اعتبارنامه).

## چه چیزهایی بررسی می‌شود

- **UI نصب وب (GitHub Pages):** صفحهٔ اصلی (`index.html`) و فایل‌های `assets/*`، `manifest.webmanifest` به‌صورت محلی در همین مخزن میزبانی می‌شوند و نباید به‌عنوان loader/redirect محتوای UI را از Worker بارگذاری کنند.
- **سرویس پردازش (`proxy/worker.js`):** Worker فقط نقش پردازشی دارد (بدون میزبانی UI نصب) و endpointهای لازم نصب را ارائه می‌دهد.
- **اسکریپت‌های نصب:** سینتکس و ساختار فایل‌های کلیدی قابل بررسی است.

هدف دیپلوی همچنان `https://github.com/IRNova/NovaWorker` است و این مخزن تغییری در سورس NovaWorker ایجاد نمی‌کند.

## بررسی خودکار (CI)

Workflow اعتبارسنجی: [`.github/workflows/validate-proxy.yml`](.github/workflows/validate-proxy.yml) (و/یا `verify.yml` در صورت وجود)

این بررسی‌ها به‌صورت عمومی انجام می‌شوند:
- `node --check proxy/worker.js`
- `node --check scripts/install.mjs`
- `node scripts/validate-installer-ui.mjs`
- `npx wrangler@4 deploy --dry-run` (در پوشه `proxy/`)

## بازتولید محلی

پیش‌نیاز: Node.js 22+

```bash
node --check proxy/worker.js
node --check scripts/install.mjs
node scripts/validate-installer-ui.mjs
cd proxy && npx --yes wrangler@4 deploy --dry-run --outdir /tmp/nova-install-dry-run
```

## بررسی معماری UI ↔ پردازش

- صفحهٔ نصب باید از GitHub Pages بارگذاری شود (`index.html` واقعی، نه انتقال‌دهنده به Worker).
- آدرس سرویس پردازش فقط در **یک نقطهٔ پیکربندی** تنظیم می‌شود: [`assets/proxy-endpoint.js`](assets/proxy-endpoint.js)
- فایل‌های UI میزبان GitHub نباید شامل آدرس سخت‌کدشده Worker نصب باشند.

می‌توانید با جستجو بررسی کنید:

```bash
# نمونه: نباید نشانی Worker قدیمی/سخت‌کدشده در UI میزبانی‌شده باشد
grep -R "workers.dev" index.html assets manifest.webmanifest sw.js || true
```

(در حالت پیکربندی‌شده توسط کاربر، آدرس پروکسی فقط در `assets/proxy-endpoint.js` قرار می‌گیرد.)

## محدودیت‌ها

- تأیید صحت نهایی یک Worker دیپلوی‌شده روی حساب Cloudflare شما نیازمند بررسی همان دیپلوی/اکانت است.
- خطاهای runtime پس از دیپلوی (مانند برخی موارد 1101) ممکن است خارج از بررسی‌های استاتیک/ dry-run باشند.
