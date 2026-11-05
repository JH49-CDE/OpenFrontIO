/**
 * Test helper: what the GLSL preprocessor leaves of a shader when some
 * defines are NOT set. `#ifdef NAME` / `#ifndef NAME` blocks on the given
 * names are resolved (nesting, `#else`); every other directive and its
 * lines are kept as they are (their defines are unknown here).
 */
export function withoutDefines(src: string, names: readonly string[]): string {
  const off = new Set(names);
  // Per open block: whether it is one of ours, and whether its lines show.
  const stack: { ours: boolean; show: boolean; parent: boolean }[] = [];
  const shown = () => stack.every((b) => b.show);
  const out: string[] = [];
  for (const line of src.split("\n")) {
    const m = /^\s*#\s*(ifdef|ifndef|if|else|elif|endif)\b\s*(\w*)/.exec(line);
    if (m === null) {
      if (shown()) out.push(line);
      continue;
    }
    const [, dir, name] = m;
    if (dir === "ifdef" || dir === "ifndef") {
      const parent = shown();
      if (off.has(name)) {
        stack.push({ ours: true, show: dir === "ifndef", parent });
        continue;
      }
      stack.push({ ours: false, show: true, parent });
      if (parent) out.push(line);
    } else if (dir === "if") {
      const parent = shown();
      stack.push({ ours: false, show: true, parent });
      if (parent) out.push(line);
    } else if (dir === "else" || dir === "elif") {
      const top = stack[stack.length - 1];
      if (top?.ours) {
        top.show = !top.show;
        continue;
      }
      if (top?.parent !== false) out.push(line);
    } else {
      const top = stack.pop();
      if (top !== undefined && !top.ours && top.parent) out.push(line);
    }
  }
  return out.join("\n");
}
