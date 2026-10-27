// Shared visual defaults and browser-safe pure helpers for the frosted workbench.
// The two functions below are serialized into the page by visualRuntimeSource();
// keep them self-contained (no imports or references to module-scope bindings).

export const APPEARANCE_MODES = Object.freeze(['legacy', 'workbench']);

// Applied only by the explicit `appearance.set workbench` command. Merely reading
// an old config never opts the user into this mode or rewrites their settings.
export const WORKBENCH_FX = Object.freeze({
  appearance: 'workbench',
  opacity: 0.50,
  brightness: 0.80,
  contrast: 1.02,
  saturate: 0.85,
  blur: 0,
  dim: 0.10,
  fadeMs: 900,
  transition: 'fade',
  panelAlpha: 0.64,
  panelAlphaDark: 0.64,
  panelBlur: 16,
  composerAlpha: 0.86,
  sidebarAlpha: 0.78,
  sidebarAlphaDark: 0.78,
  sidebarBlur: 16,
  autoTint: false,
  autoReadability: true,
});

export function adaptWorkbenchAlphas(base, luminance, theme, enabled) {
  const source = base || {};
  const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const baseline = {
    main: numberOr(source.main, 0.64),
    sidebar: numberOr(source.sidebar, 0.78),
    composer: numberOr(source.composer, 0.86),
  };
  if (!enabled || !Number.isFinite(luminance)) return baseline;
  const light = theme === 'light';
  const limits = light
    ? { main: [0.58, 0.82], sidebar: [0.74, 0.90], composer: [0.84, 0.96] }
    : { main: [0.58, 0.74], sidebar: [0.74, 0.84], composer: [0.84, 0.92] };
  const clamp = (value, range) => Math.min(range[1], Math.max(range[0], value));
  const lum = Math.min(1, Math.max(0, luminance));
  // Bright images need a stronger dark mask; dark images need a stronger light
  // mask. At most +/-0.06 changes, never the host theme or the saved sliders.
  const delta = (light ? 0.5 - lum : lum - 0.5) * 0.12;
  const rounded = (value) => Math.round(value * 1000) / 1000;
  return {
    main: rounded(clamp(baseline.main + delta, limits.main)),
    sidebar: rounded(clamp(baseline.sidebar + delta, limits.sidebar)),
    composer: rounded(clamp(baseline.composer + delta, limits.composer)),
  };
}

export function visualSampleIsCurrent(sample, current) {
  return !!(sample && current
    && sample.token === current.token
    && sample.key === current.key
    && sample.appearance === current.appearance
    && sample.readability === current.readability);
}

export function visualRuntimeSource() {
  return `;window.__weVisual={adapt:${adaptWorkbenchAlphas.toString()},isCurrent:${visualSampleIsCurrent.toString()}};\n`;
}
