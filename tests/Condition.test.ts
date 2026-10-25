import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Equal, Exit, Schema } from "effect"
import { Condition, Limits, Resource } from "../src/index.ts"
import * as Nodes from "../src/internal/nodes.ts"
import { alice, aliceBot, Bot, Caller, sharedBot } from "./fixtures.ts"

const $ = Condition.builder<Resource.Data<typeof Bot>, Bot, Caller>()

const path = [
	"org",
	{ _tag: "Field", field: "organizationId" },
	"user",
	{ _tag: "Field", field: "ownerUserId" },
	"bot",
	{ _tag: "Field", field: "id" },
] as const

const test = (condition: Condition.Test<Bot, Caller>, value: Bot = aliceBot) =>
	Condition.evaluateSync(condition, { value, principal: alice, path })

const toSql = Condition.fold<string>({
	true: () => "TRUE",
	false: () => "FALSE",
	compare: (op, field, value) =>
		value === null
			? `${field} ${op === "eq" ? "IS" : "IS NOT"} NULL`
			: `${field} ${{ eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" }[op]} ${JSON.stringify(value)}`,
	in: (field, values) =>
		`${field} IN (${values.map((value) => JSON.stringify(value)).join(", ")})`,
	exists: (field) => `${field} IS NOT NULL`,
	and: (parts) => `(${parts.join(" AND ")})`,
	or: (parts) => `(${parts.join(" OR ")})`,
	not: (part) => `NOT ${part}`,
})

