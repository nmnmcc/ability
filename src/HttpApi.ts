/**
 * Tools to check authorization in an `effect/http-api` server.
 *
 * Each endpoint says what it needs with the {@link Required} annotation. A
 * group can give a default with {@link GroupRequired}: one list for GET
 * requests and one list for all other methods. A middleware checks the
 * requirements before the handler runs, in each group that uses it. An
 * endpoint with no annotation is a defect, so a new endpoint is closed until
 * you say what it needs. An empty list means the endpoint is open. An endpoint
 * in a group without the middleware is not checked at all.
 *
 * ```ts
 * class Authorization extends HttpApiMiddleware.Service<
 *   Authorization,
 *   { requires: Identity }
 * >()("app/Authorization", { error: HttpApi.errors }) {}
 *
 * const endpoint = HttpApiEndpoint.patch("update", "/bots/:id", { ... })
 *   .annotate(HttpApi.Required, [
 *     HttpApi.requires(Auth, "update", "Bot", (params) => Bots.find(params.id)),
 *   ])
 *
 * const bots = HttpApiGroup.make("bots").add(endpoint).middleware(Authorization)
 *
 * const AuthorizationLive = HttpApi.layer(Authorization, Auth)
 * ```
 *
 * This module is a separate entry point, `@nmnmcc/ability/HttpApi`, because
 * `effect/http-api` is not stable yet.
 *
 * @stability unstable
 * @since 0.3.0
 */
// A `load` function of a requirement is kept in an annotation, so its error
// type and its service type are erased to `unknown`. The language service
// check for `unknown` in an Effect is off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { HttpRouter } from "effect/http"
import { HttpApiSchema } from "effect/http-api"
import * as Authorizer from "./Authorizer.ts"
import type * as Domain from "./Domain.ts"
import * as Resource from "./Resource.ts"

/**
 * One check that an endpoint needs: an action on a kind of resource. With
 * `load`, the middleware loads the resource value from the path parameters
 * and checks the action on that value. Without `load`, it checks the action
 * on the kind.
 *
 * @stability unstable
 * @category models
 * @since 0.3.0
 */
export interface Requirement {
	readonly action: string
	readonly kind: string
	readonly load?: (
		params: Readonly<Record<string, string | undefined>>,
	) => Effect.Effect<object, unknown, unknown>
}

/**
 * The checks that an endpoint needs.
 *
 * @stability unstable
 * @category annotations
 * @since 0.3.0
 */
export class Required extends Context.Service<
	Required,
	ReadonlyArray<Requirement>
>()("@nmnmcc/ability/HttpApi/Required") {}

/**
 * The checks for every endpoint of a group with no {@link Required}
 * annotation. `read` is for GET requests. `write` is for all other methods.
 *
 * @stability unstable
 * @category annotations
 * @since 0.3.0
 */
export class GroupRequired extends Context.Service<
	GroupRequired,
	{
		readonly read: ReadonlyArray<Requirement>
		readonly write: ReadonlyArray<Requirement>
	}
>()("@nmnmcc/ability/HttpApi/GroupRequired") {}

/**
 * Makes a {@link Requirement} with the types of an authorizer. The action must
 * be an action of the kind, and `load` must give a value of the kind.
 *
 * `load` may fail. Its errors must be errors of the middleware, and the
 * services that it needs must be given to {@link layer}.
 *
 * @stability unstable
 * @category constructors
 * @since 0.3.0
 */
export const requires: <
	A extends { readonly domain: Domain.Any },
	const K extends Domain.Kind<A["domain"]>,
>(
	authorizer: A,
	action: Domain.ActionOf<A["domain"], K>,
	kind: K,
	load?: (
		params: Readonly<Record<string, string | undefined>>,
	) => Effect.Effect<Domain.ValueOf<A["domain"], K>, unknown, unknown>,
) => Requirement = (_authorizer, action, kind, load) =>
	load === undefined ? { action, kind } : { action, kind, load }

/**
 * The Schema of a `PolicyUnavailable` response. It encodes only the `_tag`, so
 * the cause does not go to the client.
 */
