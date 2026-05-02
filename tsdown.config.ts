import {defineConfig} from "tsdown"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    Ability: "src/Ability.ts",
    AbilityExtra: "src/AbilityExtra.ts"
  },
  format: "esm",
  unbundle: true,
  root: "src",
  fixedExtension: false,
  dts: {
    sourcemap: false
  },
  sourcemap: false,
  clean: true,
  deps: {
    skipNodeModulesBundle: true
  },
  report: false
})
