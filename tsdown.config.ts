import { defineConfig } from "tsdown"

export default defineConfig({
	entry: {
		index: "src/index.ts",
		Ability: "src/Ability.ts",
		AbilityExtra: "src/AbilityExtra.ts",
	},
	format: "esm",
	platform: "neutral",
	fixedExtension: false,
	target: "esnext",
	unbundle: true,
	sourcemap: true,
	dts: { sourcemap: true },
	deps: { neverBundle: true },
	exports: { packageJson: false, bin: false },
	report: false,
})
