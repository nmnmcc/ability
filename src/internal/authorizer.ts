/**
 * The values of authorizers: the service class and the layer.
 * The types are in `Authorizer.ts`.
 */
// The service erases the error type and the service type of predicates,
// principals and deciders to `unknown`. The public types keep them, so the
// language service check for `unknown` in an Effect is off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Authorizer from "../Authorizer.ts"
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

const forbidden = (
	target: AnyTarget,
	kind: string,
	reason: string | undefined,
): Authorizer.Forbidden =>
	Authorizer.Forbidden.make({
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
	},
) => {
	const domain: Domain.Any = service.domain
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
					Effect.mapError((cause) =>
						Authorizer.PolicyUnavailable.make({ cause }),
					),
					Effect.map((value) =>
						Policies.provideContext(value, services as never),
					),
				)

			const withServices = <A, E>(
				effect: Effect.Effect<A, E, unknown>,
			): Effect.Effect<A, E, unknown> => Effect.provideContext(effect, services)

			const current = Effect.gen(function* () {
				const principal = yield* service.principal
				const value = yield* load(principal)
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
				if (descriptor === undefined || !Decide.fitsKind(descriptor, target)) {
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

			// A filter is the residual in the scope. It does no coverage search.
			const filter = (
				target: AnyTarget,
			): Effect.Effect<Condition.Ast, unknown, unknown> =>
				Effect.map(current, ({ principal, policy: value }): Condition.Ast =>
					Analysis.residual(value, { ...target, principal } as never),
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
			} as never
		}),
	)
}
