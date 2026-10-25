/**
 * How rules and policies give one answer when more than one applies. The
 * task is to share files.
 *
 * A list of rules has a combining algorithm:
 * - `denyOverrides` (the default): one deny is enough to deny.
 * - `permitOverrides`: one allow is enough to allow.
 * - `firstApplicable` and `lastApplicable`: the first or the last rule that
 *   applies gives the answer, as in a list of firewall rules.
 *
 * Policies go together with combinators:
 * - `Policy.any`: one policy that allows is enough.
 * - `Policy.firstOf`: the first policy that gives an answer wins. Here the
 *   grants that a person gave by hand come before the usual rules.
 * - `Policy.ceiling`: a deny of the cap always wins.
 */
import { Schema } from "effect"
import { Domain, Policy, Resource } from "../src/index.ts"

class User extends Schema.Class<User>("User")({
	id: Schema.String,
	team: Schema.String,
}) {}

class File extends Resource.Class<File>()("File", {
	actions: ["read", "download"],
	fields: {
		id: Schema.String,
		ownerId: Schema.String,
		team: Schema.String,
		visibility: Schema.Literals(["private", "team", "public"]),
		legalHold: Schema.Boolean,
	},
}) {}

const Drive = Domain.make({ principal: User, resources: [File] })

// The same rules with each algorithm. The owner may download, and a file on
// legal hold may not be downloaded.
const rulesWith = (algorithm: Policy.Algorithm) =>
	Policy.define(Drive, { algorithm })(function* (_) {
		yield* _.allow("download", File, {
			when: ($) => $.eq("ownerId", $.principal("id")),
		})
		yield* _.deny("download", File, {
			when: ($) => $.eq("legalHold", true),
			reason: "The file is on legal hold",
		})
	})

// Ordered rules: the first one that applies gives the answer.
const byVisibility = Policy.define(Drive, { algorithm: "firstApplicable" })(
	function* (_) {
		yield* _.allow("read", File, { when: ($) => $.eq("visibility", "public") })
		yield* _.deny("read", File, {
			when: ($) => $.eq("visibility", "private"),
			reason: "The file is private",
		})
		yield* _.allow("read", File, {
			when: ($) => $.eq("team", $.principal("team")),
		})
	},
)

// The owner may always read their own files.
const owners = Policy.define(Drive)(function* (_) {
	yield* _.allow("read", File, {
		when: ($) => $.eq("ownerId", $.principal("id")),
	})
})

// Grants that a person gave by hand, kept apart from the usual rules.
const grants = Policy.define(Drive)(function* (_) {
	yield* _.allow("read", File, {
		when: ($) => $.and($.eq("id", "f9"), $.eq("ownerId", "zoe")),
		reason: "Zoe shared this file with the auditors",
	})
})

// The limits of the company, for every file.
const company = Policy.define(Drive)(function* (_) {
	yield* _.deny(["read", "download"], File, {
		when: ($) => $.eq("legalHold", true),
		reason: "The file is on legal hold",
	})
})

const reading = Policy.firstOf([
	grants,
	Policy.any([owners, byVisibility]),
]).pipe(Policy.ceiling(company))

const kim = User.make({ id: "kim", team: "design" })
const auditor = User.make({ id: "aud", team: "audit" })

const file = (fields: Partial<File>) =>
	File.make({
		id: "f1",
		ownerId: "kim",
		team: "design",
		visibility: "team",
		legalHold: false,
		...fields,
	})

const decide = (
	policy: Policy.Policy<typeof Drive>,
	principal: User,
	action: "read" | "download",
	resource: File,
) => Policy.decideSync(policy, { principal, action, resource })._tag

const held = file({ legalHold: true })

console.log({
	// The owner, and the file on legal hold: two rules apply.
	denyOverrides: decide(rulesWith("denyOverrides"), kim, "download", held),
	permitOverrides: decide(rulesWith("permitOverrides"), kim, "download", held),
	firstApplicable: decide(rulesWith("firstApplicable"), kim, "download", held),
	lastApplicable: decide(rulesWith("lastApplicable"), kim, "download", held),
	// The first rule that applies wins, in order.
	publicFile: decide(
		byVisibility,
		auditor,
		"read",
		file({ visibility: "public" }),
	),
	privateFile: decide(
		byVisibility,
		kim,
		"read",
		file({ visibility: "private" }),
	),
	// The owner may read their private file: `any` needs one allow.
	ownPrivate: decide(reading, kim, "read", file({ visibility: "private" })),
	// A grant comes first, so the auditor may read the private file of Zoe.
	granted: decide(
		reading,
		auditor,
		"read",
		file({ id: "f9", ownerId: "zoe", team: "legal", visibility: "private" }),
	),
	// The cap wins over everything: also the owner may not read it.
	onHold: decide(reading, kim, "read", held),
})
