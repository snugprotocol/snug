# Lessons

**Render light, don't restate it.** The color math (CIE xy through the Hue wide-gamut
matrix, mirek through the blackbody curve) exists so tiles GLOW instead of printing
numbers. A room that says "45%, mirek 370" is a settings screen; a room that looks
like dusk is a mood — and the same math then powers swatches, palette bands, and the
designer preview for free.

**Symbolic addressing has to be total to mean anything.** One
`snug-connection://hue/...` scheme everywhere, no address literal anywhere in the
file — and the error map has to honor that: `NET_AMBIGUOUS_CONNECTION` gets its own
"one bridge at a time" state, never the pairing CTA, because two approved addresses
is a configuration knot, not a missing connection.

**grouped_light is the whole write surface.** Every surface composes at room level,
so one governed PUT per room covers rooms, moods, batch, and the designer alike.
Per-light writes would have multiplied confirm prompts without adding a single
capability the app's own thesis wants.

**Validate the agent's proposal entry by entry, not all-or-nothing.** Shape errors
reject the whole reply (the narration still shows as text, so a chatty answer
degrades gracefully); a bad entry drops just that entry and the preview names the
dropped rooms; every number is clamped to the bridge's legal ranges. The designer
stays useful even when it half-misses.

**One gesture, one governed write.** Sliders fire continuously, and every write costs
the user a confirmation — debouncing brightness commits per room (450ms) is the
difference between a dimmer and a nag.

**A sample home must glow, not explain.** The first empty state was a skeleton grid
with generic "room 1..4" stand-ins behind the mood cards — accurate, and completely
mute about what the app is for. Replacing it with a named, lit, authored home
(dusk-amber Living Room next to a work-white Office; a candle-dim Bedroom; a dark
Kitchen) turned the pre-connect screen into the demo itself. Render-only constants
made eviction trivial: there is nothing to evict — the sample home simply stops
rendering when the bridge answers.
