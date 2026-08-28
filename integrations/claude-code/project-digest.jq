# Project-memory digest session-start injection — jq re-implementation for the Claude Code
# SessionStart hook (integrations/claude-code/session-start.sh).
#
# KEEP IN SYNC with the canonical TypeScript in src/services/projectDigest.ts (and its
# verbatim copy in integrations/pi/asaki-memory.ts). scripts/eval-project-digest.ts runs
# this file against the same fixtures as the TS copy and fails if the rendered blocks
# differ by a single byte.
#
# Input:  the /v1/memories/list response ({"memories": [...]}) on stdin — the SAME response
#         the banner and the standing-rule block already use, so this costs no extra request.
# Output: the rendered block, or an empty string when nothing is eligible.
# Args:   --arg project, --argjson standingKinds, --argjson max, --argjson maxChars,
#         --argjson contentChars, --argjson index, --argjson indexMax, --argjson indexMaxChars,
#         --argjson indexContentChars.

def known_kinds:
  ["preference", "rule", "fact", "decision", "task_learning", "bug_fix", "workflow"];

def clean_text:
  gsub("[\r\n]"; " ") | gsub("[\t ]+"; " ") | sub("^ +"; "") | sub(" +$"; "");

def trunc_text($n):
  if (length > $n) then (.[0:$n] + "…") else . end;

def index_line($n):
  ((((.content // "") | tostring) | clean_text)) as $content
  | "- "
  + (.id | tostring)
  + " ["
  + (if .scope == "global" then "global" else "project" end)
  + "/"
  + (if ((.kind | type) == "string") and (.kind != "") then .kind else "fact" end)
  + "] "
  + ($content | trunc_text($n))
  + " (" + ($content | length | tostring) + " chars)";

def digest_line($n):
  "- ["
  + (if .scope == "global" then "global" else "project" end)
  + "/"
  + (if ((.kind | type) == "string") and (.kind != "") then .kind else "fact" end)
  + "] "
  + (((.content // "") | tostring) | clean_text | trunc_text($n));

# Dynamic complement of the standing kinds, so the two blocks can never share a memory.
(if (($standingKinds | length) > 0) then $standingKinds else ["rule", "preference"] end) as $standing
| (known_kinds | map(select(. as $k | ($standing | index($k)) == null))) as $kinds
| [ (.memories // [])[]
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
| (reduce ($eligible | map(digest_line($contentChars)))[] as $line
     ({ lines: [], chars: 0, stopped: false };
      if .stopped then .
      elif ((.lines | length) >= $max) then (.stopped = true)
      elif (((.chars + ($line | length) + 1) > $maxChars) and ((.lines | length) > 0)) then (.stopped = true)
      else { lines: (.lines + [$line]), chars: (.chars + ($line | length) + 1), stopped: false }
      end)) as $budget
| ($budget.lines | length) as $shown
| ([ $indexMaxChars, ([0, ($maxChars - $budget.chars)] | max) ] | min) as $indexBudget
| (if (($shown < $total) and $index)
   then (reduce ($eligible[$shown:]
                 | map(select(((.id | type) == "string") and (.id != "")))
                 | map(index_line($indexContentChars)))[] as $line
           ({ lines: [], chars: 0, stopped: false };
            if .stopped then .
            elif ((.lines | length) >= $indexMax) then (.stopped = true)
            elif ((.chars + ($line | length) + 1) > $indexBudget) then (.stopped = true)
            else { lines: (.lines + [$line]), chars: (.chars + ($line | length) + 1), stopped: false }
            end))
   else { lines: [] } end) as $indexBlock
| ($indexBlock.lines | length) as $indexed
| if $shown == 0 then ""
  else
    ([ "## Asaki Project Memory (" + ($shown | tostring) + " of " + ($total | tostring) + ")",
       "",
       "This is recalled context, not directives: durable memories of this project (plus global ones) that are not standing rules. They record what was already decided, learned or fixed — use them instead of re-deriving. Entries listed by id only are not expanded here: call asaki_memory_get with those ids to read them in full, and asaki_memory_search when you need more than these excerpts.",
       "" ]
     + $budget.lines
     + (if $indexed > 0
        then ([ "",
                "(showing " + ($shown | tostring) + " of " + ($total | tostring)
                + " project memories in full; the next " + ($indexed | tostring)
                + " are indexed below — call asaki_memory_get with those ids to read them)" ]
              + $indexBlock.lines
              + (if (($total - $shown - $indexed) > 0)
                 then [ "(… and " + (($total - $shown - $indexed) | tostring)
                        + " more not listed; call asaki_memory_list or asaki_memory_search for the rest)" ]
                 else [] end))
        elif $shown < $total
        then [ "",
               "(showing " + ($shown | tostring) + " of " + ($total | tostring)
               + " project memories — more exist; call asaki_memory_list or asaki_memory_search for the rest)" ]
        else [] end))
    | join("\n")
  end
