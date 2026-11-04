/**
 * Which map renderer a live game uses: the default WebGL2 `MapRenderer`, or
 * the opt-in Three.js prototype (`ThreeMapRenderer`), and the `three_*`
 * quality parameters that the prototype reads.
 *
 * Opt in with `?renderer=three` (remembered in localStorage), opt back out
 * with `?renderer=webgl` (or `gl`). Deliberately tiny and free of imports: the
 * homepage loads it, and three itself is only ever fetched with `import()`
 * once a game starts with the flag on.
 *
 * The homepage rewrites the address bar when a game starts (solo and
 * multiplayer alike), so nothing here may read `location.search` at game
 * start and expect the page-load query. Main captures the query string at
 * bootstrap and hands it to `syncRendererPreferenceFromUrl`, which remembers
 * both the renderer choice and the `three_*` parameters.
 */

/** localStorage key holding the remembered choice ("three" or absent). */
export const RENDERER_STORAGE_KEY = "openfront.renderer";
/** URL query parameter that selects the renderer. */
export const RENDERER_URL_PARAM = "renderer";
/** Prefix of the Three.js renderer's own URL parameters (`three_quality`…). */
export const THREE_URL_PARAM_PREFIX = "three_";
/**
 * sessionStorage key holding the `three_*` parameters of the last page load
 * that named any, as a query string. Per tab, so a game started after the
 * in-game Quit button (which reloads the homepage without a query) keeps them.
 */
export const THREE_PARAMS_SESSION_KEY = "openfront.threeParams";

type RendererChoice = "three" | "webgl";

// What the page-load URL said, captured by syncRendererPreferenceFromUrl
// (null before it runs, or when the URL said nothing): covers this page load
// even when storage is blocked.
let pageChoice: RendererChoice | null = null;
let pageThreeParams: string | null = null;

function currentSearch(): string {
  try {
    return globalThis.location?.search ?? "";
  } catch {
    return "";
  }
}

function parse(search: string): URLSearchParams | null {
  try {
    return new URLSearchParams(search);
  } catch {
    return null;
  }
}

/** The renderer named in a query string, or null when it names none. */
function urlChoice(search: string): RendererChoice | null {
  switch (parse(search)?.get(RENDERER_URL_PARAM)?.trim().toLowerCase()) {
    case "three":
      return "three";
    case "webgl":
    case "gl":
      return "webgl";
    default:
      return null;
  }
}

function storedChoice(): RendererChoice | null {
  try {
    return globalThis.localStorage?.getItem(RENDERER_STORAGE_KEY) === "three"
      ? "three"
      : null;
  } catch {
    return null;
  }
}

/**
 * The `three_*` parameters of a query string, re-encoded as a query string
 * (`"three_quality=low&three_bloom=0"`), or "" when it has none.
 */
export function threeParamsOf(search: string): string {
  const params = parse(search);
  if (params === null) return "";
  const kept = new URLSearchParams();
  for (const [key, value] of params) {
    if (key.startsWith(THREE_URL_PARAM_PREFIX)) kept.append(key, value);
  }
  return kept.toString();
}

/** True when a query string names a renderer or any `three_*` parameter. */
export function namesRendererParams(search: string): boolean {
  const params = parse(search);
  if (params === null) return false;
  for (const key of params.keys()) {
    if (key === RENDERER_URL_PARAM || key.startsWith(THREE_URL_PARAM_PREFIX)) {
      return true;
    }
  }
  return false;
}

/**
 * Persist what the page-load URL says about the renderer:
 * - `renderer=three` is remembered, `renderer=webgl`/`gl` forgets it, and
 *   any other value (or none) leaves the stored choice alone;
 * - when the URL names a renderer or any `three_*` parameter, its `three_*`
 *   parameters (possibly none) replace those remembered for this tab.
 *
 * Does nothing when the URL names neither. Pass the query string captured at
 * page load: the address bar is rewritten once a game starts.
 */
export function syncRendererPreferenceFromUrl(
  search: string = currentSearch(),
): void {
  const choice = urlChoice(search);
  if (choice !== null) {
    pageChoice = choice;
    try {
      if (choice === "three") {
        globalThis.localStorage?.setItem(RENDERER_STORAGE_KEY, "three");
      } else {
        globalThis.localStorage?.removeItem(RENDERER_STORAGE_KEY);
      }
    } catch {
      // Storage blocked (private mode, sandboxed iframe): the URL still works
      // for this page load.
    }
  }
  if (!namesRendererParams(search)) return;
  pageThreeParams = threeParamsOf(search);
  try {
    if (pageThreeParams === "") {
      globalThis.sessionStorage?.removeItem(THREE_PARAMS_SESSION_KEY);
    } else {
      globalThis.sessionStorage?.setItem(
        THREE_PARAMS_SESSION_KEY,
        pageThreeParams,
      );
    }
  } catch {
    // Storage blocked: the captured copy still covers this page load.
  }
}

/**
 * The `three_*` parameters in effect, as a query string for
 * `readThreeSettingsFromUrl`. In order: those captured at this page load by
 * `syncRendererPreferenceFromUrl`; else those still in the address bar (an
 * entry point that never ran the sync); else those remembered for this tab;
 * else "".
 */
export function threeSettingsSearch(): string {
  if (pageThreeParams !== null) return pageThreeParams;
  const live = threeParamsOf(currentSearch());
  if (live !== "") return live;
  try {
    return globalThis.sessionStorage?.getItem(THREE_PARAMS_SESSION_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * True when the Three.js renderer should be used: the URL wins, else storage.
 * Without an explicit query string, the live address bar comes first, then
 * the renderer the page-load URL named (in case storage is blocked and the
 * address bar was rewritten since), then storage.
 */
export function isThreeRendererRequested(search?: string): boolean {
  const fromUrl =
    urlChoice(search ?? currentSearch()) ??
    (search === undefined ? pageChoice : null);
  return (fromUrl ?? storedChoice()) === "three";
}
