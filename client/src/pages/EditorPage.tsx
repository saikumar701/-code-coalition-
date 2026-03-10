import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import EditorComponent from "../components/editor/EditorComponent"
import LeftSidebar from "../components/LeftSidebar"
import FileStructureView from "../components/files/FileStructureView"
import ChatsView from "../components/sidebar/sidebar-views/ChatsView"
import FileSharingView from "../components/sidebar/sidebar-views/FileSharingView"
import ExternalImportView from "../components/sidebar/sidebar-views/ExternalImportView"
import CopilotView from "../components/sidebar/sidebar-views/CopilotView"
import ScreenShareView from "../components/sidebar/sidebar-views/ScreenShareView"
import SettingsView from "../components/sidebar/sidebar-views/SettingsView"
import UsersView from "../components/sidebar/sidebar-views/UsersView"
import TerminalView from "../components/terminal-view"
import TopToolbar from "../components/TopToolbar"
import { Code2, Pencil } from "lucide-react"
import { useAppContext } from "@/context/AppContext"
import { useSocket } from "@/context/SocketContext"
import { SocketEvent } from "@/types/socket"
import { USER_STATUS } from "@/types/user"
import { useParams } from "react-router-dom"
import angryCatGif from "@/assets/u_mey4kjj5ww-angry-2498_512.gif"
import peekingCatGif from "@/assets/misskalem-cat-17977_512.gif"
import { useRunCode } from "@/context/RunCodeContext"
import { getClientSessionId } from "@/utils/session"
import { lazy, Suspense, useState, useEffect, useRef } from "react"

const DrawingEditor = lazy(() => import("../components/drawing/DrawingEditor"))

type TerminalOutputPayload = {
    data?: string
    lines?: string[]
}

const TERMINAL_ERROR_PATTERNS = [
    /\bsyntaxerror\b/i,
    /\bparsererror\b/i,
    /\btraceback\b/i,
    /\bexception\b/i,
    /error/i,
    /\bfailed\b/i,
    /\bnpm err!/i,
    /is not recognized as an internal or external command/i,
    /command not found/i,
    /permission denied/i,
    /no such file or directory/i,
    /at line:\s*\d+\s*char:\s*\d+/i,
    /cannot find/i,
]

const stripAnsi = (value: string) =>
    value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")

