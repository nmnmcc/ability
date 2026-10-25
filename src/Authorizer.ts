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
 * principal. The policy of each principal is loaded once and kept in a cache
 * for a short time.
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
// The service erases the error type and the service type of predicates,
// principals and deciders to `unknown`. The public types keep them, so the
// language service check for `unknown` in an Effect is off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Cache from "effect/Cache"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Hash from "effect/Hash"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Condition from "./Condition.ts"
import * as Decision from "./Decision.ts"
import * as Domain from "./Domain.ts"
import * as Policy from "./Policy.ts"
import * as Resource from "./Resource.ts"

/**
 * The error when a policy says no.
 *
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export class Forbidden extends Schema.TaggedError<Forbidden>(
	"@nmnmcc/ability/Authorizer/Forbidden",
)("Forbidden", {
	action: Schema.String,
	kind: Schema.String,
	field: Schema.optionalKey(Schema.String),
	reason: Schema.optionalKey(Schema.String),
}) {}

/**
 * The error when the policy of the principal can not be loaded. The cause is
 * kept, but it is not shown to the client.
 *
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export class PolicyUnavailable extends Schema.TaggedError<PolicyUnavailable>(
	"@nmnmcc/ability/Authorizer/PolicyUnavailable",
)("PolicyUnavailable", { cause: Schema.Defect() }) {}

/**
 * The error when a decider must wait for an answer. `ticket` names the
 * request that waits, so the client can come back for the answer.
 *
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export class Pending extends Schema.TaggedError<Pending>(
	"@nmnmcc/ability/Authorizer/Pending",
)("Pending", {
	ticket: Schema.String,
	reason: Schema.optionalKey(Schema.String),
}) {}

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
 * A request to the decider.
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
		Policy.Policy<D, E, never, Condition.Opaque>,
		PolicyUnavailable | E,
		R
	>
	/** Gives the decision of the policy. It does not ask the decider. */
	readonly decide: (
		target: Policy.Target<D>,
	) => Effect.Effect<Decision.Decision, PolicyUnavailable | E, R>
	/** Succeeds when the principal may do the act, and fails when it may not. */
	readonly check: (
		target: Target<D>,
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
	 * with `Condition.fold`. It is `False` when the principal may act on no
	 * value, so the list is empty: it is not an error.
	 */
	readonly filter: <const T extends Policy.KindTarget<D>>(
		target: T,
	) => Effect.Effect<
		Condition.Condition<
			E,
			never,
			Condition.Opaque,
			Policy.ResidualReads<D, T["kind"]>
		>,
		PolicyUnavailable | E,
		R
	>
	/**
	 * Tells if the principal may act on all, none or some of the values in
	 * the scope of the target. See `Policy.coverage`. Use it to show a button
	 * only when the answer is not `None`.
	 */
	readonly coverage: <const T extends Policy.KindTarget<D>>(
		target: T,
	) => Effect.Effect<
		Policy.Coverage<
			E,
			never,
			Condition.Opaque,
			Policy.ResidualReads<D, T["kind"]>
		>,
		PolicyUnavailable | E,
		R
	>
	/** Gives the fields of a value that the principal may use. */
	readonly permittedFields: (
		target: Policy.FieldlessTarget<D>,
	) => Effect.Effect<ReadonlyArray<string>, PolicyUnavailable | E, R>
	/**
	 * Removes the cached policy of a principal, or of every principal. Call it
	 * after a change to the rules or roles of a principal.
	 */
	readonly invalidate: (principal?: Domain.Principal<D>) => Effect.Effect<void>
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
	readonly decide: (
		target: Policy.Target<D>,
	) => Effect.Effect<Decision.Decision, PolicyUnavailable | E, R | Self>
	readonly check: (
		target: Target<D>,
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
			E,
			never,
			Condition.Opaque,
			Policy.ResidualReads<D, T["kind"]>
		>,
		PolicyUnavailable | E,
		R | Self
	>
	readonly coverage: <const T extends Policy.KindTarget<D>>(
		target: T,
	) => Effect.Effect<
		Policy.Coverage<
			E,
			never,
			Condition.Opaque,
			Policy.ResidualReads<D, T["kind"]>
		>,
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
) => ServiceClass<Self, Id, D, E, R> = (() =>
	(
		id: string,
		options: {
			readonly domain: Domain.Any
			readonly principal: Effect.Effect<any, any, any>
		},
	) => {
		const Base = Context.Service<any, any>()(id)
		return class extends Base {
			static readonly domain = options.domain
			static readonly principal = options.principal
			static readonly decide = (target: AnyTarget) =>
				this.use((service: any) => service.decide(target))
			static readonly check = (target: AnyTarget) =>
				this.use((service: any) => service.check(target))
			static readonly guard = (target: AnyTarget, options: unknown) =>
				this.use((service: any) => service.guard(target, options))
			static readonly filter = (target: AnyTarget) =>
				this.use((service: any) => service.filter(target))
			static readonly coverage = (target: AnyTarget) =>
				this.use((service: any) => service.coverage(target))
			static readonly permittedFields = (target: AnyTarget) =>
				this.use((service: any) => service.permittedFields(target))
		}
	}) as never

type AnyTarget = {
	readonly action: string
	readonly resource?: object
	readonly kind?: string
	readonly field?: string
	readonly within?: unknown
}

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
	 * are taken when the layer is built.
	 */
	readonly policy: (
		principal: Domain.Principal<D>,
	) => Effect.Effect<Policy.Policy<D, E, RP, any>, EL, RL>
	/**
	 * Answers when no rule gives an answer. Without a decider, such a request
	 * fails with {@link Forbidden}.
	 */
	readonly decider?: (
		request: DeciderRequest<D>,
	) => Effect.Effect<Decision.Decision, Pending | E, R>
	/**
	 * How the policies are kept. The default keeps 1000 policies for 30 seconds.
	 * Give `false` to load the policy for each check.
	 *
	 * The key of a principal is the text of its JSON form, from the Schema of
	 * the principal of the domain. A principal is kept only when the value that
	 * the Schema decodes from that form is `Equal` to it. The loader gets that
	 * decoded copy, so two principals with one key get one policy, and the
	 * cache can not change an answer. So the loader must decide by the data of
	 * the principal, not by the identity of its objects. Give `key` to make the
	 * key in another way: then the loader gets the principal of the first check
	 * with the key.
	 */
	readonly cache?:
		| {
				readonly capacity?: number
				readonly timeToLive?: Duration.Input
				readonly key?: (principal: Domain.Principal<D>) => string | undefined
		  }
		| false
}

