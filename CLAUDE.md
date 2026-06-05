@AGENTS.md

<!-- BEGIN:forge-wiki-rules -->

## Wiki — keep it current (the *why*, not just the *what*)

This repo has an Obsidian-style wiki at `wiki/`. It is the source of truth for the
*why*. Code says what; the wiki says why. Keeping it current is not optional.

- **Non-trivial decisions & trade-offs** → record an ADR in `wiki/decisions/`
  (Context · Decision · Why · Alternatives · Consequences). The *why* and the roads
  not taken matter more than the choice. Number ADRs sequentially, zero-padded
  (`0007-...`). Link every new ADR from `wiki/index.md` in the same change.
- **Incidents, failures, surprising root causes** → write `wiki/notes/YYYY-MM-DD-slug.md`
  (timeline · root cause · the decision it forced · what it demonstrates). How the
  system fails is stronger signal than the happy path.
- **Deliberate scope cuts** → record in `wiki/improvements.md` ("deferred X for Y").
- **Architecture changes** → keep `wiki/architecture.md` honest as phases land.
- When you make such a change, **say so in your reply** — note which wiki file you
  updated. Under-capturing the *why* is the failure mode to avoid; when in doubt,
  write it down.

## Phase & branch discipline

- Work happens in ordered phases defined in `wiki/plan.md`.
- Each phase runs on its own branch `phase/<n>-<slug>` off the base branch.
- Commit as many times as needed *on the phase branch*. Never commit directly on
  the base branch.
- A finished phase merges back as **exactly one squashed commit**, and only after
  its declared **verifiable gate** is green.
- Every merged phase gets one `wiki/build-log.md` entry: what was done, the *why*
  of notable decisions, and the exact gate that was met.

<!-- END:forge-wiki-rules -->
