# Design System — Burst Super-Res

## Product Context
- **What this is:** Free, private, offline tool that merges camera bursts into one 2x-resolution image. Desktop app (tinyjs), browser PWA, phone camera capture.
- **Who it's for:** Photography hobbyists (Sony A6000 hacking-guide crowd) who want real resolution without AI or subscriptions.
- **Space/industry:** Browser photo tools (Photopea, Squoosh, darktable, Lightroom web).
- **Project type:** Utility app shell + small landing/README surface.

## Memorable thing
"Free, offline, private — and it actually works in a browser tab."
Every design decision serves this posture: the app should look like honest precision equipment, not SaaS.

## Aesthetic Direction
- **Direction:** Industrial/utilitarian with editorial restraint — "Darkroom Instrument."
- **Decoration level:** intentional. No gradients, no blobs, no decorative shapes, no stock imagery. One subtle live indicator (safelight dot) and one motion showpiece (merge scan sweep).
- **Mood:** a darkroom safelight over a workbench. Near-black chrome so the photographs are the only saturated thing on screen. Calm, exact, quietly confident.
- **Reference points:** Photopea editor chrome (dark neutral), Squoosh (single-task clarity), Print/darkroom traditions (serif + mono).

## Typography
Three voices, each a literal darkroom object:
- **Display/wordmark:** Instrument Serif — the photographic print. Wordmark, landing headline only. Subset + self-hosted (~8KB) so it works offline.
- **Body/UI:** system sans (`-apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, sans-serif`) — the workbench. **Declared feature, not laziness:** "no font bytes over the wire except the subset." This is an explicit rule; do not "fix" it by pulling in a webfont for body text.
- **Data/measurements:** JetBrains Mono, `font-variant-numeric: tabular-nums` — the measurement. Every number the app measures (alignment rms, pixel dimensions, ISO/exposure, merge time, frame counts) renders in mono. Prose never does. Mono is never used for buttons or headings.
- **Loading:** self-host subsets (Instrument Serif, JetBrains Mono) in `src/web/fonts/`; system sans needs none. Fallbacks: Georgia for serif, `ui-monospace` for mono.
- **Scale:**
  - display 30–44px (landing), wordmark 17–19px
  - body 14px / 1.55, small 12px
  - mono data 11–13.5px

## Color
- **Approach:** restrained. Amber appears on exactly two things: the primary action, and the safelight dot. Verdict colors live only inside badges.
- **Accent (safelight):** `#e8a23a` (hi `#f2b558`, ink `#1c1407`, dim `#3a2d16`)
- **Neutrals (surfaces, dark to raised):** bg `#101216` · sunken `#12141a` · panel `#181b21` · line `#272b34` · line-soft `#20242c`
- **Text:** `#dde0e6` · dim `#aab0bb` · muted `#9aa1ad`
- **Semantic / verdicts:** good `#57c78c` on `#1b3327` · soft `#e3b65e` on `#342c17` · bad `#e68686` on `#3a2323`
- **Dark mode:** app is dark-only by design (photo editing needs a neutral dark surround). `color-scheme: dark`.

## Spacing
- **Base unit:** 8px
- **Density:** comfortable-compact (utility, not marketing)
- **Scale:** xs 4 · sm 8 · md 12 · lg 16 · xl 24 · 2xl 32 · 3xl 48

## Layout
- **Approach:** grid-disciplined app shell. 360px sidebar + fluid canvas (`360px minmax(0,1fr)`); one scrolling column below 960px or short windows.
- **Max content width:** landing/marketing ~1080px.
- **Border radius (hierarchical):** sm 6px (chips, kbd, hud) · md 10px (buttons, frames) · lg 14px (panels, modal) · full 9999px (badges, safelight dot).

## Motion
- **Approach:** minimal-functional, plus one expressive moment.
- **The one showpiece:** merge progress as a visible horizontal scan sweep across the canvas — the machine thinking.
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro 50–100ms · short 150–250ms · medium 250–400ms · long 400–700ms (scan sweep lives at long).

## Voice (UI copy)
Plain, honest, no hype. Measured claims with real numbers ("0.22 px", "12000 × 8000", "4 of 8 frames"). Never "unlock", "supercharge", "seamless". Privacy is stated once, flatly ("0 uploads"), not marketed with badges.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-11-28 | Initial design system: "Darkroom Instrument" | Created by /design-consultation. Formalizes the existing near-black + amber darkroom CSS; adds serif wordmark and mono data voice to serve the "free, offline, private, precision tool" posture. System-sans body kept as a declared anti-SaaS feature. |
