/**
 * Which map renderer a live game uses: the default WebGL2 `MapRenderer`, or
 * the opt-in Three.js prototype (`ThreeMapRenderer`).
 *
 * Opt in with `?renderer=three` (remembered in localStorage), opt back out
 * with `?renderer=webgl` (or `gl`). Deliberately tiny and free of imports: the
 * homepage loads it, and three itself is only ever fetched with `import()`
 * once a game starts with the flag on.
 */

/** localStorage key holding the remembered choice ("three" or absent). */
export const RENDERER_STORAGE_KEY = "openfront.renderer";
/** URL query parameter that selects the renderer. */
export const RENDERER_URL_PARAM = "renderer";

type RendererChoice = "three" | "webgl";

function currentSearch(): string {
  try {
    return globalThis.location?.search ?? "";
  } catch {
    return "";
  }
}

/** The renderer named in a query string, or null when it names none. */
function urlChoice(search: string): RendererChoice | null {
  let value: string | null;
  try {
    value = new URLSearchParams(search).get(RENDERER_URL_PARAM);
  } catch {
    return null;
  }
  switch (value?.trim().toLowerCase()) {
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
 * Persist a renderer named in the URL: `three` is remembered, `webgl`/`gl`
 * forgets it. Does nothing when the URL names no renderer. Pass the query
 * string captured at page load if the address bar may have been rewritten
 * since.
 */
export function syncRendererPreferenceFromUrl(
  search: string = currentSearch(),
): void {
  const choice = urlChoice(search);
  if (choice === null) return;
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

/** True when the Three.js renderer should be used: the URL wins, else storage. */
export function isThreeRendererRequested(
  search: string = currentSearch(),
): boolean {
  return (urlChoice(search) ?? storedChoice()) === "three";
}
