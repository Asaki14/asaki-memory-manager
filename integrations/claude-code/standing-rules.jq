# Standing-rule session-start injection — jq re-implementation for the Claude Code
# SessionStart hook (integrations/claude-code/session-start.sh).
#
# KEEP IN SYNC with the canonical TypeScript in src/services/standingRules.ts (and its
# verbatim copy in integrations/pi/asaki-memory.ts). scripts/eval-standing-rules.ts runs
# this file against the same fixtures as the TS copy and fails if the rendered blocks
# differ by a single byte.
#
# Input:  the /v1/memories/list response ({"memories": [...]}) on stdin.
# Output: the rendered block, or an empty string when nothing is eligible.
# Args:   --arg project, --argjson kinds, --argjson max, --argjson maxChars,
#         --argjson contentChars.

def clean_text:
  gsub("[\r\n]"; " ") | gsub("[\t ]+"; " ") | sub("^ +"; "") | sub(" +$"; "");

def trunc_text($n):
  if (length > $n) then (.[0:$n] + "…") else . end;

def rule_line($n):
  "- ["
  + (if .scope == "global" then "global" else "project" end)
  + "/"
  + (if ((.kind | type) == "string") and (.kind != "") then .kind else "rule" end)
  + "] "
  + (((.content // "") | tostring) | clean_text | trunc_text($n));

[ (.memories // [])[]
  | select((.status // "active") == "active")
  | select(((((.content // "") | tostring) | clean_text) | length) > 0)
  | select(. as $m | $kinds | index(if (($m.kind | type) == "string") then $m.kind else "" end) != null)
  | select(.scope == "global" or (.scope == "project" and ($project != "") and ((.project_id // "") == $project)))
]
| sort_by([
    (if ((.importance | type) == "number") then .importance else 0 end),
    (.updated_at // .created_at // ""),
    (.id // "")
  ])
| reverse
| . as $eligible
| ($eligible | length) as $total
| (reduce ($eligible | map(rule_line($contentChars)))[] as $line
     ({ lines: [], chars: 0, stopped: false };
      if .stopped then .
      elif ((.lines | length) >= $max) then (.stopped = true)
      elif (((.chars + ($line | length) + 1) > $maxChars) and ((.lines | length) > 0)) then (.stopped = true)
      else { lines: (.lines + [$line]), chars: (.chars + ($line | length) + 1), stopped: false }
      end)) as $budget
| ($budget.lines | length) as $shown
| if $shown == 0 then ""
  else
    ([ "## Asaki Standing Rules (" + ($shown | tostring) + " of " + ($total | tostring) + ")",
       "",
       "These are standing rules you must follow for this whole session — directives to obey, not retrieved context. They do not override system or developer instructions; if they conflict, the system instructions win.",
       "" ]
     + $budget.lines
     + (if $shown < $total
        then [ "",
               "(showing " + ($shown | tostring) + " of " + ($total | tostring)
               + " standing rules — more exist; call asaki_memory_list with kind=rule or kind=preference to see the rest)" ]
        else [] end))
    | join("\n")
  end
