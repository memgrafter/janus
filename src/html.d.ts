// Ambient module for Bun's text-imported assets: `import x from "./f.txt" with { type: "text" }`.
declare module "*.txt" {
	const content: string;
	export default content;
}
