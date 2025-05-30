import createLexer, { Lexer, Token } from "./lexer.js";
import { UnitValue, parseUnitValue } from "./units.js";

// Define node types for the AST
type NodeType = "id" | "+" | "-" | "*" | "/" | "^" | "()" | "neg";

interface BaseNode {
  type: NodeType;
}

interface IdNode extends BaseNode {
  type: "id";
  ref: number | Function;
  id: string;
}

interface BinaryOpNode extends BaseNode {
  type: "+" | "-" | "*" | "/" | "^";
  left: ASTNode;
  right: ASTNode;
}

interface FunctionCallNode extends BaseNode {
  type: "()";
  target: IdNode;
  args: ASTNode;
}

interface NegationNode extends BaseNode {
  type: "neg";
  value: ASTNode;
}

type ASTNode =
  | IdNode
  | BinaryOpNode
  | FunctionCallNode
  | NegationNode
  | UnitValue
  | number;

interface BindingPowers {
  [key: string]: number;
}

interface NudFunction {
  (token: Token, bp: number): ASTNode;
}

interface LedFunction {
  (left: ASTNode, token: Token, bp: number): ASTNode;
}

interface NudFunctions {
  [key: string]: NudFunction;
}

interface LedFunctions {
  [key: string]: LedFunction;
}

function parser(s: string): () => ASTNode {
  const lexer: Lexer = createLexer(s);

  // We'll check for adjacent numbers and consecutive operators during parsing
  const BPS: BindingPowers = {
    [null as unknown as string]: 0,
    NUMBER: 0,
    ID: 0,
    ")": 0,
    "+": 20,
    "-": 20,
    "*": 30,
    "/": 30,
    "^": 40,
    "(": 50,
  };

  const NUDS: NudFunctions = {
    NUMBER_WITH_UNIT: (t) => parseUnitValue(t.match!),
    NUMBER: (t) => new UnitValue(parseFloat(t.match!)),
    ID: (t) => {
      const mbr = Math[t.match! as keyof typeof Math];
      if (typeof mbr == "undefined") {
        // Get the input string position from the token
        let posInfo = "";
        try {
          if (t.strpos) {
            const pos = t.strpos();
            if (
              pos &&
              pos.start &&
              typeof pos.start.line === "number" &&
              typeof pos.start.column === "number"
            ) {
              posInfo = `at line ${pos.start.line}, column ${pos.start.column}`;
            }
          }
        } catch (e) {
          // If there's any error getting position, we'll use a generic message
        }

        throw new Error(
          `Unknown expression: '${t.match}'${
            posInfo ? " " + posInfo : ""
          }. Only Math constants and functions are supported.`
        );
      }
      return { type: "id", ref: mbr, id: t.match! } as IdNode;
    },
    "+": (_t, bp) => parse(bp),
    "-": (_t, bp) => ({ type: "neg", value: parse(bp) } as NegationNode),
    "(": () => {
      const inner = parse();
      lexer.expect(")");
      return inner;
    },
  };

  const LEDS: LedFunctions = {
    "+": (left, _t, bp) =>
      ({ type: "+", left, right: parse(bp) } as BinaryOpNode),
    "-": (left, _t, bp) =>
      ({ type: "-", left, right: parse(bp) } as BinaryOpNode),
    "*": (left, _t, bp) =>
      ({ type: "*", left, right: parse(bp) } as BinaryOpNode),
    "/": (left, _t, bp) =>
      ({ type: "/", left, right: parse(bp) } as BinaryOpNode),
    "^": (left, _t, bp) =>
      ({
        type: "^",
        left,
        right: parse(bp - 1),
      } as BinaryOpNode),
    "(": (left) => {
      if ((left as IdNode).type != "id") {
        throw new Error(`Cannot invoke expression as if it was a function`);
      }
      const idNode = left as IdNode;
      if (typeof idNode.ref != "function") {
        throw new Error(`Cannot invoke non-function`);
      }

      const args = parse();
      lexer.expect(")");
      return { type: "()", target: idNode, args } as FunctionCallNode;
    },
  };

  function bp(token: Token): number {
    return BPS[token.type as keyof typeof BPS] || 0;
  }

  function nud(token: Token): ASTNode {
    if (!NUDS[token.type as keyof typeof NUDS])
      throw new Error(
        `NUD not defined for token type: ${JSON.stringify(token.type)}`
      );
    return NUDS[token.type as keyof typeof NUDS](token, bp(token));
  }

  function led(left: ASTNode, token: Token): ASTNode {
    if (!LEDS[token.type as keyof typeof LEDS])
      throw new Error(
        `LED not defined for token type: ${JSON.stringify(token.type)}`
      );
    return LEDS[token.type as keyof typeof LEDS](left, token, bp(token));
  }

  // Check for adjacent numbers in the input
  function checkForAdjacentNumbers(): void {
    // Look ahead in the token stream for adjacent numbers
    for (let i = 0; i < lexer.tokens.length - 1; i++) {
      const current = lexer.tokens[i];
      const next = lexer.tokens[i + 1];

      // If we have two numbers in a row, that's an error
      if (
        (current.type === "NUMBER" || current.type === "NUMBER_WITH_UNIT") &&
        (next.type === "NUMBER" || next.type === "NUMBER_WITH_UNIT")
      ) {
        throw new Error("Adjacent numbers are not allowed");
      }
    }
  }

  // Check for consecutive operators
  function checkForConsecutiveOperators(): void {
    for (let i = 0; i < lexer.tokens.length - 1; i++) {
      const current = lexer.tokens[i];
      const next = lexer.tokens[i + 1];

      if (isOperator(current.type) && isOperator(next.type)) {
        // Special case: double minus (--) is not allowed
        if (current.type === "-" && next.type === "-") {
          throw new Error("Double minus (--) is not allowed");
        }

        // Allow for negative numbers after other operators (e.g., 1 + -2, 3 * -4)
        if (next.type === "-" && current.type !== "-") {
          // Negation is allowed after operators other than minus
          continue;
        }

        // All other consecutive operators are not allowed
        throw new Error("Consecutive operators are not allowed");
      }
    }
  }

  // Run validation checks before parsing
  checkForAdjacentNumbers();
  checkForConsecutiveOperators();

  // Check for unbalanced parentheses
  function checkForUnbalancedParentheses(): void {
    let openCount = 0;
    for (const token of lexer.tokens) {
      if (token.type === "(") openCount++;
      if (token.type === ")") {
        openCount--;
        if (openCount < 0) {
          throw new Error("Unmatched closing parenthesis");
        }
      }
    }
    if (openCount > 0) {
      throw new Error("Unmatched opening parenthesis");
    }
  }

  checkForUnbalancedParentheses();

  function parse(rbp = 0): ASTNode {
    const token = lexer.next();

    // Validate token
    if (token.type === null && !lexer.eof()) {
      throw new Error("Unexpected token in expression");
    }

    let left = nud(token);

    while (bp(lexer.peek()) > rbp) {
      left = led(left, lexer.next());
    }

    return left;
  }

  function isOperator(type: string | null): boolean {
    return (
      type === "+" ||
      type === "-" ||
      type === "*" ||
      type === "/" ||
      type === "^"
    );
  }

  return parse;
}

