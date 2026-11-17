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
