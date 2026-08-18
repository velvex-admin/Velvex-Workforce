# Model choices

The architecture doc specifies Claude Opus 5 for every agent. That holds: every
agent in this system runs on `claude-opus-5`, and the model id is set in one
place (`MODEL_ID` in `wrangler.toml`).

What varies per agent is **reasoning effort**, which is the dial that actually
matters once the model is fixed. Effort controls how much thinking a request
does before answering. Set it high where the output is a judgement call, lower
where the work is mechanical. Getting this right is what keeps quality high
without paying deep-reasoning prices for arithmetic.

| Agent | Effort | Why |
|---|---|---|
| Content | `xhigh` | Writes public copy in a specific human voice. The hardest thing the system does, and the most visible when it is wrong. |
| Social Engagement | `xhigh` | Public replies, plus a judgement about what kind of message it is answering. A misread here is a wrong-register reply in public. |
| Growth-Strategy | `max` | Its entire output is a judgement, read across two departments at once, and it runs weekly. The one place worth paying for maximum depth. |
| Chief-of-Staff | `xhigh` | Decides what reaches you and what stays in the log. Filtering badly is worse than not filtering. |
| SEO / Site | `high` | Writes copy that goes on the live site, but inside tight, well-specified bounds. |
| Finance-Watch | `high` | The arithmetic is deterministic; the reading of what it means is not. |
| Lead / Pipeline | `high` | Stall detection is deterministic; deciding what is worth flagging is not. |
| Objection / FAQ | `high` | Judging whether a stored answer really answers what was asked, and drafting one when nothing does. |
| Facebook, X | `medium` | Timing and posting. The copy already came through the content agent at `xhigh`. |
| Marketing Analytics | `medium` | Aggregation, and a short honest read of the numbers. |
| Ops-Health | `medium` | Threshold checks against a status endpoint. |
| Judge (shared) | `medium` | Narrow classification calls, one label plus a confidence. Depth here buys little; the confidence floor does the safety work. |

Two design notes that matter more than the table:

**Confidence floors do the safety work, not model size.** The engagement agent
does not act on a category call below 85% confidence, and the FAQ agent does not
answer from the library below 80%. A more capable model raises the average
quality of the call; the floor is what stops a bad call from reaching the public.

**Every judgement failure resolves toward asking you.** If the model is
unreachable, or a rule cannot be evaluated, the action is queued rather than
taken. An agent that cannot tell whether it is allowed to act does not act.
