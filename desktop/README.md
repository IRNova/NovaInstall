# NovaInstall Desktop (سابق: Nova Wizard)

نصب **NovaWorker** روی Cloudflare با **OAuth** — بدون چسباندن توکن API.
روی ویندوز (EXE) و لینوکس/macOS با Python اجرا می‌شود.

## ارتباط با نصب وب

| کانال | آدرس | روش احراز |
|--------|------|-----------|
| وب | https://irnova.github.io/NovaInstall/ | توکن API |
| دسکتاپ (این پوشه) | اجرای محلی | OAuth کلودفلر |

هر دو پس از نصب موفق، به **Nova Control** گزارش می‌دهند.

## اجرا سریع (توسعه)

```bash
cd desktop
python3 nova_wizard.py
```

مرورگر روی `http://127.0.0.1:...` باز می‌شود.

## ساخت EXE (ویندوز)

طبق `BUILD.md` و PyInstaller.

## دانلود باینری

https://github.com/IRNova/Nova-Wizard/releases/download/V1.0.0/NovaWizard.exe

پس از انتقال کامل Releaseها، لینک به `IRNova/NovaInstall` به‌روز می‌شود.

## فایل‌ها

- `nova_wizard.py` — سرور محلی + OAuth + دیپلوی
- `static/` — UI
- `scripts/embed_ui.py` — همگام‌سازی UI embedشده
- `BUILD.md` — راهنمای بیلد

## ریپوی قدیمی

https://github.com/IRNova/Nova-Wizard پس از انتقال پایدار می‌تواند آرشیو شود.
