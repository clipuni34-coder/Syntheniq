# Retention Engine

Syntheniq does not cut clips with one fixed formula. For every candidate clip
it analyzes the **sequence of information, emotion, curiosity and payoff** and
selects the narrative architecture that best fits the actual source material.

## What it answers per clip

- What does the viewer know at each moment, and what do they still want to know?
- What question has the video created?
- When does the viewer receive the next meaningful reward?
- Would revealing the payoff too early remove the reason to keep watching?
- Where is the strongest emotional/informational payoff?
- Would a brief later-moment teaser create stronger curiosity without spoiling?
- Does the ending deliver a satisfying payoff?

## Architectures (chosen dynamically)

| Architecture | Used when the source has… |
|---|---|
| `payoff-teaser-chronological-story-payoff` | a strong later payoff that can be teased without spoiling it |
| `open-loop-progressive-reveal-resolution` | an unresolved opening question, steady reveals |
| `escalating-revelations` | 3+ rising information/emotion peaks |
| `consequence-first-explanation` | dramatic result early, cause later |
| `question-investigation-answer` | an explicit question early, answer later |
| `emotional-context-emotional-payoff` | emotion up front, context middle, emotional close |
| `transformation-journey-outcome` | before/after arc |
| `pattern-break-explanation` | abnormal moment early, normality explains it |
| `chronological-hook-escalation-final-revelation` | strong chronological story with escalating detail |
| `direct-question-punchline` | short clip, question then immediate answer |

Selection rules (deterministic, in `src/ai/heuristic.ts` → `deriveRetention`):
- Head question + no strong head payoff → `question-investigation-answer`.
- 3+ rising peaks → `escalating-revelations`.
- Dramatic opening (high energy, early) → `consequence-first-explanation`.
- Before/after language → `transformation-journey-outcome`.
- Emotion early + strong late payoff → `emotional-context-emotional-payoff`.
- Otherwise → `chronological-hook-escalation-final-revelation`.
- AI provider path (Gemini/Grok/OpenAI) receives the same 7 questions and is
  instructed to pick dynamically; heuristic mode is the offline fallback.

## Beat map

Each clip gets a **beat map** — the retention architecture translated to
timestamps in source time:

`hook → [curiosity → micro-payoff → new-curiosity]* → escalation → major-payoff → satisfaction`

Beats are deduplicated with role priority — **payoff beats never lose a
dedupe fight** (payoffs must always be rewarded).

## Teaser (cold open)

A later-moment teaser is generated **only** when:
1. the selected architecture supports it (escalating revelations,
   question→investigation, consequence-first, open-loop, transformation),
2. the candidate is 2–4s of complete sentences,
3. it sits in the back half of the clip, in a retained segment,
4. it is a distinct peak (not adjacent to the clip's head),
5. the main narrative starts with a strong hook and a **question is NOT
   already in the first 35%** (an open question at the top already holds the
   viewer — a teaser would only risk a spoiler).

Teasers play first, then the story resumes **chronologically** from the clip's
start. Lip sync is preserved because teasers are whole retained segments.

## Beat → on-screen rhythm (`deriveBeatCues`, plan stage)

The beat map also paces the motion layer so the viewer feels "something
valuable is still coming":

| Beat | On-screen cue |
|---|---|
| curiosity | one subtle accent pulse (intensity 0.5) — "a shift is coming" |
| micro-payoff | one underline reward on the actual spoken word |
| major-payoff | one impact (flash + shape + shake) if the peak isn't already marked |

Each cue is deduplicated against existing motion cues (kind + proximity), at
most one is added per kind, and total impact count stays ≤ 2. No random
effects — every animation maps to a beat in the retention sequence.

## Verified runs

- 2026-09-16, project `22c45dd8`: clip-1 `emotional-context-emotional-payoff`
  (hook@0.4, major-payoff@3, escalation@5, satisfaction@26.6); clip-2
  `chronological-hook-escalation-final-revelation` (hook@29.2, curiosity@33.4,
  major-payoff@39, escalation@42.7, satisfaction@49.3). Two different
  architectures from one source. No teaser (head question already open —
  correct).
- 2026-09-16, project `fdcc7edb`: same architectures (deterministic);
  beat-driven cues rendered — curiosity pulse at comp 4.64s, major-payoff
  impact at comp 9.83s (frame-verified in `files/clip-2.mp4`).
- Offline scenario: rising peaks → `escalating-revelations` with teaser
  28.8–31.2 (2.4s at the 30s peak). Forced-teaser render verified: teaser
  first, flash, chronological resume (`/home/user/tmp-ret/out.mp4`,
  frames `f_t12.jpg`, `f_t30.jpg`).

## Editorial visual storytelling (graphics)

Speech → meaning → editorial decision → visual representation.
Deterministic detectors (work with or without AI) turn spoken structure
into animated graphics, max 3 per clip, never on the hook/CTA, never
stacked on impacts/cutaways/punch-ins:

| Type | Trigger | Rendered as |
|---|---|---|
| `stat` | concrete numbers, "$50M", "40 views", "doubled" | card + animated counter |
| `list` | "three reasons", "two things" | numbered items, staggered |
| `progression` | "from X to Y" | from → arrow → to + fill bar |
| `comparison` | "A vs B / unlike X" | two-panel VS |
| `steps` | "first… then… finally" | sequential step diagram |

Verified in a real render: "2x my watch time" stat counter (clip-1 @21.3s
comp) and "2 key points" numbered list (clip-2 @12.3s comp) —
project `e28b5a29`, 244s, QC 2/2.

## Editorial QC (spec §19)

Before each render the finished plan is evaluated: effect overload
(auto-trimmed to the 4–12 cue budget, never touching impacts/lower-thirds),
dead gaps >2.5s, payoff placement, hook presence. Warnings are logged;
overload is auto-corrected.

## Render regression harness (spec §20/§27)

`apps/api/test/regression.mjs` renders synthetic compositions through the
real pipeline (generateComposition → hyperframes → ffprobe) and verifies
file integrity, 1080x1920, duration, audio, and — critically — that the
video is **not a frozen static snapshot** (frame-diff freeze detection).
Cases: no B-roll, 1 B-roll, 2 B-roll + 3 graphics, 60fps, tracking
emphasis. Run: `node apps/api/test/regression.mjs`
