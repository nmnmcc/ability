/**
 * Checks in an `effect/http-api` server: a small API for notes.
 *
 * - Each endpoint says what it needs with the `Required` annotation. An
 *   endpoint with no annotation is closed.
 * - An endpoint for one note loads the note, and the middleware checks the
 *   action on it.
 * - A list endpoint takes a scope from the path parameters. The middleware
 *   does not check each note: the handler gets its query with `Auth.filter`.
 *   Here `nonEmpty` asks for proof that some value is allowed. Unknown fails.
 * - The errors have HTTP status codes: 403 for `Forbidden`, 503 for
 *   `PolicyUnavailable`, and 409 for `Pending`.
 *
 * The example calls the server with the test client of Effect, so it needs no
 * network.
 */
import {
	Context,
	Effect,
	Exit,
	FileSystem,
	HashMap,
	Layer,
	Option,
	Path,
	Schema,
} from "effect"
import { Etag, HttpPlatform } from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiTest,
} from "effect/http-api"
import * as AbilityHttpApi from "../src/HttpApi.ts"
import {
	Authorizer,
	Condition,
	Domain,
	Policy,
	Resource,
} from "../src/index.ts"

class User extends Schema.Class<User, { readonly brand: unique symbol }>(
	"User",
)({ id: Schema.String }) {}

class Note extends Resource.Class<Note>()("Note", {
	actions: ["read", "update"],
	fields: {
		id: Schema.String,
		authorId: Schema.String,
		text: Schema.String,
		shared: Schema.Boolean,
	},
}) {}

const Notes = Domain.make({ principal: User, resources: [Note] })

/**
 * The caller belongs to the request, so each check reads it.
 * @effect-leakable-service
 */
class Identity extends Context.Service<Identity, User>()(
	"@nmnmcc/ability/examples/http-api/Identity",
) {}

class Auth extends Authorizer.Service<Auth>()(
	"@nmnmcc/ability/examples/http-api/Auth",
	{
		domain: Notes,
		principal: Identity,
	},
) {}

class NoteNotFound extends Schema.TaggedError<
	NoteNotFound,
	{ readonly brand: unique symbol }
>()("NoteNotFound", {
	id: Schema.String,
}) {}

// The notes in a database. Here it is a map.
const database = HashMap.make(
	["n1", Note.make({ id: "n1", authorId: "amy", text: "Hi", shared: false })],
	["n2", Note.make({ id: "n2", authorId: "bo", text: "Plan", shared: true })],
	["n3", Note.make({ id: "n3", authorId: "bo", text: "Diary", shared: false })],
)

const findNote = (id: string | undefined) =>
	Effect.fromOption(HashMap.get(database, id ?? "")).pipe(
		Effect.mapError(() => NoteNotFound.make({ id: id ?? "" })),
	)

// The middleware that checks each request. It needs the principal.
class Authorization extends HttpApiMiddleware.Service<
	Authorization,
	{ requires: Identity }
>()("@nmnmcc/ability/examples/http-api/Authorization", {
	error: [...AbilityHttpApi.errors, NoteNotFound],
}) {}

// The middleware that finds the user of the request.
class Authentication extends HttpApiMiddleware.Service<
	Authentication,
	{ provides: Identity }
>()("@nmnmcc/ability/examples/http-api/Authentication") {}

// A list endpoint says its scope one time. The middleware and the handler
// both use it.
const notesOfAuthor = AbilityHttpApi.lists(Auth, "read", "Note", {
	within: (params) => ($) => $.eq("authorId", params["user"] ?? ""),
	nonEmpty: true,
})

