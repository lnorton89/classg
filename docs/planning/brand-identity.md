# Brand identity

## Approved direction

ClassG uses a flat radar-G mark: an open cyan sensing arc, a fog inner arc, and a
small abstract aerial contact. The icon must communicate passive airspace awareness
without targeting, military, weapon, or surveillance-camera imagery.

The approved wordmark is **Manrope ExtraBold**. Set `Class` in fog/off-white and
the terminal `G` in sensor cyan. The visual reference selected by the project owner
is the Manrope lockup shown in the brand-review conversation on 2026-08-10.

Core colours: Night `#061827`, Sensor Cyan `#57C8F7`, Fog `#F0F3F5`.

Source assets are in `services/ui/public/brand/`.

## Image-generation prompts

These are preserved verbatim enough to reproduce the exploration. Image generation
was used for concept review only; production brand assets are hand-authored SVGs.

### Initial mark exploration

```text
Use case: logo-brand
Asset type: brand identity exploration board, preview only
Primary request: Create a polished logo exploration board for "ClassG", a passive,
receive-only multi-sensor drone detection system used outdoors and at night. Show
exactly three distinct, vector-friendly geometric logo marks arranged in three evenly
spaced square panels on a near-black navy technical background. Every mark must evoke
passive sensing, airspace awareness, and a small aerial object, with no military,
targeting, weapon, or surveillance-camera visual language.
Mark 1 (recommended): a minimal open circular radar sweep constructed from two clean
arcs, with a small four-armed drone/aircraft silhouette represented as a simple
diamond-and-cross at the upper right; the missing segment of the circle subtly forms
a letter G. This should read as a compact app icon.
Mark 2: a simplified topographic contour that resolves into a G with a small signal dot.
Mark 3: two calm concentric signal arcs around a minimal abstract aerial craft.
Style/medium: crisp flat vector logo design, exact geometry, mature safety-critical
technical product, no gradients, no shadows, no 3D, no mockups.
Color palette: cool sky cyan #72C7FF, pale off-white #EAF2F7, near-black navy #101A28.
The cyan is the primary accent.
Typography: beneath each mark, include the word "ClassG" in a sober humanist grotesk /
technical sans wordmark style, but prioritize the marks; labels may be very small. Set
the G slightly distinctive through a clipped open aperture.
Composition/framing: horizontal design sheet, spacious, centered, clean grid,
demonstrate the three marks at icon scale and wordmark scale.
Text (verbatim): "ClassG"
Constraints: no other text; no gradients; avoid faux military crests, crosshairs,
shields, aggressive threat imagery, generic wifi glyphs, watermark.
Avoid: photorealism, ornate detail, AI texture, visual clutter.
```

### Wordmark comparison

```text
Use case: logo-brand
Asset type: premium typography comparison sheet for brand approval
Input images: Image 1 is the approved ClassG logo mark. Preserve that square
radar-G-and-small-drone mark perfectly, unchanged, and use it eight times.
Primary request: produce ONE polished, high-resolution, horizontal 4-by-2 comparison
board. Each cell contains the exact same approved ClassG icon above one alternative
wordmark. The only change between cells is the wordmark typography. The eight cells
have no labels and no explanatory copy, only the brand name. Render the word "ClassG"
exactly in every cell.
Typography directions, reading left-to-right top-to-bottom: 1 ABC Diatype-like:
precise humanist grotesk, slightly idiosyncratic; 2 Suisse Int'l-like: neutral Swiss
sans, disciplined; 3 Neue Montreal-like: editorial neo-grotesk, confident; 4
Aeonik-like: soft geometric sans, premium; 5 Figtree-like: warm open-source humanist;
6 Onest-like: sturdy contemporary humanist; 7 Archivo-like: compact industrial
grotesk; 8 Public Sans-like: civic, plainspoken, highly legible.
Style/medium: flat vector-quality identity presentation. Night-time field-operator
technology. No sci-fi, no monospaced text, no squared techno lettering.
Color palette: deep navy #061827 board background, icon locked from reference.
Wordmark in pale off-white #EAF2F7, with ONLY the G in sensor cyan #72C7FF.
Composition/framing: equal-sized generous cells, centered mark and wordmark, enough
white space to compare letterforms. Avoid all dividers, headers, captions, notes,
labels, watermarks, and extra text. Keep the exact approved square outline around
every logo mark.
Text (verbatim): "ClassG"
Constraints: Icon must remain identical to input image. All wordmarks must spell
ClassG exactly. Use a clearly noticeably distinct typeface personality in every cell.
Avoid: additional text, font names, generic AI visual motifs, gradients, shadows, any
altered logo symbol, military language, target reticles.
```

## Implementation note

The exploration’s font names were directional references, not supplied font files.
Manrope was selected after review and is installed locally in the UI via
`@fontsource/manrope`.
