#!/bin/sh
# The app's pictures on the site and in the README, shot again (each release, or when the window's look changes):
# `site/shots.sh`. Two scenes from app/test/look.sh, each light and dark, with scripted turns (no model is asked):
# - `staff`'s staff-wide frame, the home page's hero: site/screenshot-light.webp and -dark.webp (2880×1800). The rings in
#   site/home.ts are in that frame's points: look at them after.
# - `header`, the README's header: docs/header.webp and header-dark.webp (1600 wide, the window's corners rounded), and
#   the link preview, site/og.jpg (1200×630, light).
# Needs ImageMagick (magick) and cwebp.
set -e
cd "$(dirname "$0")/.."
for tool in magick cwebp; do command -v $tool >/dev/null || { echo "site/shots.sh: needs $tool" >&2; exit 1; }; done
SHOTS="$(mktemp -d)"
trap 'rm -rf "$SHOTS"' EXIT
app/test/look.sh "$SHOTS/staff" staff
app/test/look.sh "$SHOTS/header" header

for theme in light dark; do
  cwebp -quiet -q 82 "$SHOTS/staff/staff-wide-$theme.png" -o "site/screenshot-$theme.webp"
  # The window's corners, as macOS rounds them (10pt), at 1600 wide.
  magick "$SHOTS/header/header-$theme.png" -resize 1600x \
    \( +clone -alpha extract -fill black -colorize 100 -fill white -draw 'roundrectangle 0,0 %[fx:w-1],%[fx:h-1] 11,11' \) \
    -alpha off -compose CopyOpacity -composite "$SHOTS/header-$theme.png"
  suffix=$([ $theme = light ] || echo -dark)
  cwebp -quiet -q 80 -alpha_q 100 "$SHOTS/header-$theme.png" -o "docs/header$suffix.webp"
done
magick "$SHOTS/header/header-light.png" -resize 1200x -gravity center -crop 1200x630+0+0 +repage -quality 85 site/og.jpg
ls -l site/screenshot-*.webp docs/header*.webp site/og.jpg
