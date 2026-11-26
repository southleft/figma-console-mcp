import { cvaProps, reactComponentFromSource, tsProps } from "../src/core/adherence/react-props";
import { compareComponentProps } from "../src/core/adherence/props-parity";

const cvaButton = `
const buttonVariants = cva("inline-flex {weird} [&_svg]:size-4", {
  variants: {
    variant: {
      default: "bg-primary",
      destructive: "bg-destructive text-white focus-visible:ring-destructive/20",
      outline: "border bg-background",
      "icon-only": "p-0",
    },
    size: { default: "h-9", sm: "h-8", lg: "h-10" },
    disabled: { true: "opacity-50", false: "" },
  },
  defaultVariants: { variant: "default", size: "default" },
})`;

const unionPropsButton = `
type Variant = 'primary' | 'secondary' | 'bare' | 'knockout';
type ButtonOwnProps = {
  variant?: Variant;
  size?: "sm" | "md";
  loading?: boolean;
  onClick?: () => void;
  className?: string;
};
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, ButtonOwnProps {}
`;

describe("React prop extraction", () => {
	it("reads cva variant groups, including quoted keys and boolean groups", () => {
		expect(cvaProps(cvaButton)).toEqual([
			{ name: "variant", kind: "enum", values: ["default", "destructive", "outline", "icon-only"], typeText: "'default' | 'destructive' | 'outline' | 'icon-only'" },
			{ name: "size", kind: "enum", values: ["default", "sm", "lg"], typeText: "'default' | 'sm' | 'lg'" },
			{ name: "disabled", kind: "boolean", typeText: "boolean" },
		]);
	});

	it("reads literal unions (inline or aliased) and booleans from *Props types", () => {
		const props = tsProps(unionPropsButton);
		expect(props.map((p) => `${p.name}:${p.values?.join("|") ?? p.kind}`)).toEqual([
			"variant:primary|secondary|bare|knockout",
			"size:sm|md",
			"loading:boolean",
		]);
	});

	it("feeds property parity like a manifest would", () => {
		const code = reactComponentFromSource(unionPropsButton);
		const r = compareComponentProps(
			{
				name: "Button",
				variantAxes: [
					{ name: "Variant", values: ["Primary", "Secondary", "Bare"] },
					{ name: "State", values: ["Default", "Hover", "Loading"] },
				],
			},
			code,
		);
		const v = r.axes.find((a) => a.figmaAxis === "Variant")!;
		expect(v).toMatchObject({ codeProp: "variant", codeOnlyValues: ["knockout"] });
		expect(r.axes.find((a) => a.figmaAxis === "State")!.stateProps).toEqual({ Loading: "loading" });
		expect(r.codeOnlyProps.map((p) => p.name)).toEqual(["size"]);
	});

	it("leaves out props of other components declared in the same file", () => {
		const src = `
const gizmoItemVariants = cva("", { variants: { tone: { a: "", b: "" } } });
function Gizmo({ size }: React.ComponentProps<"div"> & { size?: "sm" | "lg" }) { return null; }
type GizmoItemProps = { inset?: boolean };
function GizmoItem({ inset }: GizmoItemProps) { return null; }
function GizmoClose({ variant }: React.ComponentProps<"button"> & { variant?: "x" | "y" }) { return null; }
`;
		expect(reactComponentFromSource(src, "Gizmo").props.map((p) => p.name)).toEqual(["size"]);
		expect(reactComponentFromSource(src).props.map((p) => p.name).sort()).toEqual(["inset", "size", "tone", "variant"]);
	});
});

