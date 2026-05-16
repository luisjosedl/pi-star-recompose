# AstroDL - Star Recompose

> **AstroDL** is luisjosedl's astrophotography tool suite for PixInsight.
> **Star Recompose** is the first tool in the suite: it recomposes a
> stretched starless image with a linear stars-only image, using a
> custom ArcsinhStretch-based engine and a live embedded preview.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## What it does

Astrophoto processing workflows typically split a linear image into a
`starless` half (which you stretch creatively) and a `stars-only` half
(which is hard to stretch without blowing out star cores). This script
recomposes them:

- Pick your **starless** (already stretched, non-linear) and your
  **stars-only** (still linear, e.g. from StarXTerminator / StarNet++).
- Three sliders control the stars: `Stretch Intensity`, `Black Point`
  and `Star Color Boost`. Optional `Remove Green via SCNR`.
- A live preview inside the dialog shows the recombined result as you
  move the sliders. Mouse-wheel zoom, click-drag pan.
- **Apply** runs the same pipeline at full resolution and creates the
  `Combined` image. Optionally also keeps the stretched-stars layer as
  a separate image you can use as a brush layer or process further.

Your originals are never touched.

## Why ArcsinhStretch

The stars are stretched using PixInsight's native **ArcsinhStretch**
(based on Lupton et al. 1999), instead of a midtones rational stretch.
The asinh curve is linear in the shadows and logarithmic in the
highlights, which preserves the RGB color ratios in bright star cores
instead of crushing them to white. With `protectHighlights` and
`useRgbws` enabled, star colors stay clean and saturated even on the
brightest stars in the field.

The pipeline:

1. `ArcsinhStretch` (intensity + optional black point) on a temporary
   copy of the stars layer.
2. `ColorSaturation` hat-curve with AstroDL values
   `[(0, 0.50), (0.5, 0.85), (1, 0.50)] * boost`, Akima subsplines.
3. Optional `SCNR Green` (AverageNeutral, preserveLightness).
4. `PixelMath`: `final = min(1, starless + stars_proc)`.

## Installation

1. In PixInsight: `Resources > Updates > Manage Repositories...`
2. Click **Add**, paste:

   ```
   https://luisjosedl.github.io/pi-star-recompose/
   ```

3. Click **OK**, then `Resources > Updates > Check for Updates` and
   accept the proposed update. PixInsight will show an
   **"untrusted repository"** warning because the manifest is not signed
   with a Pleiades certificate; click *Continue* to proceed.
4. Restart PixInsight when prompted. The script appears in
   `Script > AstroDL > Star Recompose`.

Future versions install automatically the next time you run
`Check for Updates`.

Optional: assign a keyboard shortcut from `Edit > Keyboard Shortcuts...`
for one-key access.

## Usage

1. Run `StarXTerminator` (or `StarNet++`) on your linear image to
   produce a `starless` and a `stars` view.
2. Stretch the `starless` view however you like (GHS, MaskedStretch,
   HistogramTransformation, ArcsinhStretch, your favourite recipe).
3. Open the script. It auto-selects views whose ID matches
   `starless` / `stars` / `star_mask`.
4. Adjust the sliders while watching the preview. Defaults
   `Intensity 200 / Black Point 0 / Boost 1` are a sensible starting
   point for typical linear stars-only data. The Intensity slider is
   logarithmic and spans 1 to 10000, so you can push very faint stars
   out of the noise or deliberately blow out bright ones.
5. (Optional) Tick **Save stretched stars** if you also want the
   processed stars layer as a separate image.
6. Click **Apply**. A new image (`Combined`) is created with the result.

### Saving presets as workspace icons

Drag the blue **New Instance** triangle (bottom-left of the dialog) to
the PixInsight workspace. PixInsight will save the current parameter
values as a process icon. Rename it (right-click -> *Set Process
Identifier...*) to something like `MANUAL_StarRecompose_NebulaPreset`.
Re-open later by right-clicking the icon -> `Execute Globally`, or by
double-clicking it and pressing the play button.

## License

[MIT](LICENSE). Free for personal and commercial use, with attribution.
