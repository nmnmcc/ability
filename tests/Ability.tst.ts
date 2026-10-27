import { Context, Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import * as HttpApi from "../src/HttpApi.ts"
import {
	Authorizer,
	Condition,
	Domain,
	Policy,
	Resource,
	type Decision,
} from "../src/index.ts"

class Caller extends Schema.Class<Caller, { readonly brand: unique symbol }>(
	"Caller",
)({
	id: Schema.String,
	rank: Schema.Finite,
	note: Schema.optionalKey(Schema.String),
}) {
	get label(): string {
		return this.id
	}
	active(): boolean {
		return true
	}
}

class Post extends Resource.Class<Post>()("Post", {
	actions: ["read", "write"],
	fields: {
		title: Schema.String,
		owner: Schema.String,
		rank: Schema.Finite,
		note: Schema.optionalKey(Schema.String),
		settings: Schema.Struct({ mode: Schema.String }),
		list: Schema.Array(Schema.String),
		map: Schema.Record(Schema.String, Schema.String),
		deep: Schema.Struct({
			b: Schema.Struct({
				c: Schema.Struct({
					d: Schema.Struct({ e: Schema.Struct({ f: Schema.String }) }),
				}),
			}),
		}),
		fifth: Schema.Struct({
			b: Schema.Struct({
				c: Schema.Struct({ d: Schema.Struct({ e: Schema.String }) }),
			}),
		}),
	},
}) {
	get label(): string {
		return this.title
	}
	active(): boolean {
		return true
	}
}
const Note = Resource.make("Note", {
	actions: ["read"],
	fields: { text: Schema.String },
})
const App = Domain.make({ principal: Caller, resources: [Post, Note] })
type App = typeof App
const $ = Condition.builder(App, "Post")
const _ = Policy.builder(App)
const caller = Caller.make({ id: "u", rank: 1 })
const post = Post.make({
	title: "p",
	owner: "u",
	rank: 1,
	settings: { mode: "a" },
	list: [],
	map: {},
	deep: { b: { c: { d: { e: { f: "x" } } } } },
	fifth: { b: { c: { d: { e: "x" } } } },
})
const policy = Policy.define(App)(function* (_) {
	yield* _.allow("read", Post)
})

class Gate extends Context.Service<Gate, { readonly open: boolean }>()(
	"@nmnmcc/ability/tests/Ability.tst/Gate",
) {}

describe("v3 types", () => {
	it("keeps the Schema fields and full class values", () => {
		expect<Domain.Principal<App>>().type.toBe<Caller>()
		expect<Domain.DataOf<App, "Post">>().type.toBe<
			Schema.Struct.Type<Resource.Fields<typeof Post>>
		>()
		expect(
			$.predicate(
				"method",
				(value, principal) => value.active() && principal.active(),
			),
		).type.toBe<
			Condition.Condition<Condition.Reads<Post, Caller>, Condition.Opaque>
		>()
		expect($.principal).type.not.toBeCallableWith("label")
		expect($.principal).type.not.toBeCallableWith("active")
		expect($.exists).type.not.toBeCallableWith("label")
		expect($.exists).type.not.toBeCallableWith("active")
	})

	it("uses paths from Schema fields", () => {
		expect($.eq).type.toBeCallableWith("fifth.b.c.d.e", "x")
		expect($.eq).type.toBeCallableWith("deep.b.c.d.e.f", "x")
		expect($.exists).type.not.toBeCallableWith("list.0")
		expect($.exists).type.not.toBeCallableWith("map.key")
		expect($.eq).type.toBeCallableWith("note", null)
		expect($.eq).type.toBeCallableWith("note", "x")
		expect($.eq).type.not.toBeCallableWith("rank", "high")
		expect($.gt).type.not.toBeCallableWith("rank", "high")
		expect($.eq).type.not.toBeCallableWith("rank", $.principal("id"))
		expect($.eq).type.toBeCallableWith("rank", $.principal("rank"))
		expect($.eq).type.toBeCallableWith("note", $.principal("note"))
		expect($.principal).type.not.toBeCallableWith("missing")
	})

	it("keeps actions, fields and conditions within their resource", () => {
		expect(_.allow).type.toBeCallableWith("write", Post)
		expect(_.allow).type.not.toBeCallableWith("write", Note)
		expect(_.allow).type.not.toBeCallableWith("read", "Missing")
		expect(_.allow).type.toBeCallableWith("read", Post, {
			fields: ["settings", "settings.mode", "*", "map", "list"],
		})
		expect(_.allow).type.not.toBeCallableWith("read", Post, {
			fields: ["settings.*"],
		})
		expect(_.allow).type.not.toBeCallableWith("read", Post, {
			fields: ["**.title"],
		})
		expect(_.allow).type.not.toBeCallableWith("read", Post, {
			fields: ["tit*"],
		})
		expect(_.allow).type.toBeCallableWith("read", Post, {
			fields: ["deep.b.c.d.e.f"],
		})
		const predicate = $.predicate("post", (post) => post.active())
		_.allow("read", Post, { when: () => predicate })
		expect(_.allow).type.not.toBeCallableWith("read", Note, {
			when: () => predicate,
		})
		expect(Policy.decideSync).type.not.toBeCallableWith(policy, {
			principal: caller,
			action: "write",
			resource: Note.make({ text: "x" }),
		})
		expect(Policy.decideSync).type.not.toBeCallableWith(policy, {
			principal: caller,
			action: "read",
			resource: post,
			field: "list.0",
		})
		expect(Policy.decideSync).type.toBeCallableWith(policy, {
			principal: caller,
			action: "read",
			resource: post,
			field: "settings",
		})
	})

	it("requires a domain for conditions and JSON text for storage", () => {
		expect(Condition.builder).type.not.toBeCallableWith()
		expect(Condition.builder).type.not.toBeCallableWith(App, "Missing")
		expect(Condition.schema).type.not.toBeCallableWith()
		const plain = $.eq("title", "x")
		expect(
			plain.pipe(Schema.encodeSync(Condition.schema(App, "Post"))),
		).type.toBe<string>()
		expect(Schema.decodeSync(Condition.schema(App, "Post"))("{}")).type.toBe<
			Condition.Condition<Condition.Reads<Post, Caller>>
		>()
		expect(
			Schema.decodeSync(Condition.schema(App, "Post")),
		).type.not.toBeCallableWith({ _tag: "True" })
		expect(
			policy.pipe(Schema.encodeSync(Policy.schema(App))),
		).type.toBe<string>()
		expect(Schema.decodeSync(Policy.schema(App))).type.not.toBeCallableWith({
			_tag: "Rules",
			rules: [],
		})
		expect(Policy).type.not.toHaveProperty("rule")
	})

	it("keeps opaque fields whole and checks common paths and values", () => {
		const Other = Resource.make("Other", {
			actions: ["read"],
			fields: { owner: Schema.Finite, code: Schema.String },
		})
		const Pair = Domain.make({ principal: Caller, resources: [Post, Other] })
		const common = Condition.builder(Pair, "Post" as "Post" | "Other")
		expect(common.eq).type.not.toBeCallableWith("title", "x")
		expect(common.eq).type.not.toBeCallableWith("code", "x")
		expect(common.eq).type.not.toBeCallableWith("owner", "x")
		expect(common.eq).type.not.toBeCallableWith("owner", 1)
		const field = "title" as "title" | "rank"
		expect($.eq).type.not.toBeCallableWith(field, "x")
		const path: string = "title"
		expect($.eq).type.not.toBeCallableWith(path, "x")
		const Shape = Resource.make("Shape", {
			actions: ["read"],
			fields: {
				data: Schema.declare(
					(value): value is string => typeof value === "string",
				),
				changed: Schema.FiniteFromString,
				template: Schema.TemplateLiteral(["item-", Schema.String]),
				later: Schema.suspend(() => Schema.String),
				mixed: Schema.Union([
					Schema.Struct({ name: Schema.String }),
					Schema.Struct({ id: Schema.String }),
				]),
				maybe: Schema.NullOr(Schema.Struct({ name: Schema.String })),
				choice: Schema.Literals(["a", "b"]),
			},
		})
		const Shapes = Domain.make({ principal: Caller, resources: [Shape] })
		const shape = Condition.builder(Shapes, "Shape")
		expect(shape.exists).type.toBeCallableWith("data")
		expect(shape.eq).type.not.toBeCallableWith("data", "x")
		expect(shape.eq).type.not.toBeCallableWith("changed", 1)
		expect(shape.eq).type.not.toBeCallableWith("template", "item-one")
		expect(shape.eq).type.not.toBeCallableWith("later", "x")
		expect(shape.exists).type.not.toBeCallableWith("mixed.name")
		expect(shape.eq).type.toBeCallableWith("maybe.name", null)
		expect(shape.eq).type.toBeCallableWith("choice", "a")
		expect(shape.eq).type.not.toBeCallableWith("choice", "c")
		expect(Domain.make).type.not.toBeCallableWith({
			principal: Schema.Record(Schema.String, Schema.String),
			resources: [Post],
		})
	})

	it("keeps the kind of residuals and the domain of policy parts", () => {
		const residual = Policy.residual(policy, {
			principal: caller,
			kind: "Post",
			action: "read",
		})
		expect(Condition.evaluateSync).type.toBeCallableWith(residual, {
			value: post,
		})
		expect(Condition.evaluateSync).type.not.toBeCallableWith(residual, {
			value: Note.make({ text: "x" }),
		})
		const union = Policy.residual(policy, {
			principal: caller,
			kind: "Post" as "Post" | "Note",
			action: "read",
		})
		expect(Condition.evaluateSync).type.not.toBeCallableWith(union, {
			value: post,
		})
		const Other = Domain.make({
			principal: Schema.Struct({ name: Schema.String }),
			resources: [Post],
		})
		const other = Policy.define(Other)(function* (_) {
			yield* _.allow("read", Post)
		})
		expect(Policy.all).type.not.toBeCallableWith([policy, other])
		expect(Policy.any).type.not.toBeCallableWith([policy, other])
		expect(Policy.firstOf).type.not.toBeCallableWith([policy, other])
		expect(Policy.ceiling).type.not.toBeCallableWith(policy, other)
	})

	it("accepts JSON meta and rejects removed options", () => {
		expect(_.allow).type.toBeCallableWith("read", Post, {
			meta: { source: "test", tags: [1, true, null] },
		})
		expect(_.allow).type.not.toBeCallableWith("read", Post, {
			meta: new Date(),
		})
		expect(_.allow).type.not.toBeCallableWith("read", Post, {
			meta: { bad: undefined },
		})
		Domain.make({
			principal: Caller,
			resources: [Post],
			// @ts-expect-error 'limits' does not exist
			limits: { fieldPathParts: 10 },
		})
		Domain.make({
			principal: Caller,
			resources: [Post],
			// @ts-expect-error 'meta' does not exist
			meta: Schema.String,
		})
		expect(Condition.satisfiable).type.not.toBeCallableWith(plainCondition())
		Condition.satisfiable(plainCondition(), {
			schema: Post,
			// @ts-expect-error 'budget' does not exist
			budget: 1,
		})
		class Access extends Authorizer.Service<Access>()("TypeAccess", {
			domain: App,
			principal: Effect.succeed(caller),
		}) {}
		Authorizer.layer(Access, {
			policy: () => Effect.succeed(policy),
			// @ts-expect-error 'cache' does not exist
			cache: false,
		})
		expect<Authorizer.Authorizer<App, never, never>>().type.not.toHaveProperty(
			"invalidate",
		)
	})

	it("keeps the principal effects and request types in Authorizer", () => {
		/** The principal is set for each request. @effect-leakable-service */
		class Identity extends Context.Service<Identity, Caller>()(
			"@nmnmcc/ability/tests/Ability.tst/Identity",
		) {}
		const session: Effect.Effect<Caller, "no session", Identity> = Identity
		class Auth extends Authorizer.Service<Auth>()(
			"@nmnmcc/ability/tests/Ability.tst/Auth",
			{ domain: App, principal: session },
		) {}
		expect(Auth.check({ action: "read", resource: post })).type.toBe<
			Effect.Effect<
				void,
				| Authorizer.Forbidden
				| Authorizer.Pending
				| Authorizer.PolicyUnavailable
				| "no session",
				Identity | Auth
			>
		>()
		expect(Auth.check).type.not.toBeCallableWith({
			action: "write",
			kind: "Note",
		})
		expect(Auth.check).type.not.toBeCallableWith({
			action: "read",
			kind: "Post",
			resource: post,
		})
		expect(Auth.guard).type.not.toBeCallableWith(
			{ action: "read", resource: post },
			{ read: "missing", hide: () => "hidden" },
		)
		expect(Auth.check).type.not.toBeCallableWith({
			action: "read",
			kind: "Post",
			within: () => $.predicate("code", () => true),
		})
		expect(Auth.check).type.toBeCallableWith({
			action: "read",
			kind: "Post",
			within: () => $.eq("rank", 1),
		})
		expect(Authorizer.Service<never>()).type.not.toBeCallableWith(
			"BadPrincipal",
			{ domain: App, principal: Effect.succeed("wrong") },
		)
		expect(Authorizer.layer).type.not.toBeCallableWith(Auth, {
			policy: () => Effect.succeed(policy),
			decider: () => Effect.fail("wrong" as const),
		})
		expect(HttpApi.requires).type.toBeCallableWith(Auth, "write", "Post")
		expect(HttpApi.requires).type.not.toBeCallableWith(Auth, "write", "Note")
		const kind = "Post" as "Post" | "Note"
		expect(HttpApi.requires).type.not.toBeCallableWith(Auth, "write", kind)
		expect(HttpApi.lists).type.not.toBeCallableWith(Auth, "read", "Post", {
			within: () => () => $.predicate("code", () => true),
		})
	})

	it("keeps nominal nodes, rules and policies", () => {
		const plain = plainCondition()
		const copied = { ...plain }
		expect(copied).type.not.toBeAssignableTo<Condition.Condition>()
		expect({ ...policy }).type.not.toBeAssignableTo<Policy.Policy<App>>()
		const rule = _.allow("read", Post)
		expect({ ...rule }).type.not.toBeAssignableTo<Policy.Rule<App>>()
	})

	it("keeps predicate errors and services and rejects plain-only APIs", () => {
		const condition = $.predicate("gate", () =>
			Effect.gen(function* () {
				const gate = yield* Gate
				return yield* gate.open
					? Effect.succeed(true)
					: Effect.fail("closed" as const)
			}),
		)
		const opaque = Policy.define(App)(function* (_) {
			yield* _.allow("read", Post, { when: () => condition })
		})
		expect(
			Policy.decide(opaque, {
				principal: caller,
				action: "read",
				resource: post,
			}),
		).type.toBe<Effect.Effect<Decision.Decision, "closed", Gate>>()
		expect(
			Condition.evaluate(condition, { principal: caller, value: post }),
		).type.toBe<Effect.Effect<boolean, "closed", Gate>>()
		expect(
			Schema.encodeSync(Condition.schema(App, "Post")),
		).type.not.toBeCallableWith(condition)
		expect(Schema.encodeSync(Policy.schema(App))).type.not.toBeCallableWith(
			opaque,
		)
		expect(Policy.decideSync).type.not.toBeCallableWith(opaque, {
			principal: caller,
			action: "read",
			resource: post,
		})
		expect(Condition.evaluateSync).type.not.toBeCallableWith(condition, {
			principal: caller,
			value: post,
		})
	})
})

const plainCondition = () => $.eq("title", "x")
