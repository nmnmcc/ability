import { Context, Effect } from "effect"
import { Ability } from "../src/index.ts"

interface Document {
	readonly id: string
	readonly tenantId: string
	readonly ownerId: string
	readonly state: "draft" | "published"
	readonly classification: "public" | "internal" | "restricted"
	readonly title: string
	readonly body: string
}

interface Session {
	readonly userId: string
	readonly tenantId: string
	readonly trustedNetwork: boolean
}

class CurrentSession extends Context.Service<CurrentSession, Session>()(
	"@nmnmcc/ability/examples/acbc/CurrentSession",
) {}

type Subjects = {
	readonly Document: Document
}

const ability = Effect.gen(function* () {
	const session = yield* CurrentSession

	return Ability.define<Subjects>()(function* (ability) {
		yield* ability.allow("read", "Document", {
			conditions: {
				tenantId: session.tenantId,
				classification: { $in: ["public", "internal"] },
			},
		})

		yield* ability.allow("read", "Document", {
			conditions: {
				tenantId: session.tenantId,
				ownerId: session.userId,
			},
		})

		if (session.trustedNetwork) {
			yield* ability.allow("update", "Document", {
				fields: ["title", "body"],
				conditions: {
					tenantId: session.tenantId,
					ownerId: session.userId,
				},
			})
		}

		yield* ability.deny("delete", "Document", {
			conditions: { state: "published" },
			reason: "No one may delete a published document",
		})
	})
})

const document: Document = {
	id: "doc-1",
	tenantId: "tenant-a",
	ownerId: "user-1",
	state: "published",
	classification: "restricted",
	title: "Plan for the next three months",
	body: "Plans for the new product",
}

const program = Effect.gen(function* () {
	const currentAbility = yield* ability

	const canReadOwnRestricted = yield* Ability.check(currentAbility, {
		action: "read",
		subject: "Document",
		value: document,
	}).pipe(
		Effect.match({
			onFailure: () => false,
			onSuccess: () => true,
		}),
	)

	const canUpdateBody = yield* Ability.check(currentAbility, {
		action: "update",
		subject: "Document",
		value: document,
		field: "body",
	}).pipe(
		Effect.match({
			onFailure: () => false,
			onSuccess: () => true,
		}),
	)

	const deleteResult = yield* Ability.check(currentAbility, {
		action: "delete",
		subject: "Document",
		value: document,
	}).pipe(
		Effect.catchTag("AuthorizationError", (error) =>
			Effect.succeed(error.reason),
		),
		Effect.orElseSucceed(() => "some other error"),
	)

	return {
		canReadOwnRestricted,
		canUpdateBody,
		deleteResult,
	}
}).pipe(
	Effect.provideService(CurrentSession, {
		userId: "user-1",
		tenantId: "tenant-a",
		trustedNetwork: true,
	}),
)

console.log(Effect.runSync(program))
