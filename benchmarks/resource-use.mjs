import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { cpus, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Array as Arr, Schema } from "effect"
import { Condition, Domain, Policy, Resource } from "../src/index.ts"

const root = fileURLToPath(new URL("../", import.meta.url))
const file = fileURLToPath(import.meta.url)
const median = (values) => {
	const ordered = [...values].sort((a, b) => a - b)
	return ordered[Math.floor(ordered.length / 2)]
}
const stage = (name, work) => {
	try {
		return work()
	} catch (error) {
		throw new Error(name + ": " + String(error), { cause: error })
	}
}
const elapsed = (work) => {
	const start = performance.now()
	const value = work()
	return { ms: performance.now() - start, value }
}
const measure = (work) => {
	work()
	return median(Arr.makeBy(5, () => elapsed(work).ms))
}
const indices = (size) => Arr.makeBy(size, (index) => index)
const nodeCase = (kind, size) => {
	const Item = Resource.make("Item", {
		actions: ["read"],
		fields: { rank: Schema.Finite },
	})
	const App = Domain.make({ principal: Schema.Struct({}), resources: [Item] })
	const principal = {}
	const resource = Item.make({ rank: size - 1 })
	const request = { principal, action: "read", resource }
	if (kind === "rules") {
		const make = () =>
			Policy.define(App)(function* (_) {
				yield* Arr.map(indices(size), (rank) =>
					_.allow("read", Item, { when: ($) => $.eq("rank", rank) }),
				)
			})
		const buildMs = measure(make)
		const policy = make()
		assert.equal(
			stage("decide", () => Policy.decideSync(policy, request))._tag,
			"Allow",
		)
		const runs = Math.max(10, Math.floor(10000 / size))
		const checkMs =
			measure(() => {
				Arr.forEach(indices(runs), () => {
					assert.equal(Policy.decideSync(policy, request)._tag, "Allow")
				})
			}) / runs
		const codec = Policy.schema(App)
		const text = stage("policy encode", () => Schema.encodeSync(codec)(policy))
		const loadMs = measure(() => Schema.decodeSync(codec)(text))
		const residual = Policy.residual(policy, {
			principal,
			action: "read",
			kind: "Item",
		})
		assert.equal(Condition.evaluateSync(residual, { value: resource }), true)
		assert.equal(
			Condition.evaluateSync(residual, { value: Item.make({ rank: -1 }) }),
			false,
		)
		return { buildMs, checkMs, loadMs, jsonUnits: text.length }
	}
	if (kind === "condition") {
		const $ = Condition.builder(App, "Item")
		const condition = Arr.reduce(
			indices(size - 1),
			$.eq("rank", size - 1),
			Condition.not,
		)
		assert.equal(condition.depth, size)
		const expected = (size - 1) % 2 === 0
		const readMs = elapsed(() =>
			Condition.evaluateSync(condition, { value: resource, principal }),
		).ms
		assert.equal(
			Condition.evaluateSync(condition, { value: resource, principal }),
			expected,
		)
		const codec = Condition.schema(App, "Item")
		const text = stage("condition encode", () =>
			Schema.encodeSync(codec)(condition),
		)
		const loaded = stage("decode", () => Schema.decodeSync(codec)(text))
		assert.equal(
			Condition.evaluateSync(loaded, { value: resource, principal }),
			expected,
		)
		return { readMs, jsonUnits: text.length }
	}
	if (kind === "policy") {
		const leaf = Policy.define(App)(function* (_) {
			yield* _.allow("read", Item)
		})
		const policy = Arr.reduce(indices(size - 1), leaf, (child) =>
			Policy.all([child]),
		)
		assert.equal(Policy.decideSync(policy, request)._tag, "Allow")
		const codec = Policy.schema(App)
		const text = stage("policy encode", () => Schema.encodeSync(codec)(policy))
		const loaded = stage("decode", () => Schema.decodeSync(codec)(text))
		assert.equal(Policy.decideSync(loaded, request)._tag, "Allow")
		return { jsonUnits: text.length }
	}
	if (kind === "coverage" || kind === "pigeons") {
		const names =
			kind === "coverage"
				? Arr.map(indices(size), (i) => "f" + i)
				: Arr.flatMap(indices(size), (p) =>
						Arr.map(indices(size - 1), (h) => "p" + p + "h" + h),
					)
		const Flags = Resource.make("Flags", {
			actions: ["read"],
			fields: Object.fromEntries(
				Arr.map(names, (name) => [name, Schema.Boolean]),
			),
		})
		const FlagsDomain = Domain.make({
			principal: Schema.Struct({}),
			resources: [Flags],
		})
		const $ = Condition.builder(FlagsDomain, "Flags")
		const condition =
			kind === "coverage"
				? $.and(...Arr.map(names, (name) => $.eq(name, true)))
				: $.and(
						...Arr.map(indices(size), (p) =>
							$.or(
								...Arr.map(indices(size - 1), (h) =>
									$.eq("p" + p + "h" + h, true),
								),
							),
						),
						...Arr.flatMap(indices(size - 1), (h) =>
							Arr.flatMap(indices(size), (p) =>
								Arr.map(indices(size).slice(p + 1), (q) =>
									$.not(
										$.and(
											$.eq("p" + p + "h" + h, true),
											$.eq("p" + q + "h" + h, true),
										),
									),
								),
							),
						),
					)
		const policy = Policy.define(FlagsDomain)(function* (_) {
			yield* _.allow("read", Flags, { when: () => condition })
		})
		const run = () =>
			Policy.coverage(policy, { principal, action: "read", kind: "Flags" })
		const sample = elapsed(run)
		assert.equal(sample.value._tag, kind === "coverage" ? "Some" : "None")
		const coverageMs = kind === "coverage" ? measure(run) : sample.ms
		return { fields: names.length, coverageMs, result: sample.value._tag }
	}
	throw new Error("The case is not known")
}

