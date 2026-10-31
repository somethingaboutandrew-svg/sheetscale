# PlanMark

PlanMark is a private PDF markup and measurement tool for plan sheets. It's my own Bluebeam-style app. You can:

- Calibrate the scale and measure length, area (sq ft / acres) and counts.
- Mark up sheets, with layers.
- Combine PDFs, lossless size reduction, and images to PDF.

The default look is a light "Liquid Glass" theme: a pale grey canvas with frosted side panels. A dark theme, or following your computer's setting, is under the Appearance button in the title bar. If your system is set to reduce transparency, the panels go solid.

**Your files stay on your device.** Everything (opening, editing, combining, compressing) runs locally in the browser or the desktop app. Nothing is uploaded, and there is no server, account or tracking.

- **Web app:** https://somethingaboutandrew-svg.github.io/planmark/. It works offline after the first visit, and you can install it from the browser menu.
- **Mac app:** download from [Releases](https://github.com/somethingaboutandrew-svg/planmark/releases). Use `PlanMark-…-mac-arm64.zip` on Apple Silicon (M1–M4) and `…-mac-x64.zip` on Intel Macs. The app is not notarized, so the first time you open it:
  1. Unzip it and drag **PlanMark.app** to Applications.
  2. Right-click (or Control-click) **PlanMark.app**, choose **Open**, then click **Open** again.
  3. If macOS only offers *Done / Move to Trash*: open **System Settings → Privacy & Security**, scroll to *"PlanMark" was blocked…*, click **Open Anyway**, and confirm.
  4. If it says *"PlanMark is damaged and can't be opened"*, run this in Terminal, then open it again:
     `xattr -cr /Applications/PlanMark.app`

## Big files

PlanMark is built for report sets of a few hundred pages. On the test set (three 100-page reports with photos and full-sheet maps, 125 MB in total, combined into one 300-page PDF), it opens the first report in under a second, scrolls all 300 pages at 60 fps and keeps the whole browser at about 2.4–2.9 GB of memory at peak, even while saving and reducing the combined file. Pages and thumbnails render in a background worker, and saving runs in a worker that is thrown away afterwards, so the app stays responsive. Full numbers and method: [docs/PERF.md](docs/PERF.md).

## Develop

    npm install
    npm run build        # static site in dist/
    npm run preview      # http://localhost:4173
    npm test             # Playwright tests (features, UI, screenshots)
    npm run test:perf    # 300-page and large-plan performance run (builds ~125 MB of fixtures first)
    npm run test:desktop # desktop shell tests (Linux build of the Electron app)

    cd desktop && npm install
    npm run dist:mac     # Electron app zips (arm64 + x64) in desktop/release/

See [docs/FEATURES.md](docs/FEATURES.md) for the full feature list.

## License

MIT, see [LICENSE](LICENSE). Bundled third-party code keeps its own licenses:

- pdf.js (Apache-2.0)
- pdf-lib (MIT)
- qpdf / qpdf-wasm (Apache-2.0)
- UTIF.js (MIT)
- Electron (MIT)
