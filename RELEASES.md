# Release: v1.1.0 — 2026-06-24

## ✨ New Features

### `--zyte-spm-profile` auto-detection from `--device`

When `--zyte` and `--device` are used together, the SPM profile is now **automatically inferred**:

| `--device` | SPM Profile |
|------------|-------------|
| (none)     | `desktop`   |
| iPhone 15  | `mobile`    |
| Galaxy S9  | `mobile`    |
| iPad Pro   | `mobile`    |
| Desktop    | `desktop`   |

**Before** (confusing):
```bash
pi-browser capture URL --device="iPhone 15" --zyte --zyte-profile=mobile
```

**After** (auto-detected):
```bash
pi-browser capture URL --device="iPhone 15" --zyte
# SPM profile automatically → mobile
```

Explicit override still works:
```bash
pi-browser capture URL --device="iPhone 15" --zyte --zyte-spm-profile=desktop
```

### CLI help prettified

- ANSI colors in terminal (green commands, cyan flags, yellow `--zyte`)
- Colors degrade gracefully when piped
- New `ZYTE PROXY` section in main help listing supported commands

## 🔄 Changed

- `--zyte-profile` renamed to `--zyte-spm-profile` (clearer semantics)
- `--zyte-profile` still works as legacy alias (backward compatible)
- `--zyte-spm-profile` takes precedence when both are present

## ✅ Verified

Full field test against `tvcclvalves-preview.fly.dev` — **28/28 passed**:

| Command | Mode | Result |
|---------|------|--------|
| capture | viewport | 1440×900, 599 KB |
| capture | full-page | 1440×3347, 1.5 MB |
| capture | iPhone 15 | 1179×1977, DPR=3, touch=1 |
| capture | .camera_wrap | element crop 1440×576 |
| netlog | all | 40 responses |
| netlog | --min-status=400 | filtered 4xx/5xx |
| netlog | --device | mobile UA |
| slider | Camera | 2 slides |
| slider | Owl | 5 slides |
| captcha | contact page | 200×60 GD-JPEG, iframe intercept |
| zyte | fail-closed | all 4 scripts ✓ |

## 📦 Files Changed

```
zyte-proxy.js        +inferSpmProfile() + --zyte-spm-profile + legacy compat
browser-capture.js   pass device to launchZyte
browser-slider.js    pass device to launchZyte
browser-netlog.js    pass device to launchZyte
browser-captcha.js   help update
bin/pi-browser       ANSI colored help + ZYTE section
SKILL.md             docs sync
```

## 🐛 Known Issues

None.

## 📝 Migration

No breaking changes. `--zyte-profile` continues to work as an alias.
