// Each test gives its own layer, so it uses Effect.provide.
// @effect-diagnostics strictEffectProvide:off
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Ref, Schema } from "effect"
import {
	Authorizer,
	Condition,
	Decision,
	Domain,
	Policy,
	Principal,
} from "../src/index.ts"
import {
	alice,
	aliceBot,
	App,
	Bot,
	bob,
	Caller,
	sharedBot,
} from "./fixtures.ts"

class Identity extends Context.Service<Identity, Caller>()(
	"@nmnmcc/ability/tests/Authorizer.test/Identity",
) {}

class Auth extends Authorizer.Service<Auth, { requires: Identity }>()(
	"test/Auth",
	App,
) {}

const policyFor = (caller: Caller) =>
	Policy.define(App)(function* (_) {
		yield* _.allow("read", Bot, {
			when: ($) => $.under("org", $.principal("organizationId")),
		})
		yield* _.allow(["update", "delete"], Bot, {
			when: ($) => $.eq("ownerUserId", $.principal("userId")),
		})
		yield* _.deny("delete", Bot, {
			when: ($) => $.gte("level", 2),
			reason: "This Bot is in use",
		})
		if (caller.role === "admin") {
			yield* _.allow("*", "*")
		}
	})

const makeLayer = (options: {
	readonly loads: Ref.Ref<number>
	readonly fail?: boolean
	readonly decider?: Authorizer.Options<
		typeof App,
		never,
		Identity,
		never,
		never,
		never
	>["decider"]
}) =>
	Authorizer.layer(Auth, {
		principal: Identity,
		policy: (caller) =>
			Ref.update(options.loads, (n) => n + 1).pipe(
				Effect.andThen(
					options.fail === true
						? Effect.fail("database is down")
						: Effect.succeed(policyFor(caller)),
				),
			),
		...(options.decider === undefined ? {} : { decider: options.decider }),
	})

const run = <A, E>(
	effect: Effect.Effect<A, E, Auth | Identity>,
	options: {
		readonly caller?: Caller
		readonly fail?: boolean
		readonly decider?: Parameters<typeof makeLayer>[0]["decider"]
	} = {},
) =>
	Effect.gen(function* () {
		const loads = yield* Ref.make(0)
		const exit = yield* effect.pipe(
			Effect.provideService(Identity, options.caller ?? alice),
			Effect.provide(makeLayer({ loads, ...options })),
			Effect.exit,
		)
		return { exit, loads: yield* Ref.get(loads) }
	})

const failureTag = (exit: Exit.Exit<unknown, unknown>) =>
	Exit.isFailure(exit)
		? Exit.findErrorOption(exit).pipe((option) =>
				option._tag === "Some"
					? (option.value as { readonly _tag: string })._tag
					: "Defect",
			)
		: "Success"

