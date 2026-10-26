/**
 * The values of authorizers: the errors, the service class and the layer.
 * The types are in `Authorizer.ts`.
 */
// The service erases the error type and the service type of predicates,
// principals and deciders to `unknown`. The public types keep them, so the
// language service check for `unknown` in an Effect is off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Arr from "effect/Array"
import * as Cache from "effect/Cache"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Hash from "effect/Hash"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Authorizer from "../Authorizer.ts"
import type * as Condition from "../Condition.ts"
import * as Decision from "../Decision.ts"
import type * as Domain from "../Domain.ts"
import type * as Policy from "../Policy.ts"
import * as Analysis from "./analysis.ts"
import * as Decide from "./decide.ts"
import * as DomainData from "./domain.ts"
import * as Policies from "./policy.ts"
import * as ResourceData from "./resource.ts"

type AnyServiceClass = Authorizer.AnyServiceClass

/** The error when a policy says no. */
export class Forbidden extends Schema.TaggedError<Forbidden>(
	"@nmnmcc/ability/Authorizer/Forbidden",
)("Forbidden", {
	action: Schema.String,
	kind: Schema.String,
	field: Schema.optionalKey(Schema.String),
	reason: Schema.optionalKey(Schema.String),
}) {}

/** The error when the policy of the principal can not be loaded. */
export class PolicyUnavailable extends Schema.TaggedError<PolicyUnavailable>(
	"@nmnmcc/ability/Authorizer/PolicyUnavailable",
)("PolicyUnavailable", { cause: Schema.Defect() }) {}

/** The error when a decider must wait for an answer. */
export class Pending extends Schema.TaggedError<Pending>(
	"@nmnmcc/ability/Authorizer/Pending",
)("Pending", {
	ticket: Schema.String,
	reason: Schema.optionalKey(Schema.String),
}) {}

/** Makes an authorizer service class for a domain. */
export const Service =
	() =>
	(
		id: string,
		options: {
			readonly domain: Domain.Any
			readonly principal: Effect.Effect<any, any, any>
		},
		// The class has no name, and its type uses types of Effect that a
		// declaration file can not name. So this function gives a `Context.Key`.
		// The public module gives the full type.
	): Context.Key<any, any> => {
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
	}

type AnyTarget = {
	readonly action: string
	readonly resource?: object
	readonly kind?: string
	readonly field?: string
	readonly within?: unknown
}

/**
 * A cache key for a principal. Two keys are equal when they have the same
 * text, so two principals with the same key share one policy. The key also
 * keeps the principal that the loader gets, so the cache can load its
 * policy. A `Data` value would compare the principal too, so the key gives
 * its own equality with `Equal.Equal`.
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
 * Gives the JSON codec of a Schema, or `undefined` when the Schema has no JSON
 * form, as a struct with a symbol key has none.
 */
const jsonCodecOf = (
	schema: Schema.Top,
): Schema.Codec<unknown, unknown> | undefined => {
	try {
		return Schema.toCodecJson(schema) as unknown as Schema.Codec<
			unknown,
			unknown
		>
	} catch {
		return undefined
	}
}

/**
 * Makes the cache key of a principal from its JSON form. The key is the text
 * of the form, and it keeps the principal that the Schema decodes from that
 * text. The loader gets only that copy, so what it sees comes from the text.
 * A Schema must decode one text to one value each time. Data that it makes
 * when it decodes, as `expired` from the time now, is kept with the policy
 * until the entry ends, as data that the loader reads is.
 *
 * A principal gets no key when it does not encode, or when the copy is not
 * `Equal` to it. Two classes, or a string and a number, may have one JSON
 * form, as in a union, and a copy of the other class is not the principal.
 */