const appSource = (resources, fields, rules) => {
	const fieldText = Arr.map(
		indices(fields),
		(i) => "f" + i + ": Schema.String",
	).join(",")
	return [
		'import { Schema } from "effect"',
		'import { Condition, Domain, Policy, Resource } from "./src/index.ts"',
		"const fields = { ownerId: Schema.String, " + fieldText + " }",
		...Arr.map(
			indices(resources),
			(i) =>
				"const r" +
				i +
				' = Resource.make("R' +
				i +
				'", {actions: ["read"], fields})',
		),
		"const App = Domain.make({principal: Schema.Struct({id: Schema.String}), resources: [" +
			Arr.map(indices(resources), (i) => "r" + i).join(",") +
			"]})",
		'export const condition = Condition.builder(App, "R0").eq("f0", "yes")',
		"export const policy = Policy.define(App)(function* (_) {",
		...Arr.map(
			indices(rules),
			(i) =>
				'yield* _.allow("read", r' +
				(i % resources) +
				', {fields: ["f' +
				(i % fields) +
				'"], when: ($) => $.eq("ownerId", $.principal("id"))})',
		),
		"})",
	].join("\n")
}
const pathSource = (depth) => {
	const field = Array(depth).fill("a").join(".")
	return [
		'import { Schema } from "effect"',
		'import { Condition, Domain, Policy, Resource } from "./src/index.ts"',
		"const s0 = Schema.String",
		...Arr.map(
			indices(depth - 1),
			(i) => "const s" + (i + 1) + " = Schema.Struct({a: s" + i + "})",
		),
		'const Item = Resource.make("Item", {actions: ["read"], fields: {a: s' +
			(depth - 1) +
			"}})",
		"const App = Domain.make({principal: Schema.Struct({id: Schema.String}), resources: [Item]})",
		'export const condition = Condition.builder(App, "Item").eq("' +
			field +
			'", "yes")',
		'export const policy = Policy.define(App)(function* (_) {yield* _.allow("read", Item, {fields: ["' +
			field +
			'"], when: () => condition})})',
	].join("\n")
}
const runTypes = () => {
	const directory = mkdtempSync(join(tmpdir(), "ability-resource-use-"))
	try {
		symlinkSync(join(root, "src"), join(directory, "src"), "dir")
		symlinkSync(
			join(root, "node_modules"),
			join(directory, "node_modules"),
			"dir",
		)
		writeFileSync(join(directory, "package.json"), '{"type":"module"}')
		const cases = [
			["app-3-20-60", appSource(3, 20, 60)],
			["app-10-100-1000", appSource(10, 100, 1000)],
			["fields-1000", appSource(1, 1000, 20)],
			...Arr.map([10, 100, 250, 500, 1000], (n) => [
				"path-" + n,
				pathSource(n),
			]),
		]
		return Arr.map(cases, ([name, source]) => {
			writeFileSync(join(directory, "case.ts"), source)
			writeFileSync(
				join(directory, "tsconfig.json"),
				JSON.stringify({
					extends: join(root, "tsconfig.json"),
					include: ["case.ts"],
				}),
			)
			const run = () =>
				spawnSync(
					join(root, "node_modules/.bin/tsc"),
					[
						"-p",
						join(directory, "tsconfig.json"),
						"--noEmit",
						"--incremental",
						"false",
						"--extendedDiagnostics",
					],
					{
						cwd: root,
						encoding: "utf8",
						timeout: 20000,
						maxBuffer: 1024 * 1024,
					},
				)
			const first = run()
			if (first.status !== 0) {
				const result = {
					name,
					status: "failed",
					error:
						first.error?.message ??
						(first.stdout.match(/error TS[0-9]+:[^\n]+/g) ?? []).slice(0, 2),
				}
				console.log(JSON.stringify(result))
				return result
			}
			const samples = Arr.makeBy(5, () => {
				const result = run()
				assert.equal(result.status, 0, result.stdout)
				const read = (key) =>
					Number(
						result.stdout.match(
							new RegExp("^" + key + ":\\s+([0-9.]+)", "m"),
						)?.[1],
					)
				return {
					totalMs: read("Total time") * 1000,
					checkMs: read("Check time") * 1000,
					memoryMiB: read("Memory used") / 1024,
				}
			})
			const result = {
				name,
				status: "passed",
				...Object.fromEntries(
					Arr.map(["totalMs", "checkMs", "memoryMiB"], (key) => [
						key,
						median(Arr.map(samples, (sample) => sample[key])),
					]),
				),
			}
			console.log(JSON.stringify(result))
			return result
		})
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}
if (process.argv[2] === "--worker") {
	try {
		const result = nodeCase(process.argv[3], Number(process.argv[4]))
		console.log(JSON.stringify({ status: "passed", ...result }))
	} catch (error) {
		console.log(
			JSON.stringify({ status: "failed", error: String(error).slice(0, 400) }),
		)
	}
} else {
	console.log(
		JSON.stringify({
			node: process.version,
			cpu: cpus()[0]?.model,
			platform: process.platform,
			samples: 5,
		}),
	)
	const types = runTypes()
	const runtime = Arr.map(
		[
			...Arr.map([100, 1000, 10000], (n) => ["rules", n]),
			...Arr.map([100, 500, 1000, 2000, 5000], (n) => ["condition", n]),
			...Arr.map([100, 500, 1000, 2000], (n) => ["policy", n]),
			...Arr.map([10, 20, 40], (n) => ["coverage", n]),
			...Arr.map([4, 6, 8], (n) => ["pigeons", n]),
		],
		([kind, size]) => {
			// This timeout belongs to the measurement process, not the library.
			const child = spawnSync(
				process.execPath,
				["--max-old-space-size=512", file, "--worker", kind, String(size)],
				{ cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 },
			)
			const output = child.stdout.trim()
			const result = {
				kind,
				size,
				...(child.error
					? {
							status: child.error.code === "ETIMEDOUT" ? "timeout" : "failed",
							error: child.error.message,
						}
					: child.status !== 0
						? { status: "failed", error: child.stderr.slice(0, 400) }
						: JSON.parse(output)),
			}
			console.log(JSON.stringify(result))
			return result
		},
	)
	assert.ok(types.length > 0 && runtime.length > 0)
}
