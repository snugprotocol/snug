# Vision

Moodboard is the LAN-class gold-standard starter: a Philips Hue app that complements
rather than clones the vendor app. Hue's own app is switches and sliders; Moodboard
treats light as mood — composed, named, remembered — and gives the agent the one role
a settings screen cannot fill: lighting designer. Describe a feeling; get back a
validated per-room plan, previewed as a palette, applied only on the user's tap.

It is also the reference implementation of ADR-0026 symbolic addressing: every bridge
request is `snug-connection://hue/...`; the app never learns — and never contains —
an address.
