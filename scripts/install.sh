#!/usr/bin/env bash
# Installs this Pokédex layout (fork with Linux/WSL fixes) into Herdr on Linux or WSL.
# Safe to run again: it backs up whatever it replaces and never touches your save.
#   scripts/install.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
SERVER_DIR="${POKEDEX_SERVER_DIR:-$HOME/.local/share/pokedex-agents-server}"
SERVER_REPO="https://github.com/mitcheljimenez/pokedex-agents-server.git"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$APP/backup-pokedex-$STAMP"

have() { command -v "$1" >/dev/null 2>&1; }
warn() { printf '  ! %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }

# 1. Requirements ---------------------------------------------------------------
step "Checking requirements"
missing=()
have git || missing+=("git            -> sudo apt install git")
have herdr-app || missing+=("herdr-app      -> install Herdr first")
have jq || missing+=("jq             -> sudo apt install jq")
{ have bun || [ -x "$HOME/.bun/bin/bun" ]; } || missing+=("bun            -> curl -fsSL https://bun.sh/install | bash")
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing (install these, then run this script again):"
  printf '  - %s\n' "${missing[@]}"
  exit 1
fi
echo "  git, herdr-app, jq, bun: ok"

# Optional ones: the layout works without them, with less.
{ have paplay || have pw-play || have ffplay || have mpg123 || have mpv; } \
  || warn "No sound player: no jingles. Fix: sudo apt install mpg123"
have zoxide || warn "zoxide not found: the picker won't suggest folders. Fix: see README"
have claude || warn "Claude Code not found: no 5h/weekly usage in the status bar"
if ! grep -qi microsoft /proc/version 2>/dev/null; then
  { have wl-copy || have xclip; } || warn "No clipboard tool: Share copies no image. Fix: sudo apt install wl-clipboard (or xclip)"
fi

# 2. Game server ----------------------------------------------------------------
step "Game server ($SERVER_DIR)"
if [ -d "$SERVER_DIR/.git" ]; then
  echo "  already there, left as is (git -C \"$SERVER_DIR\" pull to update)"
else
  git clone -q "$SERVER_REPO" "$SERVER_DIR"
  echo "  cloned $SERVER_REPO"
fi

# 3. Layout, mods, icons --------------------------------------------------------
step "Copying layout and mods into $APP"
mkdir -p "$APP/layouts" "$APP/mods" "$APP/personal-icons"
backup() { # path relative to $APP
  if [ -e "$APP/$1" ]; then mkdir -p "$BACKUP/$(dirname "$1")"; cp -a "$APP/$1" "$BACKUP/$1"; fi
}
for f in layouts/pokedex.json layouts/pokedex.svg personal-icons/retro-agent.svg; do
  backup "$f"; cp "$REPO/$f" "$APP/$f"
done
for m in "$REPO"/mods/pokedex-*; do
  name="mods/$(basename "$m")"
  backup "$name"; rm -rf "${APP:?}/$name"; cp -a "$m" "$APP/$name"
done
[ -d "$BACKUP" ] && echo "  previous files saved in $BACKUP"

# 4. Keys and programs (merged, never replaced) --------------------------------
step "Merging keys.json and programs.json"
merge() { # file in repo, file in app, jq filter
  if [ -f "$APP/$2" ]; then
    backup "$2"
    jq --slurpfile new "$REPO/$1" "$3" "$APP/$2" > "$APP/$2.tmp" && mv "$APP/$2.tmp" "$APP/$2"
  else
    cp "$REPO/$1" "$APP/$2"
  fi
}
# Pokedex keys replace the layout:pokedex section; ctrl-shift-a (new Claude tab) is
# added to global only if you haven't bound it yourself.
merge keys.linux.json keys.json \
  '.["layout:pokedex"] = $new[0]["layout:pokedex"] | .global = ($new[0].global + (.global // {}))'
merge programs.json programs.json '.programs = ((.programs // {}) + $new[0].programs)'
echo "  done"

# 5. Claude usage in the status bar ---------------------------------------------
step "Claude Code usage (5h / weekly)"
SETTINGS="$HOME/.claude/settings.json"
if ! have claude; then
  echo "  skipped (Claude Code not installed)"
elif [ -f "$SETTINGS" ] && jq -e '.statusLine' "$SETTINGS" >/dev/null 2>&1; then
  cmd="$(jq -r '.statusLine.command // ""' "$SETTINGS")"
  if grep -qs "claude-usage/last.json" "${cmd##* }"; then
    echo "  your status line already saves usage"
  else
    echo "  You already have a status line ($cmd). Add this line right after input=\$(cat) in it:"
    echo '    mkdir -p "$HOME/.cache/claude-usage" && printf "%s" "$input" > "$HOME/.cache/claude-usage/last.json"'
  fi
else
  mkdir -p "$HOME/.claude"
  cp "$REPO/extras/claude-statusline.sh" "$HOME/.claude/pokedex-statusline.sh"
  chmod +x "$HOME/.claude/pokedex-statusline.sh"
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  cp "$SETTINGS" "$SETTINGS.bak-pokedex-$STAMP"
  jq --arg c "bash $HOME/.claude/pokedex-statusline.sh" '.statusLine = {type: "command", command: $c}' \
    "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
  echo "  status line installed (~/.claude/pokedex-statusline.sh)"
fi

# 6. Check ----------------------------------------------------------------------
step "Checking mods"
failed=0
for m in "$APP"/mods/pokedex-*; do
  if herdr-app check "$m" >/dev/null 2>&1; then echo "  ok   $(basename "$m")"
  else echo "  FAIL $(basename "$m")  (run: herdr-app check \"$m\")"; failed=1; fi
done
[ $failed = 0 ] || exit 1

echo
echo "Done. Open the layout with:  herdr-app do layout.switch --name pokedex"
