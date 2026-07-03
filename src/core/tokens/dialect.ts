/**
 * DTCG dialect helpers — legacy vs 2025.10 value encodings.
 *
 * The token pipeline historically speaks the "legacy" DTCG dialect: colors
 * as hex strings ("#4085F2"), FLOAT dimensions as bare numbers. The DTCG
 * 2025.10 spec (https://tr.designtokens.org/format/) switched to object
 * forms:
 *
 *   color     = { colorSpace: "srgb", components: [r, g, b], alpha?, hex? }
 *   dimension = { value: number, unit: "px" | "rem" }
 *   duration  = { value: number, unit: "ms" | "s" }   (we already emit this)
 *
 * Export stays legacy by default (downstream consumers depend on it) and
 * opts into 2025 via the `dtcgDialect` option. Import accepts BOTH dialects
 * unconditionally. This module centralizes:
 *
 *   - 2025 encoding helpers used by the dtcg/json formatters at render time
 *   - dialect-agnostic canonicalization used by the import diff so a 2025
 *     color object compares equal to the same color's legacy hex string
 *     (both are quantized to 1/255 per channel, tolerating the 8-bit
 *     precision loss inherent to hex)
 *   - stripping of the transient `rawColor` field the converter carries on
 *     COLOR TokenValues (full-precision floats for 2025 components) so it
 *     never leaks into serialized output
 */

/** Export dialect selector. `legacy` is the default everywhere. */
export type DtcgDialect = "legacy" | "2025";

/** Raw Figma color floats, 0–1 range. */
export interface RawRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function byteHex(f: number): string {
  return Math.round(clamp01(f) * 255)
    .toString(16)
    .padStart(2, "0");
}

/**
 * Canonicalize any color-like literal to a lowercase 8-digit hex string
 * (`#rrggbbaa`), or return null when the literal isn't recognizably a color.
 *
 * Accepts:
 *   - hex strings: #rgb, #rrggbb, #rrggbbaa
 *   - 2025.10 color objects with srgb (or unspecified) colorSpace +
 *     3 numeric components (+ optional alpha)
 *   - color objects with a hex fallback field (any colorSpace) + optional alpha
 *
 * Both the components form and the hex form quantize to 1 / 255 per channel,
 * so a full-precision components array compares equal to the hex string the
 * legacy pipeline derived from the same Figma floats.
 */
