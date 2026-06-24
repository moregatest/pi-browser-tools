#!/bin/sh
# install.sh — make the browser-tools skill callable globally as `pi-browser`,
# so other pi skills can reference it without {baseDir}.
#
# Idempotent: installs npm deps (if missing) and symlinks pi-browser into a PATH
# bin dir (default ~/.local/bin, override with PI_BROWSER_BIN_DIR), mirroring the
# existing `ht` convention (repo stays the source of truth; ~/.local/bin holds a
# symlink).

set -eu

# --- repo root = this script's dir (resolve symlinks too, in case install.sh is
#     itself linked somewhere) ---
src=$0
while [ -h "$src" ]; do
	dir=$(cd -P "$(dirname "$src")" && pwd)
	src=$(readlink "$src")
	case $src in
		/*) ;;
		*) src=$dir/$src ;;
	esac
done
root=$(cd -P "$(dirname "$src")" && pwd)

bin_dir=${PI_BROWSER_BIN_DIR:-$HOME/.local/bin}
target="$root/bin/pi-browser"
link="$bin_dir/pi-browser"

echo "browser-tools global install"
echo "  repo:    $root"
echo "  bin dir: $bin_dir"
echo

# 1) dependencies (puppeteer + bundled Chromium)
if [ ! -d "$root/node_modules/puppeteer" ]; then
	echo "-> installing npm dependencies (downloads Chromium; may take a while)..."
	(cd "$root" && npm install)
else
	echo "-> dependencies already present (node_modules/puppeteer) -- skipping npm install"
fi

# 2) symlink the dispatcher onto PATH
mkdir -p "$bin_dir"
chmod +x "$target"
ln -sf "$target" "$link"
echo "-> linked $link -> $target"

# 3) PATH check (warn only; never fail the install)
case ":$PATH:" in
	*":$bin_dir:"*)
		echo "-> $bin_dir is on PATH (ok)"
		;;
	*)
		echo "!! $bin_dir is NOT on PATH. Add this to your shell profile:"
		echo "     export PATH=\"$bin_dir:\$PATH\""
		;;
esac

echo
echo "Done. Try:  pi-browser --help"
echo "Cross-skill usage (in another skill's SKILL.md):"
echo "    pi-browser capture <url> --full-page --out=/tmp/p.png"
echo "    pi-browser netlog  <url> --min-status=400"
