/**
 * Roles, API tokens and a platform limit in a program for many teams: a task
 * tracker where each workspace has projects, and each project has tasks.
 *
 * - The policy of a member comes from its role: a viewer, a member, an admin
 *   or an owner. The loader makes it from the data of the member.
 * - An API token may never do more than its member, so the two policies go
 *   together with `Policy.all`.
 * - The platform has deny rules for everyone. `Policy.ceiling` puts them on
 *   top. Their allow rules would do nothing.
 *
 * A resource path takes the place of a resource key such as
 * `workspace.<id>.project.<id>.task.<id>`. `$.under(...)` is the same as a
 * rule for a key and every key below it.
 *
 * A scope (`within`) is a part of a kind, such as the tasks of one project. It
 * answers three questions:
 * - May the member act on every value in the scope? This is the check for a
 *   new task, which has no id yet.
 * - Which values in the scope may the member act on? This is the list query.
 * - May the member act on some value in the scope? This is the test to show a
 *   button.
 */
import { Effect, Schema } from "effect"
import { Condition, Domain, Policy, Resource } from "../src/index.ts"

class Member extends Schema.Class<Member>("Member")({
	userId: Schema.String,
	workspaceId: Schema.String,
	role: Schema.Literals(["viewer", "member", "admin", "owner"]),
}) {}

class Task extends Resource.Class<Task>()("Task", {
	actions: ["read", "create", "update", "delete"],
	fields: {
		id: Schema.String,
		workspaceId: Schema.String,
		projectId: Schema.String,
		assigneeId: Schema.NullOr(Schema.String),
		status: Schema.Literals(["open", "done"]),
	},
	path: (f) => [
		"workspace",
		f.workspaceId,
		"project",
		f.projectId,
		"task",
		f.id,
	],
}) {}

const Tracker = Domain.make({ principal: Member, resources: [Task] })

/** The rules of a role. A loader runs this one time for each member. */
const forRole = (member: Member) =>
	Policy.define(Tracker)(function* (_) {
		// Every role may read the tasks of its workspace.
		yield* _.allow("read", Task, {
			when: ($) => $.under("workspace", $.principal("workspaceId")),
		})
		if (member.role === "member") {
			yield* _.allow(["create", "update"], Task, {
				when: ($) =>
					$.and(
						$.under("workspace", $.principal("workspaceId")),
						$.or(
							$.eq("assigneeId", $.principal("userId")),
							$.eq("assigneeId", null),
						),
					),
			})
		}
		if (member.role === "admin" || member.role === "owner") {
			yield* _.allow(["create", "update"], Task, {
				when: ($) => $.under("workspace", $.principal("workspaceId")),
			})
		}
		if (member.role === "owner") {
			yield* _.allow("delete", Task, {
				when: ($) => $.under("workspace", $.principal("workspaceId")),
			})
		}
		// No one may delete a task that is done: it is a record of the work.
		yield* _.deny("delete", Task, {
			when: ($) => $.eq("status", "done"),
			reason: "A task that is done is a record of the work",
		})
	})

/** An API token that may only read. */
const readOnlyToken = Policy.define(Tracker)(function* (_) {
	yield* _.allow("read", "*")
})

/** The limits of the platform, for every member and every token. */
const platform = Policy.define(Tracker)(function* (_) {
	yield* _.deny(["create", "update", "delete"], "*", {
		when: ($) => $.under("workspace", "suspended"),
		reason: "The platform stopped all changes to this workspace",
	})
})

const forSession = (member: Member) =>
	forRole(member).pipe(Policy.ceiling(platform))
const forToken = (member: Member) =>
	Policy.all([forRole(member), readOnlyToken]).pipe(Policy.ceiling(platform))

// The residual condition is the list query. Change it into SQL with fold. The
// values go into the query as bound parameters, not into the SQL text. A value
// from a principal may have a quote in it, and in the SQL text it could change
// the query.
//
// In this library a test is true or false. In SQL a test with NULL is
// unknown, and NOT unknown is unknown too. So each test is made true or false
// with COALESCE, and `ne` and `in` say what to do with NULL.
interface Query {
	readonly sql: string
	readonly params: ReadonlyArray<Condition.Scalar>
}

const operators = {
	eq: "=",
	ne: "<>",
	lt: "<",
	lte: "<=",
	gt: ">",
	gte: ">=",
} as const

const join = (parts: ReadonlyArray<Query>, glue: string): Query => ({
	sql: `(${parts.map((part) => part.sql).join(glue)})`,
	params: parts.flatMap((part) => part.params),
})

