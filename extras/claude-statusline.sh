#!/usr/bin/env bash
# Claude Code status line for the Pokédex layout. It saves the JSON Claude Code sends
# (which carries rate_limits: 5h and weekly usage) so the Pokédex status bar can show it,
# then prints the folder and the usage.
# Already have your own status line? Just add these two lines after `input=$(cat)`:
#   mkdir -p "$HOME/.cache/claude-usage" && printf "%s" "$input" > "$HOME/.cache/claude-usage/last.json"
input=$(cat)
mkdir -p "$HOME/.cache/claude-usage" && printf "%s" "$input" > "$HOME/.cache/claude-usage/last.json"
jq -r '
  (.workspace.current_dir // .cwd // "") as $d
  | ($d | sub("^" + env.HOME + "/?"; "~/")) as $dir
  | [ $dir,
      (if .rate_limits.five_hour then "5h \(.rate_limits.five_hour.used_percentage | floor)%" else empty end),
      (if .rate_limits.seven_day then "7d \(.rate_limits.seven_day.used_percentage | floor)%" else empty end)
    ] | join("  ")' <<<"$input" 2>/dev/null || pwd
