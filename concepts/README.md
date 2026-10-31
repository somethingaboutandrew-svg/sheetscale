# PlanMark UI concepts (for choosing a direction)

Static, working HTML/CSS mockups built on the real demo sheet. `plan.png` is the demo wetland plan, marked up and exported by PlanMark itself (`scene.spec.ts`).

Open in a browser as `A.html?view=main|panel|start&theme=dark|light`. B works the same way, and C also has `view=radial`.

To regenerate the screenshots, run `node concepts/shoot.mjs A:main:dark ...`. Output goes to `screenshots/concepts/`.

- **A, Studio Pro:** dark graphite, frosted floating tool rail and contextual inspector, Figma/Linear feel.
- **B, Clean Desk:** light macOS-native, unified toolbar with Markup / Measure / Pages modes and labelled tools, source-list sidebar and inspector.
- **C, Field Focus:** maximised sheet, floating bottom dock, Space/right-click radial tool palette, slide-over panels, giant scale readout.
