# Velvex standing position — the draft to send to `intel.position`

This is the statement the Competitive Intelligence agent reads **before** it reads
anything the open web says about Velvex, and which **outranks** the web where the
two disagree. It exists so a brief never reports a stale fact about Velvex back
to its own owner as a finding.

Everything under "Verifiable" below is drawn from this repository, not invented:
`src/core/business.ts`, `src/core/config.ts` and CLAUDE.md. Everything under
"Only you can write this" is left blank on purpose. **Do not let an agent fill
those in.** A guessed answer here does not stay a guess: it becomes the thing
that outranks the public record, and a wrong entry would be worse than having no
statement at all.

Send it with:

```
curl -X PUT "$BASE/api/intel/position" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{ "standing": "PASTE THE FINISHED TEXT HERE, AS ONE STRING" }
JSON
```

where `$BASE` is `https://velvex-vx03.a99339744.workers.dev/x/<APP_PATH_SECRET>`.
A PUT replaces this prose and **keeps** every question you have already answered.

---

## Verifiable from this repository

Velvex sells a commercial architecture diagnostic, positioned as an
institutional-grade third-party diagnostic standard. It is not a consulting
firm, not a financial auditor, not a coaching provider, and not an open-ended
advisory relationship.

The diagnostic engine is called Veĺa, currently v0.1. It reads six nodes:
Structural Architecture, Revenue Mechanics, Channel Dependency, Operational
Capacity, Pressure Point Matrix, Continuity Risk. Every engagement is analysed
across three trajectories: Structural Architecture Mapping, Systemic Integrity
Calibration, and Vulnerability and Pressure Point Isolation.

The deliverable is a single Executive Ledger carrying the Final Velvex Score, a
structural reading across all seven systems, a six-dimension scoring breakdown,
ranked pressure points and three prioritised recommendations, paired with a
five-minute executive audio briefing.

Turnaround is within 24 hours of an accepted intake. There is a money-back
guarantee and structured follow-up at 30, 90 and 180 days.

Pricing is an introductory $149 per engagement for the first 10 clients only,
after which it returns to the standing $999. Any page or third-party summary
quoting only one of those two figures is describing the offer incompletely.

Every finding is tagged as observed fact, inference or assumption, and every
assumption is disclosed rather than hidden. This is the credibility claim, and
it is the thing most likely to be imitated in words before it is imitated in
practice.

Distribution is institutional: B2B enterprises and capital allocators, aimed at
businesses approaching a scaling decision.

## Only you can write this

Fill these in and delete the brackets. Anything you leave out, the agent will
keep treating as unsettled, which is the correct behaviour but costs you a
question each cycle.

- **Validation.** [What has the Veĺa framework actually been validated against,
  and when? You have said you validated it yourself. State what that consisted
  of and the date, because "unvalidated" is exactly the stale claim the open web
  will otherwise keep returning.]
- **Engagements to date.** [How many diagnostics have been delivered, and how
  many of the 10 introductory seats remain? The agent needs this to judge whether
  a positioning move is available now or only later.]
- **What is live versus planned.** [Which parts of the site, the engine and the
  Ledger are in production today, and which are described but not yet built?]
- **What the public record still gets wrong.** [Anything you have seen written
  or assumed about Velvex that is out of date or was never true. This is the
  highest-value section: it is a direct instruction about what not to repeat.]
- **What you are deliberately not doing.** [Positions you have already
  considered and rejected, so the agent stops proposing them. It will otherwise
  rediscover them every quarter and spend a positioning gap on each one.]
