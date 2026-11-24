import { setTimeout as delay } from "node:timers/promises"
import { afterEach, describe, expect, it } from "vitest"
import type { FakeModel } from "../tui/support/fake-openai-server.js"
import type { AcpFixture } from "./support/acp-fixture.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { prompt } from "./support/scenarios.js"

const MODELS: FakeModel[] = [
	{
		slug: "truncating",
		displayName: "Truncating model",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
		metadata: { thinking_levels: ["low", "medium", "high"] },
	},
]

function chatRequests(fixture: AcpFixture) {
	return fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
}

function efforts(fixture: AcpFixture) {
	return chatRequests(fixture).map((request) => (request.body as { reasoning_effort?: string }).reasoning_effort)
}

async function waitForChatCount(fixture: AcpFixture, count: number): Promise<void> {
	const deadline = Date.now() + 15_000
	while (chatRequests(fixture).length < count) {
		if (Date.now() > deadline) throw new Error(`Expected ${count} chat requests; got ${chatRequests(fixture).length}`)
		await delay(50)
	}
}

async function start(fixture: AcpFixture) {
	const session = await fixture.conn.request("session/new", { cwd: fixture.workDir, mcpServers: [] })
	await fixture.conn.request("session/set_config_option", {
		sessionId: session.sessionId,
		configId: "reasoning_effort",
		value: "high",
	})
	return session
}

describe("ACP request length recovery", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
	})

	it("keeps lower effort after successful continuation", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-request-length-success",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "truncating",
			models: MODELS,
			responses: [
				{
					thinking: ["No visible text before truncation"],
					finishReason: "length",
					headers: { "x-auto-reasoning-effort": "high" },
				},
				{ stream: ["ACP_CONTINUATION_COMPLETE"] },
				{ stream: ["ACP_PREFERENCE_RETAINED"] },
			],
		})
		const session = await start(fixture)
		await prompt(fixture, session.sessionId, "Start the capped response")
		expect(efforts(fixture)).toEqual(["high", "medium"])
		expect(JSON.stringify(chatRequests(fixture)[1].body)).toContain("before producing visible text")
		await prompt(fixture, session.sessionId, "Check the next user turn")
		expect(efforts(fixture)).toEqual(["high", "medium", "medium"])
		expect(
			fixture.client.extNotifications.some((notification) =>
				JSON.stringify(notification.params).includes("Queued one medium continuation"),
			),
		).toBe(true)
	})

	it("stops after a second truncation and restores the original effort", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-request-length-repeated",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "truncating",
			models: MODELS,
			responses: [
				{ thinking: ["First cap"], finishReason: "length", headers: { "x-auto-reasoning-effort": "high" } },
				{ thinking: ["Second cap"], finishReason: "length" },
				{ stream: ["ACP_ERROR_ROLLBACK"] },
			],
		})
		const session = await start(fixture)
		await prompt(fixture, session.sessionId, "Truncation twice")
		expect(chatRequests(fixture)).toHaveLength(2)
		expect(
			fixture.client.extNotifications.some((notification) =>
				JSON.stringify(notification.params).includes("output limit again"),
			),
		).toBe(true)
		await prompt(fixture, session.sessionId, "Check restored preference")
		expect(efforts(fixture)).toEqual(["high", "medium", "high"])
	})

	it("restores original effort after ACP cancellation and isolates replayed ownership", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-request-length-cancel",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "truncating",
			models: MODELS,
			responses: [
				{ thinking: ["Original cap"], finishReason: "length" },
				{ holdUntil: new Promise<void>(() => {}) },
				{ stream: ["ACP_CANCELLATION_ROLLBACK"] },
			],
		})
		const session = await start(fixture)
		const running = prompt(fixture, session.sessionId, "Start a cancellable fallback")
		await waitForChatCount(fixture, 2)
		await fixture.conn.notify("session/cancel", { sessionId: session.sessionId })
		await running
		const reloaded = await fixture.conn.request("session/load", {
			sessionId: session.sessionId,
			cwd: fixture.workDir,
			mcpServers: [],
		})
		const effort = reloaded.configOptions?.find((option) => option.id === "reasoning_effort")
		expect(effort?.currentValue).toBe("high")
		await prompt(fixture, session.sessionId, "Check the reloaded session")
		expect(efforts(fixture)).toEqual(["high", "medium", "high"])
	})

	it("retains lower effort while a native retry recovers a retryable provider error", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-request-length-native-retry",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "truncating",
			models: MODELS,
			responses: [
				{ thinking: ["Original cap"], finishReason: "length" },
				{ status: 503, body: { error: { message: "The service is temporarily unavailable." } } },
				{ stream: ["NATIVE_RETRY_PRESERVED_LOWER_EFFORT"] },
			],
		})
		const session = await start(fixture)
		await prompt(fixture, session.sessionId, "Preserve the recovery during a native retry")
		expect(efforts(fixture)).toEqual(["high", "medium", "medium"])
	})
})
