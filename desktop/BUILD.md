# ساخت نسخهٔ دسکتاپ NovaInstall

منبع این پوشه از **Nova Wizard** به NovaInstall منتقل شده است.

## پیش‌نیاز

- Python 3.10+
- (اختیاری برای EXE) PyInstaller

## اجرای توسعه

```bash
cd desktop
python3 nova_wizard.py
```

اگر `static/index.html` کنار اسکریپت باشد همان UI لود می‌شود؛ وگرنه نسخهٔ embed داخل `nova_wizard.py`.

## همگام‌سازی UI embed

```bash
python3 scripts/embed_ui.py
python3 scripts/embed_ui.py --check
```

## EXE ویندوز

```bash
pip install pyinstaller
pyinstaller --onefile --name NovaInstall --add-data "static;static" nova_wizard.py
```

خروجی را در GitHub Releases ریپوی **NovaInstall** منتشر کنید.

دانلود موقت (Release قدیمی Wizard):

https://github.com/IRNova/Nova-Wizard/releases/download/V1.0.0/NovaWizard.exe
