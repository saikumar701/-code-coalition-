import { VscDebugStop, VscRunAll } from "react-icons/vsc"
import { Button } from "@/components/ui/button"
import { useRunCode } from "@/context/RunCodeContext"
import { useAppContext } from "@/context/AppContext"
import { useFileSystem } from "@/context/FileContext"
import GitHubCorner from "@/components/GitHubCorner"
import Dropdown from "@/components/common/Dropdown"

const TopToolbar = () => {
    const { runCode, stopProjectRunner, previewUrl, isRunning, isStoppingRunner } = useRunCode()
    const { autoSaveEnabled, setAutoSaveEnabled } = useAppContext()
    const { saveWorkspaceNow } = useFileSystem()

    return (
        <div className="workspace-toolbar flex items-center justify-between px-3 py-2 text-[var(--ui-text-primary)]">
            {/* Left section */}
            <div className="flex items-center gap-4">
                <Button
                    className="sidebar-modern-btn sidebar-modern-btn--primary h-9 px-4"
                    size="sm"
                    onClick={runCode}
                    disabled={isRunning || isStoppingRunner}
                >
                    <VscRunAll className="mr-2 h-5 w-5" />
                    Run
                </Button>
                <Button
                    className="sidebar-modern-btn h-9 px-4"
                    size="sm"
                    onClick={stopProjectRunner}
                    disabled={!previewUrl || isRunning || isStoppingRunner}
                >
                    <VscDebugStop className="mr-2 h-5 w-5" />
                    {isStoppingRunner ? "Stopping..." : "Stop"}
                </Button>
                <Button
                    className={`h-9 px-4 ${
                        autoSaveEnabled
                            ? "sidebar-modern-btn sidebar-modern-btn--primary"
                            : "sidebar-modern-btn"
                    }`}
                    size="sm"
                    onClick={() => {
                        const nextValue = !autoSaveEnabled
                        setAutoSaveEnabled(nextValue)
                        if (nextValue) {
                            saveWorkspaceNow()
                        }
                    }}
                >
                    Auto Save: {autoSaveEnabled ? "ON" : "OFF"}
                </Button>
            </div>

            {/* Center section */}
            <div className="flex flex-1 justify-center">
                <span className="workspace-brand-title text-xl font-extrabold">
                    Code Coalition
                </span>
            </div>

            {/* Right section */}
            <div className="flex items-center gap-4">
                <GitHubCorner />
                <Dropdown />
            </div>
        </div>
    )
}

export default TopToolbar
