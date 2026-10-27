/**
 * A predicate: a test that runs code, here to ask another service. The task
 * is to book meeting rooms.
 *
 * - A rule may book a room only when the calendar says that it is free. The
 *   calendar is an Effect service, and it may fail.
 * - The service type and the error type of the predicate go into the types of
 *   the policy and of every check. A check that does not give the service is
 *   a type error.
 * - `Policy.provideContext` gives the service to the policy one time, so the
 *   checks need no service.
 * - A policy with a predicate can not become JSON or SQL. Its residual is one
 *   predicate that runs the whole policy for each value.
 */
import { Context, Effect, Schema } from "effect"
import { Domain, Policy, Resource } from "../src/index.ts"

class Employee extends Schema.Class<
	Employee,
	{ readonly brand: unique symbol }
>("Employee")({
	id: Schema.String,
	floor: Schema.Finite,
}) {}

class Room extends Resource.Class<Room>()("Room", {
	actions: ["view", "book"],
	fields: {
		id: Schema.String,
		floor: Schema.Finite,
		seats: Schema.Finite,
	},
}) {
	canSeatGroup() {
		return this.seats > 0
	}
}

const Office = Domain.make({ principal: Employee, resources: [Room] })

class CalendarDown extends Schema.TaggedError<
	CalendarDown,
	{ readonly brand: unique symbol }
>()("CalendarDown", {}) {}

class Calendar extends Context.Service<
	Calendar,
	{ readonly isFree: (roomId: string) => Effect.Effect<boolean, CalendarDown> }
>()("@nmnmcc/ability/examples/predicates/Calendar") {}

const policy = Policy.define(Office)(function* (_) {
	yield* _.allow("view", Room)
	yield* _.allow("book", Room, {
		when: ($) =>
			$.and(
				// Plain data: a room on the floor of the employee.
				$.eq("floor", $.principal("floor")),
				// Code: the calendar says that the room is free.
				$.predicate("room is free", (room) =>
					Effect.gen(function* () {
						const calendar = yield* Calendar
						// A predicate gets the full class value, with its methods.
						return room.canSeatGroup() && (yield* calendar.isFree(room.id))
					}),
				),
			),
	})
	yield* _.deny("book", Room, {
		when: ($) => $.gt("seats", 20),
		reason: "A large room needs a booking from the office team",
	})
})

// A calendar where only room r2 is taken.
const calendar = Context.make(Calendar, {
	isFree: (roomId) => Effect.succeed(roomId !== "r2"),
})

const ida = Employee.make({ id: "ida", floor: 3 })
const small = Room.make({ id: "r1", floor: 3, seats: 4 })
const taken = Room.make({ id: "r2", floor: 3, seats: 6 })
const large = Room.make({ id: "r3", floor: 3, seats: 40 })
const otherFloor = Room.make({ id: "r4", floor: 5, seats: 4 })

const program = Effect.gen(function* () {
	// The policy needs the calendar until it is given.
	const ready = Policy.provideContext(policy, calendar)
	const book = (room: Room) =>
		Effect.map(
			Policy.decide(ready, { principal: ida, action: "book", resource: room }),
			(decision) => decision._tag,
		)
	// The residual runs the whole policy for each value. It needs no
	// calendar, because the policy has it.
	const bookable = Policy.residual(ready, {
		principal: ida,
		action: "book",
		kind: "Room",
	})
	return {
		small: yield* book(small),
		taken: yield* book(taken),
		large: yield* book(large),
		otherFloor: yield* book(otherFloor),
		residualTag: bookable._tag,
		// A calendar that fails makes the check fail, not say yes.
		calendarDown: yield* Policy.decide(policy, {
			principal: ida,
			action: "book",
			resource: small,
		}).pipe(
			Effect.provideService(Calendar, {
				isFree: () => Effect.fail(CalendarDown.make({})),
			}),
			Effect.map((decision) => decision._tag),
			Effect.catchTag("CalendarDown", () => Effect.succeed("CalendarDown")),
		),
	}
})

console.log(Effect.runSync(program))
