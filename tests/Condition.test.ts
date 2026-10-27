import { assert, describe, it } from "@effect/vitest"
import {
	Array as Arr,
	Effect,
	Equal,
	Exit,
	HashMap,
	Option,
	Schema,
} from "effect"
import { Condition, Domain, Resource } from "../src/index.ts"
import * as Nodes from "../src/internal/nodes.ts"
import { alice, aliceBot, App, Bot, Caller, sharedBot } from "./fixtures.ts"

const $ = Condition.builder(App, "Bot")
const codec = Condition.schema(App, "Bot")

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
		const json = Schema.encodeSync(codec)(condition)
		assert.strictEqual(typeof json, "string")
		const decoded = Schema.decodeSync(codec)(json)
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

	it("keeps the identity of a bound condition and principal reference", () => {
		const First = Domain.make({ principal: Caller, resources: [Bot] })
		const Second = Domain.make({ principal: Caller, resources: [Bot] })
		const first = Condition.builder(First, "Bot")
		const second = Condition.builder(Second, "Bot")
		const condition = first.eq("ownerUserId", first.principal("userId"))
		assert.throws(() => first.eq("ownerUserId", second.principal("userId")))
		assert.throws(() => Condition.and(condition, second.exists("name")))
		const exit = Schema.encodeExit(Condition.schema(Second, "Bot"))(condition)
		assert.isTrue(Exit.isFailure(exit))
		assert.isFalse(Exit.hasDies(exit))
	})

	it("counts shared children without a size cap", () => {
		const doubled = (levels: number) =>
			Arr.reduce(Arr.range(1, levels), Condition.always, (condition) =>
				Condition.and(condition, condition),
			)
		assert.doesNotThrow(() => doubled(12))
		assert.strictEqual(doubled(13).weight, 16383)
	})

	it("accepts large lists of operands", () => {
		const values = Arr.range(1, 10_000 - 1)
		const condition = $.in("level", values)
		assert.strictEqual(condition.weight, 10_000)
		const text = Schema.encodeSync(codec)(condition)
		assert.isTrue(Equal.equals(Schema.decodeSync(codec)(text), condition))
		assert.strictEqual($.in("level", [...values, 0]).weight, 10001)
	})

	it("takes JSON text only", () => {
		Arr.forEach(
			[
				{ _tag: "True" },
				"{",
				'{"_tag":"Other"}',
				'{"_tag":"Not"}',
				'{"_tag":"Compare","op":"eq","field":"name"}',
				'{"_tag":"Exists","field":"shared"}',
				'{"_tag":"Exists","field":"settings.model.extra"}',
			],
			(input) => {
				const exit = Schema.decodeUnknownExit(codec)(input)
				assert.isTrue(Exit.isFailure(exit))
				assert.isFalse(Exit.hasDies(exit))
			},
		)
	})

	it("decodes an empty list as an empty list", () => {
		const decode = Schema.decodeSync(codec)
		assert.isTrue(
			Equal.equals(decode('{"_tag":"And","conditions":[]}'), Condition.and()),
		)
		assert.isTrue(
			Equal.equals(decode('{"_tag":"Or","conditions":[]}'), Condition.or()),
		)
		const input = '{"_tag":"In","field":"name","values":[]}'
		assert.deepStrictEqual(
			JSON.parse(Schema.encodeSync(codec)(decode(input))),
			JSON.parse(input),
		)
	})

	it("checks long path names against the domain", () => {
		const field = Arr.makeBy(101, () => "a").join(".")
		assert.strictEqual(new Nodes.Exists({ field }).field, field)
		assert.isTrue(
			Exit.isFailure(
				Schema.decodeExit(codec)(JSON.stringify({ _tag: "Exists", field })),
			),
		)
	})

	it("copies lists when it makes a condition", () => {
		const values = ["Helper"]
		const condition = $.in("name", values)
		values.length = 0
		assert.isTrue(test(condition))
		const parts: Array<Condition.Condition> = [
			$.eq("ownerUserId", "alice") as Condition.Condition,
		]
		const both = Condition.andAll(parts)
		const either = Condition.orAll(parts)
		parts.length = 0
		assert.isFalse(test(both, sharedBot))
		assert.isTrue(test(either))
	})

	it("reads only own data fields", () => {
		class Value {
			get name() {
				throw new Error("A getter must not run")
			}
		}
		const value = new Value() as unknown as Bot
		assert.isFalse(test($.exists("name"), value))
		assert.isFalse(test($.eq("name", "Helper"), value))
		assert.isTrue(
			test($.eq("ownerUserId", null), {
				...aliceBot,
				ownerUserId: undefined,
			} as unknown as Bot),
		)
	})

	describe("satisfiable", () => {
		const Shape = Schema.Struct({
			count: Schema.Int,
			ratio: Schema.Finite,
			// This field also admits NaN and the infinities.
			// @effect-diagnostics-next-line schemaNumber:off
			size: Schema.Number,
			name: Schema.String,
			state: Schema.Literals(["open", "closed"]),
			flag: Schema.Boolean,
			note: Schema.optionalKey(Schema.String),
		})
		const Item = Resource.make("Item", {
			actions: ["read"],
			fields: Shape.fields,
		})
		const Items = Domain.make({
			principal: Schema.Struct({}),
			resources: [Item],
		})
		const _ = Condition.builder(Items, "Item")
		type Plain = Condition.Condition<any>
		const tagOf = (condition: Plain) =>
			Condition.satisfiable(condition, { schema: Shape })._tag
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

		it("keeps non-finite values out of JSON text", () => {
			const numberCodec = Condition.schema(Items, "Item")
			Arr.forEach([NaN, Infinity, -Infinity], (value) => {
				const exit = Schema.encodeExit(numberCodec)(_.eq("size", value))
				assert.isTrue(Exit.isFailure(exit))
				assert.isFalse(Exit.hasDies(exit))
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

		it("lets only an optional field be missing", () => {
			assert.deepStrictEqual(example(_.not(_.exists("note"))), { note: null })
			assert.strictEqual(tagOf(_.not(_.exists("ratio"))), "Unsatisfiable")
			assert.strictEqual(tagOf(_.not(_.exists("name"))), "Unsatisfiable")
		})

		it("does not prove coverage for complex or related data", () => {
			const shapes: ReadonlyArray<Schema.Top> = [
				Schema.Struct({ data: Schema.Record(Schema.String, Schema.String) }),
				Schema.Struct({ data: Schema.Array(Schema.String) }),
				Schema.Struct({
					data: Schema.NullOr(Schema.Struct({ value: Schema.String })),
				}),
				Schema.Struct({
					data: Schema.optionalKey(Schema.Struct({ value: Schema.String })),
				}),
				Schema.Struct({
					data: Schema.Union([
						Schema.Struct({ a: Schema.String }),
						Schema.Struct({ b: Schema.String }),
					]),
				}),
			]
			Arr.forEach(shapes, (schema) => {
				assert.deepStrictEqual(
					Condition.satisfiable(Condition.always, { schema }),
					{ _tag: "Unknown", reason: "schema" } as never,
				)
			})
		})

		it("can not say with a predicate", () => {
			assert.deepStrictEqual(
				Condition.satisfiable(
					$.predicate("shared", (bot) => bot.shared),
					{ schema: Bot },
				),
				{ _tag: "Unknown", reason: "predicate" } as never,
			)
		})

		it("analyses more than sixteen fields", () => {
			const names = [
				"a",
				"b",
				"c",
				"d",
				"e",
				"f",
				"g",
				"h",
				"i",
				"j",
				"k",
				"l",
				"m",
				"n",
				"o",
				"p",
				"q",
			] as const
			const fields = Object.fromEntries(
				Arr.map(names, (name) => [name, Schema.Boolean]),
			) as Record<(typeof names)[number], typeof Schema.Boolean>
			const Flags = Resource.make("Flags", { actions: ["read"], fields })
			const FlagsDomain = Domain.make({
				principal: Schema.Struct({}),
				resources: [Flags],
			})
			const free = Condition.builder(FlagsDomain, "Flags")
			const atLimit = Condition.andAll(
				Arr.map(names.slice(0, 16), (name) => free.eq(name, true)),
			)
			assert.strictEqual(
				Condition.satisfiable(atLimit, { schema: Schema.Struct(fields) })._tag,
				"Satisfiable",
			)
			const condition = Condition.andAll(
				Arr.map(names, (name) => free.eq(name, true)),
			)
			assert.strictEqual(
				Condition.satisfiable(condition, { schema: Schema.Struct(fields) })
					._tag,
				"Satisfiable",
			)
		})

		it("finishes a search past the old step budget", () => {
			const test = (most: number) =>
				_.and(
					_.in("ratio", Arr.range(1, most)),
					_.or(_.lt("ratio", 0), _.gt("ratio", most), _.eq("ratio", 0)),
				)
			assert.strictEqual(tagOf(test(40)), "Unsatisfiable")
			assert.strictEqual(tagOf(test(9900)), "Unsatisfiable")
		})

		it("needs a condition with the principal already in it", () => {
			assert.throws(() =>
				Condition.satisfiable($.eq("ownerUserId", $.principal("userId")), {
					schema: Bot,
				}),
			)
			assert.throws(() =>
				Condition.satisfiable($.under("org", "acme"), { schema: Bot }),
			)
		})
	})
})

describe("Condition equality", () => {
	it("is not equal to a value of another type", () => {
		const condition = $.eq("id", "1")
		const other = Option.some(-340028015)
		assert.isFalse(Equal.equals(condition, other))
		assert.isFalse(Equal.equals(other, condition))
		const map = HashMap.make([condition as unknown, "condition"])
		assert.isTrue(Option.isNone(HashMap.get(map, other)))
		assert.isTrue(Option.isSome(HashMap.get(map, condition)))
	})
})

describe("Condition node properties", () => {
	const Step = Schema.Literals(["and", "or", "not", "leaf"])

	it.prop(
		"counts each node and operand for each place in a shared tree",
		{ steps: Schema.Array(Step).check(Schema.isMaxLength(40)) },
		({ steps }) => {
			const leaf: Nodes.Node = new Nodes.Compare({
				op: "eq",
				field: "level",
				value: Nodes.literal(1),
			})
			const weights = Arr.reduce(steps, [2], (all, step) => {
				const weight = all[all.length - 1]!
				return [
					...all,
					step === "and" || step === "or"
						? 2 * weight + 1
						: weight + (step === "not" ? 1 : 3),
				]
			})
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
			return make().weight === weights[weights.length - 1]
		},
	)

	it.prop(
		"decodes JSON text or returns a failure without a defect",
		{ input: Schema.Json },
		({ input }) => {
			const exit = Schema.decodeExit(codec)(JSON.stringify(input))
			return Exit.isSuccess(exit) || !Exit.hasDies(exit)
		},
	)

	it.prop(
		"loads chains past the old depth bound",
		{ levels: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 70 })) },
		({ levels }) => {
			const chain = Arr.reduce(
				Array.from({ length: levels - 1 }),
				{ _tag: "True" } as unknown,
				(condition) => ({ _tag: "Not", condition }),
			)
			const exit = Schema.decodeExit(codec)(JSON.stringify(chain))
			return (
				Exit.isSuccess(exit) &&
				Condition.evaluateSync(exit.value, {
					value: aliceBot,
					principal: alice,
				}) ===
					((levels - 1) % 2 === 0)
			)
		},
	)
})