describe("Condition", () => {
	it("compares fields with values and with principal fields", () => {
		assert.isTrue(test($.eq("ownerUserId", "alice")))
		assert.isTrue(test($.eq("ownerUserId", $.principal("userId"))))
		assert.isFalse(test($.eq("ownerUserId", $.principal("userId")), sharedBot))
		assert.isTrue(test($.eq("ownerUserId", null), sharedBot))
		assert.isTrue(test($.ne("name", "Team")))
		assert.isTrue(test($.eq("settings.model", "small")))
	})

	it("compares only numbers with numbers and strings with strings", () => {
		assert.isTrue(test($.gt("level", 1)))
		assert.isTrue(test($.lte("level", 2)))
		assert.isFalse(test($.lt("level", 2)))
		assert.isTrue(test($.gte("name", "H")))
	})

	it("tests lists, missing values and logic", () => {
		assert.isTrue(test($.in("name", ["Helper", "Team"])))
		assert.isFalse(test($.in("name", [])))
		assert.isTrue(test($.exists("ownerUserId")))
		assert.isFalse(test($.exists("ownerUserId"), sharedBot))
		assert.isTrue(test($.and($.gt("level", 1), $.not($.eq("name", "Team")))))
		assert.isTrue(test($.or($.eq("name", "Team"), $.eq("name", "Helper"))))
		assert.isTrue(test($.and()))
		assert.isFalse(test($.or()))
	})

	it("tests the path of a resource", () => {
		assert.isTrue(test($.under("org", "acme")))
		assert.isTrue(
			test(
				$.under(
					"org",
					$.principal("organizationId"),
					"user",
					$.principal("userId"),
				),
			),
		)
		assert.isFalse(
			test($.under("org", "acme", "user", $.principal("userId")), sharedBot),
		)
		assert.isTrue(test($.under("org", "acme", "user", null), sharedBot))
		assert.isFalse(
			Condition.evaluateSync($.under("org"), {
				value: aliceBot,
				principal: alice,
			}),
		)
	})

	it("puts the principal in and expands the path", () => {
		const condition = $.and(
			$.under(
				"org",
				$.principal("organizationId"),
				"user",
				$.principal("userId"),
			),
			$.gt("level", 0),
		)
		const residual = Condition.partial(condition, { principal: alice, path })
		assert.deepStrictEqual(
			Effect.runSync(toSql(residual)),
			`(organizationId = "acme" AND ownerUserId = "alice" AND level > 0)`,
		)
		assert.deepStrictEqual(
			Condition.partial($.under("team"), { principal: alice, path }),
			Condition.never,
		)
		assert.deepStrictEqual(
			Condition.partial($.under("org"), { principal: alice, path }),
			Condition.always,
		)
	})

	it("makes conditions smaller", () => {
		assert.deepStrictEqual(
			Condition.simplify(
				$.and(Condition.always, $.and($.eq("name", "a"), $.eq("name", "a"))),
			),
			$.eq("name", "a"),
		)
		assert.deepStrictEqual(
			Condition.simplify($.or(Condition.always, $.eq("name", "a"))),
			Condition.always,
		)
		assert.deepStrictEqual(
			Condition.simplify($.not($.not($.exists("name")))),
			$.exists("name"),
		)
		assert.deepStrictEqual(
			Condition.simplify($.not($.eq("name", "a"))),
			$.ne("name", "a"),
		)
	})

	it("fails to fold a condition that still has principal fields or paths", () => {
		const exit = Effect.runSyncExit(
			toSql($.eq("ownerUserId", $.principal("userId"))),
		)
		assert.isTrue(Exit.isFailure(exit))
		assert.isTrue(Exit.isFailure(Effect.runSyncExit(toSql($.under("org")))))
	})

	it.effect("runs predicates as Effects", () =>
		Effect.gen(function* () {
			const condition = $.and(
				$.eq("ownerUserId", "alice"),
				$.predicate("long name", (bot) => Effect.succeed(bot.name.length > 3)),
			)
			assert.isTrue(
				yield* Condition.evaluate(condition, {
					value: aliceBot,
					principal: alice,
					path,
				}),
			)
			const failing = $.predicate("broken", () =>
				Effect.fail("no data" as const),
			)
			const exit = yield* Effect.exit(
				Condition.evaluate(failing, { value: aliceBot, principal: alice }),
			)
			assert.isTrue(Exit.isFailure(exit))
		}),
	)

	it("keeps a condition as JSON", () => {
		const condition = $.and(
			$.under("org", $.principal("organizationId")),
			$.or($.in("name", ["a", "b"]), $.not($.exists("ownerUserId"))),
			$.gte("level", 3),
		)
		const json = JSON.parse(JSON.stringify(condition))
		const decoded = Schema.decodeUnknownSync(Condition.schema)(json)
		assert.deepStrictEqual(decoded, condition)
		assert.deepStrictEqual(Condition.fields(condition), [
			"name",
			"ownerUserId",
			"level",
		])
	})

	describe("keeps the work of predicates when it makes a condition smaller", () => {
		const failing = $.predicate("offline", () => Effect.fail("offline"))
		const run = (
			condition: Condition.Condition<
				Condition.Reads<Bot, Caller>,
				Condition.Opaque<string>
			>,
		) =>
			Effect.exit(
				Condition.evaluate(condition, { value: aliceBot, principal: alice }),
			)

		it.effect("keeps the tests that guard a predicate", () =>
			Effect.gen(function* () {
				const condition = $.or($.eq("id", "b1"), failing, Condition.always)
				assert.deepStrictEqual(yield* run(condition), Exit.succeed(true))
				assert.deepStrictEqual(
					yield* run(Condition.simplify(condition)),
					Exit.succeed(true),
				)
			}),
		)

		it.effect("does not absorb a test past a predicate", () =>
			Effect.gen(function* () {
				const a = $.eq("id", "b1")
				const condition = $.or($.and(a, $.eq("name", "Helper")), failing, a)
				assert.deepStrictEqual(
					yield* run(Condition.simplify(condition)),
					Exit.succeed(true),
				)
			}),
		)

		it.effect("runs a predicate each time it is in the condition", () =>
			Effect.gen(function* () {
				let calls = 0
				const once = $.predicate("once", () => {
					calls = calls + 1
					return calls === 1
				})
				const condition = Condition.simplify($.and(once, once))
				assert.deepStrictEqual(
					yield* Effect.exit(
						Condition.evaluate(condition, {
							value: aliceBot,
							principal: alice,
						}),
					),
					Exit.succeed(false),
				)
			}),
		)
	})

	it("does not put a principal value that is not a scalar in a condition", () => {
		const principal = { ...alice, userId: 1n } as unknown as Caller
		const condition = $.eq("ownerUserId", $.principal("userId"))
		assert.deepStrictEqual(
			Condition.partial(condition, { principal, path }),
			Condition.never,
		)
	})

	it("stops a shared condition past the ceiling when it is made", () => {
		const calls = { true: 0 }
		const visit = Condition.fold<void>({
			true: () => {
				calls.true += 1
			},
			false: () => undefined,
			compare: () => undefined,
			in: () => undefined,
			exists: () => undefined,
			and: () => undefined,
			or: () => undefined,
			not: () => undefined,
		})
		const doubled = (levels: number) =>
			Array.from({ length: levels }).reduce<Condition.Condition>(
				(condition) => Condition.and(condition, condition),
				Condition.always,
			)
		// A shared child counts for each place: 15 levels have 65535 nodes.
		Effect.runSync(visit(doubled(15)))
		assert.strictEqual(calls.true, 2 ** 15)
		// A node does not know its domain, so it checks the ceiling: 26 levels
		// have 134217727 nodes.
		const start = Date.now()
		assert.doesNotThrow(() => doubled(25))
		assert.throws(
			() => doubled(26),
			/134217727 nodes and values. The most is 100000000/,
		)
		assert.isBelow(Date.now() - start, 100)
		// A decode checks the limit of the decode, with the default here.
		const shared = Arr.reduce(
			Arr.range(1, 20),
			{ _tag: "True" } as unknown,
			(inner) => ({ _tag: "And", conditions: [inner, inner] }),
		)
		const exit = Schema.decodeUnknownExit(Condition.schema)(shared)
		assert.isTrue(Exit.isFailure(exit))
		assert.include(
			String(Exit.isFailure(exit) ? exit.cause : ""),
			"The most is 1000000",
		)
	})

	it("keeps a number that JSON can not hold out of the JSON text", () => {
		const condition = Condition.builder<
			{ readonly n: number | null },
			unknown,
			unknown
		>().eq("n", Infinity)
		const exit = Schema.decodeUnknownExit(Condition.schema)(
			JSON.parse(JSON.stringify(condition)),
		)
		assert.isTrue(Exit.isFailure(exit))
	})

	it("decodes an empty list as an empty list", () => {
		const decode = Schema.decodeUnknownSync(Condition.schema)
		assert.isTrue(
			Equal.equals(decode({ _tag: "And", conditions: [] }), Condition.and()),
		)
		assert.isTrue(
			Equal.equals(decode({ _tag: "Or", conditions: [] }), Condition.or()),
		)
		assert.deepStrictEqual(
			Schema.encodeSync(Condition.schema)(
				decode({ _tag: "In", field: "a", values: [] }),
			),
			{ _tag: "In", field: "a", values: [] },
		)
	})

	it("does not take a field path with more parts than the limit", () => {
		const exit = Schema.decodeExit(Condition.schema)({
			_tag: "Compare",
			op: "eq",
			field: `${"x.".repeat(1000)}x`,
			value: { _tag: "Literal", value: "yes" },
		})
		assert.isTrue(Exit.isFailure(exit))
		assert.include(
			String(Exit.isFailure(exit) ? exit.cause : ""),
			"A field path has more than 1000 parts. The most is 1000.",
		)
		assert.isTrue(
			Exit.isSuccess(
				Schema.decodeExit(Condition.schema)({
					_tag: "Exists",
					field: `${"x.".repeat(999)}x`,
				}),
			),
		)
		// A node does not know its domain, so it checks the ceiling.
		assert.throws(
			() =>
				Condition.builder<any, unknown, unknown>().exists(
					`${"x.".repeat(10_000)}x`,
				),
			/A field path has 10001 parts. The most is 10000./,
		)
	})

	it("copies the list of andAll and orAll", () => {
		const parts: Array<Condition.Condition> = [
			$.eq("ownerUserId", "alice") as Condition.Condition,
		]
		const both = Condition.andAll(parts)
		const either = Condition.orAll(parts)
		parts.length = 0
		assert.isFalse(test(both, sharedBot))
		assert.isTrue(test(either))
	})

	it("decodes and walks deep JSON without filling the stack", () => {
		const deep = Array.from({ length: 100_000 }).reduce<unknown>(
			(condition) => ({ _tag: "Not", condition }),
			{ _tag: "Exists", field: "a" },
		)
		const exit = Schema.decodeUnknownExit(Condition.schema)(deep)
		assert.isTrue(Exit.isSuccess(exit))
		if (Exit.isFailure(exit)) {
			return
		}
		const condition = exit.value
		// An even number of `Not` nodes gives the test back.
		assert.isTrue(Condition.evaluateSync(condition, { value: { a: 1 } }))
		assert.isFalse(Condition.evaluateSync(condition, { value: {} }))
		assert.deepStrictEqual(Condition.fields(condition), ["a"])
		// The JSON form decodes again. `JSON.stringify` of it is not in the
		// test: the engine writes JSON text with a walk that fills the stack
		// at this depth.
		const again = condition.pipe(
			Schema.encodeSync(Condition.schema),
			Schema.decodeSync(Condition.schema),
		)
		assert.isTrue(Condition.evaluateSync(again, { value: { a: 1 } }))
	})

	describe("satisfiable", () => {
		const Shape = Schema.Struct({
			count: Schema.Int,
			ratio: Schema.Finite,
			// The test needs NaN and the infinities in this field.
			// @effect-diagnostics-next-line schemaNumber:off
			size: Schema.Number,
			name: Schema.String,
			state: Schema.Literals(["open", "closed"]),
			flag: Schema.Boolean,
			note: Schema.optionalKey(Schema.String),
			box: Schema.NullOr(Schema.Struct({ label: Schema.String })),
			when: Schema.Date,
			// A required field with no value would make the whole Schema empty.
			nothing: Schema.optionalKey(Schema.Never),
		})
		type Data = typeof Shape.Type
		const _ = Condition.builder<Data, Data, never>()
		// The types of a builder do not let a test name a struct field, or
		// compare a date with a string. These tests need both.
		const loose = Condition.builder<
			Record<string, Condition.Scalar>,
			object,
			never
		>()
		type Plain = Condition.Condition<any>
		const tagOf = (condition: Plain) =>
			Condition.satisfiable(condition, { schema: Shape })._tag

		/** Tests that the example makes the condition true. */
		const example = (condition: Plain) => {
			const answer = Condition.satisfiable(condition, { schema: Shape })
			assert.strictEqual(answer._tag, "Satisfiable")
			const value = answer._tag === "Satisfiable" ? answer.example : {}
			assert.isTrue(Condition.evaluateSync(condition, { value }))
			return value
		}

		it("knows that there is no integer between two integers", () => {
			assert.strictEqual(
				tagOf(
					_.not(_.or(_.lte("count", 0), _.eq("count", 1), _.gte("count", 2))),
				),
				"Unsatisfiable",
			)
			assert.deepStrictEqual(
				example(_.and(_.gt("count", 1), _.lt("count", 3))),
				{ count: 2 },
			)
		})

		it("finds the number next to a number", () => {
			assert.strictEqual(
				tagOf(_.and(_.gt("ratio", 1), _.lt("ratio", 1.0000000000000002))),
				"Unsatisfiable",
			)
			example(_.and(_.gt("ratio", 1), _.lt("ratio", 1.0000000000000004)))
			example(_.gt("ratio", Number.MAX_VALUE / 2))
		})

		it("keeps NaN and the infinities only where the Schema has them", () => {
			const neither = (field: "ratio" | "size") =>
				_.and(_.not(_.lt(field, 0)), _.not(_.gte(field, 0)))
			assert.strictEqual(tagOf(neither("ratio")), "Unsatisfiable")
			assert.isTrue(Number.isNaN(example(neither("size"))["size"]))
			assert.strictEqual(
				tagOf(_.gt("ratio", Number.MAX_VALUE)),
				"Unsatisfiable",
			)
			assert.deepStrictEqual(example(_.gt("size", Number.MAX_VALUE)), {
				size: Infinity,
			})
		})

		it("treats 0 and -0 as one value", () => {
			assert.strictEqual(
				tagOf(_.and(_.eq("size", 0), _.ne("size", -0))),
				"Unsatisfiable",
			)
		})

		it("finds the string next to a string", () => {
			assert.strictEqual(
				tagOf(_.and(_.gt("name", "a"), _.lt("name", "a\0"))),
				"Unsatisfiable",
			)
			assert.deepStrictEqual(
				example(_.and(_.gt("name", "a"), _.lt("name", "a\0\0"))),
				{ name: "a\0" },
			)
			assert.strictEqual(tagOf(_.lt("name", "")), "Unsatisfiable")
		})

		it("uses only the literals of a field", () => {
			assert.strictEqual(
				tagOf(_.and(_.ne("state", "open"), _.ne("state", "closed"))),
				"Unsatisfiable",
			)
			assert.strictEqual(
				tagOf(_.and(_.ne("flag", true), _.ne("flag", false))),
				"Unsatisfiable",
			)
		})

		it("lets an optional field be missing", () => {
			assert.deepStrictEqual(example(_.not(_.exists("note"))), {
				note: null,
			})
			assert.strictEqual(tagOf(_.not(_.exists("name"))), "Unsatisfiable")
		})

		it("makes the fields below a missing struct missing", () => {
			// With no Schema, a field may have any value, and the search still
			// knows that the fields below a missing struct are missing.
			const missing = _.and(_.exists("box.label"), _.not(loose.exists("box")))
			assert.strictEqual(Condition.satisfiable(missing)._tag, "Unsatisfiable")
			const present = _.and(_.eq("box.label", "x"), loose.exists("box"))
			const answer = Condition.satisfiable(present)
			assert.deepStrictEqual(
				answer._tag === "Satisfiable" ? answer.example : undefined,
				{ box: { label: "x" } },
			)
		})

		it("searches a field that is not a scalar by its shape", () => {
			assert.deepStrictEqual(example(_.exists("box.label")), {
				box: { label: "" },
			})
			assert.strictEqual(
				tagOf(_.and(_.exists("box.label"), _.not(loose.exists("box")))),
				"Unsatisfiable",
			)
			// A date is an object, so it is never a string.
			assert.strictEqual(tagOf(loose.ne("when", "x")), "Satisfiable")
			assert.strictEqual(tagOf(loose.eq("when", "x")), "Unsatisfiable")
			assert.strictEqual(tagOf(_.exists("nothing")), "Unsatisfiable")
		})

		it("finds no value for a field of no value", () => {
			const Empty = Schema.Struct({
				name: Schema.String,
				missing: Schema.Never,
			})
			const $ = Condition.builder<
				{ readonly missing: string | null },
				unknown,
				never
			>()
			const tag = (condition: Plain) =>
				Condition.satisfiable(condition, { schema: Empty })._tag
			assert.strictEqual(tag($.exists("missing")), "Unsatisfiable")
			assert.strictEqual(tag($.not($.exists("missing"))), "Unsatisfiable")
			// A plain field next to it is still exact.
			assert.strictEqual(tagOf(_.eq("name", "a")), "Satisfiable")
		})

		it("lets a field have any value with no Schema", () => {
			const answer = Condition.satisfiable(
				_.and(_.not(_.lt("count", 0)), _.not(_.gte("count", 0))),
			)
			assert.strictEqual(answer._tag, "Satisfiable")
		})

		it("can not say with a predicate", () => {
			assert.deepStrictEqual(
				Condition.satisfiable($.predicate("shared", (bot) => bot.shared)),
				{ _tag: "Unknown", reason: "predicate" } as never,
			)
		})

		it("stops at its budget", () => {
			// Ten boolean fields with a test that is never true. The search
			// visits more than five nodes before it knows.
			const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]
			const free = Condition.builder<Record<string, boolean>, object, never>()
			const condition = Condition.and(
				Condition.or(...names.map((name) => free.eq(name, true))),
				...names.map((name) => free.ne(name, true)),
			)
			const Flags = Schema.Struct(
				Object.fromEntries(names.map((name) => [name, Schema.Boolean])),
			)
			assert.strictEqual(
				Condition.satisfiable(condition, { schema: Flags })._tag,
				"Unsatisfiable",
			)
			assert.strictEqual(
				Condition.satisfiable(condition, { schema: Flags, budget: 5 })._tag,
				"Unknown",
			)
		})

		it("needs a condition with the principal in it", () => {
			assert.throws(() =>
				Condition.satisfiable($.eq("ownerUserId", $.principal("userId"))),
			)
			assert.throws(() => Condition.satisfiable($.under("org", "acme")))
		})
	})
})

