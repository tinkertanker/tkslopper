# tkslopper icon

Approved Goo Glyph: green splash, negative-space cannon, and three detached goo balls (four circles including the wheel).

| File                        | Use                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `tkslopper-original.png`    | Unmodified approved Painter image, 1254 × 1254; retains the original texture and background.  |
| `tkslopper.svg`             | Scalable, transparent, flat-green master (`#60ae0a`). Real vector paths, not an embedded PNG. |
| `tkslopper-monochrome.svg`  | Same paths with `currentColor`; inherits text color when used inline.                         |
| `tkslopper-transparent.png` | Transparent 1254 × 1254 export of the SVG.                                                    |
| `tkslopper-ivory.png`       | 1254 × 1254 SVG export on ivory (`#fffffa`).                                                  |
| `tkslopper-512.png`         | Transparent 512 × 512 export.                                                                 |
| `tkslopper-32.png`          | Transparent 32 × 32 small-icon export.                                                        |

## Fidelity

The SVG traces the approved PNG rather than redrawing or idealizing its geometry. It preserves the approved cannon angle, wheel, splash, and droplets. The SVG intentionally replaces the generated image's subtle texture with its median foreground color.

Traced with Potrace 1.16 (optimization tolerance 0.2) from the PNG's blue-channel silhouette at a 50% threshold. Rendered with CairoSVG at the original 1254 × 1254 resolution and compared against that silhouette: **99.639% intersection-over-union**, with 1,098 differing pixels out of 1,572,516 total pixels. This measures shape fidelity, not pixel-perfect color or texture reproduction.

A side-by-side render and magenta edge overlay were visually inspected: the cannon, wheel, splash boundary, and all three droplets align without a visible offset at the comparison scale. All exports retain the original square canvas and margins.
