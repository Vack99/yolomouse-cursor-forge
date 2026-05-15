# yolomouse-cursor-forge

A collaborative pixel-art workshop for designing custom animated cursors for [YoloMouse](https://dragonrisegames.com/yolomouse) (Steam edition). Aaron describes a concept; Claude paints each frame as a text grid; one PowerShell command compiles it into a working `.ani` cursor and installs it.

See `docs/specs/2026-05-14-cursor-forge-design.md` for the locked design.

## Quickstart

```powershell
.\forge.ps1 new RedSkull         # scaffold projects\RedSkull\ with 8 empty 64x64 grids
# (Claude fills in palette.txt + frames/*.grid.txt)
.\forge.ps1 build RedSkull       # compile -> projects\RedSkull\build\RedSkull.ani + previews
.\forge.ps1 preview RedSkull     # open preview.gif and preview_strip.png
.\forge.ps1 install RedSkull     # copy bundle into YoloMouse\Cursors\RedSkull\
.\forge.ps1 reload               # restart YoloLauncher to pick up the new cursor
```

## Commands

| Verb | Args | Effect |
|---|---|---|
| `new` | `<Name> [-Frames 8\|12\|24] [-Size 64]` | Scaffold from `projects\_template\`. Default 8 frames at 64x64. |
| `build` | `<Name>` | Compile grids -> `.ani` + bundle + previews in `build\`. |
| `preview` | `<Name>` | Open `build\preview.gif` and `build\preview_strip.png`. |
| `install` | `<Name>` | Copy `build\` contents into YoloMouse `Cursors\<Name>\`. |
| `uninstall` | `<Name>` | Remove `<Name>` from YoloMouse Cursors. |
| `reload` | (none) | Kill + relaunch `YoloLauncher.exe`. |
| `list` | (none) | Show all projects + build/install status. |

## Requirements

- Windows 10/11
- PowerShell 5.1 (built in)
- YoloMouse (Steam, from Dragonrise Games) installed at `C:\Program Files (x86)\Steam\steamapps\common\YoloMouse\`

No other dependencies. No Python, no installs.

## Tests

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Run-Tests.ps1
```