/**
 * A cache key for a principal. Two keys are equal when they have the same
 * text, so two principals with the same key share one policy. The key also
 * keeps the principal, so the cache can load its policy. A plain `Data` value
 * can not do both, so the key gives its own equality with `Equal.Equal`.
 */
class PrincipalKey implements Equal.Equal {
	readonly principal: object
	readonly text: string
	constructor(principal: object, text: string) {
		this.principal = principal
		this.text = text
	}
	[Equal.symbol](that: unknown): boolean {
		return that instanceof PrincipalKey && that.text === this.text
	}
	[Hash.symbol](): number {
		return Hash.string(this.text)
	}
}

/**
 * Makes the cache key of a principal from its JSON form. The key keeps the
 * principal that the Schema decodes from that form, so the loader sees only
 * the data that the key shows. A principal gets no key when it does not
 * encode, or when the decoded value is not `Equal` to it. Two classes, or a
 * string and a number, may have one JSON form, as in a union, and `Equal`
 * tells them apart. So two principals with one key are equal, and the cache
 * can not give one the policy of the other.
 */
const jsonKey = (
	schema: Schema.Top,
): ((principal: object) => PrincipalKey | undefined) => {
	const codec = Schema.toCodecJson(schema) as unknown as Schema.Codec<
		unknown,
		unknown
	>
	const encode = Schema.encodeUnknownResult(codec)
	const decode = Schema.decodeUnknownResult(codec)
	const keyOf = (principal: object): PrincipalKey | undefined =>
		Result.match(encode(principal), {
			onFailure: () => undefined,
			onSuccess: (json) =>
				Result.match(decode(json), {
					onFailure: () => undefined,
					onSuccess: (decoded) =>
						Equal.equals(decoded, principal)
							? new PrincipalKey(decoded as object, JSON.stringify(json))
							: undefined,
				}),
		})
	return (principal) => {
		// A very deep principal may fill the stack of the encoder or of
		// `Equal`. Such a principal is not kept.
		try {
			return keyOf(principal)
		} catch {
			return undefined
		}
	}
}

