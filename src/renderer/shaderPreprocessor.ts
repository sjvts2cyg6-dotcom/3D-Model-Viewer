/**
 * Minimal WGSL preprocessor for compile-time feature flags.
 *
 *   #if NAME      #if !NAME      #else      #endif     (nestable)
 *
 * Directive lines and disabled lines are replaced by blank lines so WGSL
 * compiler line numbers still match the source file.
 */
export type Defines = Readonly<Record<string, boolean>>;

const DIRECTIVE = /^\s*#(if|else|endif)\b\s*(!?)\s*(\w*)\s*$/;

export function preprocessWgsl(source: string, defines: Defines): string {
  const out: string[] = [];
  // Each frame: is this branch active, and was the enclosing scope active?
  const stack: { active: boolean; parent: boolean }[] = [];
  let active = true;

  source.split('\n').forEach((line, i) => {
    const m = DIRECTIVE.exec(line);
    if (!m) {
      out.push(active ? line : '');
      return;
    }
    const [, kind, neg, name] = m;
    if (kind === 'if') {
      if (!name) throw new Error(`WGSL preprocessor: #if without a name (line ${i + 1})`);
      const value = !!defines[name] !== (neg === '!');
      stack.push({ active: value, parent: active });
      active = active && value;
    } else {
      const top = stack[stack.length - 1];
      if (!top) throw new Error(`WGSL preprocessor: #${kind} without #if (line ${i + 1})`);
      if (kind === 'else') {
        top.active = !top.active;
        active = top.parent && top.active;
      } else {
        stack.pop();
        active = top.parent;
      }
    }
    out.push('');
  });

  if (stack.length) throw new Error('WGSL preprocessor: unterminated #if');
  return out.join('\n');
}