const jsonKey = (
	schema: Schema.Top,
	most: number,
): {
	readonly keyOf: (principal: object) => PrincipalKey | undefined
	/**
	 * The text of the JSON form of a principal, with no test of the copy. A
	 * key with this text is the key that a check of the principal used, also
	 * when its copy now is another value, as `expired` from the time now:
	 * `invalidate` takes away that key.
	 */
	readonly textOf: (principal: object) => string | undefined
} => {
	const codec = jsonCodecOf(schema)
	// A principal with no JSON form is never kept.
	if (codec === undefined) {
		return { keyOf: () => undefined, textOf: () => undefined }
	}
	const encode = Schema.encodeUnknownResult(codec)
	const decode = Schema.decodeUnknownResult(codec)
	// The JSON form has a shared part at each place, so a principal of few
	// objects may have a very large form. A principal past the limit is not
	// kept: a try can not stop a heap that fills up. A very deep principal may
	// fill the stack of the encoder or of `Equal`. Such a principal is not
	// kept either.
	const guarded =
		<A>(make: (principal: object) => A | undefined) =>
		(principal: object): A | undefined => {
			if (!fitsNodes(principal, most)) {
				return undefined
			}
			try {
				return make(principal)
			} catch {
				return undefined
			}
		}
	// The encoded value may hold more than its text shows, as an object of a
	// `Schema.Any` field does: `JSON.stringify` leaves out a map. So the copy
	// comes from the text.
	const textOf = guarded((principal) =>
		Result.match(encode(principal), {
			onFailure: () => undefined,
			onSuccess: (json) => JSON.stringify(json),
		}),
	)
	const keyOf = guarded((principal) => {
		const text = textOf(principal)
		return text === undefined
			? undefined
			: Result.match(decode(JSON.parse(text)), {
					onFailure: () => undefined,
					onSuccess: (decoded) =>
						Equal.equals(decoded, principal)
							? new PrincipalKey(decoded as object, text)
							: undefined,
				})
	})
	return { keyOf, textOf }
}

/** Tells if a name is the index of an item of a list. */
const isIndex = (name: PropertyKey): boolean =>
	typeof name === "string" &&
	/^(?:0|[1-9]\d*)$/.test(name) &&
	Number(name) < 2 ** 32 - 1

/**
 * Tells if a value has at most `most` objects and items, with a part that it
 * uses in many places counted for each place, as its JSON form has it. The
 * walk keeps a stack of the parts to visit, so a deep value does not fill the
 * stack, and it stops at the first part past `most`. A value with a loop has
 * no end of places, so it goes past `most` too, and so does a value that
 * hides its data, as a `Redacted`. The stack and the count belong to this
 * call.
 */
