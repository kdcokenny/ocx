interface NotifyBackendOptions {
	preferCmux: boolean
	tryCmuxNotify: () => Promise<boolean>
	sendNodeNotify: () => void
}

export async function sendNotificationWithFallback(options: NotifyBackendOptions): Promise<void> {
	if (!options.preferCmux) {
		options.sendNodeNotify()
		return
	}

	try {
		const sentViaCmux = await options.tryCmuxNotify()
		if (sentViaCmux) return
	} catch {
		// Fall through to node-notifier fallback
	}

	options.sendNodeNotify()
}
