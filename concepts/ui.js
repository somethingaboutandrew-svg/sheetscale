// Content builders shared by the concepts (each concept styles and places them differently).
(() => {
const I = window.IC;
const PAL = [['#E5484D','Red'],['#F76B15','Orange'],['#FFB224','Amber'],['#15803D','Green'],['#12A594','Teal'],['#1D4ED8','Blue'],['#7C3AED','Violet'],['#1C2024','Ink']];
const kbd = (k) => k.split(' ').map((x) => `<kbd>${x}</kbd>`).join('');
const swatches = (sel, id) => `<div class="swatches" role="radiogroup" aria-label="${id}">${PAL.map(([c, n]) => `<button class="sw${c === sel ? ' on' : ''}" style="--c:${c}" role="radio" aria-checked="${c === sel}" aria-label="${n}" title="${n}"></button>`).join('')}<button class="sw custom" aria-label="Custom colour" title="Custom colour…"></button></div>`;
const slider = (label, v, c) => `<div class="field"><label>${label}</label><div class="slider" style="--v:${v}%;--c:${c}"><div class="track"><div class="fillbar"></div><div class="knob"></div></div><output>${v}%</output></div></div>`;
const dashes = (on) => `<div class="seg dashes" role="radiogroup" aria-label="Line style">${[['solid',''],['dashed','6 4'],['dotted','0.5 4'],['cloud','cloud']].map(([n, d]) => `<button class="${n === on ? 'on' : ''}" role="radio" aria-checked="${n === on}" title="${n[0].toUpperCase() + n.slice(1)}">${d === 'cloud' ? '<svg viewBox="0 0 44 12"><path d="M2 9a4 4 0 018 0a4 4 0 018 0a4 4 0 018 0a4 4 0 018 0a4 4 0 018 0" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>' : `<svg viewBox="0 0 44 12"><path d="M3 6h38" stroke="currentColor" stroke-width="2" stroke-linecap="round" ${d ? `stroke-dasharray="${d}"` : ''}/></svg>`}</button>`).join('')}</div>`;
const widths = (on) => `<div class="seg widths" role="radiogroup" aria-label="Line width">${[0.5, 1, 1.5, 2, 3].map((w) => `<button class="${w === on ? 'on' : ''}" role="radio" aria-checked="${w === on}" title="${w} pt"><svg viewBox="0 0 28 14"><path d="M4 7h20" stroke="currentColor" stroke-width="${Math.max(0.8, w * 1.1)}" stroke-linecap="round"/></svg><span>${w}</span></button>`).join('')}</div>`;

window.UI = {
  I, kbd, PAL,
  props: () => `
    <div class="ph"><div class="ph-ic" style="--c:#15803D">${I['m-area']}</div><div><div class="ph-t">Area</div><div class="ph-s">Wetland A · Wetland Delineation</div></div><button class="ib" title="More">${I.more}</button></div>
    <div class="measure">
      <div class="m-main"><span class="m-v">16,579.04</span><span class="m-u">sq ft</span></div>
      <div class="m-sub"><span><b>0.381</b> ac</span><span class="dotsep"></span><span>Perimeter <b>504.05</b> ft</span></div>
      <div class="m-scale">${I.scale}<span>Page scale 1″ = 50′ · calibrated</span><button class="link">Change</button></div>
    </div>
    <section><h4>Stroke</h4>${swatches('#15803D', 'Stroke colour')}
      ${slider('Opacity', 100, '#15803D')}
      <div class="field"><label>Width</label>${widths(1.5)}</div>
      <div class="field"><label>Style</label>${dashes('solid')}</div>
    </section>
    <section><h4>Fill <span class="toggle on" role="switch" aria-checked="true" title="Fill on"><i></i></span></h4>${swatches('#15803D', 'Fill colour')}
      ${slider('Opacity', 25, '#22C55E')}
    </section>
    <section><h4>Label</h4>
      <div class="field"><label>Show</label><div class="seg txt"><button class="on">sq ft + ac</button><button>Area</button><button>None</button></div></div>
      <div class="field"><label>Size</label><div class="num"><button>−</button><span>10 pt</span><button>+</button></div></div>
    </section>
    <section><h4>Markup</h4>
      <div class="field"><label>Layer</label><div class="select"><span class="ldot" style="--c:#15803D"></span>Wetland Delineation${I.chevd}</div></div>
      <div class="field"><label>Note</label><div class="input">Wetland A, PFO/PEM complex</div></div>
      <div class="field"><label>Author</label><div class="input muted">Andrew Pocta · Oct 31</div></div>
    </section>
    <div class="pf"><button class="btn ghost">Set as tool default</button><button class="btn ghost">Save to Tool Chest</button></div>`,
  layers: () => {
    const L = [['Wetland Delineation', '#15803D', 4, true, false, true], ['Review Comments', '#E5484D', 3, true, false, false], ['Markups', '#1D4ED8', 0, true, true, false]];
    const P = [['Topography', true], ['Hydrology', true], ['Parcel & Survey', true]];
    return `<section><h4>Markup layers <button class="ib sm" title="New layer">${I.plus}</button></h4>
      ${L.map(([n, c, k, vis, lock, act]) => `<div class="lrow${act ? ' on' : ''}"><span class="ldot" style="--c:${c}"></span><span class="ln">${n}</span><span class="lk">${k}</span><button class="ib sm${vis ? '' : ' off'}" title="${vis ? 'Hide' : 'Show'}">${vis ? I.eye : I.eyeoff}</button><button class="ib sm${lock ? '' : ' faint'}" title="${lock ? 'Unlock' : 'Lock'}">${lock ? I.lock : I.unlock}</button></div>`).join('')}
    </section>
    <section><h4>PDF layers <span class="cap">from file</span></h4>
      ${P.map(([n, v]) => `<div class="lrow"><span class="lchk on">${I.check}</span><span class="ln">${n}</span><button class="ib sm" title="Hide">${I.eye}</button></div>`).join('')}
    </section>`;
  },
  markups: () => {
    const R = [['m-area', 'Area', 'Wetland A', '16,579.04 sq ft', '0.381 ac', '#15803D', true], ['m-count', 'Count', 'Wetland flags', '6 ea', '', '#EA580C'], ['m-polylength', 'Polylength', 'Unnamed tributary', '235.89 ft', '', '#1D4ED8'], ['m-length', 'Length', 'Buffer to Route 17', '118.06 ft', '', '#1D4ED8'], ['cloud', 'Cloud', 'Review Comments', '', '', '#E5484D'], ['callout', 'Callout', 'Confirm WL-4 flag location…', '', '', '#E5484D'], ['highlight', 'Highlight', 'Scale note', '', '', '#FFB224']];
    return `<div class="mfilter"><div class="search">${I.search}<span>Filter markups</span></div><button class="ib" title="Export CSV">${I.export}</button></div>
    <div class="mlist">${R.map(([t, k, n, v, v2, c, s]) => `<div class="mrow${s ? ' on' : ''}"><span class="mic" style="--c:${c}">${I[t]}</span><span class="mt"><b>${k}</b><small>${n}</small></span><span class="mv">${v}${v2 ? `<small>${v2}</small>` : ''}</span></div>`).join('')}</div>
    <div class="totals"><h4>Totals · page 1</h4><div><span>Area</span><b>16,579.04 sq ft <small>0.381 ac</small></b></div><div><span>Length</span><b>353.95 ft</b></div><div><span>Count</span><b>6 ea</b></div></div>`;
  },
  recent: () => [['W-1 Riverbend Commons — Wetland Delineation.pdf', 'Edited 9:14 AM · 2 pages · 7 markups', 'thumb.png'], ['W-2 Riverbend Commons — Buffer Plan.pdf', 'Edited yesterday · 1 page', 'thumb2.png'], ['Hampton Rd Parcel 12-B — JD Request.pdf', 'Oct 27 · 14 pages · 52 markups', 'thumb-clean.png'], ['Site 4 Stormwater — As-builts.pdf', 'Oct 22 · 9 pages', 'thumb2.png']],
};
})();
