# PlanMark

PlanMark is a private PDF markup and measurement tool for plan sheets. It's my own Bluebeam-style app. You can:

- Calibrate the scale and measure length, area (sq ft / acres) and counts.
- Mark up sheets, with layers.
- Combine PDFs, lossless size reduction, and images to PDF.

**Your files stay on your device.** Everything (opening, editing, combining, compressing) runs locally in the browser or the desktop app. Nothing is uploaded, and there is no server, account or tracking.

- **Web app:** https://somethingaboutandrew-svg.github.io/planmark/. It works offline after the first visit, and you can install it from the browser menu.
- **Mac app:** download from [Releases](https://github.com/somethingaboutandrew-svg/planmark/releases). Use `PlanMark-…-mac-arm64.zip` on Apple Silicon (M1–M4) and `…-mac-x64.zip` on Intel Macs. The app is not notarized, so the first time you open it:
  1. Unzip it and drag **PlanMark.app** to Applications.
  2. Right-click (or Control-click) **PlanMark.app**, choose **Open**, then click **Open** again.
  3. If macOS only offers *Done / Move to Trash*: open **System Settings → Privacy & Security**, scroll to *"PlanMark" was blocked…*, click **Open Anyway**, and confirm.
  4. If it says *"PlanMark is damaged and can't be opened"*, run this in Terminal, then open it again:
     `xattr -cr /Applications/PlanMark.app`

## Develop

    npm install
    npm run build        # static site in dist/
    npm run preview      # http://localhost:4173
    npm test             # Playwright tests

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
