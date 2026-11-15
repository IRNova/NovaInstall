# NovaInstall

نصب کامل و بی‌نقص **[NovaWorker](https://github.com/IRNova/NovaWorker)** روی Cloudflare.

<p align="center">
  <img src="assets/logo-mark.svg" width="88" alt="Nova Worker" />
</p>

این ریپو **فقط** برای نصب سورس رسمی NovaWorker است:

`https://github.com/IRNova/NovaWorker` → `_worker.js`

## دو روش نصب

| روش | دستگاه | احراز هویت | لینک |
|------|--------|------------|------|
| **وب** | ویندوز / لینوکس / موبایل | توکن API | https://irnova.github.io/NovaInstall/ |
| **دسکتاپ** | ویندوز (EXE) / Python | OAuth کلودفلر | [`desktop/`](./desktop/) |

هر دو مسیر:

1. دانلود `_worker.js` از **IRNova/NovaWorker**
2. ساخت KV + آپلود Worker با نام تصادفی
3. نوشتن `install.json` (رمز ادمین)
4. فعال‌سازی `workers.dev` و دادن لینک ورود
5. ثبت در [Nova Control](https://nova-control.altramax083.workers.dev/)

## نصب وب (پیشنهادی)

**https://irnova.github.io/NovaInstall/**

## نصب دسکتاپ

```bash
cd desktop
python3 nova_wizard.py
```

EXE موقت: [NovaWizard.exe](https://github.com/IRNova/Nova-Wizard/releases/download/V1.0.0/NovaWizard.exe)

## ساختار

```
NovaInstall/
├── index.html    # لودر GitHub Pages
├── proxy/        # پروکسی نصب وب
├── desktop/      # نصب OAuth (سابق Nova Wizard → الان NovaWorker)
├── scripts/
└── assets/
```

## لایسنس

MIT — خود NovaWorker تابع لایسنس ریپوی خودش است.