const forbidden = (
	target: AnyTarget,
	kind: string,
	reason: string | undefined,
): Forbidden =>
	Forbidden.make({
		action: target.action,
		kind,
		...(target.field === undefined ? {} : { field: target.field }),
		...(reason === undefined ? {} : { reason }),
	})

const makeLayer = (
	service: AnyServiceClass,
	options: {
		readonly policy: (
			principal: object,
		) => Effect.Effect<Policy.Any, unknown, unknown>
		readonly decider?: (
			request: object,
		) => Effect.Effect<Decision.Decision, unknown, unknown>
		readonly cache?:
			| {
					readonly capacity?: number
					readonly timeToLive?: Duration.Input
					readonly key?: (principal: object) => string | undefined
			  }
			| false
	},
) => {
	const domain: Domain.Any = service.domain
	// It gives `undefined` when the principal has no key. Such a principal does
	// not use the cache.
	const custom = options.cache === false ? undefined : options.cache?.key
	const keyOf: (principal: object) => PrincipalKey | undefined =
		custom === undefined
			? jsonKey(domain.principal)
			: (principal) => {
					const text = custom(principal)
					return text === undefined
						? undefined
						: new PrincipalKey(principal, text)
				}
	return Layer.effect(
		service,
		Effect.gen(function* () {
			// The services of the policy loader and of the predicates come from the
			// layer, so a check does not need them.
			const services = yield* Effect.context<never>()

			// The predicates of the policy get the services of the layer, so the
			// policy and its residual conditions need no services.
			// A policy of another domain may have the same types, but its resources
			// may have other paths. So it fails closed, as a policy that can not be
			// loaded.
			const load = (principal: object) =>
				options.policy(principal).pipe(
					Effect.provideContext(services),
					Effect.filterOrFail(
						(value) => value.domain === domain,
						() =>
							new globalThis.Error(
								"The loaded policy is not a policy of this domain",
							),
					),
					Effect.mapError((cause) => PolicyUnavailable.make({ cause })),
					Effect.map((value) =>
						Policy.provideContext(value, services as never),
					),
				)

			const cache =
				options.cache === false
					? undefined
					: yield* Cache.make({
							capacity: options.cache?.capacity ?? 1000,
							timeToLive: options.cache?.timeToLive ?? "30 seconds",
							lookup: (key: PrincipalKey) => load(key.principal),
						})

			const policyFor = (principal: object) => {
				const key = cache === undefined ? undefined : keyOf(principal)
				if (cache === undefined || key === undefined) {
					return load(principal)
				}
				// A failed lookup is kept in the cache. Remove it, so the next check
				// tries again.
				return Cache.get(cache, key).pipe(
					Effect.tapError(() => Cache.invalidate(cache, key)),
				)
			}

			const withServices = <A, E>(
				effect: Effect.Effect<A, E, unknown>,
			): Effect.Effect<A, E, unknown> => Effect.provideContext(effect, services)

			const current = Effect.gen(function* () {
				const principal = yield* service.principal
				const value = yield* policyFor(principal)
				return { principal, policy: value }
			})

			// The principal and its policy, loaded one time. A check that asks
			// the policy two times, such as `guard`, uses one snapshot for both,
			// so the two answers come from one principal.
			type Snapshot = Effect.Success<typeof current>

			const decideWith = Effect.fnUntraced(function* (
				{ principal, policy: value }: Snapshot,
				target: AnyTarget,
			) {
				const decision: Decision.Decision = yield* withServices(
					Policy.decide(value, { ...target, principal } as never),
				)
				return decision
			})

			const decide = (target: AnyTarget) =>
				Effect.flatMap(current, (snapshot) => decideWith(snapshot, target))

			const checkWith = Effect.fnUntraced(function* (
				{ principal, policy: value }: Snapshot,
				target: AnyTarget,
			) {
				const kind =
					target.resource === undefined
						? (target.kind ?? "")
						: (Resource.kindOf(target.resource) ?? "")
				// A request that does not fit its kind gets a "no" at once. The
				// decider must not say yes to an action that the kind does not have.
				const descriptor = Domain.descriptorOf(domain, kind)
				if (descriptor === undefined || !Policy.fitsKind(descriptor, target)) {
					return yield* forbidden(target, kind, undefined)
				}
				const fromPolicy: Decision.Decision =
					target.resource === undefined
						? Policy.decideKind(value, { ...target, principal } as never)
						: yield* withServices(
								Policy.decide(value, { ...target, principal } as never),
							)
				// When no rule gives an answer, the decider gives it.
				const decision: Decision.Decision =
					fromPolicy._tag === "NotApplicable" && options.decider !== undefined
						? yield* options.decider({ ...target, principal })
						: fromPolicy
				if (decision._tag !== "Allow") {
					return yield* forbidden(target, kind, Decision.reason(decision))
				}
			})

			const check = (target: AnyTarget) =>
				Effect.flatMap(current, (snapshot) => checkWith(snapshot, target))

			const guard = Effect.fnUntraced(function* (
				target: AnyTarget,
				guardOptions: {
					readonly read?: string
					readonly hide: () => unknown
				},
			) {
				const snapshot = yield* current
				const read = guardOptions.read ?? "read"
				const { field: _field, ...rest } = target
				const visible: Decision.Decision = yield* decideWith(snapshot, {
					...rest,
					action: read,
				})
				if (visible._tag !== "Allow") {
					return yield* Effect.fail(guardOptions.hide())
				}
				if (target.action !== read || target.field !== undefined) {
					yield* checkWith(snapshot, target)
				}
			})

			// The filter is the condition of the coverage: the scope for `All`,
			// `False` for `None`, and else the residual condition in the scope.
			// The residual throws an error when it is too large, so the filter
			// fails.
			const filter = (
				target: AnyTarget,
			): Effect.Effect<Condition.Ast, unknown, unknown> =>
				Effect.map(
					current,
					({ principal, policy: value }): Condition.Ast =>
						Policy.coverage(value, { ...target, principal } as never)
							.condition as Condition.Ast,
				)

			const coverage = (
				target: AnyTarget,
			): Effect.Effect<Policy.Coverage<any, any, any, any>, unknown, unknown> =>
				Effect.map(current, ({ principal, policy: value }) =>
					Policy.coverage(value, { ...target, principal } as never),
				)

			const permittedFields = Effect.fnUntraced(function* (target: AnyTarget) {
				const { principal, policy: value } = yield* current
				return yield* withServices(
					Policy.permittedFields(value, { ...target, principal } as never),
				)
			})

			const invalidate = (principal?: object) => {
				if (cache === undefined) {
					return Effect.void
				}
				if (principal === undefined) {
					return Cache.invalidateAll(cache)
				}
				const key = keyOf(principal)
				return key === undefined ? Effect.void : Cache.invalidate(cache, key)
			}

			return {
				domain,
				principal: service.principal,
				policy: Effect.map(current, ({ policy: value }) => value),
				decide,
				check,
				guard,
				filter,
				coverage,
				permittedFields,
				invalidate,
			} as never
		}),
	)
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
) => Layer.Layer<Self, never, RL | RP> = makeLayer as never
