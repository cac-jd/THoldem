#!/bin/sh
# Update THoldem and open it in your browser (macOS / Linux).
cd "$(dirname "$0")" || exit 1
git pull --ff-only || echo "Couldn't update (offline?) — opening the copy you have."
case "$(uname)" in
  Darwin) open index.html ;;
  *) xdg-open index.html >/dev/null 2>&1 || echo "Open $(pwd)/index.html in your browser." ;;
esac
