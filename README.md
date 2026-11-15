# NovaInstall

نصب آسان [NovaWorker](https://github.com/IRNova/NovaWorker) روی Cloudflare — **وب** و **دسکتاپ**.

<p align="center">
  <img src="assets/logo-mark.svg" width="88" alt="Nova Worker" />
</p>

## نصب وب (همه دستگاه‌ها)

**https://irnova.github.io/NovaInstall/**

- توکن API با دسترسی از پیش‌آماده
- Worker + KV با نام تصادفی
- لینک ورود + رمز
- ثبت در [Nova Control](https://nova-control.altramax083.workers.dev/)

## نصب دسکتاپ (OAuth، بدون توکن)

پوشه [`desktop/`](./desktop/) — همان **Nova Wizard** ادغام‌شده.

- ویندوز: [دانلود NovaWizard.exe](https://github.com/IRNova/Nova-Wizard/releases/download/V1.0.0/NovaWizard.exe)
- توسعه: `python3 desktop/nova_wizard.py`

## معماری

```
NovaInstall/
├── index.html          # لودر GitHub Pages
├── proxy/              # پروکسی نصب (Cloudflare Worker)
├── desktop/            # OAuth Wizard (ویندوز / Python)
├── scripts/            # ابزار نصب
└── assets/
```

## Nova Control

پنل آمار نصب و وضعیت پنل‌ها:

https://nova-control.altramax083.workers.dev/

## ریپوهای مرتبط

- Worker: https://github.com/IRNova/NovaWorker
- Wizard (قدیمی، ادغام در `desktop/`): https://github.com/IRNova/Nova-Wizard

## لایسنس

MIT
