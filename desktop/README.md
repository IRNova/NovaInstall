# NovaInstall Desktop

نصب **NovaWorker** روی Cloudflare با OAuth (بدون چسباندن توکن).

## سورس رسمی

- https://cdn.jsdelivr.net/gh/IRNova/NovaWorker@main/_worker.js
- https://raw.githubusercontent.com/IRNova/NovaWorker/main/_worker.js

## اجرا

```bash
python3 nova_wizard.py
```

## کارهایی که انجام می‌شود

1. ورود Cloudflare OAuth
2. دانلود `_worker.js` از **IRNova/NovaWorker**
3. KV + آپلود Worker + `install.json`
4. لینک `…workers.dev/login` + رمز
5. گزارش به Nova Control

هم‌تراز با نصب‌کنندهٔ وب همین ریپو.

## EXE

https://github.com/IRNova/Nova-Wizard/releases/download/V1.0.0/NovaWizard.exe
