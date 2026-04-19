import { describe, expect, it } from "bun:test"
import {
	buildCmuxSessionStatusTransitionForEvent,
	buildCmuxSessionStatusTransitionForQuestionTool,
	getCmuxSessionStatusText,
} from "../files/plugins/notify/status"

describe("notify cmux session status state mapping", () => {
	it("maps question tool hook to needs-input", () => {
		expect(buildCmuxSessionStatusTransitionForQuestionTool(" session-a ")).toEqual({
			sessionID: "session-a",
			logicalState: "needs-input",
		})
	})

	it("maps question and permission events to needs-input", () => {
		expect(
			buildCmuxSessionStatusTransitionForEvent("question.asked", {
				sessionID: "session-a",
			}),
		).toEqual({
			sessionID: "session-a",
			logicalState: "needs-input",
		})

		expect(
			buildCmuxSessionStatusTransitionForEvent("permission.asked", {
				sessionID: "session-a",
			}),
		).toEqual({
			sessionID: "session-a",
			logicalState: "needs-input",
		})

		expect(
			buildCmuxSessionStatusTransitionForEvent("permission.updated", {
				sessionID: "session-a",
			}),
		).toEqual({
			sessionID: "session-a",
			logicalState: "needs-input",
		})
	})

	it("returns null for permission.updated without session ID", () => {
		expect(buildCmuxSessionStatusTransitionForEvent("permission.updated", {})).toBeNull()
	})

	it("maps idle and animated busy session.status transitions", () => {
		expect(
			buildCmuxSessionStatusTransitionForEvent("session.status", {
				sessionID: "session-a",
				status: { type: "idle" },
			}),
		).toEqual({
			sessionID: "session-a",
			logicalState: "idle",
		})

		expect(
			buildCmuxSessionStatusTransitionForEvent("session.status", {
				sessionID: "session-a",
				status: { type: "busy" },
			}),
		).toEqual({
			sessionID: "session-a",
			logicalState: "animated-busy",
		})

		expect(
			buildCmuxSessionStatusTransitionForEvent("session.status", {
				sessionID: "session-a",
				status: { type: "retry" },
			}),
		).toEqual({
			sessionID: "session-a",
			logicalState: "animated-busy",
		})
	})

	it("keeps legacy running alias mapped to animated busy", () => {
		expect(
			buildCmuxSessionStatusTransitionForEvent("session.status", {
				sessionID: "session-a",
				status: { type: "running" },
			}),
		).toEqual({
			sessionID: "session-a",
			logicalState: "animated-busy",
		})
	})

	it("ignores unsupported session.status values", () => {
		expect(
			buildCmuxSessionStatusTransitionForEvent("session.status", {
				sessionID: "session-a",
				status: { type: "paused" },
			}),
		).toBeNull()
	})

	it("maps session.error and session.idle", () => {
		expect(
			buildCmuxSessionStatusTransitionForEvent("session.error", {
				sessionID: "session-a",
			}),
		).toEqual({
			sessionID: "session-a",
			logicalState: "error",
		})

		expect(
			buildCmuxSessionStatusTransitionForEvent("session.idle", {
				sessionID: "session-a",
			}),
		).toEqual({
			sessionID: "session-a",
			logicalState: "idle",
		})
	})

	it("maps non-busy cmux status levels to stable text", () => {
		expect(getCmuxSessionStatusText("needs-input")).toBe("Needs input")
		expect(getCmuxSessionStatusText("error")).toBe("Error")
	})
})
