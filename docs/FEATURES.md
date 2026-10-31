# PlanMark

Private, browser-based PDF markup and measurement app (a personal Bluebeam-style tool).
Everything runs locally in the browser: files are opened, edited, combined and compressed on the
device and are never uploaded. Works in current Chrome, Edge and Safari on Windows and macOS and can
be installed as an app (PWA) from the browser's install / "Add to Dock" / "Add to Home Screen" menu.

## Build and run

    npm install
    npm run build        # static site in dist/
    npm run preview      # serves dist/ at http://localhost:4173

`dist/` is a plain static folder and can be hosted on any static host (HTTPS is required for the
installable/offline PWA features, except on localhost).

## Tests

    npm test             # builds, generates fixtures, runs Playwright (headless Chromium)

## Features (v1)

- Open PDFs (button, drag & drop, multiple files as tabs), smooth zoom (Ctrl/⌘ + wheel, pinch), pan (H or hold Space), page thumbnails.
- Scale: per-page standard scales (engineering 1" = 10'..2000', architectural, 1:N ratios in feet or metres), custom paper = real, or **Calibrate** by clicking two ends of a known length. Units: in, ft, yd, mi, mm, cm, m, km; precision 0-4 decimals.
- Measure: Length, Polylength, Perimeter, Area (sq ft + acres, or m² + hectares), Count. Labels drawn on the sheet; snap to markup endpoints; Shift for 45° constraint.
- Markups: pen, line, arrow, polyline, polygon, rectangle, ellipse, revision cloud, text box, callout, highlight. Line/fill colour, line and fill opacity, line width, solid/dashed/dotted/cloud border, arrowheads, font size, text colour. Select / move / resize vertices / delete, multi-select, marquee, copy/paste, undo/redo, tool presets (Tool Chest).
- Layers: the PDF's own layers (OCGs) can be shown/hidden; create your own markup layers (show/hide/lock), saved as real PDF layers.
- Markups list with totals and CSV export.
- Save with editable annotations (standard PDF annotations with appearance streams and PDF measurement dictionaries) or flattened (burned into page content, still grouped in PDF layers). The page scale is written as a standard PDF viewport /Measure dictionary.
- Combine PDFs; reorder pages by dragging thumbnails; rotate, delete, extract, insert pages.
- Lossless size reduction with qpdf (WebAssembly): object streams, recompress Flate at level 9, drop unused objects/resources. Images are never downsampled or re-encoded.
- Images (PNG, JPG, TIFF incl. multi-page, plus anything the browser can decode) to PDF.
- Autosave of open documents and markups in the browser (IndexedDB); refresh-safe.
- Owner-password-protected PDFs are decrypted locally with qpdf.

## Not in v1

Office/CAD (DWG/DXF) conversion, user-password PDFs, snapping to PDF drawing geometry, editing
markups made in other apps (they display but are not editable), bookmarks/forms preserved on save,
angle/radius/volume tools, cut-outs in areas, feet-inches display format, cloud sync between devices.

Third-party code: pdf.js (Apache-2.0), pdf-lib (MIT), qpdf / qpdf-wasm (Apache-2.0), UTIF.js (MIT).
