import { useRunCode } from "@/context/RunCodeContext"
import { ExternalLink, MonitorPlay, RefreshCcw, Square } from "lucide-react"
import { useState } from "react"

const Preview = () => {
	const {
		previewUrl,
		openPreviewInNewTab,
		stopProjectRunner,
		isRunning,
		isStoppingRunner,
	} = useRunCode()
	const [reloadKey, setReloadKey] = useState(0)

	if (!previewUrl) {
		return (
			<div className="terminal-shell flex h-full flex-col">
				<div className="terminal-header flex items-center gap-2 border-b px-3 py-2">
					<MonitorPlay size={14} className="text-[var(--ui-terminal-muted)]" />
					<span className="text-xs font-medium text-[var(--ui-terminal-text)]">
						Preview
					</span>
				</div>
				<div className="flex h-full items-center justify-center text-sm text-[var(--ui-terminal-muted)]">
					Press Run to start the app preview.
				</div>
			</div>
		)
	}

	return (
		<div className="terminal-shell flex h-full flex-col">
			<div className="terminal-header flex items-center justify-between border-b px-3 py-2">
				<div className="flex items-center gap-2">
					<MonitorPlay size={14} className="text-[var(--ui-terminal-muted)]" />
					<span className="text-xs font-medium text-[var(--ui-terminal-text)]">Preview</span>
					{isRunning && (
						<span className="text-xs text-[var(--ui-terminal-accent)]">Starting...</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					<button
						onClick={stopProjectRunner}
						disabled={isStoppingRunner || isRunning}
						className="terminal-action-btn rounded px-2 py-1 text-xs disabled:opacity-50"
						title="Stop preview"
					>
						<Square size={12} />
					</button>
					<button
						onClick={() => setReloadKey((value) => value + 1)}
						className="terminal-action-btn rounded px-2 py-1 text-xs"
					>
						<RefreshCcw size={12} />
					</button>
					<button
						onClick={openPreviewInNewTab}
						className="terminal-action-btn rounded px-2 py-1 text-xs"
					>
						<ExternalLink size={12} />
					</button>
				</div>
			</div>
			<iframe
				key={reloadKey}
				src={previewUrl}
				className="h-full w-full border-0"
				title="App Preview"
				sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-downloads"
			/>
		</div>
	)
}

export default Preview
