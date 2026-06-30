#!/usr/bin/env bash
# local linux desktop build. tauri's appimage tooling trips on two arch quirks, this works around both and
# then runs the normal build. on distros that do not have these quirks neither workaround changes anything,
# so it is safe to use everywhere. pass extra args straight through, eg ./scripts/build-linux.sh --debug
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. linuxdeploy bundles an old strip that cannot read the .relr.dyn sections in arch's system libraries, so
#    every strip call fails and the bundle aborts. the libraries are fine, we just skip stripping
export NO_STRIP=true

# 2. arch's gdk-pixbuf compiles its loaders into the library, so the module dir pkg-config advertises does
#    not exist on disk and the gtk plugin's recursive cp of it fails. only when that dir is genuinely missing
#    do we hand pkg-config an empty stand in, the built in loaders cover runtime either way
bindir="$(pkg-config --variable=gdk_pixbuf_binarydir gdk-pixbuf-2.0 2>/dev/null || true)"
if [ -n "$bindir" ] && [ ! -d "$bindir" ]; then
    echo "gdk-pixbuf module dir $bindir is missing (loaders are built in), shimming it for linuxdeploy"
    pc=""
    for d in /usr/lib/pkgconfig /usr/lib64/pkgconfig /usr/share/pkgconfig; do
        [ -f "$d/gdk-pixbuf-2.0.pc" ] && { pc="$d/gdk-pixbuf-2.0.pc"; break; }
    done
    if [ -n "$pc" ]; then
        shim="$(mktemp -d)"
        trap 'rm -rf "$shim"' EXIT
        mkdir -p "$shim/pc" "$shim/lib/gdk-pixbuf-2.0/2.10.0/loaders"
        gdk-pixbuf-query-loaders > "$shim/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache" 2>/dev/null || true
        sed -E "s#^gdk_pixbuf_binarydir=.*#gdk_pixbuf_binarydir=$shim/lib/gdk-pixbuf-2.0/2.10.0#" \
            "$pc" > "$shim/pc/gdk-pixbuf-2.0.pc"
        export PKG_CONFIG_PATH="$shim/pc${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
    fi
fi

exec npx tauri build "$@"
