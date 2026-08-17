/**
 * A deliberately tiny expression language for `branch` node conditions.
 *
 * Grammar (recursive descent, no evaluation of arbitrary code):
 *
 *   or         := and ( "||" and )*
 *   and        := comparison ( "&&" comparison )*
 *   comparison := unary ( ( "==" | "!=" ) unary )?
 *   unary      := "!" unary | primary
 *   primary    := "(" or ")" | identifier | string | number | boolean
 *
 * There is no `eval`, no property access, and no function calls by design:
 * scenario files are content, and content must never be able to execute code.
 */

export type Value = string | number | boolean | undefined;
export type Vars = Readonly<Record<string, Value>>;

export class ExprError extends Error {}

type Token =
  | { kind: 'ident'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'op'; value: '==' | '!=' | '&&' | '||' | '!' | '(' | ')' };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i]!;

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    if (c === '(' || c === ')') {
      tokens.push({ kind: 'op', value: c });
      i++;
      continue;
    }

    if (c === '=' || c === '!') {
      if (src[i + 1] === '=') {
        tokens.push({ kind: 'op', value: c === '=' ? '==' : '!=' });
        i += 2;
        continue;
      }
      if (c === '!') {
        tokens.push({ kind: 'op', value: '!' });
        i++;
        continue;
      }
      throw new ExprError(`Unexpected "=" at position ${i} (use "==" for comparison)`);
    }

    if (c === '&' || c === '|') {
      if (src[i + 1] === c) {
        tokens.push({ kind: 'op', value: c === '&' ? '&&' : '||' });
        i += 2;
        continue;
      }
      throw new ExprError(`Unexpected "${c}" at position ${i} (use "${c}${c}")`);
    }

    if (c === '"' || c === "'") {
      const quote = c;
      let value = '';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          value += src[i + 1];
          i += 2;
          continue;
        }
        value += src[i];
        i++;
      }
      if (i >= src.length) throw new ExprError(`Unterminated string literal in: ${src}`);
      i++; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }

    if (DIGIT.test(c)) {
      let raw = '';
      while (i < src.length && (DIGIT.test(src[i]!) || src[i] === '.')) {
        raw += src[i];
        i++;
      }
      const num = Number(raw);
      if (Number.isNaN(num)) throw new ExprError(`Invalid number "${raw}"`);
      tokens.push({ kind: 'number', value: num });
      continue;
    }

    if (IDENT_START.test(c)) {
      let name = '';
      while (i < src.length && IDENT_PART.test(src[i]!)) {
        name += src[i];
        i++;
      }
      if (name === 'true' || name === 'false') {
        tokens.push({ kind: 'boolean', value: name === 'true' });
      } else {
        tokens.push({ kind: 'ident', value: name });
      }
      continue;
    }

    throw new ExprError(`Unexpected character "${c}" at position ${i}`);
  }

  return tokens;
}

export type Node =
  | { kind: 'literal'; value: Value }
  | { kind: 'var'; name: string }
  | { kind: 'not'; operand: Node }
  | { kind: 'binary'; op: '==' | '!=' | '&&' | '||'; left: Node; right: Node };

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eatOp(value: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'op' && t.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  parse(): Node {
    const node = this.or();
    if (this.pos < this.tokens.length) {
      throw new ExprError(`Unexpected trailing input in expression`);
    }
    return node;
  }

  private or(): Node {
    let left = this.and();
    while (this.eatOp('||')) {
      left = { kind: 'binary', op: '||', left, right: this.and() };
    }
    return left;
  }

  private and(): Node {
    let left = this.comparison();
    while (this.eatOp('&&')) {
      left = { kind: 'binary', op: '&&', left, right: this.comparison() };
    }
    return left;
  }

  private comparison(): Node {
    const left = this.unary();
    for (const op of ['==', '!='] as const) {
      if (this.eatOp(op)) {
        return { kind: 'binary', op, left, right: this.unary() };
      }
    }
    return left;
  }

  private unary(): Node {
    if (this.eatOp('!')) return { kind: 'not', operand: this.unary() };
    return this.primary();
  }

  private primary(): Node {
    const t = this.peek();
    if (!t) throw new ExprError('Unexpected end of expression');

    if (t.kind === 'op' && t.value === '(') {
      this.pos++;
      const inner = this.or();
      if (!this.eatOp(')')) throw new ExprError('Missing closing ")"');
      return inner;
    }

    if (t.kind === 'ident') {
      this.pos++;
      return { kind: 'var', name: t.value };
    }

    if (t.kind === 'string' || t.kind === 'number' || t.kind === 'boolean') {
      this.pos++;
      return { kind: 'literal', value: t.value };
    }

    throw new ExprError(`Unexpected token "${t.value}" in expression`);
  }
}

/** Parses an expression. Throws ExprError on malformed input. */
export function parseExpr(src: string): Node {
  if (src.trim() === '') throw new ExprError('Empty expression');
  return new Parser(tokenize(src)).parse();
}

/** Collects every variable name referenced, so the validator can warn on typos. */
export function referencedVars(node: Node, into: Set<string> = new Set()): Set<string> {
  switch (node.kind) {
    case 'var':
      into.add(node.name);
      break;
    case 'not':
      referencedVars(node.operand, into);
      break;
    case 'binary':
      referencedVars(node.left, into);
      referencedVars(node.right, into);
      break;
    case 'literal':
      break;
  }
  return into;
}

function truthy(v: Value): boolean {
  return v !== undefined && v !== false && v !== '' && v !== 0;
}

/**
 * Comparison is intentionally loose about number/string, because YAML authors
 * write `round == 2` and the variable may have arrived as the string "2".
 * Everything else compares strictly.
 */
function looseEquals(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof a === 'string' && typeof b === 'number') return a === String(b);
  return false;
}

export function evaluate(node: Node, vars: Vars): boolean {
  return truthy(evalValue(node, vars));
}

function evalValue(node: Node, vars: Vars): Value {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'var':
      return vars[node.name];
    case 'not':
      return !truthy(evalValue(node.operand, vars));
    case 'binary': {
      switch (node.op) {
        case '==':
          return looseEquals(evalValue(node.left, vars), evalValue(node.right, vars));
        case '!=':
          return !looseEquals(evalValue(node.left, vars), evalValue(node.right, vars));
        case '&&':
          return truthy(evalValue(node.left, vars)) && truthy(evalValue(node.right, vars));
        case '||':
          return truthy(evalValue(node.left, vars)) || truthy(evalValue(node.right, vars));
      }
    }
  }
}

/** Convenience for the engine: parse and evaluate in one step. */
export function testCondition(src: string, vars: Vars): boolean {
  return evaluate(parseExpr(src), vars);
}
