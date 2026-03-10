import { useEffect, useState } from "react"
import Output from "./Output.tsx"
import TerminalComponent from "./Terminal.tsx"
import Preview from "./Preview.tsx"
import { MonitorPlay, PlayCircle, Terminal, type LucideIcon } from "lucide-react"

type TerminalTabId = "output" | "terminal" | "preview"

type TerminalTabSwitchDetail = {
	tab?: TerminalTabId
}

const TerminalView = () => {
	const [activeTab, setActiveTab] = useState<TerminalTabId>("terminal")

	useEffect(() => {
		const handleTabSwitch = (event: Event) => {
			const customEvent = event as CustomEvent<TerminalTabSwitchDetail>
			const nextTab = customEvent.detail?.tab
			if (!nextTab) return
			setActiveTab(nextTab)
		}

		window.addEventListener("terminal:set-tab", handleTabSwitch as EventListener)
		return () => {
			window.removeEventListener("terminal:set-tab", handleTabSwitch as EventListener)
		}
	}, [])

	const tabs: Array<{ id: TerminalTabId; label: string; icon: LucideIcon }> = [
		{ id: "output", label: "Output", icon: PlayCircle },
		{ id: "terminal", label: "Terminal", icon: Terminal },
		{ id: "preview", label: "Preview", icon: MonitorPlay },
	]

	return (
		<div className="terminal-shell flex h-full flex-col">
			<div className="terminal-tabbar flex items-center overflow-x-auto border-t">
				{tabs.map((tab) => (
					<Tab
						key={tab.id}
						label={tab.label}
						icon={tab.icon}
						active={activeTab === tab.id}
						onClick={() => setActiveTab(tab.id)}
					/>
				))}
			</div>

			<div className="flex-grow overflow-hidden">
				{activeTab === "output" && <Output />}
				{activeTab === "terminal" && <TerminalComponent />}
				{activeTab === "preview" && <Preview />}
			</div>
		</div>
	)
}

interface TabProps {
	label: string
	active: boolean
	onClick: () => void
	icon?: LucideIcon
}

const Tab: React.FC<TabProps> = ({ label, active, onClick, icon: Icon }) => (
	<div
		className={`
            terminal-tab flex cursor-pointer items-center gap-2 whitespace-nowrap px-4 py-2 text-xs font-medium
            transition-all
            ${active ? "terminal-tab--active" : ""}
        `}
		onClick={onClick}
	>
		{Icon && <Icon size={14} />}
		{label}
	</div>
)

export default TerminalView
