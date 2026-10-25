// Checks a request for a principal with a part that holds one object in
// two places, 23 levels down: 24 objects, but 16,777,215 places in its JSON
// form. A test runs this file in a Node.js process with a small heap, so an
// Authorizer that made the JSON form for its cache key runs out of memory.
// The script is an entry point, so it uses Effect.provide.
// @effect-diagnostics strictEffectProvide:off
import { Array as Arr, Context, Effect, Exit, Schema } from "effect"
import { Authorizer, Domain, Policy, Resource } from "../../src/index.ts"

const Note = Resource.make("Note", {
	actions: ["read"],
	fields: { text: Schema.String },
})
const Holder = Schema.Struct({ claims: Schema.Unknown })
const Holders = Domain.make({ principal: Holder, resources: [Note] })
class CurrentHolder extends Context.Service<
	CurrentHolder,
	typeof Holder.Type
>()("@nmnmcc/ability/tests/scripts/shared-principal/CurrentHolder") {}
class HolderAuth extends Authorizer.Service<HolderAuth>()(
	"test/SharedPrincipalAuth",
	{ domain: Holders, principal: CurrentHolder },
) {}
const claims = Arr.reduce(Arr.range(1, 23), {} as unknown, (inner) => ({
	a: inner,
	b: inner,
}))
const check = (cache: false | undefined) =>
	Effect.runSyncExit(
		HolderAuth.check({
			action: "read",
			resource: Note.make({ text: "t" }),
		}).pipe(
			Effect.provideService(CurrentHolder, { claims }),
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
console.log(
	Exit.isSuccess(check(undefined)) && Exit.isSuccess(check(false))
		? "checked"
		: "failed",
)
