# Exploration chrome: Superego

Detected 2026-11-04 from `packages/ui/src/styles.css` (no design-system doc).

- **Palette:** monochrome; white/black with Tailwind's zinc scale. Paper `#fff`, page `#fafafa` (zinc-50), ink `#18181b` (zinc-900), muted `#71717a` (zinc-500), lines `#e4e4e7` (zinc-200).
- **Accents:** none beyond ink. Superego's accent token is the text colour, so "brand" accents in the chrome are zinc greys.
- **Fonts:** system sans (`ui-sans-serif`, -apple-system, Inter fallback) for body; system mono (`ui-monospace`, SF Mono, JetBrains Mono) for the eyebrow, letter badges, frame bars and analysis labels. No webfonts.
- **Shape:** 6px component radius in the app; frames at 12px; flat, with a light shadow on preview frames only.
- **Mode:** light chrome. The app follows the system (light-dark tokens).

Say "rebrand the explorations" to adjust.