describe("Authorizer", () => {
	it.effect("passes a check that the policy allows", () =>
		Effect.gen(function* () {
			const { exit } = yield* run(
				Auth.check({ action: "update", resource: aliceBot }),
			)
			assert.isTrue(Exit.isSuccess(exit))
		}),
	)

	it.effect("fails a check with Forbidden and the reason of the rule", () =>
		Effect.gen(function* () {
			const { exit } = yield* run(
				Auth.check({ action: "delete", resource: aliceBot }),
			)
			assert.strictEqual(failureTag(exit), "Forbidden")
			const error = Exit.findErrorOption(exit)
			assert.deepStrictEqual(
				error._tag === "Some" ? error.value : undefined,
				Authorizer.Forbidden.make({
					action: "delete",
					kind: "Bot",
					reason: "This Bot is in use",
				}),
			)
		}),
	)

	it.effect("checks a kind only when every value is allowed", () =>
		Effect.gen(function* () {
			const member = yield* run(Auth.check({ action: "read", kind: "Bot" }))
			assert.strictEqual(failureTag(member.exit), "Forbidden")
			const admin = yield* run(Auth.check({ action: "read", kind: "Bot" }), {
				caller: Caller.make({ ...alice, role: "admin" }),
			})
			assert.isTrue(Exit.isSuccess(admin.exit))
		}),
	)

	it.effect("hides a resource that the principal may not read", () =>
		Effect.gen(function* () {
			const other = Bot.make({ ...aliceBot, organizationId: "other" })
			const hidden = yield* run(
				Auth.guard(
					{ action: "update", resource: other },
					{ hide: () => ({ _tag: "BotNotFound" as const }) },
				),
			)
			assert.strictEqual(failureTag(hidden.exit), "BotNotFound")
			const seen = yield* run(
				Auth.guard(
					{ action: "update", resource: aliceBot },
					{ hide: () => ({ _tag: "BotNotFound" as const }) },
				),
				{ caller: bob },
			)
			assert.strictEqual(failureTag(seen.exit), "Forbidden")
		}),
	)

	it.effect("gives a filter for queries", () =>
		Effect.gen(function* () {
			const { exit } = yield* run(
				Effect.gen(function* () {
					const condition = yield* Auth.filter({
						action: "update",
						kind: "Bot",
					})
					return [
						yield* Condition.evaluate(condition, { value: aliceBot }),
						yield* Condition.evaluate(condition, { value: sharedBot }),
					]
				}),
			)
			assert.deepStrictEqual(Exit.isSuccess(exit) ? exit.value : [], [
				true,
				false,
			])
		}),
	)

	it.effect("loads the policy of a principal once", () =>
		Effect.gen(function* () {
			const { loads } = yield* run(
				Effect.gen(function* () {
					yield* Auth.check({ action: "read", resource: aliceBot })
					yield* Auth.check({ action: "read", resource: sharedBot })
					yield* Effect.provideService(
						Auth.check({ action: "read", resource: sharedBot }),
						Identity,
						bob,
					)
					yield* Auth.check({ action: "update", resource: aliceBot })
				}),
			)
			assert.strictEqual(loads, 2)
		}),
	)

	it.effect("loads the policy again after invalidate", () =>
		Effect.gen(function* () {
			const { loads } = yield* run(
				Effect.gen(function* () {
					const auth = yield* Auth
					yield* auth.check({ action: "read", resource: aliceBot })
					yield* auth.invalidate(alice)
					yield* auth.check({ action: "read", resource: aliceBot })
				}),
			)
			assert.strictEqual(loads, 2)
		}),
	)

	it.effect("fails closed when the policy can not be loaded", () =>
		Effect.gen(function* () {
			const { exit, loads } = yield* run(
				Effect.gen(function* () {
					yield* Effect.ignore(
						Auth.check({ action: "read", resource: aliceBot }),
					)
					yield* Auth.check({ action: "read", resource: aliceBot })
				}),
				{ fail: true },
			)
			assert.strictEqual(failureTag(exit), "PolicyUnavailable")
			assert.strictEqual(loads, 2)
		}),
	)

	it.effect("asks the decider when no rule gives an answer", () =>
		Effect.gen(function* () {
			const decider: Parameters<typeof makeLayer>[0]["decider"] = (request) =>
				request.action === "delegate"
					? Effect.fail(Authorizer.Pending.make({ ticket: "req-1" }))
					: Effect.succeed(Decision.Allow({}))
			const pending = yield* run(
				Auth.check({ action: "delegate", resource: aliceBot }),
				{ decider },
			)
			assert.strictEqual(failureTag(pending.exit), "Pending")
			const allowed = yield* run(
				Auth.check({ action: "update", resource: sharedBot }),
				{ decider },
			)
			assert.isTrue(Exit.isSuccess(allowed.exit))
			const denied = yield* run(
				Auth.check({ action: "delete", resource: aliceBot }),
				{ decider },
			)
			assert.strictEqual(failureTag(denied.exit), "Forbidden")
		}),
	)

	it.effect("gives the services of predicates from the layer", () =>
		Effect.gen(function* () {
			class Quota extends Context.Service<Quota, { readonly left: number }>()(
				"@nmnmcc/ability/tests/Authorizer.test/Quota",
			) {}
			class Auth2 extends Authorizer.Service<Auth2, { requires: Identity }>()(
				"test/Auth2",
				App,
			) {}
			const layer = Authorizer.layer(Auth2, {
				principal: Identity,
				policy: () =>
					Effect.succeed(
						Policy.define(App)(function* (_) {
							yield* _.allow("read", Bot, {
								when: ($) =>
									$.predicate("quota", () =>
										Effect.map(Quota, (quota) => quota.left > 0),
									),
							})
						}),
					),
			}).pipe(Layer.provide(Layer.succeed(Quota, { left: 1 })))
			const exit = yield* Auth2.check({
				action: "read",
				resource: aliceBot,
			}).pipe(
				Effect.provideService(Identity, alice),
				Effect.provide(layer),
				Effect.exit,
			)
			assert.isTrue(Exit.isSuccess(exit))
			const filtered = yield* Effect.gen(function* () {
				const condition = yield* Auth2.filter({ action: "read", kind: "Bot" })
				return yield* Condition.evaluate(condition, { value: aliceBot })
			}).pipe(
				Effect.provideService(Identity, alice),
				Effect.provide(layer),
				Effect.exit,
			)
			assert.isTrue(Exit.isSuccess(filtered) && filtered.value)
		}),
	)

	it.effect("does not let the decider allow a kind with a denied value", () =>
		Effect.gen(function* () {
			class Auth3 extends Authorizer.Service<Auth3, { requires: Identity }>()(
				"test/Auth3",
				App,
			) {}
			const layer = Authorizer.layer(Auth3, {
				principal: Identity,
				policy: () =>
					Effect.succeed(
						Policy.define(App)(function* (_) {
							yield* _.allow("read", Bot)
							yield* _.deny("read", Bot, { when: ($) => $.eq("id", "b1") })
						}),
					),
				decider: () => Effect.succeed(Decision.Allow({})),
			})
			const exit = yield* Auth3.check({ action: "read", kind: "Bot" }).pipe(
				Effect.provideService(Identity, alice),
				Effect.provide(layer),
				Effect.exit,
			)
			assert.strictEqual(failureTag(exit), "Forbidden")
		}),
	)

	it.effect("does not give one cached policy to two principals", () =>
		Effect.gen(function* () {
			class User extends Principal.Class<User>("User")({
				claims: Schema.ReadonlyMap(Schema.String, Schema.String),
			}) {}
			const Shop = Domain.make({ principal: User, resources: [Bot] })
			class Current extends Context.Service<Current, User>()(
				"@nmnmcc/ability/tests/Authorizer.test/Current",
			) {}
			class ShopAuth extends Authorizer.Service<
				ShopAuth,
				{ requires: Current }
			>()("test/ShopAuth", Shop) {}
			const layer = Authorizer.layer(ShopAuth, {
				principal: Current,
				policy: (user) =>
					Effect.succeed(
						Policy.define(Shop)(function* (_) {
							if (user.claims.get("role") === "admin") {
								yield* _.allow("read", Bot)
							}
						}),
					),
			})
			const admin = User.make({ claims: new Map([["role", "admin"]]) })
			const guest = User.make({ claims: new Map([["role", "guest"]]) })
			const exit = yield* Effect.gen(function* () {
				yield* Effect.provideService(
					ShopAuth.check({ action: "read", resource: aliceBot }),
					Current,
					admin,
				)
				yield* Effect.provideService(
					ShopAuth.check({ action: "read", resource: aliceBot }),
					Current,
					guest,
				)
			}).pipe(Effect.provide(layer), Effect.exit)
			assert.strictEqual(failureTag(exit), "Forbidden")
		}),
	)

	it.effect("keeps the types of principal values in the cache key", () =>
		Effect.gen(function* () {
			class User extends Principal.Class<User>("User")({
				id: Schema.Union([Schema.BigInt, Schema.String]),
			}) {}
			const Shop = Domain.make({ principal: User, resources: [Bot] })
			class ShopUser extends Context.Service<ShopUser, User>()(
				"@nmnmcc/ability/tests/Authorizer.test/ShopUser",
			) {}
			class ShopAuth extends Authorizer.Service<
				ShopAuth,
				{ requires: ShopUser }
			>()("test/ShopAuth2", Shop) {}
			const layer = Authorizer.layer(ShopAuth, {
				principal: ShopUser,
				policy: (user) =>
					Effect.succeed(
						Policy.define(Shop)(function* (_) {
							if (typeof user.id === "bigint") {
								yield* _.allow("read", Bot)
							}
						}),
					),
			})
			const exit = yield* Effect.gen(function* () {
				yield* Effect.provideService(
					ShopAuth.check({ action: "read", resource: aliceBot }),
					ShopUser,
					User.make({ id: 1n }),
				)
				yield* Effect.provideService(
					ShopAuth.check({ action: "read", resource: aliceBot }),
					ShopUser,
					User.make({ id: "1" }),
				)
			}).pipe(Effect.provide(layer), Effect.exit)
			assert.strictEqual(failureTag(exit), "Forbidden")
		}),
	)
})
