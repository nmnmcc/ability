/**
 * An authorizer service in an Effect program: a place where a team keeps its
 * documents.
 *
 * - The principal comes from the `Identity` service of the request.
 * - The policy of each principal is loaded one time and kept in a cache.
 * - `guard` says "not found" when the principal may not see the document, so
 *   a client does not learn that it is there.
 * - `filter` gives the condition for the list query of the documents.
 * - The decider answers when no rule does. Here a request to share a document
 *   outside the team waits for a person to say yes.
 */
import { Context, Effect, Schema } from "effect"
import {
	Authorizer,
	Decision,
	Domain,
	Policy,
	Principal,
	Resource,
} from "../src/index.ts"

class Member extends Principal.Class<Member>("Member")({
	id: Schema.String,
	team: Schema.String,
}) {}

class Document extends Resource.Class<Document>()("Document", {
	actions: ["read", "update", "share"],
	fields: {
		id: Schema.String,
		ownerId: Schema.String,
		team: Schema.String,
		archived: Schema.Boolean,
	},
}) {}

const Workspace = Domain.make({ principal: Member, resources: [Document] })

class Identity extends Context.Service<Identity, Member>()(
	"@nmnmcc/ability/examples/authorizer/Identity",
) {}

class Auth extends Authorizer.Service<Auth>()(
	"@nmnmcc/ability/examples/authorizer/Auth",
	{
		domain: Workspace,
		principal: Identity,
	},
) {}

class DocumentNotFound extends Schema.TaggedError<DocumentNotFound>()(
	"DocumentNotFound",
	{ id: Schema.String },
) {}

const AuthLive = Authorizer.layer(Auth, {
	// In a real program this loads the rules of the member from a database.
	policy: () =>
		Effect.succeed(
			Policy.define(Workspace)(function* (_) {
				yield* _.allow("read", Document, {
					when: ($) => $.eq("team", $.principal("team")),
				})
				yield* _.allow("update", Document, {
					when: ($) => $.eq("ownerId", $.principal("id")),
				})
				yield* _.deny("update", Document, {
					when: ($) => $.eq("archived", true),
					reason: "An archived document can not change",
				})
			}),
		),
	cache: { capacity: 1000, timeToLive: "30 seconds" },
	decider: (request) =>
		request.action === "share"
			? Effect.fail(Authorizer.Pending.make({ ticket: "share-request-1" }))
			: Effect.succeed(Decision.NotApplicable),
})

/** Gives "yes", or the tag of the error. */
const answer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.as("yes"),
		Effect.catch((error) =>
			Effect.succeed(
				typeof error === "object" && error !== null && "_tag" in error
					? String(error._tag)
					: "error",
			),
		),
	)

const own = Document.make({
	id: "d1",
	ownerId: "ana",
	team: "design",
	archived: false,
})
const teammate = Document.make({
	id: "d2",
	ownerId: "ben",
	team: "design",
	archived: false,
})
const old = Document.make({
	id: "d3",
	ownerId: "ana",
	team: "design",
	archived: true,
})
const otherTeam = Document.make({
	id: "d4",
	ownerId: "cy",
	team: "sales",
	archived: false,
})

const notFound = (document: Document) => () =>
	DocumentNotFound.make({ id: document.id })

const program = Effect.gen(function* () {
	return {
		updateOwn: yield* answer(Auth.check({ action: "update", resource: own })),
		// Ana may see it, so the answer is "Forbidden".
		updateTeammate: yield* answer(
			Auth.guard(
				{ action: "update", resource: teammate },
				{ hide: notFound(teammate) },
			),
		),
		updateArchived: yield* answer(
			Auth.check({ action: "update", resource: old }),
		),
		// Ana may not see it, so the answer is "not found".
		updateOtherTeam: yield* answer(
			Auth.guard(
				{ action: "update", resource: otherTeam },
				{ hide: notFound(otherTeam) },
			),
		),
		share: yield* answer(Auth.check({ action: "share", resource: own })),
		readFilter: yield* Auth.filter({ action: "read", kind: "Document" }),
		updateCoverage: (yield* Auth.coverage({
			action: "update",
			kind: "Document",
		}))._tag,
	}
}).pipe(
	Effect.provideService(Identity, Member.make({ id: "ana", team: "design" })),
	// This is the entry point of the program, so it gives the layer here.
	// @effect-diagnostics-next-line strictEffectProvide:off
	Effect.provide(AuthLive),
)

console.log(Effect.runSync(program))