const PolicyUnavailableResponse = Schema.TaggedStruct(
	"PolicyUnavailable",
	{},
).pipe(
	Schema.decodeTo(
		Schema.declare(
			(u): u is Authorizer.PolicyUnavailable =>
				u instanceof Authorizer.PolicyUnavailable,
		),
		SchemaTransformation.transform({
			decode: () => Authorizer.PolicyUnavailable.make({ cause: undefined }),
			encode: () => ({ _tag: "PolicyUnavailable" as const }),
		}),
	),
)

/**
 * The errors of the middleware, with HTTP status codes: 403 for
 * `Forbidden`, 503 for `PolicyUnavailable`, and 409 for `Pending`.
 *
 * The body of a `PolicyUnavailable` response has only its `_tag`. The cause
 * may have private details, such as an error from the database, so it stays
 * on the server.
 *
 * @stability unstable
 * @category errors
 * @since 0.3.0
 */
export const errors = [
	Authorizer.Forbidden.pipe(HttpApiSchema.status(403)),
	PolicyUnavailableResponse.pipe(HttpApiSchema.status(503)),
	Authorizer.Pending.pipe(HttpApiSchema.status(409)),
] as const

const makeLayer = (
	middleware: Context.ServiceClass<any, string, any>,
	authorizer: Authorizer.AnyServiceClass,
) =>
	Layer.effect(
		middleware,
		Effect.gen(function* () {
			const service = yield* authorizer
			const services = yield* Effect.context<never>()
			return Effect.fnUntraced(function* (
				httpEffect: Effect.Effect<unknown, unknown, unknown>,
				options: {
					readonly endpoint: {
						readonly name: string
						readonly method: string
						readonly annotations: Context.Context<never>
					}
					readonly group: {
						readonly identifier: string
						readonly annotations: Context.Context<never>
					}
				},
			) {
				const requirements = Option.orElse(
					Context.getOption(options.endpoint.annotations, Required),
					() =>
						Option.map(
							Context.getOption(options.group.annotations, GroupRequired),
							(rules) =>
								options.endpoint.method === "GET" ? rules.read : rules.write,
						),
				)
				if (Option.isNone(requirements)) {
					return yield* Effect.die(
						new Error(
							`The endpoint ${options.group.identifier}.${options.endpoint.name} does not say what it needs. Give it the HttpApi.Required annotation.`,
						),
					)
				}
				for (const requirement of requirements.value) {
					if (requirement.load === undefined) {
						yield* service.check({
							action: requirement.action,
							kind: requirement.kind,
						} as never)
					} else {
						const params = yield* HttpRouter.params
						const value = yield* Effect.provideContext(
							requirement.load(params),
							services,
						)
						// The check is for the kind of the requirement. A value of
						// another kind is a mistake in `load`, and the check must not
						// pass with the rules of that other kind.
						if (Resource.kindOf(value) !== requirement.kind) {
							return yield* Effect.die(
								new Error(
									`The load function of ${options.group.identifier}.${options.endpoint.name} gave a value that is not a ${requirement.kind}`,
								),
							)
						}
						yield* service.check({
							action: requirement.action,
							resource: value,
						} as never)
					}
				}
				return yield* httpEffect
			})
		}),
	)

/**
 * Makes the layer of an authorization middleware. The middleware reads the
 * {@link Required} and {@link GroupRequired} annotations and checks each
 * requirement with the authorizer.
 *
 * The layer takes the authorizer when it is built. The middleware must
 * require the services of the authorizer, such as the identity of the
 * caller. `R` is the type of the services that the `load` functions need. The
 * layer takes them when it is built too.
 *
 * @stability unstable
 * @category layers
 * @since 0.3.0
 */
export const layer: <
	Self,
	Id extends string,
	A extends Authorizer.AnyServiceClass,
	R = never,
>(
	middleware: Context.ServiceClass<Self, Id, any>,
	authorizer: A,
) => Layer.Layer<
	Self,
	never,
	(A extends Context.Key<infer I, any> ? I : never) | R
> = makeLayer as never