const toSql = Condition.fold<Query>({
	true: () => ({ sql: "TRUE", params: [] }),
	false: () => ({ sql: "FALSE", params: [] }),
	compare: (op, field, value) =>
		value === null
			? // Only `eq` and `ne` are true for a null value.
				op === "eq" || op === "ne"
				? { sql: `${field} IS ${op === "eq" ? "" : "NOT "}NULL`, params: [] }
				: { sql: "FALSE", params: [] }
			: op === "ne"
				? { sql: `(${field} IS NULL OR ${field} <> ?)`, params: [value] }
				: {
						sql: `COALESCE(${field} ${operators[op]} ?, FALSE)`,
						params: [value],
					},
	in: (field, values) => {
		const known = values.filter((value) => value !== null)
		const parts: ReadonlyArray<Query> = [
			...(known.length > 0
				? [
						{
							sql: `COALESCE(${field} IN (${known.map(() => "?").join(", ")}), FALSE)`,
							params: known,
						},
					]
				: []),
			...(known.length < values.length
				? [{ sql: `${field} IS NULL`, params: [] }]
				: []),
		]
		return parts.length === 0
			? { sql: "FALSE", params: [] }
			: join(parts, " OR ")
	},
	exists: (field) => ({ sql: `${field} IS NOT NULL`, params: [] }),
	and: (parts) => join(parts, " AND "),
	or: (parts) => join(parts, " OR "),
	not: (part) => ({ sql: `NOT ${part.sql}`, params: part.params }),
})

const mia = Member.make({
	userId: "mia",
	workspaceId: "acme",
	role: "member",
})
const owner = Member.make({
	userId: "olu",
	workspaceId: "acme",
	role: "owner",
})

const assigned = Task.make({
	id: "t1",
	workspaceId: "acme",
	projectId: "web",
	assigneeId: "mia",
	status: "open",
})
const someoneElses = Task.make({
	id: "t2",
	workspaceId: "acme",
	projectId: "web",
	assigneeId: "raj",
	status: "open",
})
const done = Task.make({
	id: "t3",
	workspaceId: "acme",
	projectId: "web",
	assigneeId: "raj",
	status: "done",
})

const program = Effect.gen(function* () {
	const decide = (
		policy: Policy.Policy<typeof Tracker>,
		member: Member,
		action: "read" | "update" | "delete",
		resource: Task,
	) => Policy.decideSync(policy, { principal: member, action, resource })._tag

	return {
		// A member may change the tasks that are given to it.
		memberUpdatesOwn: decide(forSession(mia), mia, "update", assigned),
		memberUpdatesOther: decide(forSession(mia), mia, "update", someoneElses),
		// A token of the member may read, but not change.
		tokenReads: decide(forToken(mia), mia, "read", assigned),
		tokenUpdates: decide(forToken(mia), mia, "update", assigned),
		// An owner may delete, but not a task that is done.
		ownerDeletes: decide(forSession(owner), owner, "delete", someoneElses),
		ownerDeletesDone: decide(forSession(owner), owner, "delete", done),
		// The list of the tasks that the member may change, as SQL.
		changeableTasks: yield* toSql(
			Policy.residual(forSession(mia), {
				principal: mia,
				action: "update",
				kind: "Task",
			}),
		),
		// The list of one project: the scope and the policy together.
		readableInWeb: yield* toSql(
			Policy.residual(forSession(mia), {
				principal: mia,
				action: "read",
				kind: "Task",
				within: ($) => $.under("workspace", "acme", "project", "web"),
			}),
		),
		// May the member make a new task for itself in the project? "All".
		createOwn: Policy.coverage(forSession(mia), {
			principal: mia,
			action: "create",
			kind: "Task",
			within: ($) =>
				$.and(
					$.under("workspace", "acme", "project", "web"),
					$.eq("assigneeId", "mia"),
				),
		})._tag,
		// May the owner delete some tasks? "Some", so the page shows a delete
		// button.
		deleteButton: Policy.coverage(forSession(owner), {
			principal: owner,
			action: "delete",
			kind: "Task",
			within: ($) => $.under("workspace", "acme"),
		})._tag,
		// The platform stopped changes to a suspended workspace.
		suspended: decide(
			forSession(Member.make({ ...owner, workspaceId: "suspended" })),
			Member.make({ ...owner, workspaceId: "suspended" }),
			"update",
			Task.make({ ...assigned, workspaceId: "suspended" }),
		),
	}
})

console.log(Effect.runSync(program))
