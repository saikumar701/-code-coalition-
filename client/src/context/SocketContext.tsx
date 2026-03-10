import { DrawingData } from "@/types/app"
import { BACKEND_URL } from "@/config/backend"
import {
    SocketContext as SocketContextType,
    SocketEvent,
    SocketId,
} from "@/types/socket"
import { PendingJoinRequest, RemoteUser, USER_STATUS, User } from "@/types/user"
import {
    ReactNode,
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
} from "react"
import { toast } from "react-hot-toast"
import { Socket, io } from "socket.io-client"
import { useAppContext } from "./AppContext"

const SocketContext = createContext<SocketContextType | null>(null)

export const useSocket = (): SocketContextType => {
    const context = useContext(SocketContext)
    if (!context) {
        throw new Error("useSocket must be used within a SocketProvider")
    }
    return context
}

const upsertUser = (users: RemoteUser[], user: RemoteUser): RemoteUser[] => {
    const existingIndex = users.findIndex((u) => u.socketId === user.socketId)
    if (existingIndex === -1) return [...users, user]

    const updatedUsers = [...users]
    updatedUsers[existingIndex] = { ...updatedUsers[existingIndex], ...user }
    return updatedUsers
}

const upsertPendingRequest = (
    requests: PendingJoinRequest[],
    request: PendingJoinRequest,
): PendingJoinRequest[] => {
    const existingIndex = requests.findIndex(
        (pendingRequest) =>
            pendingRequest.requesterSocketId === request.requesterSocketId,
    )
    if (existingIndex === -1) return [...requests, request]

    const updatedRequests = [...requests]
    updatedRequests[existingIndex] = request
    return updatedRequests
}

const getJoinRequestToastId = (requesterSocketId: string) =>
    `join-request-${requesterSocketId}`