const EditorPage = () => {
    const [activeSidebarItem, setActiveSidebarItem] = useState("files");
    const [activeEditorTab, setActiveEditorTab] = useState<"code" | "draw">("code");
    const [editorKey, setEditorKey] = useState(0);
    const [hasTerminalError, setHasTerminalError] = useState(false);
    const { roomId: routeRoomId = "" } = useParams();
    const { socket } = useSocket();
    const { hasRunError, isRunning } = useRunCode();
    const { currentUser, setCurrentUser, status, setStatus } = useAppContext();
    const generatedGuestRef = useRef(`guest-${Math.random().toString(36).slice(2, 8)}`);
    const terminalOutputBufferRef = useRef("");

    // Force editor to remount when switching tabs or files
    useEffect(() => {
        setEditorKey(prev => prev + 1);
    }, [activeEditorTab]);

    useEffect(() => {
        const handleTerminalOutput = (payload: TerminalOutputPayload) => {
            const combinedOutput =
                typeof payload?.data === "string"
                    ? payload.data
                    : Array.isArray(payload?.lines)
                      ? payload.lines.join("\n")
                      : ""

            if (!combinedOutput.trim()) {
                return
            }

            const normalizedOutput = stripAnsi(combinedOutput)
            terminalOutputBufferRef.current = (
                terminalOutputBufferRef.current + normalizedOutput
            ).slice(-5000)

            const hasError = TERMINAL_ERROR_PATTERNS.some((pattern) =>
                pattern.test(terminalOutputBufferRef.current),
            )

            if (hasError) {
                setHasTerminalError(true)
            }
        }

        const resetTerminalError = () => {
            setHasTerminalError(false)
            terminalOutputBufferRef.current = ""
        }

        socket.on(SocketEvent.TERMINAL_OUTPUT, handleTerminalOutput)
        window.addEventListener("terminal:command-submit", resetTerminalError)
        window.addEventListener("terminal:cleared", resetTerminalError)

        return () => {
            socket.off(SocketEvent.TERMINAL_OUTPUT, handleTerminalOutput)
            window.removeEventListener("terminal:command-submit", resetTerminalError)
            window.removeEventListener("terminal:cleared", resetTerminalError)
        }
    }, [socket]);

    // Ensure direct /editor/:roomId visits still join the room so terminal/workspace sync works.
    useEffect(() => {
        if (!routeRoomId) return;

        const username = currentUser.username.trim() || generatedGuestRef.current;
        const nextUser = { ...currentUser, roomId: routeRoomId, username };
        const joinPayload = {
            roomId: routeRoomId,
            username,
            sessionId: getClientSessionId(),
            mode: currentUser.isAdmin ? "create" : "join",
        };
        const isJoinedInThisRoom =
            status === USER_STATUS.JOINED && currentUser.roomId === routeRoomId;
        const isAttemptingJoinInThisRoom =
            status === USER_STATUS.ATTEMPTING_JOIN &&
            currentUser.roomId === routeRoomId &&
            currentUser.username === username;
        const isPendingApprovalInThisRoom =
            status === USER_STATUS.PENDING_APPROVAL &&
            currentUser.roomId === routeRoomId &&
            currentUser.username === username;

        if (
            currentUser.roomId !== routeRoomId ||
            currentUser.username !== username
        ) {
            setCurrentUser(nextUser);
        }

        if (
            isJoinedInThisRoom ||
            isAttemptingJoinInThisRoom ||
            isPendingApprovalInThisRoom
        ) {
            return;
        }

        setStatus(USER_STATUS.ATTEMPTING_JOIN);
        if (!socket.connected) {
            socket.connect();
        }
        // Buffered emit handles both connected and connecting states.
        socket.emit(SocketEvent.JOIN_REQUEST, joinPayload);
    }, [
        currentUser.isAdmin,
        currentUser.roomId,
        currentUser.username,
        routeRoomId,
        setCurrentUser,
        setStatus,
        socket,
        status,
    ]);

    // Rejoin room after socket reconnect so terminal/workspace path remains correct.
    useEffect(() => {
        if (!routeRoomId) return;

        const handleReconnect = () => {
            if (
                status !== USER_STATUS.JOINED &&
                status !== USER_STATUS.ATTEMPTING_JOIN &&
                status !== USER_STATUS.PENDING_APPROVAL
            ) {
                return;
            }

            const username = currentUser.username.trim() || generatedGuestRef.current;
            socket.emit(SocketEvent.JOIN_REQUEST, {
                roomId: routeRoomId,
                username,
                sessionId: getClientSessionId(),
                mode: currentUser.isAdmin ? "create" : "join",
            });
        };

        socket.on("connect", handleReconnect);
        return () => {
            socket.off("connect", handleReconnect);
        };
    }, [
        currentUser.isAdmin,
        currentUser.roomId,
        currentUser.username,
        routeRoomId,
        socket,
        status,
    ]);

    const renderActiveSidebarView = () => {
        switch (activeSidebarItem) {
            case "files":
                return <FileStructureView />
            case "chat":
                return <ChatsView />
            case "file-sharing":
                return <FileSharingView />
            case "external-import":
                return <ExternalImportView />
            case "screen-share":
                return <ScreenShareView />
            case "copilot":
                return <CopilotView />
            case "clients":
                return <UsersView />
            case "settings":
                return <SettingsView />
            default:
                return null
        }
    }

    const hasExecutionError = (hasRunError || hasTerminalError) && !isRunning

    return (
        <div className="workspace-shell relative flex h-screen flex-col overflow-hidden text-[var(--ui-text-primary)]">
            <TopToolbar />
            <div className="flex flex-grow min-h-0">
                <LeftSidebar
                    onSelect={setActiveSidebarItem}
                    activeItem={activeSidebarItem}
                />
                
                <ResizablePanelGroup direction="horizontal" className="flex-grow">
                    {/* Sidebar Panel */}
                    <ResizablePanel defaultSize={20} minSize={15} maxSize={35}>
                        <div className="workspace-sidebar-surface h-full overflow-auto">
                            {renderActiveSidebarView()}
                        </div>
                    </ResizablePanel>
                    
                    <ResizableHandle withHandle />
                    
                    {/* Main Editor and Terminal Area */}
                    <ResizablePanel defaultSize={80}>
                        <ResizablePanelGroup direction="vertical">
                            {/* Editor Panel */}
                            <ResizablePanel defaultSize={70} minSize={30}>
                                <div className="workspace-editor-shell relative flex h-full flex-col">
                                    {/* Tab Bar */}
                                    <div className="workspace-tabbar flex flex-shrink-0 items-center gap-2 px-3 py-2">
                                        <button
                                            onClick={() => setActiveEditorTab("code")}
                                            className={`
                                                workspace-tab-btn flex items-center gap-2 px-4 py-2 text-sm font-medium
                                                ${activeEditorTab === "code" 
                                                    ? "workspace-tab-btn--active" 
                                                    : ""
                                                }
                                            `}
                                        >
                                            <Code2 size={16} />
                                            Code Editor
                                        </button>
                                        <button
                                            onClick={() => setActiveEditorTab("draw")}
                                            className={`
                                                workspace-tab-btn flex items-center gap-2 px-4 py-2 text-sm font-medium
                                                ${activeEditorTab === "draw" 
                                                    ? "workspace-tab-btn--active" 
                                                    : ""
                                                }
                                            `}
                                        >
                                            <Pencil size={16} />
                                            Drawing Board
                                        </button>
                                    </div>

                                    {/* Tab Content - with key to force remount */}
                                    <div className="relative min-h-0 flex-grow overflow-hidden">
                                        {activeEditorTab === "code" && (
                                            <div key={`editor-${editorKey}`} className="absolute inset-0">
                                                <EditorComponent />
                                            </div>
                                        )}
                                        {activeEditorTab === "draw" && (
                                            <div key={`draw-${editorKey}`} className="absolute inset-0">
                                                <Suspense
                                                    fallback={
                                                        <div className="flex h-full items-center justify-center text-sm text-slate-300">
                                                            Loading drawing board...
                                                        </div>
                                                    }
                                                >
                                                    <DrawingEditor />
                                                </Suspense>
                                            </div>
                                        )}
                                    </div>

                                    {!hasExecutionError && (
                                        <div className="editor-peek-cat-wrap" aria-hidden="true">
                                            <img
                                                src={peekingCatGif}
                                                alt=""
                                                className="editor-peek-cat"
                                            />
                                        </div>
                                    )}

                                    {hasExecutionError && (
                                        <img
                                            src={angryCatGif}
                                            alt="Code error indicator"
                                            className="editor-error-cat"
                                        />
                                    )}
                                </div>
                            </ResizablePanel>
                            
                            <ResizableHandle withHandle />
                            
                            {/* Terminal Panel */}
                            <ResizablePanel defaultSize={30} minSize={20} maxSize={60}>
                                <div className="h-full overflow-hidden">
                                    <TerminalView />
                                </div>
                            </ResizablePanel>
                        </ResizablePanelGroup>
                    </ResizablePanel>
                </ResizablePanelGroup>
            </div>
        </div>
    );
};

export default EditorPage;
