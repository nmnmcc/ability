/**
 * An authorizer is an Effect service that makes decisions for the principal
 * of the current request.
 *
 * You make the service class, in the same way as `Context.Service`. Give the
 * domain, and the Effect that gives the principal of the current request. The
 * error type and the service type of the checks come from that Effect:
 *
 * ```ts
 * class Auth extends Authorizer.Service<Auth>()("app/Auth", {
 *   domain: App,
 *   principal: Identity,
 * }) {}
 * ```
 *
 * Then give a layer with {@link layer}. It says how to load the policy of a
 * principal. The loader runs for each operation. Put a cache in the loader
 * when the application needs one.
 *
 * Then use the service in a handler:
 *
 * ```ts
 * yield* Auth.check({ action: "update", resource: document })
 * ```
 *
 * A "no" answer goes into the error channel as {@link Forbidden}. When the
 * policy can not be loaded, the check fails with {@link PolicyUnavailable}.
 * So the check fails closed: an error is never a "yes".
 *
 * When no rule gives an answer, the authorizer asks the decider, if there is
 * one. A decider may answer at once, or fail with {@link Pending} when a person
 * or another service must answer later.
 *
 * @stability stable
 * @since 0.3.0
 */
import type * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Condition from "./Condition.ts"
import type * as Decision from "./Decision.ts"
import type * as Domain from "./Domain.ts"
import * as Internal from "./internal/authorizer.ts"
import type * as Policy from "./Policy.ts"

/**
 * The error when a policy says no.
 *
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export const Forbidden: typeof Internal.Forbidden = Internal.Forbidden

/**
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export type Forbidden = Internal.Forbidden

/**
 * The error when the policy of the principal can not be loaded. The cause is
 * kept, but it is not shown to the client.
 *
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export const PolicyUnavailable: typeof Internal.PolicyUnavailable =
	Internal.PolicyUnavailable

/**
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export type PolicyUnavailable = Internal.PolicyUnavailable

/**
 * The error when a decider must wait for an answer. `ticket` names the
 * request that waits, so the client can come back for the answer.
 *
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export const Pending: typeof Internal.Pending = Internal.Pending

/**
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export type Pending = Internal.Pending

/**
 * What a check is about: an act on a resource value, or an act on a kind of
 * resource. A check on a kind passes only when the policy allows the act on
 * every value of the kind. With a scope (`within`), it passes when the policy
 * allows the act on every value in the scope, and the scope is not empty.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Target<D> = Policy.Target<D> | Policy.KindTarget<D>

/**
 * A request to the decider. Its fields have the same paths as a check.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type DeciderRequest<D> = Policy.Request<D> | Policy.KindRequest<D>

/**
 * The options of a guard.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type GuardOptions<D, E2, K extends string = Domain.Kind<D>> = {
	/** The error when the principal may not see the resource. */
	readonly hide: () => E2
} & ("read" extends Domain.CommonAction<D, K>
	? {
			/**
			 * The action that lets the principal see the resource. It must be an
			 * action of every kind in `K`. The default is `"read"`.
			 */
			readonly read?: Domain.CommonAction<D, K>
		}
	: {
			/**
			 * The action that lets the principal see the resource. It must be an
			 * action of every kind in `K`. Some kind in `K` has no `"read"`
			 * action, so you must give it.
			 */
			readonly read: Domain.CommonAction<D, K>
		})

/**
 * The service.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Authorizer<D extends Domain.Any, E, R> {
	readonly domain: D
	/** The principal of the current request. */
	readonly principal: Effect.Effect<Domain.Principal<D>, E, R>
	/**
	 * The policy of the principal of the current request. Its predicates have
	 * the services of the layer. It may have predicates, so it is opaque.
	 */
	readonly policy: Effect.Effect<
		Policy.Policy<D, Condition.Opaque<E>>,
		PolicyUnavailable | E,
		R
	>
	/** Gives the decision of the policy. It does not ask the decider. */
	readonly decide: <const T extends Policy.Target<D>>(
		target: T,
	) => Effect.Effect<Decision.Decision, PolicyUnavailable | E, R>
	/** Succeeds when the principal may do the act, and fails when it may not. */
	readonly check: <const T extends Target<D>>(
		target: T,
	) => Effect.Effect<void, Forbidden | Pending | PolicyUnavailable | E, R>
	/**
	 * Checks the read action first, and fails with the error of `hide` when the
	 * principal may not see the resource. Then it checks the act. Use it to
	 * answer "not found" to a principal that may not know that a resource
	 * exists.
	 */
	readonly guard: <const T extends Policy.Target<D>, E2>(
		target: T,
		options: GuardOptions<D, E2, T["resource"]["_tag"]>,
	) => Effect.Effect<void, E2 | Forbidden | Pending | PolicyUnavailable | E, R>
	/**
	 * Gives the condition on resource values that the principal may act on,
	 * inside the scope of the target when it has one. Change it into a query
	 * with `Condition.fold`. It does no coverage search, so an empty result
	 * need not have the `False` tag.
	 */
	readonly filter: <const T extends Policy.KindTarget<D>>(
		target: T,
	) => Effect.Effect<
		Condition.Condition<
			Policy.ResidualReads<D, T["kind"]>,
			Condition.Opaque<E>
		>,
		PolicyUnavailable | E,
		R
	>
	/**
	 * Tells if the principal may act on all, none or some of the values in
	 * the scope of the target. See `Policy.coverage`. Use it to show a button
	 * only when the answer is `All` or `Some`.
	 */
	readonly coverage: <const T extends Policy.KindTarget<D>>(
		target: T,
	) => Effect.Effect<
		Policy.Coverage<Policy.ResidualReads<D, T["kind"]>, Condition.Opaque<E>>,
		PolicyUnavailable | E,
		R
	>
	/** Gives the fields of a value that the principal may use. */
	readonly permittedFields: (
		target: Policy.FieldlessTarget<D>,
	) => Effect.Effect<ReadonlyArray<string>, PolicyUnavailable | E, R>
}

