import { assert, beforeAll, describe, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import { execFileSync } from "node:child_process"
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))

const source = `
import { Effect, Schema } from "effect"

export const forbidden = Authorizer.Forbidden.make({ action: "read", kind: "Post" })
export const pending = new Authorizer.Pending({ ticket: "one" })
export const unavailable = Authorizer.PolicyUnavailable.make({ cause: "No policy" })
export const policy = new Policy.PolicyError({ issues: [], message: "Bad rule" })
export const failed = Effect.gen(function* () {
  return yield* forbidden
})
export const errors = Schema.Union([
  Authorizer.Forbidden,
  Authorizer.Pending,
  Authorizer.PolicyUnavailable,
  Policy.PolicyError,
])
export const decoded = Schema.decodeUnknownEffect(errors)
`

describe("Package declarations", () => {
	beforeAll(() => {
		execFileSync("devenv", ["shell", "--", "pnpm", "build"], { cwd: root })
	}, 30_000)

	it.each(["root", "modules"])(
		"emits error types from the %s exports",
		(entry) => {
			const directory = mkdtempSync(join(tmpdir(), "ability-declarations-"))
			try {
				// Use only package files. The source tree must not help this check.
				const installed = join(directory, "node_modules/@nmnmcc/ability")
				mkdirSync(installed, { recursive: true })
				cpSync(join(root, "package.json"), join(installed, "package.json"))
				cpSync(join(root, "dist"), join(installed, "dist"), { recursive: true })
				symlinkSync(
					join(root, "node_modules/effect"),
					join(directory, "node_modules/effect"),
					"dir",
				)
				writeFileSync(
					join(directory, "package.json"),
					JSON.stringify({ type: "module" }),
				)
				const imports =
					entry === "root"
						? 'import { Authorizer, Policy } from "@nmnmcc/ability"'
						: Arr.map(
								["Authorizer", "Policy"],
								(name) => `import * as ${name} from "@nmnmcc/ability/${name}"`,
							).join("\n")
				writeFileSync(join(directory, "index.ts"), `${imports}\n${source}`)
				execFileSync(
					"devenv",
					[
						"shell",
						"--",
						"pnpm",
						"exec",
						"tsc",
						"--ignoreConfig",
						"--declaration",
						"--emitDeclarationOnly",
						"--strict",
						"--skipLibCheck",
						"--module",
						"nodenext",
						"--target",
						"esnext",
						join(directory, "index.ts"),
					],
					{ cwd: root },
				)
				const declaration = readFileSync(join(directory, "index.d.ts"), "utf8")
				assert.notInclude(declaration, "/internal/")
				Arr.forEach(
					[
						"Authorizer.Forbidden",
						"Authorizer.Pending",
						"Authorizer.PolicyUnavailable",
						"Policy.PolicyError",
					],
					(name) => assert.include(declaration, name),
				)
			} finally {
				rmSync(directory, { recursive: true, force: true })
			}
		},
		30_000,
	)
})