const SocketProvider = ({ children }: { children: ReactNode }) => {
    const {
        setUsers,
        setStatus,
        currentUser,
        setCurrentUser,
        setPendingJoinRequests,
        drawingData,
        setDrawingData,
    } = useAppContext()
    const socket: Socket = useMemo(
        () =>
            io(BACKEND_URL, {
                reconnectionAttempts: 5,
                transports: ["websocket"], // prefer websocket to avoid long-poll timeouts
                autoConnect: true,
            }),
        [],
    )

    const handleError = useCallback(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err: any) => {
            console.log("socket error", err)
            setStatus(USER_STATUS.CONNECTION_FAILED)
            toast.dismiss()
            toast.error("Failed to connect to the server")
        },
        [setStatus],
    )

    const handleUsernameExist = useCallback(() => {
        toast.dismiss()
        setPendingJoinRequests([])
        setStatus(USER_STATUS.INITIAL)
        toast.error(
            "The username you chose already exists in the room. Please choose a different username.",
        )
    }, [setPendingJoinRequests, setStatus])

    const handleRoomJoinError = useCallback(
        ({ message }: { message?: string }) => {
            toast.dismiss()
            setPendingJoinRequests([])
            setStatus(USER_STATUS.INITIAL)
            toast.error(message || "Unable to join the room.")
        },
        [setPendingJoinRequests, setStatus],
    )

    const handleJoinPendingApproval = useCallback(() => {
        setStatus(USER_STATUS.PENDING_APPROVAL)
        toast.loading("Waiting for admin approval...", { id: "join-room" })
    }, [setStatus])

    const handleJoinRejected = useCallback(
        ({ message }: { message?: string }) => {
            toast.dismiss()
            setStatus(USER_STATUS.INITIAL)
            toast.error(message || "Admin rejected your join request.")
        },
        [setStatus],
    )

    const handleJoiningAccept = useCallback(
        ({ user, users }: { user: User; users: RemoteUser[] }) => {
            setCurrentUser(user)
            setPendingJoinRequests([])
            setUsers(users.reduce<RemoteUser[]>((acc, roomUser) => upsertUser(acc, roomUser), []))
            toast.dismiss()
            setStatus(USER_STATUS.JOINED)

            if (users.length > 1) {
                toast.loading("Syncing data, please wait...")
            }
        },
        [setCurrentUser, setPendingJoinRequests, setStatus, setUsers],
    )

    const handleJoinApprovalRequested = useCallback(
        ({ request }: { request?: PendingJoinRequest }) => {
            if (!request) return
            setPendingJoinRequests((prevRequests) =>
                upsertPendingRequest(prevRequests, request),
            )
            const toastId = getJoinRequestToastId(request.requesterSocketId)
            toast.dismiss(toastId)
            toast(
                `${request.username} wants to join room ${request.roomId}. Open Users panel to approve or reject.`,
                {
                    id: toastId,
                    duration: 15000,
                },
            )
        },
        [setPendingJoinRequests],
    )

    const handleJoinRequestResolved = useCallback(
        ({ requesterSocketId }: { requesterSocketId?: string }) => {
            if (!requesterSocketId) return
            toast.dismiss(getJoinRequestToastId(requesterSocketId))
            setPendingJoinRequests((prevRequests) =>
                prevRequests.filter(
                    (request) =>
                        request.requesterSocketId !== requesterSocketId,
                ),
            )
        },
        [setPendingJoinRequests],
    )

    const handleUserUpdated = useCallback(
        ({ user }: { user: RemoteUser }) => {
            if (!user?.socketId || user.socketId !== socket.id) return
            if (
                user.username === currentUser.username &&
                user.roomId === currentUser.roomId &&
                user.isAdmin === currentUser.isAdmin
            ) {
                return
            }
            setCurrentUser({
                username: user.username,
                roomId: user.roomId,
                isAdmin: user.isAdmin,
            })
        },
        [
            currentUser.isAdmin,
            currentUser.roomId,
            currentUser.username,
            setCurrentUser,
            socket.id,
        ],
    )

    const handleUserJoined = useCallback(
        ({ user }: { user: RemoteUser }) => {
            setUsers((prevUsers) => {
                const hasUser = prevUsers.some((u) => u.socketId === user.socketId)
                if (!hasUser) {
                    toast.success(`${user.username} joined the room`)
                }
                return upsertUser(prevUsers, user)
            })
        },
        [setUsers],
    )

    const handleUserLeft = useCallback(
        ({ user }: { user: RemoteUser }) => {
            toast.success(`${user.username} left the room`)
            setUsers((prevUsers) =>
                prevUsers.filter((u: RemoteUser) => u.socketId !== user.socketId),
            )
        },
        [setUsers],
    )

    const handleRequestDrawing = useCallback(
        ({ socketId }: { socketId: SocketId }) => {
            socket.emit(SocketEvent.SYNC_DRAWING, { socketId, drawingData })
        },
        [socket, drawingData],
    )

    const handleDrawingSync = useCallback(
        ({
            drawingData,
            snapshot,
        }: {
            drawingData?: DrawingData
            snapshot?: DrawingData
        }) => {
            const normalizedDrawingData = drawingData ?? snapshot ?? null
            setDrawingData(normalizedDrawingData)
        },
        [setDrawingData],
    )

    useEffect(() => {
        socket.on("connect_error", handleError)
        socket.on("connect_failed", handleError)
        socket.on(SocketEvent.USERNAME_EXISTS, handleUsernameExist)
        socket.on(SocketEvent.ROOM_JOIN_ERROR, handleRoomJoinError)
        socket.on(SocketEvent.JOIN_PENDING_APPROVAL, handleJoinPendingApproval)
        socket.on(SocketEvent.JOIN_REJECTED, handleJoinRejected)
        socket.on(SocketEvent.JOIN_ACCEPTED, handleJoiningAccept)
        socket.on(SocketEvent.JOIN_APPROVAL_REQUESTED, handleJoinApprovalRequested)
        socket.on(SocketEvent.JOIN_REQUEST_RESOLVED, handleJoinRequestResolved)
        socket.on(SocketEvent.USER_JOINED, handleUserJoined)
        socket.on(SocketEvent.USER_UPDATED, handleUserUpdated)
        socket.on(SocketEvent.USER_DISCONNECTED, handleUserLeft)
        socket.on(SocketEvent.REQUEST_DRAWING, handleRequestDrawing)
        socket.on(SocketEvent.SYNC_DRAWING, handleDrawingSync)

        return () => {
            socket.off("connect_error", handleError)
            socket.off("connect_failed", handleError)
            socket.off(SocketEvent.USERNAME_EXISTS, handleUsernameExist)
            socket.off(SocketEvent.ROOM_JOIN_ERROR, handleRoomJoinError)
            socket.off(SocketEvent.JOIN_PENDING_APPROVAL, handleJoinPendingApproval)
            socket.off(SocketEvent.JOIN_REJECTED, handleJoinRejected)
            socket.off(SocketEvent.JOIN_ACCEPTED, handleJoiningAccept)
            socket.off(
                SocketEvent.JOIN_APPROVAL_REQUESTED,
                handleJoinApprovalRequested,
            )
            socket.off(
                SocketEvent.JOIN_REQUEST_RESOLVED,
                handleJoinRequestResolved,
            )
            socket.off(SocketEvent.USER_JOINED, handleUserJoined)
            socket.off(SocketEvent.USER_UPDATED, handleUserUpdated)
            socket.off(SocketEvent.USER_DISCONNECTED, handleUserLeft)
            socket.off(SocketEvent.REQUEST_DRAWING, handleRequestDrawing)
            socket.off(SocketEvent.SYNC_DRAWING, handleDrawingSync)
        }
    }, [
        handleDrawingSync,
        handleError,
        handleJoinApprovalRequested,
        handleJoiningAccept,
        handleJoinPendingApproval,
        handleJoinRejected,
        handleJoinRequestResolved,
        handleRoomJoinError,
        handleUserUpdated,
        handleUserJoined,
        handleRequestDrawing,
        handleUserLeft,
        handleUsernameExist,
        socket,
    ])

    return (
        <SocketContext.Provider
            value={{
                socket,
            }}
        >
            {children}
        </SocketContext.Provider>
    )
}

export { SocketProvider }
export default SocketContext
