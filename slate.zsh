# slatewiper shell hooks. Source from ~/.zshrc.
#   - a one-line magenta FYI when you land in a repo where a wipe dropped something
#   - `unwipe` to bring a dropped agent session back right here
autoload -Uz add-zsh-hook
_slate_repo=${${(%):-%x}:A:h}

_slate_dir() {
  local root; root=$(git rev-parse --show-toplevel 2>/dev/null) || root=$PWD
  print -r -- "$root/.slate"
}

# Lines like "- claude: Title (cwd ...)" → "claude · Title"
_slate_items() {  # $1 = marker file
  sed -nE 's/^- (claude|codex|cursor)(: )?(.*) \(cwd [^)]*\)( — kept.*)?$/\1 · \3/p' "$1" | sed -E 's/ · $//'
}

# `slate ...` is slatewipe; `slate find <text>` searches every archive.
slate() { node $_slate_repo/slatewipe.mjs "$@"; }

_slate_notice() {
  local dir; dir=$(_slate_dir)
  [[ -d $dir ]] || return 0
  local -a files; files=($dir/*.md(N.om))
  (( ${#files} )) || return 0
  [[ ${_slate_last_dir:-} == $dir ]] && return 0
  _slate_last_dir=$dir
  local latest=${files[1]:t:r}
  local when="${latest%%_*} ${${${latest#*_}//-/:}%:*}"
  local -a items; items=(${(f)"$(_slate_items ${files[1]})"})
  local list=${(j:, :)items}
  local shells=$(grep -c '^- shell ' ${files[1]}); (( shells )) && list="${list:+$list, }${shells} shell(s)"
  local earlier=""; (( ${#files} > 1 )) && earlier=" (+$(( ${#files} - 1 )) earlier wipes)"
  print -P "%F{magenta}⌫ slate%f %F{244}${when}%f ${list:-nothing resumable}%F{244}${earlier} · %F{magenta}unwipe%f%F{244} to resume, %F{magenta}unwipe -l%f%F{244} to list%f"
}
add-zsh-hook chpwd _slate_notice
_slate_notice

# unwipe            resume the most recent dropped agent session in this repo (asks if several)
# unwipe N          resume the Nth from `unwipe -l`
# unwipe -l         list resumable sessions here, newest wipe first
# A session dropped in several wipes is listed once, under its newest wipe.
unwipe() {
  local dir; dir=$(_slate_dir)
  local -a files; files=($dir/*.md(N.om))
  (( ${#files} )) || { print -P "%F{244}nothing was dropped here%f"; return 1; }
  local -a labels cmds
  local f line label
  for f in $files; do
    label=""
    while IFS= read -r line; do
      if [[ $line =~ '^- (claude|codex|cursor)(: )?(.*) \(cwd' ]]; then label="${match[1]} · ${match[3]}"
      elif [[ $line =~ '^  - resume: `(.*)`$' && -n $label ]]; then
        (( ${cmds[(Ie)${match[1]}]} )) || { labels+=("$label  %F{244}[${${f:t:r}%%_*}]%f"); cmds+=("${match[1]}"); }
        label=""
      fi
    done < $f
  done
  (( ${#cmds} )) || { print -P "%F{244}no agent sessions in ${dir}%f"; return 1; }
  if [[ $1 == -l ]]; then
    local i; for (( i = 1; i <= ${#cmds}; i++ )); do print -P "%F{magenta}$i%f  ${labels[$i]}"; print -P "   %F{244}${cmds[$i]}%f"; done
    return 0
  fi
  local pick=${1:-}
  if [[ -z $pick ]]; then
    if (( ${#cmds} == 1 )); then pick=1
    else
      local i; for (( i = 1; i <= ${#cmds}; i++ )); do print -P "%F{magenta}$i%f  ${labels[$i]}"; done
      read "pick?which? [1] "; pick=${pick:-1}
    fi
  fi
  [[ $pick == <1-> && $pick -le ${#cmds} ]] || { print "no such entry"; return 1; }
  print -P "%F{magenta}⌫ unwipe:%f ${labels[$pick]}"
  eval "${cmds[$pick]}"
}
