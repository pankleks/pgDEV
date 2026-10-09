Linux launcher icons derived from the root `pgDEV.png`, at standard hicolor
sizes: 16, 24, 32, 48, 64, 128, 256 and 512 pixels. Keep the root image as
the source of truth; regenerate these PNGs if the application icon changes.

The Linux package installs these under the `pgdev` icon name. Its desktop
file is `pgdev.desktop`, matching Electron's `desktopName` and the launcher
entry's `StartupWMClass` so GNOME can associate running windows with the icon.

`icon.ico` packs the 16–256px PNGs for Windows. `win.icon` points at it so
electron-builder skips its PNG→ICO conversion (which crashes with
`0xC0000005` on CI); regenerate it from these PNGs if the icon changes.
