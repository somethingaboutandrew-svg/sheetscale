// Places the real rendered demo sheet (with markups exported by PlanMark) and draws a live selection overlay.
window.planSheet = (opts = {}) => {
  const ring = window.SCENE.ring;
  const W = 1224, H = 792;
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const bx = Math.min(...xs) - 6, by = Math.min(...ys) - 6, bw = Math.max(...xs) - bx + 6, bh = Math.max(...ys) - by + 6;
  const sel = opts.select === false ? '' : `
    <polygon points="${ring.map((p) => p.join(',')).join(' ')}" fill="none" stroke="var(--sel)" stroke-width="2.2" vector-effect="non-scaling-stroke"/>
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="none" stroke="var(--sel)" stroke-width="1" stroke-dasharray="5 4" vector-effect="non-scaling-stroke" opacity=".8"/>
    ${ring.map((p) => `<rect x="${p[0] - 3.4}" y="${p[1] - 3.4}" width="6.8" height="6.8" rx="1.6" fill="#fff" stroke="var(--sel)" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`).join('')}`;
  const tip = opts.tip ? `<div class="mtip" style="left:${((bx + bw) / W) * 100}%;top:${(by / H) * 100}%">${opts.tip}</div>` : '';
  return `<div class="sheet"><img src="${opts.clean ? 'plan-clean.png' : 'plan.png'}" alt="Riverbend Commons wetland delineation plan" draggable="false"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${sel}</svg>${tip}</div>`;
};
window.Q = new URLSearchParams(location.search);
document.documentElement.dataset.theme = Q.get('theme') || document.documentElement.dataset.theme || 'light';
document.documentElement.dataset.view = Q.get('view') || 'main';
