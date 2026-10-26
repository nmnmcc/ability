// Checks a request for a principal with a part that holds one object in
// two places, 23 levels down: 24 objects, but 16,777,215 places in its JSON
// form. The part is in a field, in a `Redacted`, which hides its data, behind
// a getter, or in an own field of a date. A test runs this file in a Node.js
// process with a small heap, so an Authorizer that made the JSON form for its
// cache key runs out of memory.
// The script is an entry point, so it uses Effect.provide.
// @effect-diagnostics strictEffectProvide:off
import { Array as Arr, Context, Effect, Exit, Redacted, Schema } from "effect"
import { Authorizer, Domain, Policy, Resource } from "../../src/index.ts"

const Note = Resource.make("Note", {
	actions: ["read"],
	fields: { text: Schema.String },
})
class CurrentHolder extends Context.Service<CurrentHolder, object>()(
	"@nmnmcc/ability/tests/scripts/shared-principal/CurrentHolder",
) {}

/** Checks a request for a principal of a Schema, with a cache and with none. */
const checks = (principal: Schema.Top, holder: object): boolean => {
	const Holders = Domain.make({
		principal: principal as never,
		resources: [Note],
	})
	class HolderAuth extends Authorizer.Service<HolderAuth>()(
		"test/SharedPrincipalAuth",
		{ domain: Holders, principal: CurrentHolder as never },
	) {}
	const check = (cache: false | undefined) =>
		Effect.runSyncExit(
			HolderAuth.check({
				action: "read",
				resource: Note.make({ text: "t" }),
			}).pipe(
				Effect.provideService(CurrentHolder, holder),
				Effect.provide(
					Authorizer.layer(HolderAuth, {
						policy: () =>
							Effect.succeed(
								Policy.define(Holders)(function* (_) {
									yield* _.allow("read", Note)
								}),
							),
						...(cache === undefined ? {} : { cache }),
					}),
				),
			),
		)
	return Exit.isSuccess(check(undefined)) && Exit.isSuccess(check(false))
}

const shared = Arr.reduce(Arr.range(1, 23), {} as unknown, (inner) => ({
	a: inner,
	b: inner,
}))
const Claims = Schema.Struct({ claims: Schema.Unknown })
const Secret = Schema.Struct({ secret: Schema.Redacted(Schema.Unknown) })
const cases: ReadonlyArray<readonly [Schema.Top, object]> = [
	[Claims, { claims: shared }],
	[Secret, { secret: Redacted.make(shared) }],
	[
		Claims,
		Object.defineProperty({}, "claims", {
			get: () => shared,
			enumerable: true,
		}),
	],
	[Claims, { claims: Object.assign(new Date(0), { claims: shared }) }],
]
console.log(
	Arr.every(cases, ([principal, holder]) => checks(principal, holder))
		? "checked"
		: "failed",
)
