import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { AgentSession, AgentSessionEventListener } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { ReviewPanelChildUsage } from "./types.js"
import { ReviewPanelUsageBuffer } from "./usage.js"

function childSession() {
	const listeners = new Set<AgentSessionEventListener>()
	const session = {
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	} as unknown as AgentSession
	return {
		session,
		listenerCount: () => listeners.size,
		emit(provider: string, model: string, input: number) {
			const message: AssistantMessage = {
				role: "assistant",
				api: "openai-completions",
				provider,
				model,
				content: [],
				usage: {
					input,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: input + 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			}
			for (const listener of [...listeners]) listener({ type: "message_end", message })
		},
	}
}

describe("review panel child usage", () => {
	it("aggregates actual provider/model pairs once and emits only later deltas", async () => {
		const child = childSession()
		const emit = vi.fn<(usage: ReviewPanelChildUsage) => void>()
		const buffer = new ReviewPanelUsageBuffer(emit, "parent-tool-call")
		buffer.attach("spec", child.session)
		child.emit("serving-provider-a", "routed-model-a", 10)
		child.emit("serving-provider-a", "routed-model-a", 5)
		child.emit("serving-provider-b", "routed-model-b", 7)
		await buffer.flush()
		expect(emit.mock.calls.map(([usage]) => usage)).toEqual([
			{
				writer: "spec",
				provider: "serving-provider-a",
				model: "routed-model-a",
				usage: { input: 15, output: 4, cacheRead: 0, cacheWrite: 0 },
				parentToolCallId: "parent-tool-call",
			},
			{
				writer: "spec",
				provider: "serving-provider-b",
				model: "routed-model-b",
				usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0 },
				parentToolCallId: "parent-tool-call",
			},
		])
		await buffer.flush()
		expect(emit).toHaveBeenCalledTimes(2)
		child.emit("serving-provider-a", "routed-model-a", 3)
		await buffer.flush()
		expect(emit).toHaveBeenCalledTimes(3)
		expect(emit.mock.calls[2][0].usage.input).toBe(3)
		buffer.close()
		expect(child.listenerCount()).toBe(0)
	})
})
