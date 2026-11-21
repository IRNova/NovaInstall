# NovaInstall Processing Proxy

این Worker فقط نقش **سرویس پردازش** نصب وب را دارد (نه میزبانی UI).

- رابط کاربری نصب روی **GitHub Pages** است: `index.html` + `assets/*`
- مرورگر فقط برای پردازش (preflight / jobs / install / api / health / probe) به این Worker متصل می‌شود
- اتصال UI به پروکسی با **یک خط** در `assets/proxy-endpoint.js` انجام می‌شود:
  - `window.NOVA_PROXY_ENDPOINT = "https://<your-proxy>.workers.dev";`

## ویژگی‌های پردازشی اضافه‌شده

- Rate limiting محافظه‌کارانه (best-effort per-isolate) برای endpointهای حساس
- خطاهای دقیق‌تر با `reason` و `hint` در preflight/install/job
- آمار تجمیعی/تفکیکی و وضعیت سلامت روی همان Worker (`/status`, `/status.json`, `/health`)

## مسیرهای پردازشی

- `GET /health` — وضعیت سلامت/قابلیت‌ها، اجزا و زمان (همراه با محافظت best-effort rate limit)
- `GET /status` — داشبورد آماری تجمیعی و تفکیکی روی همان Worker (HTML)
- `GET /status.json` — همان آمار به‌صورت JSON
- `POST /preflight` — بررسی خواندنی توکن/اکانت/دسترسی‌ها
- `POST /jobs` — شروع نصب پایدار (Durable Object)
- `GET /jobs/:id` — دریافت وضعیت/رویدادها/نتیجه نصب
- `POST /install` — نصب استریم (سازگاری قدیمی)
- `ALL /api/*` — پراکسی امن به API محدود Cloudflare (برای نیازهای نصب)
- `GET /probe?url=...` — بررسی محدود آدرس‌های مجاز

## دیپلوی

```bash
cd proxy
npx wrangler@4 deploy
```

یا از Workflow **Deploy Installer Proxy** در GitHub Actions استفاده کنید.

### Secrets/Vars

- `CF_API_TOKEN` (Actions secret، برای دیپلوی)
- `CF_ACCOUNT_ID` (اختیاری)
- `ALLOWED_ORIGINS` (در `wrangler.toml`، پیش‌فرض `https://irnova.github.io`)

### Durable Objects

- `INSTALL_JOBS` (`InstallJob`) — اجرای/پیگیری نصب‌های پایدار (migration `v1`)
- `INSTALL_STATS` (`InstallStats`) — ذخیره تجمیعی آمار تفکیکی نصب/preflight برای `/status` (migration `v2`)

تنظیمات binding و migrationها در `wrangler.toml` موجود است؛ هنگام دیپلوی با Wrangler اعمال می‌شوند.

## نکات

- این Worker UI صفحهٔ نصب را سرو نمی‌کند؛ صفحه باید از GitHub Pages بارگذاری شود.
- سورس نصب هدف همچنان `IRNova/NovaWorker` است.
- آمار موفق اختیاری GitHub (`NOVA_GITHUB_STATS_TOKEN` / `NOVA_GITHUB_STATS_REPO`) در صورت پیکربندی روی محیط Worker قابل استفاده است.
