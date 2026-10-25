/**
 * Policies kept as JSON, as in a database: a help desk with tickets.
 *
 * - `Policy.schema` changes a policy into JSON and back. Decoding checks each
 *   kind, action, field and principal field against the domain, so a policy
 *   from the database can not name a field that does not exist.
 * - `meta` keeps extra data with each rule, such as who made a grant. Its
 *   Schema is part of the domain.
 * - `Policy.explain` gives the decision and the rules that were tested, for an
 *   audit log.
 */
import { Effect, Exit, Schema } from "effect"
import { Domain, Policy, Principal, Resource } from "../src/index.ts"

class Agent extends Principal.Class<Agent>("Agent")({
	id: Schema.String,
	queue: Schema.String,
}) {}

const Ticket = Resource.make("Ticket", {
	actions: ["read", "reply", "close"],
	fields: {
		id: Schema.String,
		queue: Schema.String,
		assigneeId: Schema.NullOr(Schema.String),
		priority: Schema.Literals(["low", "high"]),
	},
})

const GrantMeta = Schema.Struct({
	grantedBy: Schema.String,
	ticket: Schema.optionalKey(Schema.String),
})

const HelpDesk = Domain.make({
	principal: Agent,
	resources: [Ticket],
	meta: GrantMeta,
})

const PolicySchema = Policy.schema(HelpDesk)

// A policy made in code, as an admin page would make it.
const policy = Policy.define(HelpDesk)(function* (_) {
	yield* _.allow(["read", "reply"], Ticket, {
		when: ($) => $.eq("queue", $.principal("queue")),
		id: "queue-access",
		meta: { grantedBy: "admin" },
	})
	yield* _.allow("close", Ticket, {
		when: ($) => $.eq("assigneeId", $.principal("id")),
		id: "close-own",
		meta: { grantedBy: "admin" },
	})
	yield* _.deny("close", Ticket, {
		when: ($) => $.eq("priority", "high"),
		id: "no-close-high",
		reason: "A lead must close a ticket with a high priority",
		meta: { grantedBy: "security", ticket: "SEC-12" },
	})
})

// Keep it as JSON text, and load it again.
const saved = JSON.stringify(Schema.encodeSync(PolicySchema)(policy))
const loaded = Schema.decodeUnknownSync(PolicySchema)(JSON.parse(saved))

// A row in the database with a mistake: the field is "assignee", not
// "assigneeId". The policy does not load, so it can never give a wrong
// answer.
const broken = {
	_tag: "Rules",
	algorithm: "denyOverrides",
	rules: [
		{
			_tag: "Allow",
			actions: ["close"],
			resources: ["Ticket"],
			when: {
				_tag: "Compare",
				op: "eq",
				field: "assignee",
				value: { _tag: "Principal", path: "id" },
			},
		},
	],
}

const sam = Agent.make({ id: "sam", queue: "billing" })
const ticket = Ticket.make({
	id: "k1",
	queue: "billing",
	assigneeId: "sam",
	priority: "high",
})

const program = Effect.gen(function* () {
	const explained = yield* Policy.explain(loaded, {
		principal: sam,
		action: "close",
		resource: ticket,
	})
	const brokenExit = Schema.decodeUnknownExit(PolicySchema)(broken)
	return {
		savedLength: saved.length,
		sameAfterLoad: Policy.decideSync(loaded, {
			principal: sam,
			action: "reply",
			resource: ticket,
		})._tag,
		// One line of the audit log for each rule that was tested.
		decision: explained.decision._tag,
		audit: explained.steps.map((step) => ({
			rule: step.rule.id,
			applies: step.applies,
			grantedBy: (step.rule.meta as typeof GrantMeta.Type | undefined)
				?.grantedBy,
		})),
		brokenLoads: Exit.isSuccess(brokenExit),
		brokenError: Exit.isFailure(brokenExit)
			? String(brokenExit.cause).includes("assignee")
			: false,
	}
})

console.log(Effect.runSync(program))