/**
 * The class made by {@link Service}. The static functions use the service
 * from the context.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface ServiceClass<
	Self,
	Id extends string,
	D extends Domain.Any,
	E,
	R,
> extends Context.ServiceClass<Self, Id, Authorizer<D, E, R>> {
	readonly domain: D
	/** The Effect that gives the principal of the current request. */
	readonly principal: Effect.Effect<Domain.Principal<D>, E, R>
	readonly decide: <const T extends Policy.Target<D>>(
		target: T,
	) => Effect.Effect<Decision.Decision, PolicyUnavailable | E, R | Self>
	readonly check: <const T extends Target<D>>(
		target: T,
	) => Effect.Effect<
		void,
		Forbidden | Pending | PolicyUnavailable | E,
		R | Self
	>
	readonly guard: <const T extends Policy.Target<D>, E2>(
		target: T,
		options: GuardOptions<D, E2, T["resource"]["_tag"]>,
	) => Effect.Effect<
		void,
		E2 | Forbidden | Pending | PolicyUnavailable | E,
		R | Self
	>
	readonly filter: <const T extends Policy.KindTarget<D>>(
		target: T,
	) => Effect.Effect<
		Condition.Condition<
			Policy.ResidualReads<D, T["kind"]>,
			Condition.Opaque<E>
		>,
		PolicyUnavailable | E,
		R | Self
	>
	readonly coverage: <const T extends Policy.KindTarget<D>>(
		target: T,
	) => Effect.Effect<
		Policy.Coverage<Policy.ResidualReads<D, T["kind"]>, Condition.Opaque<E>>,
		PolicyUnavailable | E,
		R | Self
	>
	readonly permittedFields: (
		target: Policy.FieldlessTarget<D>,
	) => Effect.Effect<ReadonlyArray<string>, PolicyUnavailable | E, R | Self>
}

/**
 * Any service class made by {@link Service}.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type AnyServiceClass = Context.Key<any, any> & {
	readonly domain: Domain.Any
	readonly principal: Effect.Effect<any, any, any>
}

/**
 * Makes an authorizer service class for a domain.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const Service: <Self>() => <
	const Id extends string,
	D extends Domain.Any,
	E = never,
	R = never,
>(
	id: Id,
	options: {
		readonly domain: D
		/** Gives the principal of the current request. */
		readonly principal: Effect.Effect<Domain.Principal<NoInfer<D>>, E, R>
	},
) => ServiceClass<Self, Id, D, E, R> = Internal.Service as never

/**
 * The options of {@link layer}.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Options<D extends Domain.Any, E, R, EL, RL, RP> {
	/**
	 * Loads the policy of a principal. A failure becomes
	 * {@link PolicyUnavailable}. The services of the predicates of the policy
	 * are taken when the layer is built. The loader gets the same principal
	 * object as the current request, with no copy or JSON change.
	 */
	readonly policy: (
		principal: Domain.Principal<D>,
	) => Effect.Effect<Policy.Policy<D, Condition.Opaque<E, RP>>, EL, RL>
	/**
	 * Answers when no rule gives an answer. Without a decider, such a request
	 * fails with {@link Forbidden}.
	 */
	readonly decider?: (
		request: DeciderRequest<D>,
	) => Effect.Effect<Decision.Decision, Pending | E, R>
}

/**
 * Makes the layer of an authorizer.
 *
 * @stability stable
 * @category layers
 * @since 0.3.0
 */
export const layer: <
	Self,
	Id extends string,
	D extends Domain.Any,
	E,
	R,
	EL = never,
	RL = never,
	RP = never,
>(
	service: ServiceClass<Self, Id, D, E, R>,
	options: Options<D, NoInfer<E>, NoInfer<R>, EL, RL, RP>,
) => Layer.Layer<Self, never, RL | RP> = Internal.makeLayer as never
