/**
 * Render a gradient token's literal as a CSS gradient function, shared by
 * the CSS-shaped formatters (CSS vars, SCSS, Tailwind v4, Tailwind v3).
 *
 * Accepts both shapes a gradient literal arrives in:
 *   - the internal composite `{ type, angle?, stops }` (GradientValue)
 *   - the DTCG spec form: `$value` is a plain array of `{ color, position }`
 *     stops, rendered as `linear-gradient(<stops>)`
 *
 * Stop colors may be CSS color strings or DTCG 2025.10 color objects
 * (srgb components or a `hex` field). A stop color that is an alias
 * reference (`{core.red}`) can't be expressed inside a gradient value here,
 * so the token is skipped with a reason rather than emitting broken CSS.
 */
import { colorLiteralToCanonicalHex } from "../dialect.js";
import { num } from "./composed-color.js";

export type GradientResult = { css: string } | { skip: string };

const isReference = (v: unknown): v is string =>
  typeof v === "string" && /^\{[^}]+\}$/.test(v.trim());

function stopColor(color: unknown): string | null {
  if (typeof color === "string") return color;
  const hex = colorLiteralToCanonicalHex(color);
  if (!hex) return null;
  // Drop the alpha byte when fully opaque: #rrggbbff → #rrggbb.
  return hex.endsWith("ff") ? hex.slice(0, 7) : hex;
}

export function renderGradient(literal: unknown): GradientResult {
  if (!literal || typeof literal !== "object") return { skip: "unparseable gradient value" };
  const isSpecArray = Array.isArray(literal);
  const g = (isSpecArray ? { type: "linear", stops: literal } : literal) as Record<string, unknown>;
  const stops = Array.isArray(g.stops) ? g.stops : null;
  if (!stops || stops.length === 0) return { skip: "unparseable gradient value" };

  const rendered: string[] = [];
  for (const s of stops) {
    if (!s || typeof s !== "object") return { skip: "unparseable gradient value" };
    const stop = s as Record<string, unknown>;
    if (isReference(stop.color) || isReference(stop.position)) {
      const ref = isReference(stop.color) ? stop.color : stop.position;
      return { skip: `gradient stop references ${ref}, which can't be resolved inside a gradient value` };
    }
    const color = stopColor(stop.color);
    if (!color) return { skip: "unparseable gradient value" };
    if (typeof stop.position !== "number") {
      rendered.push(color);
      continue;
    }
    // Positions are 0–1 fractions (DTCG); values above 1 are taken as percent.
    const pct = stop.position <= 1 ? stop.position * 100 : stop.position;
    rendered.push(`${color} ${num(pct)}%`);
  }

  const stopList = rendered.join(", ");
  const angle = typeof g.angle === "number" ? g.angle : undefined;
  if (g.type === "linear") {
    return { css: `linear-gradient(${angle !== undefined ? `${num(angle)}deg, ` : ""}${stopList})` };
  }
  if (g.type === "radial") return { css: `radial-gradient(${stopList})` };
  if (g.type === "conic") {
    return { css: `conic-gradient(${angle !== undefined ? `from ${num(angle)}deg, ` : ""}${stopList})` };
  }
  return { skip: "unparseable gradient value" };
}
