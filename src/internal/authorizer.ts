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
import * as Chunk from "effect/Chunk"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Hash from "effect/Hash"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
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
import * as Trampoline from "./trampoline.ts"

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
 * text, so two principals with the same key share one policy. A key from the
 * JSON form also needs equal decoded principals: a Schema may make data when
 * it decodes, as `expired` from a time, so one text may give two principals.
 * The key also keeps the principal, so the cache can load its policy. A plain
 * `Data` value can not do all this, so the key gives its own equality with
 * `Equal.Equal`.
 */
class PrincipalKey implements Equal.Equal {
	readonly principal: object
	readonly text: string
	/**
	 * The order of the parts of the decoded principal, from {@link orderOf},
	 * when the key is the JSON form. The decoded principals must be equal
	 * too, with their parts in the same order. `undefined` for a key from
	 * `cache.key`.
	 */
	readonly order: string | undefined
	constructor(principal: object, text: string, order: string | undefined) {
		this.principal = principal
		this.text = text
		this.order = order
	}
	[Equal.symbol](that: unknown): boolean {
		return (
			that instanceof PrincipalKey &&
			that.text === this.text &&
			that.order === this.order &&
			(this.order === undefined || Equal.equals(that.principal, this.principal))
		)
	}
	[Hash.symbol](): number {
		return Hash.string(this.text)
	}
}

/**
 * The text of the order of the parts of a value: the names of the fields of
 * each object, and the items of each list, set and map, with each scalar, in
 * the order that a loop sees them. `Equal` does not see the order of the
 * fields of an object or of the items of a map, but a loader may read it, as
 * `Object.values` does. So two keys need the same order too. A scalar is in
 * the text with its type, so the items of a set or a map show their order,
 * and `-0` is not `0`: `Equal` takes them as one, but a loader may not.
 *
 * Each object gets a number at its first visit, and a later visit of it, as
 * of a part that the value shares or of a loop back to a part above, writes
 * `#` and the number. So the walk ends for a value with a loop, and a shared
 * part does not make the text very long. The numbers are in a native `Map`,
 * because the walk must find an object by the object itself. The map belongs
 * to one walk.
 *
 * A value that keeps its data inside, with no own fields, as a `Date`, a
 * `URL` or a `RegExp` with the place of its next match, is in the text with
 * its data, and so is an `Option`.
 * For another such value, the walk can not see the data, so it throws, and
 * the principal gets no key: it is not kept.
 */
const orderOf = (root: unknown): string => {
	const ids = new Map<object, number>()
	return Trampoline.adaptive<unknown, string>((R, child) => (value, depth) => {
		if (typeof value !== "object" || value === null) {
			return R.succeed(
				typeof value === "string"
					? JSON.stringify(value)
					: Object.is(value, -0)
						? "number:-0"
						: `${typeof value}:${String(value)}`,
			)
		}
		const known = ids.get(value)
		if (known !== undefined) {
			return R.succeed(`#${String(known)}`)
		}
		ids.set(value, ids.size)
		const items = (list: ReadonlyArray<unknown>) =>
			R.forEach(list, (item) => child(item, depth + 1))
		if (value instanceof Date) {
			return R.succeed(`date:${String(value.getTime())}`)
		}
		if (value instanceof URL) {
			return R.succeed(`url:${JSON.stringify(value.href)}`)
		}
		if (value instanceof RegExp) {
			// A `RegExp` with the flag `g` or `y` keeps the place of its next
			// match in `lastIndex`, which `Equal` does not see.
			return R.succeed(
				`regexp:${JSON.stringify(String(value))}:${String(value.lastIndex)}`,
			)
		}
		if (Option.isOption(value)) {
			return Option.isSome(value)
				? R.map(child(value.value, depth + 1), (text) => `some(${text})`)
				: R.succeed("none")
		}
		if (Array.isArray(value)) {
			return R.map(items(value), (texts) => `[${texts.join(",")}]`)
		}
		if (
			value instanceof Map ||
			value instanceof Set ||
			HashMap.isHashMap(value) ||
			HashSet.isHashSet(value) ||
			Chunk.isChunk(value)
		) {
			return R.map(
				items(Array.from(value as Iterable<unknown>)),
				(texts) => `<${texts.join(",")}>`,
			)
		}
		const names = Object.keys(value)
		const prototype: unknown = Object.getPrototypeOf(value)
		if (
			names.length === 0 &&
			prototype !== Object.prototype &&
			prototype !== null
		) {
			throw new Error("The data of a part of the principal is not in fields")
		}
		return R.map(
			items(Arr.map(names, (name) => (value as Record<string, unknown>)[name])),
			(texts) =>
				`{${Arr.map(names, (name, index) => `${JSON.stringify(name)}:${texts[index]!}`).join(",")}}`,
		)
	})(root)
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
 * Makes the cache key of a principal from its JSON form. The key keeps the
 * principal that the Schema decodes from that form, so the loader sees only
 * the data that the key shows. A principal gets no key when it does not
 * encode, or when the decoded value is not `Equal` to it. Two classes, or a
 * string and a number, may have one JSON form, as in a union, and `Equal`
 * tells them apart. A Schema may make data when it decodes, as the order of
 * the fields of a record, so the key keeps that order too. So two
 * principals with one key are equal, and the cache can not give one the
 * policy of the other.
 */
const jsonKey = (
	schema: Schema.Top,
): ((principal: object) => PrincipalKey | undefined) => {
	const codec = jsonCodecOf(schema)
	// A principal with no JSON form is never kept.
	if (codec === undefined) {
		return () => undefined
	}
	const encode = Schema.encodeUnknownResult(codec)
	const decode = Schema.decodeUnknownResult(codec)
	const keyOf = (principal: object): PrincipalKey | undefined =>
		Result.match(encode(principal), {
			onFailure: () => undefined,
			onSuccess: (json) => {
				// The key is the text, so the check decodes the text. The encoded
				// value may hold more than its text shows, as an object of a
				// `Schema.Any` field does: `JSON.stringify` leaves out a map.
				const text = JSON.stringify(json)
				return Result.match(decode(JSON.parse(text)), {
					onFailure: () => undefined,
					onSuccess: (decoded) =>
						Equal.equals(decoded, principal)
							? new PrincipalKey(decoded as object, text, orderOf(decoded))
							: undefined,
				})
			},
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
	const canonicalOf = jsonKey(domain.principal)
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
			: new PrincipalKey(canonical?.principal ?? principal, text, undefined)
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
				const key = keyOf(principal, canonicalOf(principal))
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
