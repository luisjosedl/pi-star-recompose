# AstroDL - Star Recompose Pro

> **AstroDL** is luisjosedl's astrophotography tool suite for PixInsight.
> **Star Recompose Pro** recomposes a stretched starless image with a
> linear stars-only image, with a live preview and an optional editable
> ellipse mask to limit the stars stretch to a region of the frame.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## What it does

A typical astrophotography workflow splits a linear image into a
`starless` half (which you stretch creatively) and a `stars-only` half
(which is hard to stretch without blowing out star cores). Star
Recompose Pro recombines them:

- Pick your **Starless** (already stretched, non-linear) and your
  **Stars** (still linear, e.g. from StarXTerminator or StarNet++).
- Three sliders control the stars layer: `Stretch` (intensity), `Color
  Boost` (saturation), and `Mask Strength`. Optional **SCNR Green** and
  **SCNR Magenta** to clean a residual color cast on the stars.
- A live preview inside the dialog shows the recombined result as you
  move the sliders. Mouse-wheel to zoom, drag with the Pan tool to
  navigate.
- **Apply** runs the same pipeline at full resolution and creates the
  `Combined` image. Optionally also keeps the stretched stars as a
  separate `Stars_Stretched` image you can use as a layer.

Your original views are never touched.

## Mask editor (optional)

You can add a single editable **ellipse** that limits where the stars
contribute. Useful to preserve the soft core of a galaxy or nebula
without crushing the star colors in the surrounding sky.

- Select **Ellipse** in the *Mask Tool* combo, then click+drag on the
  preview. The first click and the drag endpoint define the two ends of
  the major axis (the ellipse auto-rotates to that orientation).
- Drag the **four red corner handles** to resize. Drag the **green
  handle** above the ellipse to rotate. Drag the body to move.
- The ellipse stays anchored to the same region when you resize the
  dialog window.
- **Mask Strength**: how much the stars are attenuated where the
  ellipse covers (0 = mask disabled, 1 = stars fully removed inside).
- **Mask Feather**: soft-edge transition width, as a percentage of
  image width.
- **Gradient**: where inside the ellipse the solid `mask=1` core ends
  and the falloff begins (0% = pure gradient from center, 100% = hard
  edge at the ellipse boundary).
- **Invert**: keeps stars only inside the ellipse and removes them
  everywhere else (the outline turns cyan in this mode).
- **Clear Mask** removes the ellipse and restores stars everywhere.

The **View** combo lets you switch between:
- *Image only* &mdash; recombined preview with no mask effect (best for
  aligning the ellipse to features).
- *Image + mask effect* &mdash; the same view the Apply button will
  produce.
- *Mask only (B/W)* &mdash; the raw mask in grayscale, useful to verify
  the gradient profile.

The **Compare** button toggles between *Image only* and *Image + mask
effect* in one click.

## Pipeline

For each preview update, the script runs:

1. `PixelMath` per-channel rational stretch on a temporary copy of the
   stars layer: `y = (K * x) / ((K-1) * x + 1)`, where K is the
   *Stretch* slider value (1..1000).
2. `ColorSaturation` hat-curve to add saturation to bright star cores:
   `[(0, b*0.50), (0.5, b*0.85), (1, b*0.50)]` Akima subsplines, where
   `b` is the *Color Boost* slider.
3. Optional `SCNR Green` (AverageNeutral, preserveLightness) and / or
   custom Magenta removal via PixelMath:
   `R' = R - min(max(0, R-G), max(0, B-G))` and same for B.
4. `PixelMath` combine:
   `final = min(1, starless + stars_proc * (1 - mask * strength))`
   (or `(1 - (1-mask) * strength)` in invert mode).

The full-resolution Apply uses the same expressions at the native size
of the source views.

## Installation

1. In PixInsight: `Resources > Updates > Manage Repositories...`
2. Click **Add**, paste:

   ```
   https://luisjosedl.github.io/pi-star-recompose/
   ```

3. Click **OK**, then `Resources > Updates > Check for Updates` and
   accept the proposed update. PixInsight will show an
   **"untrusted repository"** warning because the manifest is not
   signed with a Pleiades certificate; click *Continue* to proceed.
4. Restart PixInsight when prompted. The script appears in
   `Script > AstroDL Suite > Star Recompose Pro`.

Future versions install automatically the next time you run
`Check for Updates`.

## Usage

1. Run `StarXTerminator` (or `StarNet++`) on your linear image to
   produce a `starless` and a `stars` view.
2. Stretch the `starless` view however you like (GHS, MaskedStretch,
   HistogramTransformation, ArcsinhStretch, your favourite recipe).
3. Open the script. It auto-selects views whose ID matches
   `starless` / `stars` / `star_mask`.
4. Adjust **Stretch** and **Color Boost** while watching the preview.
   `Stretch = 100` and `Color Boost = 1.00` are a sensible starting
   point for typical linear stars-only data.
5. *(Optional)* Switch the Mask Tool to **Ellipse**, click+drag to
   place the ellipse, and tune Strength / Feather / Gradient.
6. *(Optional)* Tick **Create stars layer** if you also want the
   processed stars as a separate output image.
7. Click **Apply**. A new image (`Combined`) is created with the
   result. If "Create stars layer" was on, `Stars_Stretched` is also
   created.

## Saving presets as process icons

Drag the blue **New Instance** triangle (bottom-left of the dialog) to
the PixInsight workspace. PixInsight saves the current slider values
and Output name as a process icon. Rename it
(right-click &rarr; *Set Process Identifier...*) to something like
`StarRecompose_NebulaPreset`. Re-open later by double-clicking the
icon and pressing the play button.

> Note: the ellipse geometry itself is not currently persisted across
> sessions, but the sliders and SCNR / output settings are.

## License

[MIT](LICENSE). Free for personal and commercial use, with attribution.
