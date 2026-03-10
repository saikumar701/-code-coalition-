import { useAppContext } from "@/context/AppContext"
import { useSocket } from "@/context/SocketContext"
import useWindowDimensions from "@/hooks/useWindowDimensions"
import { SocketEvent } from "@/types/socket"
import { useCallback, useEffect } from "react"
import { HistoryEntry, RecordsDiff, TLRecord, Tldraw, useEditor } from "tldraw"
import "tldraw/tldraw.css"

function DrawingEditor() {
    const { isMobile } = useWindowDimensions()

    return (
        <Tldraw
            inferDarkMode
            forceMobile={isMobile}
            defaultName="Editor"
            className="z-0"
        >
            <ReachEditor />
        </Tldraw>
    )
}

function ReachEditor() {
    const editor = useEditor()
    const { drawingData } = useAppContext()
    const { socket } = useSocket()

    const handleChangeEvent = useCallback(
        (change: HistoryEntry<TLRecord>) => {
            const diff = change.changes
            socket.emit(SocketEvent.DRAWING_UPDATE, { diff })
        },
        [socket],
    )

    // Handle drawing updates from other clients
    const handleRemoteDrawing = useCallback(
        ({ diff }: { diff: RecordsDiff<TLRecord> }) => {
            editor.store.mergeRemoteChanges(() => {
                editor.store.applyDiff(diff)
            })
        },
        [editor.store],
    )

    useEffect(() => {
        // Apply initial/remote snapshot whenever drawingData is updated.
        if (drawingData && Object.keys(drawingData).length > 0) {
            editor.loadSnapshot(drawingData as any)
        }
    }, [drawingData, editor])

    useEffect(() => {
        const cleanupFunction = editor.store.listen(handleChangeEvent, {
            source: "user",
            scope: "document",
        })
        // Listen for drawing updates from other clients
        socket.on(SocketEvent.DRAWING_UPDATE, handleRemoteDrawing)

        // Cleanup
        return () => {
            cleanupFunction()
            socket.off(SocketEvent.DRAWING_UPDATE)
        }
    }, [editor.store, handleChangeEvent, handleRemoteDrawing, socket])

    return null
}

export default DrawingEditor