parser.visit = function visit(node: ASTNode): UnitValue {
  if (typeof node == "number") return new UnitValue(node);
  if (node instanceof UnitValue) return node;

  const nodeHandlers = {
    id: (n: IdNode) => {
      // Handle constants like PI by wrapping them in UnitValue
      return new UnitValue(n.ref as number);
    },
    "^": (n: BinaryOpNode) => {
      const left = visit(n.left);
      const right = visit(n.right);

      // Only allow power operations on unitless values
      if (!left.isUnitless() || !right.isUnitless()) {
        throw new Error(
          "Power operations can only be performed on unitless values"
        );
      }

      return new UnitValue(Math.pow(left.value, right.value));
    },
    "+": (n: BinaryOpNode) => {
      const left = visit(n.left);
      const right = visit(n.right);
      return left.add(right);
    },
    "-": (n: BinaryOpNode) => {
      const left = visit(n.left);
      const right = visit(n.right);
      return left.subtract(right);
    },
    "*": (n: BinaryOpNode) => {
      const left = visit(n.left);
      const right = visit(n.right);
      return left.multiply(right);
    },
    "/": (n: BinaryOpNode) => {
      const left = visit(n.left);
      const right = visit(n.right);
      return left.divide(right);
    },
    "()": (node: FunctionCallNode) => {
      const args = visit(node.args);
      // Math functions should only operate on the numeric value
      if (
        node.target.id === "floor" ||
        node.target.id === "ceil" ||
        node.target.id === "abs" ||
        node.target.id === "cos"
      ) {
        return new UnitValue(
          (node.target.ref as Function)(args.value),
          args.unit
        );
      }
      // For constants like PI, we need to return a UnitValue
      if (typeof node.target.ref === "number") {
        return new UnitValue(node.target.ref);
      }
      // For other functions, ensure we're passing the value, not the UnitValue object
      return new UnitValue((node.target.ref as Function)(args.value));
    },
    neg: (n: NegationNode) => {
      const value = visit(n.value);
      return value.negate();
    },
  };

  const typedNode = node as BaseNode;
  return nodeHandlers[typedNode.type as keyof typeof nodeHandlers](node as any);
};

parser.calc = function calc(s: string): number | string {
  const parse = parser(s);
  const result = parser.visit(parse());
  // Make sure result is a UnitValue before checking isUnitless
  if (!(result instanceof UnitValue)) {
    // If not a UnitValue, convert it to one
    return result as unknown as number;
  }

  // Return number for unitless values, string for values with units
  if (result.isUnitless()) {
    // If this is a result of dividing same units, return as string
    if (result.fromUnitDivision) {
      return result.value.toString();
    }
    return result.value;
  } else {
    return result.toString();
  }
};

export default parser;
export { parser };
export const calc = parser.calc;
