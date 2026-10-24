/**
 * An authorizer is an Effect service that makes decisions for the principal
 * of the current request.
 *
 * You make the service class, in the same way as `Context.Service`. Give the
 * services that the principal and the decider need as `requires`, and their
 * errors as `error`:
 *
 * ```ts
 * class Auth extends Authorizer.Service<Auth, { requires: Identity }>()(
 *   "app/Auth",
 *   App,
 * ) {}
 * ```
 *
 * Then give a layer with {@link layer}. It says where the principal comes
 * from and how to load its policy. The policy of each principal is loaded
 * once and kept in a cache for a short time.
 *
 * Then use the service in a handler:
 *
 * ```ts
 * yield* Auth.check({ action: "update", resource: bot })
 * ```
 *
 * A "no" answer goes into the error channel as {@link Forbidden}. When the
 * policy can not be loaded, the check fails with {@link PolicyUnavailable}.
 * So the check fails closed: an error is never a "yes".
 *
 * When no rule gives an answer, the authorizer asks the decider, if there is
 * one. A decider may answer at once, or fail with {@link Pending} when a person
 * or a Bot must answer later.
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
import * as Schema from "effect/Schema"
import * as Condition from "./Condition.ts"
import * as Decision from "./Decision.ts"
import type * as Domain from "./Domain.ts"
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
 * The services and the errors of the principal and the decider of an
 * authorizer.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Config {
	readonly requires?: unknown
	readonly error?: unknown
}

type RequiresOf<C> = C extends { readonly requires: infer R } ? R : never
type ErrorOf<C> = C extends { readonly error: infer E } ? E : never

/**
 * What a check is about: an act on a resource value, or an act on a kind of
 * resource. A check on a kind passes only when the policy allows the act on
 * every value of the kind.
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
export interface GuardOptions<D, E2> {
	/** The action that lets the principal see the resource. The default is `"read"`. */
	readonly read?: Domain.AnyAction<D>
	/** The error when the principal may not see the resource. */
	readonly hide: () => E2
}

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
	readonly guard: <E2>(
		target: Policy.Target<D>,
		options: GuardOptions<D, E2>,
	) => Effect.Effect<void, E2 | Forbidden | Pending | PolicyUnavailable | E, R>
	/**
	 * Gives the condition on resource values that the principal may act on.
	 * Change it into a query with `Condition.fold`.
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
	readonly guard: <E2>(
		target: Policy.Target<D>,
		options: GuardOptions<D, E2>,
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
}

/**
 * Makes an authorizer service class for a domain.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const Service: <Self, C extends Config = {}>() => <
	const Id extends string,
	D extends Domain.Any,
>(
	id: Id,
	domain: D,
) => ServiceClass<Self, Id, D, ErrorOf<C>, RequiresOf<C>> = (() =>
	(id: string, domain: Domain.Any) => {
		const Base = Context.Service<any, any>()(id)
		return class extends Base {
			static readonly domain = domain
			static readonly decide = (target: AnyTarget) =>
				this.use((service: any) => service.decide(target))
			static readonly check = (target: AnyTarget) =>
				this.use((service: any) => service.check(target))
			static readonly guard = (target: AnyTarget, options: unknown) =>
				this.use((service: any) => service.guard(target, options))
			static readonly filter = (target: AnyTarget) =>
				this.use((service: any) => service.filter(target))
			static readonly permittedFields = (target: AnyTarget) =>
				this.use((service: any) => service.permittedFields(target))
		}
	}) as never

type AnyTarget = {
	readonly action: string
	readonly resource?: object
	readonly kind?: string
	readonly field?: string
}

/**
 * The options of {@link layer}.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Options<D extends Domain.Any, E, R, EL, RL, RP> {
	/** Gives the principal of the current request. */
	readonly principal: Effect.Effect<Domain.Principal<D>, E, R>
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
	 */
	readonly cache?:
		| {
				readonly capacity?: number
				readonly timeToLive?: Duration.Input
		  }
		| false
}

