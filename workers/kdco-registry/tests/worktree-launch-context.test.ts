import { describe, expect, it } from "bun:test"
import {
	buildSessionLaunchArgv,
	parseActiveLaunchContext,
	parsePersistedLaunchMetadata,
} from "../files/plugins/worktree/launch-context"

describe("worktree launch context", () => {
	it("treats missing OCX_CONTEXT marker as plain launch", () => {
		expect(parseActiveLaunchContext({ OCX_PROFILE: "work" })).toEqual({ mode: "plain" })
	})

	it("fails loud when OCX_CONTEXT=1 is missing OCX_BIN", () => {
		expect(() => parseActiveLaunchContext({ OCX_CONTEXT: "1", OCX_PROFILE: "work" })).toThrow(
			/OCX_BIN/,
		)
	})

	it("fails loud when OCX_CONTEXT=1 is missing OCX_PROFILE", () => {
		expect(() =>
			parseActiveLaunchContext({ OCX_CONTEXT: "1", OCX_BIN: "/usr/local/bin/ocx" }),
		).toThrow(/OCX_PROFILE/)
	})

	it("parses OCX_CONTEXT marker with bin and profile", () => {
		expect(
			parseActiveLaunchContext({
				OCX_CONTEXT: "1",
				OCX_BIN: "/usr/local/bin/ocx",
				OCX_PROFILE: "work",
			}),
		).toEqual({
			mode: "ocx",
			ocxBin: "/usr/local/bin/ocx",
			profile: "work",
		})
	})

	it("treats legacy persisted metadata as plain", () => {
		expect(parsePersistedLaunchMetadata({})).toEqual({ mode: "plain" })
	})

	it("parses persisted ocx metadata", () => {
		expect(
			parsePersistedLaunchMetadata({
				launchMode: "ocx",
				ocxBin: "/usr/local/bin/ocx",
				profile: "work",
			}),
		).toEqual({
			mode: "ocx",
			ocxBin: "/usr/local/bin/ocx",
			profile: "work",
		})
	})

	it("fails loud for incomplete persisted ocx metadata", () => {
		expect(() =>
			parsePersistedLaunchMetadata({
				launchMode: "ocx",
				ocxBin: "/usr/local/bin/ocx",
			}),
		).toThrow(/profile/)
	})

	it("builds plain session launch argv", () => {
		expect(buildSessionLaunchArgv("session-123", { mode: "plain" })).toEqual([
			"opencode",
			"--session",
			"session-123",
		])
	})

	it("builds OCX session launch argv", () => {
		expect(
			buildSessionLaunchArgv("session-123", {
				mode: "ocx",
				ocxBin: "/usr/local/bin/ocx",
				profile: "work",
			}),
		).toEqual(["/usr/local/bin/ocx", "opencode", "-p", "work", "--session", "session-123"])
	})
})
