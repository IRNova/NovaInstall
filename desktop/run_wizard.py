#!/usr/bin/env python3
"""NovaInstall Desktop — entry point.

Uses local nova_wizard.py if it is the full source. Otherwise downloads from
the repo / legacy Wizard.
"""
from __future__ import annotations
import runpy, sys, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOCAL = HERE / "nova_wizard.py"
FULL = HERE / "nova_wizard_full.py"
URLS = [
    "https://raw.githubusercontent.com/IRNova/NovaInstall/main/desktop/nova_wizard_full.py",
    "https://raw.githubusercontent.com/IRNova/Nova-Wizard/main/nova_wizard.py",
]

def main() -> None:
    target = None
    if LOCAL.exists() and LOCAL.stat().st_size > 20000:
        target = LOCAL
    elif FULL.exists() and FULL.stat().st_size > 20000:
        target = FULL
    else:
        last = None
        for url in URLS:
            try:
                print("Downloading", url)
                data = urllib.request.urlopen(url, timeout=90).read()
                if len(data) < 10000:
                    raise RuntimeError("too small")
                FULL.write_bytes(data)
                target = FULL
                break
            except Exception as e:
                last = e
                print(" ", e)
        if target is None:
            raise SystemExit(f"wizard source missing: {last}")
    sys.argv[0] = str(target)
    runpy.run_path(str(target), run_name="__main__")

if __name__ == "__main__":
    main()
