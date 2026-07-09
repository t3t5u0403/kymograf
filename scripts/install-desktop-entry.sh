#!/bin/sh
# Install a local .desktop entry + icon so a from-source kymograf shows its
# own icon in taskbars/launchers (Plasma/GNOME associate windows by app id).
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p ~/.local/share/applications ~/.local/share/icons/hicolor/1024x1024/apps
cp "$DIR/build/icon.png" ~/.local/share/icons/hicolor/1024x1024/apps/kymograf.png
cat > ~/.local/share/applications/kymograf.desktop <<EOF
[Desktop Entry]
Name=kymograf
Comment=MIDI + audio-reactive music video renderer
Exec=sh -c "cd $DIR && npm run app"
Icon=kymograf
Type=Application
Categories=AudioVideo;Audio;Video;
StartupWMClass=kymograf
EOF
update-desktop-database ~/.local/share/applications 2>/dev/null || true
echo "installed: ~/.local/share/applications/kymograf.desktop"