describe("Condition node properties", () => {
	const Step = Schema.Literals(["and", "or", "not", "leaf"])

	it.prop(
		"stops a shared condition exactly when it goes past the ceiling",
		{ steps: Schema.Array(Step).check(Schema.isMaxLength(40)) },
		({ steps }) => {
			// The constructors of the nodes, with no step that makes a condition
			// smaller, so the size of each node is the size that is counted here.
			const leaf: Nodes.Node = new Nodes.Compare({
				op: "eq",
				field: "a",
				value: Nodes.literal(1),
			})
			// The size after each step, counted by hand. A constructor checks the
			// ceiling, as a node does not know its domain, and there is no limit
			// of levels. A step past the ceiling stops the work.
			const sizes = Arr.reduce(steps, [1], (all, step) => {
				const size = all[all.length - 1]!
				return [
					...all,
					step === "and" || step === "or"
						? 2 * size + 1
						: size + (step === "not" ? 1 : 2),
				]
			})
			const fails = Arr.some(
				sizes,
				(size) => size > Limits.ceilings.conditionNodes,
			)
			const make = () =>
				Arr.reduce(steps, leaf, (condition, step): Nodes.Node =>
					step === "and"
						? new Nodes.And([condition, condition])
						: step === "or"
							? new Nodes.Or([condition, condition])
							: step === "not"
								? new Nodes.Not(condition)
								: new Nodes.And([condition, leaf]),
				)
			if (fails) {
				assert.throws(make, /The most is/)
				return true
			}
			return make().size === sizes[sizes.length - 1]
		},
	)

	it.prop(
		"decodes any JSON or fails, and never throws",
		{ input: Schema.Json },
		({ input }) => {
			const exit = Schema.decodeUnknownExit(Condition.schema)(input)
			return Exit.isSuccess(exit) || !Exit.hasDies(exit)
		},
	)

	it.prop(
		"decodes a chain of Not nodes of any depth, and gives its meaning",
		{
			levels: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5000 })),
		},
		({ levels }) => {
			const chain = Array.from({ length: levels - 1 }).reduce<unknown>(
				(condition) => ({ _tag: "Not", condition }),
				{ _tag: "True" },
			)
			const exit = Schema.decodeUnknownExit(Condition.schema)(chain)
			// An even number of `Not` nodes over `True` is true.
			return (
				Exit.isSuccess(exit) &&
				Condition.evaluateSync(exit.value, { value: {} }) ===
					((levels - 1) % 2 === 0)
			)
		},
	)
})
