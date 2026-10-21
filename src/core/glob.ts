/** Minimal glob -> RegExp conversion (supports **, *, ?, {a,b}). Paths use '/' separators. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  let inGroup = false;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**/' = zero or more folders; trailing '**' = anything
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      inGroup = true;
      re += '(?:';
    } else if (c === '}' && inGroup) {
      inGroup = false;
      re += ')';
    } else if (c === ',' && inGroup) {
      re += '|';
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
    i++;
  }
  return new RegExp(`^${re}$`, 'i');
}

export function makeMatcher(globs: string[]): (path: string) => boolean {
  const res = globs.filter((g) => g.trim()).map(globToRegExp);
  return (path) => res.some((r) => r.test(path));
}
