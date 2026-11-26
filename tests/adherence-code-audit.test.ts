import { auditCode, scoreCodeAudit, tokenNamesFrom } from "../src/core/adherence/code-audit";

const good = {
	path: "src/Pricing.tsx",
	content: `import { Button, Card } from "@acme/ui";
export function Pricing() {
  return (
    <Card style={{ gap: "var(--space-4)" }}>
      <Button variant="primary">Buy</Button>
      <p className="text-[color:var(--text-muted)]">Billed yearly</p>
    </Card>
  );
}`,
};

const bad = {
	path: "src/Checkout.tsx",
	content: `import { Button } from "@acme/ui";
import { Card } from "./Card";
const Badge = ({ children }) => <span>{children}</span>;
export function Checkout() {
  return (
    <div style={{ padding: 13, borderRadius: "6px", color: "#3366ff" }}>
      <button onClick={pay}>Pay</button>
      <div className="bg-[#fafafa] p-[13px]">Total</div>
      <span style={{ color: "var(--brand-blue-450)" }}>Promo</span>
      <a href="#top">Top</a>
    </div>
  );
}`,
};

const ds = { packages: ["@acme/ui"], components: ["Button", "Card", "Badge", "Input"], tokens: ["space-4", "text-muted"] };

describe("code adherence audit", () => {
	it("passes code that uses system components and tokens", () => {
		const r = auditCode([good], ds);
		const v = scoreCodeAudit(r);
		expect(r.stats.dsComponentUses).toBe(2);
		expect(r.findings.filter((f) => f.severity !== "info")).toEqual([]);
		expect(v.pass).toBe(true);
	});

	it("flags re-implementations, invented tokens, raw elements and literals", () => {
		const r = auditCode([bad], ds);
		const rules = r.findings.map((f) => `${f.rule}@${f.line}`);
		expect(rules).toEqual(
			expect.arrayContaining([
				"local-lookalike-import@2", // local Card while the system has Card (source not audited)
				"reimplements-component@3", // local Badge
				"hardcoded-length@6",
				"hardcoded-color@6",
				"raw-element@7",
				"tailwind-arbitrary-value@8",
				"unknown-token@9",
			]),
		);
		expect(rules).not.toContain("hardcoded-color@10"); // href="#top" is an anchor
		const v = scoreCodeAudit(r);
		expect(v.pass).toBe(false);
		expect(v.errors).toBe(2);
	});

	it("reads token names from CSS and DTCG JSON", () => {
		expect(tokenNamesFrom("t.css", ":root { --space-4: 16px; --text-muted: #666; }")).toEqual(["space-4", "text-muted"]);
		expect(tokenNamesFrom("t.json", JSON.stringify({ color: { brand: { $value: "#00f", $type: "color" } } }))).toContain("color-brand");
	});

	it("doesn't flag a wrapper that renders the system component", () => {
		const wrapper = { path: "src/Submit.tsx", content: `import { Button } from "@acme/ui";
export function SubmitButton(props) {
  return <Button variant="primary" {...props} />;
}` };
		expect(auditCode([wrapper], ds).findings.filter((f) => f.rule === "reimplements-component")).toEqual([]);
	});

	it("reads design-system imports a formatter wrapped over several lines", () => {
		const wrapped = { path: "src/Wrapped.tsx", content: `import {
  Button,
  Card,
} from "@acme/ui";
function Badge() { return <span />; }
export const X = () => <Card><Button>Go</Button></Card>;` };
		const r = auditCode([wrapped], { packages: ["@acme/ui"], components: ["Badge"] });
		expect(r.stats.dsComponentUses).toBe(2);
		expect(r.componentsUsed).toEqual({ Card: 1, Button: 1 });
		expect(r.findings.map((f) => `${f.rule}@${f.line}`)).toContain("reimplements-component@5");
	});

	it("matches token names case-insensitively (JSON token paths vs var())", () => {
		const names = tokenNamesFrom("t.json", JSON.stringify({ colorPrimary: { $value: "#00f" } }));
		expect(names).toContain("colorPrimary");
		const src = { path: "a.tsx", content: `<p style={{ color: "var(--colorPrimary)" }} />` };
		const r = auditCode([src], { tokens: names });
		expect(r.findings.filter((f) => f.rule === "unknown-token")).toEqual([]);
		const r2 = auditCode([{ path: "b.tsx", content: `<p style={{ color: "var(--colorprimary)" }} />` }], { tokens: ["colorPrimary"] });
		expect(r2.findings.filter((f) => f.rule === "unknown-token")).toEqual([]);
	});
});

