/**
 * Rules for some fields of a value only: the staff list of a company.
 *
 * - Everyone may read the name and the email of every person.
 * - A person may read all of their own record.
 * - A manager may read the pay of the people who report to them.
 * - Only the people team may change pay. A deny rule for some fields does not
 *   stop a change to the other fields.
 *
 * `fields` takes patterns: `*` stands for any part of one field name, and `**`
 * for any number of parts. `Policy.permittedFields` gives the fields that a
 * request may use, for example to make a form or to cut a JSON answer.
 */
import { Effect, Schema } from "effect"
import { Domain, Policy, Resource } from "../src/index.ts"

class Staff extends Schema.Class<Staff>("Staff")({
	id: Schema.String,
	team: Schema.Literals(["engineering", "people"]),
}) {}

class Person extends Resource.Class<Person>()("Person", {
	actions: ["read", "update"],
	fields: {
		id: Schema.String,
		managerId: Schema.NullOr(Schema.String),
		name: Schema.String,
		email: Schema.String,
		pay: Schema.Struct({ base: Schema.Finite, bonus: Schema.Finite }),
		notes: Schema.String,
	},
}) {}

const Company = Domain.make({ principal: Staff, resources: [Person] })

const policyFor = (staff: Staff) =>
	Policy.define(Company)(function* (_) {
		yield* _.allow("read", Person, { fields: ["name", "email"] })
		yield* _.allow("read", Person, {
			when: ($) => $.eq("id", $.principal("id")),
		})
		yield* _.allow("read", Person, {
			fields: ["pay.*"],
			when: ($) => $.eq("managerId", $.principal("id")),
		})
		yield* _.allow("update", Person, {
			fields: ["name", "email", "notes"],
			when: ($) => $.eq("id", $.principal("id")),
		})
		if (staff.team === "people") {
			yield* _.allow(["read", "update"], Person)
		} else {
			yield* _.deny("update", Person, {
				fields: ["pay.**"],
				reason: "Only the people team may change pay",
			})
		}
	})

const ada = Staff.make({ id: "ada", team: "engineering" })
const lin = Staff.make({ id: "lin", team: "engineering" })
const pia = Staff.make({ id: "pia", team: "people" })

// Lin reports to Ada.
const linRecord = Person.make({
	id: "lin",
	managerId: "ada",
	name: "Lin",
	email: "lin@example.com",
	pay: { base: 5000, bonus: 500 },
	notes: "Likes tea",
})

const program = Effect.gen(function* () {
	const fieldsOf = (staff: Staff, action: "read" | "update") =>
		Policy.permittedFields(policyFor(staff), {
			principal: staff,
			action,
			resource: linRecord,
		})
	const decide = (
		staff: Staff,
		action: "read" | "update",
		field?: "name" | "pay.base" | "notes",
	) =>
		Policy.decideSync(policyFor(staff), {
			principal: staff,
			action,
			resource: linRecord,
			...(field === undefined ? {} : { field }),
		})._tag

	return {
		// Each person sees another part of the same record.
		linReads: yield* fieldsOf(lin, "read"),
		adaReads: yield* fieldsOf(ada, "read"),
		piaReads: yield* fieldsOf(pia, "read"),
		// Lin may change their own name, but not their pay.
		linChanges: yield* fieldsOf(lin, "update"),
		linChangesName: decide(lin, "update", "name"),
		linChangesPay: decide(lin, "update", "pay.base"),
		// "May Lin change some fields of the record?" is a yes.
		linChangesSomething: decide(lin, "update"),
		// Ada may read the pay of Lin, but not the notes.
		adaReadsPay: decide(ada, "read", "pay.base"),
		adaReadsNotes: decide(ada, "read", "notes"),
		piaChangesPay: decide(pia, "update", "pay.base"),
	}
})

console.log(Effect.runSync(program))