const Api = HttpApi.make("notes").add(
	HttpApiGroup.make("notes")
		.add(
			HttpApiEndpoint.get("read", "/notes/:id", {
				params: { id: Schema.String },
				success: Schema.String,
			}).annotate(AbilityHttpApi.Required, [
				AbilityHttpApi.requires(Auth, "read", "Note", (params) =>
					findNote(params["id"]),
				),
			]),
			HttpApiEndpoint.patch("update", "/notes/:id", {
				params: { id: Schema.String },
				success: Schema.String,
			}).annotate(AbilityHttpApi.Required, [
				AbilityHttpApi.requires(Auth, "update", "Note", (params) =>
					findNote(params["id"]),
				),
			]),
			HttpApiEndpoint.get("byAuthor", "/users/:user/notes", {
				params: { user: Schema.String },
				success: Schema.Array(Schema.String),
			}).annotate(AbilityHttpApi.Required, [notesOfAuthor]),
			// Open to everyone: an empty list says that.
			HttpApiEndpoint.get("health", "/health", {
				success: Schema.String,
			}).annotate(AbilityHttpApi.Required, []),
			// No annotation, so the middleware closes it.
			HttpApiEndpoint.get("forgotten", "/forgotten", {
				success: Schema.String,
			}),
		)
		.middleware(Authorization)
		.middleware(Authentication),
)

const NotesLive = HttpApiBuilder.group(Api, "notes", (handlers) =>
	Effect.gen(function* () {
		// The authorizer, taken one time when the server starts.
		const auth = yield* Auth
		return handlers
			.handle("read", ({ params }) =>
				Effect.map(findNote(params.id), (note) => note.text),
			)
			.handle("update", ({ params }) => Effect.succeed(`updated ${params.id}`))
			.handle("byAuthor", () =>
				Effect.gen(function* () {
					// The filter of the principal in the scope of the requirement,
					// as a condition. A real handler changes it into a query.
					const where = yield* notesOfAuthor.filter(auth)
					const notes = Array.from(HashMap.values(database))
					const visible = yield* Effect.filter(notes, (note) =>
						Condition.evaluate(where, { value: note }),
					)
					return visible.map((note) => note.id)
				}),
			)
			.handle("health", () => Effect.succeed("ok"))
			.handle("forgotten", () => Effect.succeed("open"))
	}),
)

const AuthLive = Authorizer.layer(Auth, {
	policy: () =>
		Effect.succeed(
			Policy.define(Notes)(function* (_) {
				yield* _.allow(["read", "update"], Note, {
					when: ($) => $.eq("authorId", $.principal("id")),
				})
				yield* _.allow("read", Note, { when: ($) => $.eq("shared", true) })
			}),
		),
})

const PlatformLive = Layer.mergeAll(
	FileSystem.layerNoop({}),
	Path.layer,
	Etag.layer,
	HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
)

/** A server where every request comes from `user`. */
const serverFor = (user: User) =>
	NotesLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				Layer.succeed(Authentication, (httpEffect) =>
					Effect.provideService(httpEffect, Identity, user),
				),
				AbilityHttpApi.layer(Authorization, Auth),
			).pipe(Layer.provideMerge(AuthLive)),
		),
		Layer.provideMerge(PlatformLive),
	)

/**
 * Gives the answer of a call, the tag of its error, or "closed" when the
 * server stops the call with a defect, as for an endpoint with no annotation.
 */
const answer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.map(Effect.exit(effect), (exit): unknown =>
		Exit.isSuccess(exit)
			? exit.value
			: Option.match(Exit.findErrorOption(exit), {
					onNone: () => "closed",
					onSome: (error) =>
						typeof error === "object" && error !== null && "_tag" in error
							? String(error._tag)
							: "error",
				}),
	)

const callsOf = (user: User) =>
	Effect.gen(function* () {
		const client = yield* HttpApiTest.groups(Api, ["notes"])
		return {
			readOwn: yield* answer(client.notes.read({ params: { id: "n1" } })),
			readShared: yield* answer(client.notes.read({ params: { id: "n2" } })),
			readPrivate: yield* answer(client.notes.read({ params: { id: "n3" } })),
			updateShared: yield* answer(
				client.notes.update({ params: { id: "n2" } }),
			),
			notesOfBo: yield* answer(
				client.notes.byAuthor({ params: { user: "bo" } }),
			),
			health: yield* answer(client.notes.health()),
			forgotten: yield* answer(client.notes.forgotten()),
		}
	}).pipe(
		Effect.scoped,
		// This is the entry point of the program, so it gives the layer here.
		// @effect-diagnostics-next-line strictEffectProvide:off
		Effect.provide(serverFor(user)),
	)

const program = Effect.gen(function* () {
	return {
		amy: yield* callsOf(User.make({ id: "amy" })),
		bo: yield* callsOf(User.make({ id: "bo" })),
	}
})

console.log(await Effect.runPromise(program))
