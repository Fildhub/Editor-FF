"""Put a "PDF Translator" icon on the desktop (Windows, macOS, Linux).

    pdf-translate-shortcut          (or: python -m pdf_translator.shortcut)

Double-clicking the icon starts the web interface and opens the browser.
"""

from __future__ import annotations

import os
import plistlib
import shutil
import stat
import subprocess
import sys
from pathlib import Path

APP_NAME = "PDF Translator"
STATIC = Path(__file__).parent / "static"
# The folder that contains the pdf_translator package: starting there makes
# `-m pdf_translator.web` work even if `pip install -e .` was never run.
PROJECT = Path(__file__).resolve().parent.parent


def _desktop() -> Path:
    if sys.platform == "win32":
        try:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"],
                capture_output=True, text=True, check=True,
            ).stdout.strip()
            if out:
                return Path(out)  # also right when the desktop is in OneDrive
        except Exception:
            pass
    else:
        try:
            out = subprocess.run(["xdg-user-dir", "DESKTOP"], capture_output=True, text=True).stdout.strip()
            if out and Path(out).is_dir():
                return Path(out)
        except Exception:
            pass
    return Path.home() / "Desktop"


def _windows(desktop: Path) -> Path:
    exe = Path(sys.executable)
    pythonw = exe.with_name("pythonw.exe")  # no console window
    target = pythonw if pythonw.exists() else exe
    link = desktop / f"{APP_NAME}.lnk"
    ps = (
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:PT_LINK);"
        "$s.TargetPath = $env:PT_TARGET;"
        "$s.Arguments = '-m pdf_translator.web';"
        "$s.WorkingDirectory = $env:PT_DIR;"
        "$s.IconLocation = $env:PT_ICON;"
        "$s.Description = 'Translate PDF files and keep their layout';"
        "$s.Save()"
    )
    env = dict(os.environ, PT_LINK=str(link), PT_TARGET=str(target), PT_ICON=str(STATIC / "icon.ico"), PT_DIR=str(PROJECT))
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], check=True, env=env)
    if not link.exists():
        raise RuntimeError(f"Windows did not create {link}")
    return link


def _macos(desktop: Path) -> Path:
    app = desktop / f"{APP_NAME}.app"
    if app.exists():
        shutil.rmtree(app)
    macos = app / "Contents" / "MacOS"
    res = app / "Contents" / "Resources"
    macos.mkdir(parents=True)
    res.mkdir(parents=True)
    shutil.copy(STATIC / "icon.icns", res / "icon.icns")
    launcher = macos / "launcher"
    launcher.write_text(f'#!/bin/sh\ncd "{PROJECT}"\nexec "{sys.executable}" -m pdf_translator.web\n')
    launcher.chmod(launcher.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    with open(app / "Contents" / "Info.plist", "wb") as f:
        plistlib.dump(
            {
                "CFBundleName": APP_NAME,
                "CFBundleDisplayName": APP_NAME,
                "CFBundleIdentifier": "com.fildhub.pdftranslator",
                "CFBundleExecutable": "launcher",
                "CFBundleIconFile": "icon.icns",
                "CFBundlePackageType": "APPL",
                "CFBundleVersion": "1.0",
                "LSUIElement": True,  # no Dock icon for the background server
            },
            f,
        )
    return app


def _linux(desktop: Path) -> Path:
    entry = (
        "[Desktop Entry]\n"
        "Type=Application\n"
        f"Name={APP_NAME}\n"
        "Comment=Translate PDF files and keep their layout\n"
        f"Path={PROJECT}\n"
        f'Exec="{sys.executable}" -m pdf_translator.web\n'
        f"Icon={STATIC / 'icon.png'}\n"
        "Terminal=false\n"
        "Categories=Office;Utility;\n"
    )
    paths = [desktop / "pdf-translator.desktop", Path.home() / ".local/share/applications/pdf-translator.desktop"]
    for p in paths:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(entry)
        p.chmod(p.stat().st_mode | stat.S_IXUSR)
    try:  # GNOME: allow launching without the "untrusted" prompt
        subprocess.run(["gio", "set", str(paths[0]), "metadata::trusted", "true"], capture_output=True)
    except Exception:
        pass
    return paths[0]


def main() -> int:
    desktop = _desktop()
    desktop.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        made = _windows(desktop)
    elif sys.platform == "darwin":
        made = _macos(desktop)
    else:
        made = _linux(desktop)
    print(f"Created: {made}")
    print("Double-click it to open PDF Translator in your browser.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
