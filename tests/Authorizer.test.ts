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
	Resource,
} from "../src/index.ts"
import {
	alice,
	aliceBot,
	App,
	bob,
	Bot,
	Caller,
	emptyOf,
	sharedBot,
} from "./fixtures.ts"

/**
 * The caller belongs to the request, so each check reads it.
 * @effect-leakable-service
 */
class Identity extends Context.Service<Identity, Caller>()(
	"@nmnmcc/ability/tests/Authorizer.test/Identity",
) {}

class Auth extends Authorizer.Service<Auth>()("test/Auth", {
	domain: App,
	principal: Identity,
}) {}

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

	it.effect("guards with one principal for both of its questions", () =>
		Effect.gen(function* () {
			const turns = yield* Ref.make(0)
			const reader = Caller.make({ ...alice, role: "guest" })
			const writer = Caller.make({ ...alice, role: "member" })
			class Turning extends Authorizer.Service<Turning>()("test/Turning", {
				domain: App,
				// Each load gives the other principal.
				principal: Ref.getAndUpdate(turns, (n) => n + 1).pipe(
					Effect.map((n) => (n % 2 === 0 ? reader : writer)),
				),
			}) {}
			const layer = Authorizer.layer(Turning, {
				policy: (caller) =>
					Effect.succeed(
						Policy.define(App)(function* (_) {
							if (caller.role === "guest") {
								yield* _.allow("read", Bot)
							}
							if (caller.role === "member") {
								yield* _.allow("update", Bot)
							}
						}),
					),
			})
			const exit = yield* Turning.guard(
				{ action: "update", resource: aliceBot },
				{ hide: () => ({ _tag: "BotNotFound" as const }) },
			).pipe(Effect.provide(layer), Effect.exit)
			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(yield* Ref.get(turns), 1)
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

	describe("scopes", () => {
		it.effect("checks every value in a scope", () =>
			Effect.gen(function* () {
				const acme = yield* run(
					Auth.check({
						action: "read",
						kind: "Bot",
						within: ($) => $.under("org", "acme"),
					}),
				)
				assert.isTrue(Exit.isSuccess(acme.exit))
				const own = yield* run(
					Auth.check({
						action: "read",
						kind: "Bot",
						within: ($) => $.under("org", $.principal("organizationId")),
					}),
				)
				assert.isTrue(Exit.isSuccess(own.exit))
				const other = yield* run(
					Auth.check({
						action: "read",
						kind: "Bot",
						within: ($) => $.under("org", "other"),
					}),
				)
				assert.strictEqual(failureTag(other.exit), "Forbidden")
			}),
		)

		it.effect("checks a new value that has no id yet", () =>
			Effect.gen(function* () {
				const target = {
					action: "update",
					kind: "Bot",
					within: ($) => $.under("org", "acme", "user", "alice"),
				} satisfies Authorizer.Target<typeof App>
				const owner = yield* run(Auth.check(target))
				assert.isTrue(Exit.isSuccess(owner.exit))
				const other = yield* run(Auth.check(target), { caller: bob })
				assert.strictEqual(failureTag(other.exit), "Forbidden")
			}),
		)

		it.effect("never passes a check on an empty scope", () =>
			Effect.gen(function* () {
				const { exit } = yield* run(
					Auth.check({
						action: "read",
						kind: "Bot",
						within: ($) => $.and($.eq("name", "a"), $.eq("name", "b")),
					}),
					{ caller: Caller.make({ ...alice, role: "admin" }) },
				)
				assert.strictEqual(failureTag(exit), "Forbidden")
			}),
		)

		it.effect("gives a filter in a scope, and an empty one with no value", () =>
			Effect.gen(function* () {
				const other = Bot.make({ ...aliceBot, organizationId: "other" })
				const { exit } = yield* run(
					Effect.gen(function* () {
						const acme = yield* Auth.filter({
							action: "read",
							kind: "Bot",
							within: ($) => $.under("org", "acme"),
						})
						const none = yield* Auth.filter({
							action: "update",
							kind: "Bot",
							within: ($) => $.under("org", "acme", "user", "bob"),
						})
						return [
							yield* Condition.evaluate(acme, { value: aliceBot }),
							yield* Condition.evaluate(acme, { value: other }),
							yield* Condition.evaluate(none, { value: aliceBot }),
							yield* Condition.evaluate(none, { value: sharedBot }),
						]
					}),
				)
				assert.deepStrictEqual(Exit.isSuccess(exit) ? exit.value : [], [
					true,
					false,
					false,
					false,
				])
			}),
		)

		it.effect("tells how much of a scope the principal may act on", () =>
			Effect.gen(function* () {
				const { exit } = yield* run(
					Effect.all([
						Auth.coverage({ action: "read", kind: "Bot" }),
						Auth.coverage({
							action: "update",
							kind: "Bot",
							within: ($) => $.under("org", "acme", "user", "alice"),
						}),
						Auth.coverage({
							action: "read",
							kind: "Bot",
							within: ($) => $.under("org", "other"),
						}),
					]),
				)
				assert.deepStrictEqual(
					Exit.isSuccess(exit) ? exit.value.map((value) => value._tag) : [],
					["Some", "All", "None"],
				)
			}),
		)

		it.effect(
			"asks the decider only when no value in the scope is denied",
			() =>
				Effect.gen(function* () {
					const decider = () => Effect.succeed(Decision.Allow({}))
					const delegate = yield* run(
						Auth.check({
							action: "delegate",
							kind: "Bot",
							within: ($) => $.under("org", "acme"),
						}),
						{ decider },
					)
					assert.isTrue(Exit.isSuccess(delegate.exit))
					// Alice may delete her Bots, but not the ones in use.
					const remove = yield* run(
						Auth.check({
							action: "delete",
							kind: "Bot",
							within: ($) => $.under("org", "acme", "user", "alice"),
						}),
						{ decider },
					)
					assert.strictEqual(failureTag(remove.exit), "Forbidden")
					const unused = yield* run(
						Auth.check({
							action: "delete",
							kind: "Bot",
							within: ($) =>
								$.and(
									$.under("org", "acme", "user", "alice"),
									$.lt("level", 2),
								),
						}),
					)
					assert.isTrue(Exit.isSuccess(unused.exit))
				}),
		)

		it.effect("does not ask the decider about an empty scope", () =>
			Effect.gen(function* () {
				const { exit } = yield* run(
					Auth.check({
						action: "delegate",
						kind: "Bot",
						within: ($) => $.and($.eq("name", "a"), $.eq("name", "b")),
					}),
					{ decider: () => Effect.succeed(Decision.Allow({})) },
				)
				assert.strictEqual(failureTag(exit), "Forbidden")
			}),
		)

		it.effect("does not ask the decider when the Schema is not known", () =>
			Effect.gen(function* () {
				const Note = Resource.make("Note", {
					actions: ["read"],
					fields: { tags: Schema.Record(Schema.String, Schema.String) },
				})
				const Notes = Domain.make({ principal: Caller, resources: [Note] })
				class NoteAuth extends Authorizer.Service<NoteAuth>()("test/NoteAuth", {
					domain: Notes,
					principal: Identity,
				}) {}
				const layer = Authorizer.layer(NoteAuth, {
					policy: () => Effect.succeed(emptyOf(Notes)),
					decider: () => Effect.succeed(Decision.Allow({})),
				})
				const exit = yield* NoteAuth.check({
					action: "read",
					kind: "Note",
				}).pipe(
					Effect.provideService(Identity, alice),
					Effect.provide(layer),
					Effect.exit,
				)
				assert.strictEqual(failureTag(exit), "Forbidden")
			}),
		)

		it.effect("stops a scope that is not plain data", () =>
			Effect.gen(function* () {
				const predicate = yield* run(
					Auth.check({
						action: "read",
						kind: "Bot",
						within: (($: Condition.Builder<typeof App, "Bot">) =>
							$.predicate("shared", (bot) => bot.shared)) as never,
					}),
				)
				assert.strictEqual(failureTag(predicate.exit), "Defect")
				const missing = yield* run(
					Auth.check({
						action: "read",
						kind: "Bot",
						within: ($) => $.under("org", undefined as unknown as string),
					}),
				)
				assert.strictEqual(failureTag(missing.exit), "Defect")
			}),
		)
	})

	it.effect("loads the policy for each operation", () =>
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
			assert.strictEqual(loads, 4)
		}),
	)

	it.effect("gives the loader the original principal", () =>
		Effect.gen(function* () {
			const seen: Array<Caller> = []
			class OriginalAuth extends Authorizer.Service<OriginalAuth>()(
				"test/OriginalAuth",
				{
					domain: App,
					principal: Identity,
				},
			) {}
			const layer = Authorizer.layer(OriginalAuth, {
				policy: (caller) =>
					Effect.sync(() => {
						seen.push(caller)
						return Policy.define(App)(function* (_) {
							yield* _.allow("read", Bot)
						})
					}),
			})
			yield* OriginalAuth.check({ action: "read", resource: aliceBot }).pipe(
				Effect.provideService(Identity, alice),
				Effect.provide(layer),
			)
			assert.strictEqual(seen.length, 1)
			assert.strictEqual(seen[0], alice)
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
			class Auth2 extends Authorizer.Service<Auth2>()("test/Auth2", {
				domain: App,
				principal: Identity,
			}) {}
			const layer = Authorizer.layer(Auth2, {
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
			class Auth3 extends Authorizer.Service<Auth3>()("test/Auth3", {
				domain: App,
				principal: Identity,
			}) {}
			const layer = Authorizer.layer(Auth3, {
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

	it.effect("fails closed when the loaded policy has another domain", () =>
		Effect.gen(function* () {
			const Other = Domain.make({ principal: Caller, resources: [Bot] })
			class Mixed extends Authorizer.Service<Mixed>()("test/Mixed", {
				domain: App,
				principal: Identity,
			}) {}
			const layer = Authorizer.layer(Mixed, {
				policy: () =>
					Effect.succeed(
						Policy.define(Other)(function* (_) {
							yield* _.allow("read", Bot)
						}) as never,
					),
			})
			const exit = yield* Mixed.check({
				action: "read",
				resource: aliceBot,
			}).pipe(
				Effect.provideService(Identity, alice),
				Effect.provide(layer),
				Effect.exit,
			)
			assert.strictEqual(failureTag(exit), "PolicyUnavailable")
		}),
	)

	it.effect("keeps minus zero in the principal given to the loader", () =>
		Effect.gen(function* () {
			const Principal = Schema.Struct({ n: Schema.Finite })
			const Signs = Domain.make({ principal: Principal, resources: [Bot] })
			const original = { n: -0 }
			class SignAuth extends Authorizer.Service<SignAuth>()("test/SignAuth", {
				domain: Signs,
				principal: Effect.succeed(original),
			}) {}
			const layer = Authorizer.layer(SignAuth, {
				policy: (principal) =>
					Effect.sync(() => {
						assert.strictEqual(principal, original)
						assert.isTrue(Object.is(principal.n, -0))
						return Policy.define(Signs)(function* (_) {
							yield* _.allow("read", Bot)
						})
					}),
			})
			yield* SignAuth.check({ action: "read", resource: aliceBot }).pipe(
				Effect.provide(layer),
			)
		}),
	)

	it.effect(
		"does not ask the decider when a predicate makes coverage unknown",
		() =>
			Effect.gen(function* () {
				const calls = yield* Ref.make(0)
				const layer = Authorizer.layer(Auth, {
					policy: () =>
						Effect.succeed(
							Policy.define(App)(function* (_) {
								yield* _.allow("read", Bot, {
									when: ($) => $.predicate("shared", (bot) => bot.shared),
								})
							}),
						),
					decider: () =>
						Ref.update(calls, (n) => n + 1).pipe(Effect.as(Decision.Allow({}))),
				})
				const exit = yield* Auth.check({ action: "read", kind: "Bot" }).pipe(
					Effect.provideService(Identity, alice),
					Effect.provide(layer),
					Effect.exit,
				)
				assert.strictEqual(failureTag(exit), "Forbidden")
				assert.strictEqual(yield* Ref.get(calls), 0)
			}),
	)

	it.effect("keeps a residual when a search could prove that it is empty", () =>
		Effect.gen(function* () {
			const layer = Authorizer.layer(Auth, {
				policy: () =>
					Effect.succeed(
						Policy.define(App)(function* (_) {
							yield* _.allow("read", Bot, {
								when: ($) => $.and($.eq("name", "a"), $.eq("name", "b")),
							})
						}),
					),
			})
			const condition = yield* Auth.filter({
				action: "read",
				kind: "Bot",
			}).pipe(Effect.provideService(Identity, alice), Effect.provide(layer))
			assert.notStrictEqual(condition._tag, "False")
			assert.isFalse(yield* Condition.evaluate(condition, { value: aliceBot }))
		}),
	)
})