/**
 * A cache key for a principal. Two keys are equal when they have the same
 * text, so two principals with the same value share one policy. The key also
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
 * Tests if an array has a plain field at each index below its length. With
 * one more own key for `length`, it then has no other own keys.
 */
const hasEveryIndex = (value: Array<unknown>): boolean => {
	for (let index = 0; index < value.length; index++) {
		if (!isPlainField(value, String(index))) {
			return false
		}
	}
	return true
}

/**
 * Tests if an own key of an object holds plain data that the text shows: it
 * can be seen in a loop over the keys, and it is not a getter.
 */
const isPlainField = (value: object, key: string): boolean => {
	const descriptor = Object.getOwnPropertyDescriptor(value, key)
	return (
		descriptor !== undefined &&
		descriptor.enumerable === true &&
		"value" in descriptor
	)
}

const classIds = new WeakMap<object, number>()
let nextClassId = 0

/** Gives a number that is only for this class. */
const classId = (constructor: object): string => {
	let id = classIds.get(constructor)
	if (id === undefined) {
		id = nextClassId
		nextClassId = nextClassId + 1
		classIds.set(constructor, id)
	}
	return `#${String(id)}`
}

/**
 * Gives a text that names a principal value. Two values get one text only when
 * they have the same types and the same data. So a string `"1"` and a bigint
 * `1n` get two texts. The text keeps the class of each object, by a number
 * that is its own, because two classes may have one name.
 *
 * It reads only the fields of plain objects and of `Schema.Class` values, and
 * only when each own key is a plain field that a loop over the keys can see.
 * An object of another class may keep its data where the text can not see it,
 * as a `URL` does. So it gives `undefined` for such an object, unless it is a
 * plain `Date`, `URL`, array, `Map` or `Set` with no extra own keys. It also
 * gives `undefined` for a function, a symbol, or a value that contains itself.
 * The private fields (`#name`) of a class can not be seen, so a principal
 * class must not keep its data in them.
 */