export function colorLiteralToCanonicalHex(literal: unknown): string | null {
  if (typeof literal === "string") {
    const m = literal
      .trim()
      .match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (!m) return null;
    let digits = m[1].toLowerCase();
    if (digits.length === 3) {
      digits = digits
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (digits.length === 6) digits += "ff";
    return `#${digits}`;
  }
  if (literal && typeof literal === "object" && !Array.isArray(literal)) {
    const o = literal as Record<string, unknown>;
    const colorSpace =
      typeof o.colorSpace === "string" ? o.colorSpace : undefined;
    const comps = o.components;
    if (
      (colorSpace === undefined || colorSpace === "srgb") &&
      Array.isArray(comps) &&
      comps.length === 3 &&
      comps.every((c) => typeof c === "number")
    ) {
      const [r, g, b] = comps as number[];
      const a = typeof o.alpha === "number" ? o.alpha : 1;
      return `#${byteHex(r)}${byteHex(g)}${byteHex(b)}${byteHex(a)}`;
    }
    if (typeof o.hex === "string") {
      const base = colorLiteralToCanonicalHex(o.hex);
      if (!base) return null;
      if (typeof o.alpha === "number") {
        return base.slice(0, 7) + byteHex(o.alpha);
      }
      return base;
    }
  }
  return null;
}

/**
 * Parse a hex color string to raw rgba floats (0–1). Returns null on
 * anything that isn't a valid 3/6/8-digit hex string.
 */
export function hexToRawRgba(hex: string): RawRgba | null {
  const canonical = colorLiteralToCanonicalHex(hex);
  if (!canonical) return null;
  const d = canonical.slice(1);
  return {
    r: parseInt(d.slice(0, 2), 16) / 255,
    g: parseInt(d.slice(2, 4), 16) / 255,
    b: parseInt(d.slice(4, 6), 16) / 255,
    a: parseInt(d.slice(6, 8), 16) / 255,
  };
}

/**
 * Encode a color TokenValue in the DTCG 2025.10 object form.
 *
 * Prefers the converter's transient `rawColor` floats (full precision — NOT
 * round-tripped through 8-bit hex); falls back to parsing a hex-string
 * literal. Literals already in object form pass through verbatim. Returns
 * null when the value can't be encoded (caller keeps the legacy rendering).
 *
 * `alpha` is emitted only when < 1; `hex` is always included as the interop
 * courtesy field (#RRGGBB, alpha carried separately).
 */
export function colorValueTo2025(value: {
  literal?: unknown;
  rawColor?: RawRgba;
}): Record<string, unknown> | null {
  const lit = value.literal;
  if (lit && typeof lit === "object" && !Array.isArray(lit)) {
    // Already object-form (e.g. a re-exported 2025 document) — pass through.
    const o = lit as Record<string, unknown>;
    if ("colorSpace" in o || "components" in o || "hex" in o) return o;
    return null;
  }
  let floats: RawRgba | null = value.rawColor ?? null;
  if (!floats && typeof lit === "string") {
    floats = hexToRawRgba(lit);
  }
  if (!floats) return null;
  const { r, g, b, a } = floats;
  return {
    colorSpace: "srgb",
    components: [r, g, b],
    ...(a < 1 ? { alpha: a } : {}),
    hex: `#${byteHex(r)}${byteHex(g)}${byteHex(b)}`.toUpperCase(),
  };
}

/**
 * Encode a dimension literal in the DTCG 2025.10 object form. The converter
 * emits Figma FLOAT dimensions as bare unitless numbers conventionally
 * interpreted as px (the same convention the css/json formatters use), so
 * only bare finite numbers are converted; everything else (unit strings,
 * pre-encoded objects) keeps its current rendering.
 */
export function dimensionLiteralTo2025(
  literal: unknown,
): { value: number; unit: "px" } | null {
  if (typeof literal === "number" && Number.isFinite(literal)) {
    return { value: literal, unit: "px" };
  }
  return null;
}

/**
 * Normalize a TokenValue to a dialect-agnostic comparable form for diffing:
 *
 *   - the transient `rawColor` field is dropped (Figma-side values carry it;
 *     parsed code-side values never do)
 *   - color-like literals (hex strings OR 2025 color objects) normalize to a
 *     lowercase 8-digit hex string, quantized to 1/255 per channel
 *   - `{ value, unit }` objects with px/ms normalize to the bare number
 *     ("s" converts to ms first), so `{value: 16, unit: "px"}` equals 16 and
 *     `{value: 0.3, unit: "s"}` equals `{value: 300, unit: "ms"}`
 *   - "16px"-style strings normalize to the bare number
 *
 * Conservative by design: anything not confidently recognized is returned
 * unchanged (minus rawColor), falling back to the existing deep comparison.
 */
export function canonicalizeTokenValueForComparison(v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const obj = v as Record<string, unknown>;
  if (!("literal" in obj) && !("reference" in obj)) return v;
  const { rawColor: _rawColor, ...rest } = obj;
  if (rest.literal !== undefined) {
    const hex = colorLiteralToCanonicalHex(rest.literal);
    if (hex !== null) return { ...rest, literal: hex };
    const num = numericLiteralToCanonical(rest.literal);
    if (num !== null) return { ...rest, literal: num };
  }
  return rest;
}

/**
 * Normalize dimension/duration-shaped literals to a bare comparable number:
 *   - `{ value: n, unit: "px" | "ms" }` → n
 *   - `{ value: n, unit: "s" }` → n * 1000 (canonical ms)
 *   - `"16px"` strings → 16
 * Returns null for everything else (including rem/em/% and objects with
 * extra fields — those keep structural comparison).
 */
function numericLiteralToCanonical(literal: unknown): number | null {
  if (typeof literal === "string") {
    const m = literal.trim().match(/^(-?(?:\d+\.?\d*|\.\d+))px$/i);
    return m ? Number(m[1]) : null;
  }
  if (
    literal &&
    typeof literal === "object" &&
    !Array.isArray(literal) &&
    Object.keys(literal).length === 2
  ) {
    const o = literal as Record<string, unknown>;
    if (typeof o.value === "number" && typeof o.unit === "string") {
      if (o.unit === "px" || o.unit === "ms") return o.value;
      if (o.unit === "s") return o.value * 1000;
    }
  }
  return null;
}

/**
 * Return a copy of a mode-keyed TokenValue map with the transient `rawColor`
 * field removed from every entry. Used wherever values get serialized
 * (lastSyncedValue snapshots, diff-plan samples) so the transient field never
 * appears in output — keeping legacy output byte-identical.
 */
export function stripRawColorFromValues<V extends { rawColor?: unknown }>(
  values: Record<string, V>,
): Record<string, Omit<V, "rawColor">> {
  const out: Record<string, Omit<V, "rawColor">> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v && typeof v === "object" && "rawColor" in v) {
      const { rawColor: _rawColor, ...rest } = v;
      out[k] = rest;
    } else {
      out[k] = v;
    }
  }
  return out;
}