const fitsNodes = (root: unknown, most: number): boolean => {
	const stack: Array<unknown> = [root]
	const count = { nodes: 0 }
	const partsOf = (value: object): ReadonlyArray<unknown> | undefined => {
		const size =
			value instanceof Map || value instanceof Set
				? value.size
				: Array.isArray(value)
					? value.length
					: undefined
		// A list past the limit is past it with no copy of its items.
		if (size !== undefined && count.nodes + size > most) {
			return undefined
		}
		// A codec may read any own field, also a hidden one, and also an own
		// field of a value that keeps its data inside, as a date. A getter may
		// give any value each time, so a value with one has no known size.
		const list = Array.isArray(value)
		const names = Arr.filter(
			Reflect.ownKeys(value),
			(name) => !(list && (name === "length" || isIndex(name))),
		)
		const fields = Arr.map(names, (name) =>
			Object.getOwnPropertyDescriptor(value, name),
		)
		if (
			Arr.some(fields, (field) => field !== undefined && !("value" in field))
		) {
			return undefined
		}
		const own = Arr.map(fields, (field) => field?.value as unknown)
		if (value instanceof Map) {
			return [...value.keys(), ...value.values(), ...own]
		}
		if (value instanceof Set || list) {
			return [...Array.from(value as Iterable<unknown>), ...own]
		}
		// These keep their data inside, and it is small. An `Option` with no
		// value has no own fields.
		if (
			value instanceof Date ||
			value instanceof URL ||
			value instanceof RegExp ||
			(Option.isOption(value) && Option.isNone(value))
		) {
			return own
		}
		// A value of a class with no own fields, as a `Redacted`, keeps its
		// data where the walk can not see it, but its codec reads it. Such a
		// value has no known size, so it is past the limit.
		const prototype: unknown = Object.getPrototypeOf(value)
		if (
			names.length === 0 &&
			prototype !== Object.prototype &&
			prototype !== null
		) {
			return undefined
		}
		return own
	}
	Arr.unfold(0, (step) => {
		if (stack.length === 0 || count.nodes > most) {
			return Option.none()
		}
		const value = stack.pop()
		if (typeof value === "object" && value !== null) {
			count.nodes += 1
			const parts = partsOf(value)
			if (parts === undefined) {
				count.nodes = most + 1
			} else {
				count.nodes += parts.length
				Arr.forEach(parts, (part) => {
					stack.push(part)
				})
			}
		}
		return Option.some([step, step + 1] as const)
	})
	return count.nodes <= most
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

/** Makes the layer of an authorizer. */
export const makeLayer = (
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
	// The JSON form of a principal, and the copy that the Schema decodes from
	// it. The loader always gets the copy, with a cache or not, so a cache can
	// not change an answer: a form may lose data that `Equal` does not see,
	// as `-0` becomes `0`. A principal with no such form gives `undefined`.
	const json = jsonKey(domain.principal, domain.limits.principalNodes)
	const canonicalOf = json.keyOf
	const custom = options.cache === false ? undefined : options.cache?.key
	// It gives `undefined` when the principal has no key. Such a principal does
	// not use the cache.
	const keyOf = (
		principal: object,
		canonical: PrincipalKey | undefined,
	): PrincipalKey | undefined => {
		if (custom === undefined) {
			return canonical
		}
		const text = custom(principal)
		return text === undefined
			? undefined
			: new PrincipalKey(canonical?.principal ?? principal, text)
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
						Policies.provideContext(value, services as never),
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
				const canonical = canonicalOf(principal)
				const key =
					cache === undefined ? undefined : keyOf(principal, canonical)
				if (cache === undefined || key === undefined) {
					return load(canonical?.principal ?? principal)
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
					Decide.decideAny(value, { ...target, principal } as never),
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
						: (ResourceData.kindOf(target.resource) ?? "")
				// A request that does not fit its kind gets a "no" at once. The
				// decider must not say yes to an action that the kind does not have.
				const descriptor = DomainData.descriptorOf(domain, kind)
				if (
					descriptor === undefined ||
					!Decide.fitsKind(descriptor, target, domain.limits.fieldPathParts)
				) {
					return yield* forbidden(target, kind, undefined)
				}
				const fromPolicy: Decision.Decision =
					target.resource === undefined
						? Analysis.decideKind(value, { ...target, principal } as never)
						: yield* withServices(
								Decide.decideAny(value, { ...target, principal } as never),
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
						Analysis.coverageAny(value, { ...target, principal } as never)
							.condition as Condition.Ast,
				)

			const coverage = (
				target: AnyTarget,
			): Effect.Effect<Analysis.AnyCoverage, unknown, unknown> =>
				Effect.map(current, ({ principal, policy: value }) =>
					Analysis.coverageAny(value, { ...target, principal } as never),
				)

			const permittedFields = Effect.fnUntraced(function* (target: AnyTarget) {
				const { principal, policy: value } = yield* current
				return yield* withServices(
					Decide.permittedFields(value, { ...target, principal } as never),
				)
			})

			const invalidate = (principal?: object) => {
				if (cache === undefined) {
					return Effect.void
				}
				if (principal === undefined) {
					return Cache.invalidateAll(cache)
				}
				// A key is equal to another key by its text alone, so the key of
				// the text is the key that the check used. The copy may now be
				// another value, as `expired` from the time now, so the key does
				// not need it.
				const text =
					custom === undefined ? json.textOf(principal) : custom(principal)
				return text === undefined
					? Effect.void
					: Cache.invalidate(cache, new PrincipalKey(principal, text))
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