const keyText = (value: unknown, seen: Set<object>): string | undefined => {
	switch (typeof value) {
		case "string":
			return `s${JSON.stringify(value)}`
		case "number":
			return Object.is(value, -0) ? "n-0" : `n${String(value)}`
		case "bigint":
			return `b${String(value)}`
		case "boolean":
			return value ? "true" : "false"
		case "undefined":
			return "undefined"
		case "object":
			break
		default:
			return undefined
	}
	if (value === null) {
		return "null"
	}
	if (seen.has(value)) {
		return undefined
	}
	seen.add(value)
	const all = (items: Iterable<unknown>): Array<string> | undefined => {
		const output: Array<string> = []
		for (const item of items) {
			const text = keyText(item, seen)
			if (text === undefined) {
				return undefined
			}
			output.push(text)
		}
		return output
	}
	let text: string | undefined
	const prototype: unknown = Object.getPrototypeOf(value)
	// The own keys of the value. A built-in value keeps its data inside, so it
	// may have no own keys, and the elements of an array are its own keys. An
	// extra own key is data that the text does not show.
	const own = Reflect.ownKeys(value)
	// The entries of a map or a set keep their order, because a loader may read
	// the first one.
	if (prototype === Date.prototype && own.length === 0) {
		text = `d${String((value as Date).getTime())}`
	} else if (prototype === URL.prototype && own.length === 0) {
		text = `u${JSON.stringify((value as URL).href)}`
	} else if (
		prototype === Array.prototype &&
		own.length === (value as Array<unknown>).length + 1 &&
		hasEveryIndex(value as Array<unknown>)
	) {
		const items = all(value as Array<unknown>)
		text = items === undefined ? undefined : `[${items.join(",")}]`
	} else if (prototype === Map.prototype && own.length === 0) {
		const entries = all(
			Array.from(value as Map<unknown, unknown>, ([key, item]) => [key, item]),
		)
		text = entries === undefined ? undefined : `Map{${entries.join(",")}}`
	} else if (prototype === Set.prototype && own.length === 0) {
		const items = all(value as Set<unknown>)
		text = items === undefined ? undefined : `Set{${items.join(",")}}`
	} else if (
		(prototype === null ||
			prototype === Object.prototype ||
			Schema.isSchema((prototype as object).constructor)) &&
		own.every((key) => typeof key === "string" && isPlainField(value, key))
	) {
		// The keys keep their order, because a loader may read the first one.
		const keys = own as Array<string>
		const items = all(
			keys.map((key) => (value as Record<string, unknown>)[key]),
		)
		const name =
			prototype === null ? "" : classId((prototype as object).constructor)
		text =
			items === undefined
				? undefined
				: `${name}{${keys.map((key, index) => `${JSON.stringify(key)}:${items[index]!}`).join(",")}}`
	}
	seen.delete(value)
	return text
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
		readonly principal: Effect.Effect<object, unknown, unknown>
		readonly policy: (
			principal: object,
		) => Effect.Effect<Policy.Any, unknown, unknown>
		readonly decider?: (
			request: object,
		) => Effect.Effect<Decision.Decision, unknown, unknown>
		readonly cache?:
			| { readonly capacity?: number; readonly timeToLive?: Duration.Input }
			| false
	},
) => {
	const domain: Domain.Any = service.domain
	// It gives `undefined` when the principal has no key. Such a principal does
	// not use the cache.
	const keyOf = (principal: object): PrincipalKey | undefined => {
		const text = keyText(principal, new Set())
		return text === undefined ? undefined : new PrincipalKey(principal, text)
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
				const principal = yield* options.principal
				const value = yield* policyFor(principal)
				return { principal, policy: value }
			})

			const decide = Effect.fnUntraced(function* (target: AnyTarget) {
				const { principal, policy: value } = yield* current
				const decision: Decision.Decision = yield* withServices(
					Policy.decide(value, { ...target, principal } as never),
				)
				return decision
			})

			const kindDecision = (
				value: Policy.Any,
				principal: object,
				target: AnyTarget,
			): Decision.Decision => {
				const pair = Policy.residuals(value, {
					...target,
					principal,
				} as never)
				if (pair.allow._tag === "True") {
					return Decision.Allow({})
				}
				// The decider may answer for the whole kind only when no value is
				// denied, and when no predicate may fail. Else some value may get a
				// "no" from the policy, so the answer for the kind is "no".
				if (pair.deny._tag === "False" && !Condition.hasPredicate(pair.allow)) {
					return Decision.NotApplicable
				}
				return Decision.Deny({})
			}

			const check = Effect.fnUntraced(function* (target: AnyTarget) {
				const { principal, policy: value } = yield* current
				const kind =
					target.resource === undefined
						? (target.kind ?? "")
						: (Resource.kindOf(target.resource) ?? "")
				let decision: Decision.Decision =
					target.resource === undefined
						? kindDecision(value, principal, target)
						: yield* withServices(
								Policy.decide(value, { ...target, principal } as never),
							)
				if (
					decision._tag === "NotApplicable" &&
					options.decider !== undefined
				) {
					decision = yield* options.decider({ ...target, principal })
				}
				if (decision._tag !== "Allow") {
					return yield* forbidden(target, kind, Decision.reason(decision))
				}
			})

			const guard = Effect.fnUntraced(function* (
				target: AnyTarget,
				guardOptions: {
					readonly read?: string
					readonly hide: () => unknown
				},
			) {
				const read = guardOptions.read ?? "read"
				const { field: _field, ...rest } = target
				const visible: Decision.Decision = yield* decide({
					...rest,
					action: read,
				})
				if (visible._tag !== "Allow") {
					return yield* Effect.fail(guardOptions.hide())
				}
				if (target.action !== read || target.field !== undefined) {
					yield* check(target)
				}
			})

			const filter = (
				target: AnyTarget,
			): Effect.Effect<Condition.Ast, unknown, unknown> =>
				Effect.map(current, ({ principal, policy: value }) =>
					Policy.residual(value, { ...target, principal } as never),
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
				principal: options.principal,
				policy: Effect.map(current, ({ policy: value }) => value),
				decide,
				check,
				guard,
				filter,
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
