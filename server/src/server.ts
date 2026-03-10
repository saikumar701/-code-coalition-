import express, { Response, Request } from "express"
import dotenv from "dotenv"
import http from "http"
import cors from "cors"
import { SocketEvent, SocketId } from "./types/socket"
import { USER_CONNECTION_STATUS, User } from "./types/user"
import { Server } from "socket.io"
import path from "path"
import * as pty from "node-pty"
import os from "os"
import net from "net"
import fs from "fs"
import fsPromises from "fs/promises"
import { randomBytes } from "crypto"
import { spawn } from "child_process"
import {
	initializeRoomSnapshotStore,
	loadRoomSnapshot,
	saveRoomSnapshot,
} from "./services/roomSnapshotStore"
import {
	getProjectRunnerLogs,
	getProjectRunnerStatus,
	resolvePreviewTarget,
	startProjectRunnerSession,
	stopProjectRunnerSession,
} from "./services/projectRunner"

const loadServerEnv = () => {
	const envPaths = [
		path.resolve(process.cwd(), "server", ".env"),
		path.resolve(__dirname, "..", ".env"),
	]

	envPaths.forEach((envPath) => {
		dotenv.config({ path: envPath, override: true })
	})
}

loadServerEnv()
void initializeRoomSnapshotStore()

const app = express()
const jsonBodyLimit = (process.env.JSON_BODY_LIMIT || "80mb").trim() || "80mb"

app.use(express.json({ limit: jsonBodyLimit }))
app.use(express.urlencoded({ limit: jsonBodyLimit, extended: true }))

app.use(cors())

app.use(express.static(path.join(__dirname, "public"))) // Serve static files

const server = http.createServer(app)
const io = new Server(server, {
	cors: {
		origin: "*",
	},
	maxHttpBufferSize: 1e8,
	pingTimeout: 60000,
})

let userSocketMap: User[] = []
const ptyProcess = new Map<SocketId, pty.IPty>()
const shell = os.platform() === "win32" ? "powershell.exe" : "bash"
const isWorkspaceDiskSyncEnabled =
	(process.env.WORKSPACE_DISK_SYNC || "").trim().toLowerCase() === "true"
const workspaceRoot = isWorkspaceDiskSyncEnabled
	? path.resolve(process.cwd(), ".workspaces")
	: path.join(os.tmpdir(), "code-coalition-workspaces")
const runnerWorkspaceRoot = path.join(workspaceRoot, "__runner_sessions")
const roomFileTrees = new Map<string, WorkspaceFileSystemItem>()
const roomTrackedPaths = new Map<string, Set<string>>()
const roomRunnerWorkspacePaths = new Map<string, string>()
const roomSyncTimers = new Map<string, NodeJS.Timeout>()
const roomScreenShareMap = new Map<string, ScreenShareInfo>()
const roomAdminSocketMap = new Map<string, SocketId>()
const pendingJoinRequestMap = new Map<SocketId, PendingJoinRequest>()
const approvedRoomSessions = new Map<string, Map<string, ApprovedSessionRecord>>()
const maxFileShareEnvValue = Number(process.env.FILE_SHARE_MAX_SIZE_MB || "20")
const maxFileShareSizeMb =
	Number.isFinite(maxFileShareEnvValue) && maxFileShareEnvValue > 0
		? maxFileShareEnvValue
		: 20
const maxFileShareSizeBytes = maxFileShareSizeMb * 1024 * 1024
const maxFileShareNameLength = 255
const maxExternalImportEnvValue = Number(process.env.EXTERNAL_IMPORT_MAX_SIZE_MB || "15")
const maxExternalImportSizeMb =
	Number.isFinite(maxExternalImportEnvValue) && maxExternalImportEnvValue > 0
		? maxExternalImportEnvValue
		: 15
const maxExternalImportSizeBytes = maxExternalImportSizeMb * 1024 * 1024
const oauthStateStore = new Map<string, OAuthStateRecord>()
const oauthStateTtlMs = 10 * 60 * 1000
const googleDriveScope = "https://www.googleapis.com/auth/drive.readonly"
const githubScope = "repo read:user"
const localRunTimeoutMs = 15000
const localFallbackRuntimes: PistonRuntime[] = [
	{
		language: "javascript",
		version: "local",
		aliases: ["js", "node"],
	},
	{
		language: "python",
		version: "local",
		aliases: ["py", "python3"],
	},
]

interface WorkspaceFileSystemItem {
	id: string
	name: string
	type: "file" | "directory"
	children?: WorkspaceFileSystemItem[]
	content?: string
	contentEncoding?: "utf8" | "base64"
	mimeType?: string
}

interface WorkspaceEntry {
	relativePath: string
	type: "file" | "directory"
	content?: string
	contentEncoding?: "utf8" | "base64"
	mimeType?: string
}

interface IncomingSharedFile {
	id?: string
	name?: string
	mimeType?: string
	size?: number
	dataUrl?: string
}

interface SharedFilePayload {
	id: string
	name: string
	mimeType: string
	size: number
	dataUrl: string
	senderUsername: string
	senderSocketId: string
	recipientSocketId: string | null
	roomId: string
	sentAt: string
}

interface ChatMessagePayload {
	id: string
	message: string
	username: string
	timestamp: string
	isDirect: boolean
	recipientSocketId: string | null
	recipientUsername: string | null
}

interface ScreenShareInfo {
	socketId: string
	username: string
}

interface ScreenShareSignalEnvelope {
	type: "offer" | "answer" | "ice-candidate"
	sdp?: {
		type?: string
		sdp?: string
	}
	candidate?: {
		candidate?: string
		sdpMid?: string | null
		sdpMLineIndex?: number | null
		usernameFragment?: string | null
	}
}

type OAuthProvider = "github" | "gdrive"

interface OAuthStateRecord {
	provider: OAuthProvider
	origin: string
	createdAt: number
}

interface PistonRuntime {
	language: string
	version: string
	aliases: string[]
}

interface PistonExecuteFile {
	name?: string
	content?: string
}

interface PistonExecuteBody {
	language?: string
	version?: string
	files?: PistonExecuteFile[]
	stdin?: string
}

interface LocalExecutionResult {
	stdout: string
	stderr: string
	code: number | null
	signal: NodeJS.Signals | null
	spawnErrorCode?: string
}

interface LocalCommandCandidate {
	command: string
	getArgs: (filePath: string) => string[]
}

type JoinMode = "create" | "join"

interface JoinRequestPayload {
	roomId?: string
	username?: string
	sessionId?: string
	mode?: JoinMode
}

interface JoinApprovalDecisionPayload {
	requesterSocketId?: string
	approved?: boolean
}

interface PendingJoinRequest {
	requestId: string
	roomId: string
	username: string
	requesterSocketId: SocketId
	sessionId: string
	requestedAt: number
}

interface ApprovedSessionRecord {
	username: string
	isAdmin: boolean
}

if (!fs.existsSync(workspaceRoot)) {
	fs.mkdirSync(workspaceRoot, { recursive: true })
}
console.log(
	`Workspace mirror mode: ${isWorkspaceDiskSyncEnabled ? "project-disk" : "temp-only"} (${workspaceRoot})`,
)

function sanitizeRoomId(roomId: string): string {
	return roomId.replace(/[^a-zA-Z0-9_-]/g, "_")
}

function getRoomWorkspacePath(roomId: string): string {
	const directoryPath = path.join(workspaceRoot, sanitizeRoomId(roomId))
	if (!fs.existsSync(directoryPath)) {
		fs.mkdirSync(directoryPath, { recursive: true })
	}
	return directoryPath
}

function createPtyForSocket(socketId: SocketId, socket: any, cwd: string): pty.IPty {
	const instance = pty.spawn(shell, [], {
		name: "xterm-color",
		cols: 80,
		rows: 30,
		cwd,
		env: process.env,
	})

	instance.onData((data: string) => {
		socket.emit(SocketEvent.TERMINAL_OUTPUT, {
			data,
		})
	})

	instance.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
		const isUserInterrupt = exitCode === -1073741510 || exitCode === 130
		if (isUserInterrupt) {
			console.log(`PTY process for ${socketId} interrupted by user.`)
		} else {
			console.log(
				`PTY process for ${socketId} exited with code ${exitCode}, signal ${signal}`
			)
		}
		ptyProcess.delete(socketId)
		socket.emit(SocketEvent.TERMINAL_OUTPUT, {
			data: "\r\n[Terminal session ended. Press Enter to restart]\r\n",
		})
	})

	ptyProcess.set(socketId, instance)
	return instance
}

function resetPtyForSocket(socket: any, cwd: string) {
	const existing = ptyProcess.get(socket.id)
	if (existing) {
		existing.kill()
		ptyProcess.delete(socket.id)
	}
	createPtyForSocket(socket.id, socket, cwd)
}

function getTerminalCwdForSocket(socketId: SocketId): string {
	const roomId = getRoomId(socketId)
	if (roomId) {
		return getRoomWorkspacePath(roomId)
	}
	return process.env.INIT_CWD || process.cwd()
}

function ensurePtyForSocket(socket: any): pty.IPty {
	const existingPty = ptyProcess.get(socket.id)
	if (existingPty) {
		return existingPty
	}

	const cwd = getTerminalCwdForSocket(socket.id)
	return createPtyForSocket(socket.id, socket, cwd)
}

function getWorkspaceEntries(children: WorkspaceFileSystemItem[], parentPath = ""): WorkspaceEntry[] {
	const entries: WorkspaceEntry[] = []

	children.forEach((child) => {
		const childPath = parentPath ? `${parentPath}/${child.name}` : child.name

		if (child.type === "directory") {
			entries.push({
				relativePath: childPath,
				type: "directory",
			})
			entries.push(...getWorkspaceEntries(child.children || [], childPath))
			return
		}

		entries.push({
			relativePath: childPath,
			type: "file",
			content: child.content || "",
			contentEncoding: child.contentEncoding || "utf8",
			mimeType: child.mimeType || "text/plain",
		})
	})

	return entries
}

async function removePathWithRetries(
	targetPath: string,
	maxAttempts = 4,
): Promise<void> {
	let attempt = 0
	while (attempt < maxAttempts) {
		try {
			await fsPromises.rm(targetPath, { recursive: true, force: true })
			return
		} catch (error) {
			attempt += 1
			const errorCode = (error as NodeJS.ErrnoException).code || ""
			const isRetryable =
				errorCode === "EBUSY" || errorCode === "EPERM" || errorCode === "ENOTEMPTY"
			if (!isRetryable || attempt >= maxAttempts) {
				throw error
			}
			await new Promise((resolve) => setTimeout(resolve, 120 * attempt))
		}
	}
}

async function clearWorkspaceDirectoryContents(workspacePath: string): Promise<void> {
	await fsPromises.mkdir(workspacePath, { recursive: true })
	const childEntries = await fsPromises.readdir(workspacePath).catch(() => [])
	for (const childEntry of childEntries) {
		const childPath = path.join(workspacePath, childEntry)
		await removePathWithRetries(childPath)
	}
}

async function writeWorkspaceEntriesToPath(
	workspacePath: string,
	entries: WorkspaceEntry[],
): Promise<void> {
	const directoryEntries = entries
		.filter((entry) => entry.type === "directory")
		.sort((a, b) => a.relativePath.split("/").length - b.relativePath.split("/").length)

	for (const directory of directoryEntries) {
		const absolutePath = path.join(workspacePath, ...directory.relativePath.split("/"))
		await fsPromises.mkdir(absolutePath, { recursive: true })
	}

	const fileEntries = entries.filter((entry) => entry.type === "file")
	for (const fileEntry of fileEntries) {
		const absolutePath = path.join(workspacePath, ...fileEntry.relativePath.split("/"))
		await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true })
		if (fileEntry.contentEncoding === "base64") {
			const fileBuffer = Buffer.from(fileEntry.content || "", "base64")
			await fsPromises.writeFile(absolutePath, Uint8Array.from(fileBuffer))
		} else {
			await fsPromises.writeFile(absolutePath, fileEntry.content || "", "utf8")
		}
	}
}

async function createRunnerWorkspaceSnapshot(
	roomId: string,
	fileTree: WorkspaceFileSystemItem,
): Promise<string> {
	const roomRunnerRoot = path.join(runnerWorkspaceRoot, sanitizeRoomId(roomId))
	const snapshotDirectoryName = `${Date.now()}-${randomBytes(4).toString("hex")}`
	const snapshotPath = path.join(roomRunnerRoot, snapshotDirectoryName)
	const entries = getWorkspaceEntries(fileTree.children || [])

	await fsPromises.mkdir(snapshotPath, { recursive: true })
	await writeWorkspaceEntriesToPath(snapshotPath, entries)
	return snapshotPath
}

async function cleanupRunnerWorkspace(roomId: string): Promise<void> {
	const runnerWorkspacePath = roomRunnerWorkspacePaths.get(roomId)
	if (!runnerWorkspacePath) return

	roomRunnerWorkspacePaths.delete(roomId)
	await removePathWithRetries(runnerWorkspacePath).catch((error) => {
		console.warn(
			`Failed to cleanup runner workspace for room ${roomId}:`,
			(error as Error).message,
		)
	})
}

async function synchronizeWorkspaceToDisk(
	roomId: string,
	forceClean = false,
): Promise<void> {
	const fileTree = roomFileTrees.get(roomId)
	if (!fileTree || fileTree.type !== "directory") return
	await saveRoomSnapshot(roomId, fileTree)

	const workspacePath = getRoomWorkspacePath(roomId)
	if (forceClean) {
		await clearWorkspaceDirectoryContents(workspacePath)
		roomTrackedPaths.delete(roomId)
	}
	const nextEntries = getWorkspaceEntries(fileTree.children || [])
	const nextPaths = new Set(nextEntries.map((entry) => entry.relativePath))
	const previousPaths = roomTrackedPaths.get(roomId) || new Set<string>()

	const removedPaths = [...previousPaths]
		.filter((relativePath) => !nextPaths.has(relativePath))
		.sort(
			(a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a),
		)

	for (const relativePath of removedPaths) {
		const absolutePath = path.join(workspacePath, ...relativePath.split("/"))
		await fsPromises.rm(absolutePath, { recursive: true, force: true })
	}

	await writeWorkspaceEntriesToPath(workspacePath, nextEntries)

	roomTrackedPaths.set(roomId, nextPaths)
}

function scheduleWorkspaceSync(roomId: string) {
	const timer = roomSyncTimers.get(roomId)
	if (timer) {
		clearTimeout(timer)
	}

	const syncTimer = setTimeout(() => {
		void synchronizeWorkspaceToDisk(roomId).catch((error) => {
			console.error(`Failed to sync workspace for room ${roomId}:`, error)
		})
		roomSyncTimers.delete(roomId)
	}, 200)

	roomSyncTimers.set(roomId, syncTimer)
}

// Function to get all users in a room
function getUsersInRoom(roomId: string): User[] {
	return userSocketMap.filter((user) => user.roomId == roomId)
}

// Function to get room id by socket id
function getRoomId(socketId: SocketId): string | null {
	const roomId = userSocketMap.find(
		(user) => user.socketId === socketId
	)?.roomId

	if (!roomId) {
		console.error("Room ID is undefined for socket ID:", socketId)
		return null
	}
	return roomId
}

function getUserBySocketId(socketId: SocketId): User | null {
	const user = userSocketMap.find((user) => user.socketId === socketId)
	if (!user) {
		console.error("User not found for socket ID:", socketId)
		return null
	}
	return user
}

function normalizeJoinMode(mode: JoinMode | undefined): JoinMode {
	return mode === "create" ? "create" : "join"
}

function toPendingJoinRequestEventPayload(request: PendingJoinRequest) {
	return {
		requestId: request.requestId,
		roomId: request.roomId,
		username: request.username,
		requesterSocketId: request.requesterSocketId,
	}
}

function getPendingJoinRequestsForRoom(roomId: string): PendingJoinRequest[] {
	return [...pendingJoinRequestMap.values()].filter((request) => request.roomId === roomId)
}

function getRoomAdminUser(roomId: string): User | null {
	const mappedAdminSocketId = roomAdminSocketMap.get(roomId) || ""
	const roomUsers = getUsersInRoom(roomId)

	if (mappedAdminSocketId) {
		const mappedAdmin = roomUsers.find((user) => user.socketId === mappedAdminSocketId) || null
		if (mappedAdmin) {
			return mappedAdmin
		}
		roomAdminSocketMap.delete(roomId)
	}

	const discoveredAdmin = roomUsers.find((user) => user.isAdmin) || null
	if (discoveredAdmin) {
		roomAdminSocketMap.set(roomId, discoveredAdmin.socketId)
	}
	return discoveredAdmin
}

function rememberApprovedSession(
	roomId: string,
	sessionId: string,
	record: ApprovedSessionRecord,
) {
	if (!sessionId) return
	const sessionsForRoom = approvedRoomSessions.get(roomId) || new Map<string, ApprovedSessionRecord>()
	sessionsForRoom.set(sessionId, record)
	approvedRoomSessions.set(roomId, sessionsForRoom)
}

function getApprovedSession(roomId: string, sessionId: string): ApprovedSessionRecord | null {
	if (!sessionId) return null
	return approvedRoomSessions.get(roomId)?.get(sessionId) || null
}

function emitPendingJoinRequestToAdmin(roomId: string, request: PendingJoinRequest) {
	const adminUser = getRoomAdminUser(roomId)
	if (!adminUser) return
	io.to(adminUser.socketId).emit(SocketEvent.JOIN_APPROVAL_REQUESTED, {
		request: toPendingJoinRequestEventPayload(request),
	})
}

function emitJoinRequestResolvedToAdmin(roomId: string, requesterSocketId: SocketId) {
	const adminUser = getRoomAdminUser(roomId)
	if (!adminUser) return
	io.to(adminUser.socketId).emit(SocketEvent.JOIN_REQUEST_RESOLVED, { requesterSocketId })
}

function removePendingJoinRequest(requesterSocketId: SocketId): PendingJoinRequest | null {
	const pendingRequest = pendingJoinRequestMap.get(requesterSocketId) || null
	if (!pendingRequest) return null

	pendingJoinRequestMap.delete(requesterSocketId)
	emitJoinRequestResolvedToAdmin(pendingRequest.roomId, requesterSocketId)
	return pendingRequest
}

function rejectPendingJoinRequestsForRoom(roomId: string, reason: string) {
	const roomPendingRequests = getPendingJoinRequestsForRoom(roomId)
	roomPendingRequests.forEach((request) => {
		pendingJoinRequestMap.delete(request.requesterSocketId)
		io.to(request.requesterSocketId).emit(SocketEvent.JOIN_REJECTED, {
			message: reason,
		})
	})
}

function findFirstFileInTree(node: WorkspaceFileSystemItem): WorkspaceFileSystemItem | null {
	if (node.type === "file") return node
	const children = node.children || []
	for (const child of children) {
		const nested = findFirstFileInTree(child)
		if (nested) return nested
	}
	return null
}

function getWorkspaceSyncPayload(fileStructure: WorkspaceFileSystemItem) {
	const directChildFiles = (fileStructure.children || []).filter(
		(item) => item.type === "file",
	)
	const firstFile = directChildFiles[0] || findFirstFileInTree(fileStructure)
	return {
		fileStructure,
		openFiles: firstFile ? [firstFile] : [],
		activeFile: firstFile || null,
	}
}

async function acceptUserIntoRoom({
	socket,
	roomId,
	username,
	sessionId,
	isAdmin,
}: {
	socket: any
	roomId: string
	username: string
	sessionId: string
	isAdmin: boolean
}) {
	let roomSnapshot = roomFileTrees.get(roomId) || null
	if (!roomSnapshot) {
		const snapshotFromDb = await loadRoomSnapshot<WorkspaceFileSystemItem>(roomId)
		if (snapshotFromDb && snapshotFromDb.type === "directory") {
			roomSnapshot = snapshotFromDb
			roomFileTrees.set(roomId, snapshotFromDb)
			await synchronizeWorkspaceToDisk(roomId)
		}
	}

	userSocketMap = userSocketMap.filter((u) => u.socketId !== socket.id)
	socket.data.joinSessionId = sessionId

	const user: User = {
		username,
		roomId,
		isAdmin,
		status: USER_CONNECTION_STATUS.ONLINE,
		cursorPosition: 0,
		typing: false,
		socketId: socket.id,
		currentFile: null,
	}

	userSocketMap.push(user)
	if (isAdmin) {
		roomAdminSocketMap.set(roomId, socket.id)
	}
	rememberApprovedSession(roomId, sessionId, {
		username,
		isAdmin,
	})

	socket.join(roomId)
	const roomWorkspacePath = getRoomWorkspacePath(roomId)
	resetPtyForSocket(socket, roomWorkspacePath)

	socket.broadcast.to(roomId).emit(SocketEvent.USER_JOINED, { user })
	const users = getUsersInRoom(roomId)

	io.to(socket.id).emit(SocketEvent.JOIN_ACCEPTED, { user, users })
	const activeScreenShare = roomScreenShareMap.get(roomId)
	io.to(socket.id).emit(SocketEvent.SCREEN_SHARE_STATUS, {
		sharerSocketId: activeScreenShare?.socketId || null,
		sharerUsername: activeScreenShare?.username || null,
	})
	if (roomSnapshot?.type === "directory") {
		io.to(socket.id).emit(
			SocketEvent.SYNC_FILE_STRUCTURE,
			getWorkspaceSyncPayload(roomSnapshot),
		)
	}
}

function getBase64DecodedSize(base64Value: string): number {
	const trimmed = base64Value.replace(/\s/g, "")
	const paddingMatch = trimmed.match(/=+$/)
	const paddingLength = paddingMatch ? paddingMatch[0].length : 0
	return Math.max(0, Math.floor((trimmed.length * 3) / 4) - paddingLength)
}

function parseDataUrl(dataUrl: string): { mimeType: string; size: number } | null {
	const dataUrlMatch = dataUrl.match(/^data:([^;]*);base64,([\s\S]+)$/)
	if (!dataUrlMatch) return null

	const mimeType =
		dataUrlMatch[1]?.trim() || "application/octet-stream"
	const encodedBody = dataUrlMatch[2]
	return {
		mimeType,
		size: getBase64DecodedSize(encodedBody),
	}
}

function parseFileNameFromContentDisposition(headerValue: string | null): string | null {
	if (!headerValue) return null

	const utf8Match = headerValue.match(/filename\*=UTF-8''([^;]+)/i)
	if (utf8Match?.[1]) {
		try {
			return decodeURIComponent(utf8Match[1].replace(/["']/g, ""))
		} catch {
			return utf8Match[1].replace(/["']/g, "")
		}
	}

	const simpleMatch = headerValue.match(/filename="?([^";]+)"?/i)
	if (simpleMatch?.[1]) {
		return simpleMatch[1]
	}

	return null
}

function sanitizeImportedFileName(fileName: string): string {
	const cleaned = fileName
		.replace(/[/\\?%*:|"<>]/g, "_")
		.trim()
	return cleaned || `imported-file-${Date.now()}`
}

function toTextSnapshotFileName(fileName: string): string {
	const sanitized = sanitizeImportedFileName(fileName || `imported-page-${Date.now()}`)
	const baseName = sanitized.replace(/\.[^./\\]+$/, "")
	return `${baseName}.snapshot.txt`
}

function getFileNameFromPath(pathname: string): string {
	const parts = pathname.split("/").filter(Boolean)
	const lastPart = parts[parts.length - 1] || ""
	if (!lastPart) return ""

	try {
		return decodeURIComponent(lastPart)
	} catch {
		return lastPart
	}
}

type DriveLinkKind =
	| "file"
	| "document"
	| "spreadsheet"
	| "presentation"
	| "drawing"
	| "form"
	| "unknown"

type ExternalImportProvider = "github" | "gdrive" | "direct"

interface DriveLinkInfo {
	fileId: string
	resourceKey: string
	kind: DriveLinkKind
}

function extractDriveFileId(urlValue: string): string | null {
	const directMatch = urlValue.match(/\/file\/d\/([a-zA-Z0-9_-]+)/)
	if (directMatch?.[1]) return directMatch[1]

	const docsMatch = urlValue.match(
		/\/(?:document|spreadsheets|presentation|drawings|forms)\/d\/([a-zA-Z0-9_-]+)/,
	)
	if (docsMatch?.[1]) return docsMatch[1]

	const openMatch = urlValue.match(/[?&]id=([a-zA-Z0-9_-]+)/)
	if (openMatch?.[1]) return openMatch[1]

	const ucMatch = urlValue.match(/[?&]export=download&id=([a-zA-Z0-9_-]+)/)
	if (ucMatch?.[1]) return ucMatch[1]

	return null
}

function detectDriveLinkKind(parsedUrl: URL): DriveLinkKind {
	const host = parsedUrl.hostname.toLowerCase()
	const pathname = parsedUrl.pathname.toLowerCase()
	if (
		host.endsWith("drive.google.com") ||
		host === "drive.usercontent.google.com"
	) {
		return "file"
	}
	if (!host.endsWith("docs.google.com")) {
		return "unknown"
	}
	if (pathname.startsWith("/document/d/")) return "document"
	if (pathname.startsWith("/spreadsheets/d/")) return "spreadsheet"
	if (pathname.startsWith("/presentation/d/")) return "presentation"
	if (pathname.startsWith("/drawings/d/")) return "drawing"
	if (pathname.startsWith("/forms/d/")) return "form"
	return "unknown"
}

function extractDriveLinkInfo(parsedUrl: URL, rawUrl: string): DriveLinkInfo | null {
	const fileId = extractDriveFileId(rawUrl)
	if (!fileId) return null
	const resourceKey = (parsedUrl.searchParams.get("resourcekey") || "").trim()
	const kind = detectDriveLinkKind(parsedUrl)
	return {
		fileId,
		resourceKey,
		kind,
	}
}

function buildDriveDownloadUrl(info: DriveLinkInfo): string {
	const { fileId, resourceKey, kind } = info
	const url =
		kind === "document"
			? new URL(`https://docs.google.com/document/d/${fileId}/export`)
			: kind === "spreadsheet"
				? new URL(`https://docs.google.com/spreadsheets/d/${fileId}/export`)
				: kind === "presentation"
					? new URL(`https://docs.google.com/presentation/d/${fileId}/export/pptx`)
					: kind === "drawing"
						? new URL(`https://docs.google.com/drawings/d/${fileId}/export`)
						: new URL("https://drive.google.com/uc")

	if (kind === "document") {
		url.searchParams.set("format", "txt")
	} else if (kind === "spreadsheet") {
		url.searchParams.set("format", "csv")
	} else if (kind === "drawing") {
		url.searchParams.set("format", "png")
	} else if (kind === "file" || kind === "unknown" || kind === "form") {
		url.searchParams.set("export", "download")
		url.searchParams.set("id", fileId)
	}

	if (resourceKey) {
		url.searchParams.set("resourcekey", resourceKey)
	}

	return url.toString()
}

function getDriveFileNameFallback(fileId: string, kind: DriveLinkKind): string {
	if (kind === "document") return `drive-document-${fileId}.txt`
	if (kind === "spreadsheet") return `drive-sheet-${fileId}.csv`
	if (kind === "presentation") return `drive-presentation-${fileId}.pptx`
	if (kind === "drawing") return `drive-drawing-${fileId}.png`
	return `drive-file-${fileId}`
}

function buildDriveAnonymousFallbackUrls(params: {
	fileId: string
	resourceKey: string
}): string[] {
	const { fileId, resourceKey } = params
	const urls: string[] = []

	const driveUserContentUrl = new URL("https://drive.usercontent.google.com/download")
	driveUserContentUrl.searchParams.set("id", fileId)
	driveUserContentUrl.searchParams.set("export", "download")
	driveUserContentUrl.searchParams.set("confirm", "t")
	if (resourceKey) {
		driveUserContentUrl.searchParams.set("resourcekey", resourceKey)
	}
	urls.push(driveUserContentUrl.toString())

	const driveUcUrl = new URL("https://drive.google.com/uc")
	driveUcUrl.searchParams.set("export", "download")
	driveUcUrl.searchParams.set("id", fileId)
	driveUcUrl.searchParams.set("confirm", "t")
	if (resourceKey) {
		driveUcUrl.searchParams.set("resourcekey", resourceKey)
	}
	urls.push(driveUcUrl.toString())

	return urls
}

function getDriveExportMimeType(nativeMimeType: string): string | null {
	const normalizedMimeType = nativeMimeType.trim().toLowerCase()
	if (normalizedMimeType === "application/vnd.google-apps.document") return "text/plain"
	if (normalizedMimeType === "application/vnd.google-apps.spreadsheet") return "text/csv"
	if (normalizedMimeType === "application/vnd.google-apps.presentation") {
		return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
	}
	if (normalizedMimeType === "application/vnd.google-apps.drawing") return "image/png"
	return null
}

async function tryDownloadDriveFileWithAccessToken(params: {
	fileId: string
	accessToken: string
}): Promise<{ buffer: Buffer; mimeType: string; fileName: string } | null> {
	const fileId = params.fileId.trim()
	const accessToken = params.accessToken.trim()
	if (!fileId || !accessToken) return null

	const authHeaders = {
		Authorization: `Bearer ${accessToken}`,
	}
	const encodedFileId = encodeURIComponent(fileId)
	const metadataUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodedFileId}`)
	metadataUrl.searchParams.set("fields", "id,name,mimeType,size")
	metadataUrl.searchParams.set("supportsAllDrives", "true")

	try {
		const metadataResponse = await fetch(metadataUrl.toString(), {
			method: "GET",
			headers: authHeaders,
		})
		if (!metadataResponse.ok) {
			return null
		}

		const metadataPayload = (await metadataResponse.json().catch(() => null)) as
			| {
					name?: string
					mimeType?: string
			  }
			| null
		if (!metadataPayload) return null

		const fileName = sanitizeImportedFileName(
			typeof metadataPayload.name === "string" ? metadataPayload.name : `drive-file-${fileId}`,
		)
		const sourceMimeType =
			typeof metadataPayload.mimeType === "string"
				? metadataPayload.mimeType.trim()
				: "application/octet-stream"
		const exportMimeType = getDriveExportMimeType(sourceMimeType)

		let fileResponse: globalThis.Response
		let expectedMimeType = sourceMimeType
		if (exportMimeType) {
			const exportUrl = new URL(
				`https://www.googleapis.com/drive/v3/files/${encodedFileId}/export`,
			)
			exportUrl.searchParams.set("mimeType", exportMimeType)
			fileResponse = await fetch(exportUrl.toString(), {
				method: "GET",
				headers: authHeaders,
			})
			expectedMimeType = exportMimeType
		} else {
			const mediaUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodedFileId}`)
			mediaUrl.searchParams.set("alt", "media")
			mediaUrl.searchParams.set("supportsAllDrives", "true")
			fileResponse = await fetch(mediaUrl.toString(), {
				method: "GET",
				headers: authHeaders,
			})
		}

		if (!fileResponse.ok) {
			return null
		}

		const buffer = Buffer.from(await fileResponse.arrayBuffer())
		if (buffer.length === 0) {
			return null
		}

		const mimeType =
			(fileResponse.headers.get("content-type") || expectedMimeType || "application/octet-stream")
				.split(";")[0]
				.trim() || "application/octet-stream"

		return {
			buffer,
			mimeType,
			fileName,
		}
	} catch {
		return null
	}
}

function getGithubRawUrl(inputUrl: URL): string | null {
	const host = inputUrl.hostname.toLowerCase()
	if (host === "raw.githubusercontent.com") {
		return inputUrl.toString()
	}

	if (host !== "github.com") {
		return null
	}

	const parts = inputUrl.pathname.split("/").filter(Boolean)
	if (parts.length < 5 || parts[2] !== "blob") {
		return null
	}

	const owner = parts[0]
	const repo = parts[1]
	const branch = parts[3]
	const filePath = parts.slice(4).join("/")
	if (!owner || !repo || !branch || !filePath) {
		return null
	}

	return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`
}

function isLikelyTextFile(mimeType: string, buffer: Buffer): boolean {
	if (!mimeType || mimeType === "application/octet-stream") {
		const nullByteIndex = buffer.indexOf(0)
		return nullByteIndex === -1
	}

	if (mimeType.startsWith("text/")) {
		return true
	}

	return /(json|javascript|typescript|xml|yaml|yml|csv|markdown|md|x-sh|sql|svg)/i.test(
		mimeType,
	)
}

function extractGoogleDriveConfirmToken(html: string): string | null {
	if (!html) return null

	const hrefMatch = html.match(/confirm=([0-9A-Za-z_-]+)&(?:amp;)?id=/i)
	if (hrefMatch?.[1]) {
		return hrefMatch[1]
	}

	const inputMatch = html.match(/name=["']confirm["']\s+value=["']([^"']+)["']/i)
	if (inputMatch?.[1]) {
		return inputMatch[1]
	}

	return null
}

function decodeBasicHtmlEntities(value: string): string {
	return value
		.replace(/&amp;/gi, "&")
		.replace(/&#x3d;/gi, "=")
		.replace(/&#61;/gi, "=")
		.replace(/&#x2f;/gi, "/")
}

function decodeUriComponentSafe(value: string): string {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

function decodeHtmlEntitiesForText(value: string): string {
	const withNamedEntities = decodeBasicHtmlEntities(value)
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
	return withNamedEntities
		.replace(/&#(\d+);/g, (_fullMatch, codePointValue: string) => {
			const codePoint = Number(codePointValue)
			if (!Number.isFinite(codePoint)) return ""
			try {
				return String.fromCodePoint(codePoint)
			} catch {
				return ""
			}
		})
		.replace(/&#x([0-9a-f]+);/gi, (_fullMatch, codePointValue: string) => {
			const codePoint = Number.parseInt(codePointValue, 16)
			if (!Number.isFinite(codePoint)) return ""
			try {
				return String.fromCodePoint(codePoint)
			} catch {
				return ""
			}
		})
}

function extractReadableTextFromHtml(html: string): string[] {
	if (!html.trim()) return ["Empty HTML page."]

	const withoutScripts = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")

	const withLineBreakHints = withoutScripts.replace(
		/<\/?(p|div|section|article|header|footer|main|aside|h[1-6]|li|tr|td|th|pre|code|br|hr)[^>]*>/gi,
		"\n",
	)
	const textOnly = withLineBreakHints.replace(/<[^>]+>/g, " ")
	const decodedText = decodeHtmlEntitiesForText(textOnly)

	const lines = decodedText
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean)

	return lines.length > 0 ? lines : ["HTML page content could not be parsed."]
}

function buildHtmlSnapshotText(params: {
	html: string
	sourceUrl: string
	fileNameHint: string
	authPageDetected: boolean
}): { buffer: Buffer; mimeType: string; fileName: string } {
	const { html, sourceUrl, fileNameHint, authPageDetected } = params
	const allLines = extractReadableTextFromHtml(html)
	const maxLines = 300
	const maxCharsPerLine = 180
	const clippedLines = allLines
		.slice(0, maxLines)
		.map((line) =>
			line.length > maxCharsPerLine ? `${line.slice(0, maxCharsPerLine - 3)}...` : line,
		)

	const headerLines: string[] = [
		"External HTML page snapshot",
		`Source: ${sourceUrl}`,
		"",
	]
	if (authPageDetected) {
		headerLines.push(
			"Note: This page looks like a login/auth page, not a directly downloadable file.",
			"",
		)
	}
	const snapshotText = [...headerLines, ...clippedLines].join("\n")

	return {
		buffer: Buffer.from(snapshotText, "utf8"),
		mimeType: "text/plain",
		fileName: toTextSnapshotFileName(fileNameHint),
	}
}

function tryGetDirectAssetUrlFromPageUrl(pageUrl: string): string | null {
	let parsedPageUrl: URL
	try {
		parsedPageUrl = new URL(pageUrl)
	} catch {
		return null
	}

	const candidateParamNames = [
		"imgurl",
		"mediaurl",
		"file",
		"download",
		"url",
		"u",
		"continue",
		"followup",
		"continue_url",
		"dest",
	]
	for (const paramName of candidateParamNames) {
		const rawValue = (parsedPageUrl.searchParams.get(paramName) || "").trim()
		if (!rawValue) continue

		const decodedValue = decodeUriComponentSafe(rawValue)
		const decodedTwiceValue = decodeUriComponentSafe(decodedValue)
		const candidateValues = [rawValue, decodedValue, decodedTwiceValue]
		for (const candidateValue of candidateValues) {
			try {
				const candidateUrl = new URL(candidateValue)
				if (!["http:", "https:"].includes(candidateUrl.protocol)) {
					continue
				}
				if (candidateUrl.toString() === parsedPageUrl.toString()) {
					continue
				}
				return candidateUrl.toString()
			} catch {
				// Ignore invalid candidate values.
			}
		}
	}

	return null
}

function enrichDriveDownloadUrl(params: {
	urlValue: string
	baseUrl: string
	fileId: string
	resourceKey: string
}): string | null {
	const { urlValue, baseUrl, fileId, resourceKey } = params
	try {
		const url = new URL(decodeBasicHtmlEntities(urlValue), baseUrl)
		if (!url.searchParams.get("id")) {
			url.searchParams.set("id", fileId)
		}
		if (resourceKey && !url.searchParams.get("resourcekey")) {
			url.searchParams.set("resourcekey", resourceKey)
		}
		return url.toString()
	} catch {
		return null
	}
}

function extractGoogleDriveFollowUpUrl(params: {
	html: string
	baseUrl: string
	fileId: string
	resourceKey: string
}): string | null {
	const { html, baseUrl, fileId, resourceKey } = params
	if (!html) return null

	const hrefPatterns = [
		/href=["']([^"']*drive\.usercontent\.google\.com\/download[^"']*)["']/i,
		/href=["']([^"']*\/uc\?[^"']*export=download[^"']*)["']/i,
		/href=["']([^"']*confirm=[^"']*id=[^"']*)["']/i,
	]

	for (const hrefPattern of hrefPatterns) {
		const hrefMatch = html.match(hrefPattern)
		if (!hrefMatch?.[1]) continue
		const followUpUrl = enrichDriveDownloadUrl({
			urlValue: hrefMatch[1],
			baseUrl,
			fileId,
			resourceKey,
		})
		if (followUpUrl) return followUpUrl
	}

	const formMatch = html.match(/<form[^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i)
	if (!formMatch?.[1]) return null

	const actionUrl = enrichDriveDownloadUrl({
		urlValue: formMatch[1],
		baseUrl,
		fileId,
		resourceKey,
	})
	if (!actionUrl) return null

	const url = new URL(actionUrl)
	const formHtml = formMatch[2] || ""
	const inputRegex = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi
	let inputMatch: RegExpExecArray | null = null
	while ((inputMatch = inputRegex.exec(formHtml)) !== null) {
		const name = (inputMatch[1] || "").trim()
		if (!name) continue
		const value = decodeBasicHtmlEntities(inputMatch[2] || "")
		url.searchParams.set(name, value)
	}

	if (!url.searchParams.get("id")) {
		url.searchParams.set("id", fileId)
	}
	if (resourceKey && !url.searchParams.get("resourcekey")) {
		url.searchParams.set("resourcekey", resourceKey)
	}

	return url.toString()
}

function isHtmlAuthPageResponse(params: {
	provider: ExternalImportProvider
	mimeType: string
	buffer: Buffer
	finalUrl: string
}): boolean {
	const { provider, mimeType, buffer, finalUrl } = params
	const looksLikeHtml = mimeType.toLowerCase() === "text/html"
	if (!looksLikeHtml) return false

	const sampleText = buffer
		.subarray(0, Math.min(buffer.length, 4096))
		.toString("utf8")
		.toLowerCase()

	const hasHtmlMarkers = sampleText.includes("<html") || sampleText.includes("<!doctype html")
	if (!hasHtmlMarkers) return false

	const finalHost = (() => {
		try {
			return new URL(finalUrl).hostname.toLowerCase()
		} catch {
			return ""
		}
	})()

	if (provider === "gdrive") {
		const looksLikeGoogleSignInPage =
			sampleText.includes("accounts.google.com") ||
			sampleText.includes("servicelogin") ||
			sampleText.includes("identifierid") ||
			sampleText.includes("sign in to continue") ||
			sampleText.includes("to continue to google")
		if (
			finalHost.includes("accounts.google.com") ||
			looksLikeGoogleSignInPage
		) {
			return true
		}
	}

	if (provider === "github") {
		const looksLikeGitHubSignInPage =
			sampleText.includes("github") &&
			(sampleText.includes("sign in") ||
				sampleText.includes("login") ||
				sampleText.includes("session"))
		if (
			finalHost === "github.com" ||
			finalHost.endsWith(".github.com") ||
			looksLikeGitHubSignInPage
		) {
			return true
		}
	}

	return false
}

function normalizeOrigin(originValue: string | null | undefined): string {
	if (!originValue) return ""

	try {
		const parsedOrigin = new URL(originValue)
		return parsedOrigin.origin
	} catch {
		return ""
	}
}

function getServerPublicBaseUrl(req: Request): string {
	const configuredBaseUrl = normalizeOrigin(process.env.SERVER_PUBLIC_URL)
	if (configuredBaseUrl) return configuredBaseUrl

	const forwardedProto =
		typeof req.headers["x-forwarded-proto"] === "string"
			? req.headers["x-forwarded-proto"]
			: ""
	const protocol = forwardedProto || req.protocol || "http"
	const host = req.get("host")
	return `${protocol}://${host}`
}

function getDirectPreviewUrl(req: Request, port: number): string {
	const hostName =
		(typeof req.headers["x-forwarded-host"] === "string"
			? req.headers["x-forwarded-host"]
			: req.hostname || "localhost")
			.split(",")[0]
			.trim()
			.replace(/:\d+$/, "")

	return `http://${hostName}:${port}/`
}

function isWorkspaceDirectory(value: unknown): value is WorkspaceFileSystemItem {
	if (!value || typeof value !== "object") return false
	const maybeItem = value as Partial<WorkspaceFileSystemItem>
	return maybeItem.type === "directory" && typeof maybeItem.id === "string"
}

function proxyPreviewRequest(req: Request, res: Response, roomId: string, port: number) {
	const upstreamPath = req.url && req.url.trim().length > 0 ? req.url : "/"
	const requestHeaders: http.OutgoingHttpHeaders = {
		...req.headers,
		host: `127.0.0.1:${port}`,
	}

	const proxyReq = http.request(
		{
			hostname: "127.0.0.1",
			port,
			method: req.method,
			path: upstreamPath,
			headers: requestHeaders,
		},
		(proxyRes) => {
			const responseHeaders: http.OutgoingHttpHeaders = {
				...proxyRes.headers,
			}
			delete responseHeaders["x-frame-options"]

			const locationHeader = responseHeaders.location
			if (typeof locationHeader === "string" && locationHeader.startsWith("/")) {
				responseHeaders.location = `/preview/${encodeURIComponent(roomId)}${locationHeader}`
			}

			res.writeHead(proxyRes.statusCode || 502, responseHeaders)
			proxyRes.pipe(res)
		},
	)

	proxyReq.on("error", (error) => {
		if (res.headersSent) {
			res.end()
			return
		}
		res.status(502).json({
			error: `Preview proxy error: ${(error as Error).message}`,
		})
	})

	req.pipe(proxyReq)
}

function proxyPreviewUpgrade(
	req: http.IncomingMessage,
	socket: any,
	head: Buffer,
): boolean {
	const requestUrl = req.url || ""
	const parsedUrl = new URL(requestUrl, "http://localhost")
	const previewPathMatch = parsedUrl.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/)
	if (!previewPathMatch) {
		return false
	}

	const roomId = decodeURIComponent(previewPathMatch[1] || "").trim()
	if (!roomId) {
		socket.destroy()
		return true
	}

	const target = resolvePreviewTarget(roomId)
	if (!target) {
		socket.destroy()
		return true
	}

	const proxyPath = `${previewPathMatch[2] || "/"}${parsedUrl.search || ""}`
	const upstreamSocket = net.createConnection({
		host: "127.0.0.1",
		port: target.port,
	})

	upstreamSocket.on("connect", () => {
		const forwardedHeaders = Object.entries(req.headers)
			.filter(([headerName]) => headerName.toLowerCase() !== "host")
			.map(([headerName, value]) => {
				const normalizedValue = Array.isArray(value)
					? value.join(", ")
					: value || ""
				return `${headerName}: ${normalizedValue}`
			})
			.join("\r\n")
		const upgradeRequestLines = [
			`${req.method || "GET"} ${proxyPath} HTTP/1.1`,
			`Host: 127.0.0.1:${target.port}`,
		]
		if (forwardedHeaders) {
			upgradeRequestLines.push(forwardedHeaders)
		}
		upgradeRequestLines.push("", "")
		const upgradeRequest = upgradeRequestLines.join("\r\n")

		upstreamSocket.write(upgradeRequest)
		if (head?.length) {
			upstreamSocket.write(head)
		}
		socket.pipe(upstreamSocket).pipe(socket)
	})

	upstreamSocket.on("error", () => {
		socket.destroy()
	})
	socket.on("error", () => {
		upstreamSocket.destroy()
	})

	return true
}

function buildOAuthRedirectUri(req: Request, provider: OAuthProvider): string {
	const serverBaseUrl = getServerPublicBaseUrl(req)
	const pathSuffix = provider === "github" ? "github" : "gdrive"
	return `${serverBaseUrl}/api/oauth/${pathSuffix}/callback`
}

function getPistonApiBaseUrl(): string {
	const configuredBaseUrl = (process.env.PISTON_API_BASE_URL || "").trim()
	if (!configuredBaseUrl) return ""
	return configuredBaseUrl.replace(/\/+$/, "")
}

function getPistonAuthHeaders(): Record<string, string> {
	const pistonApiToken = (process.env.PISTON_API_TOKEN || "").trim()
	if (!pistonApiToken) {
		return {}
	}
	return {
		Authorization: `Bearer ${pistonApiToken}`,
	}
}

function normalizeLanguageName(value: string): string {
	return value.trim().toLowerCase()
}

function getLocalFileExtension(language: string): string {
	const normalizedLanguage = normalizeLanguageName(language)
	if (["javascript", "js", "node"].includes(normalizedLanguage)) return ".js"
	if (["python", "py", "python3"].includes(normalizedLanguage)) return ".py"
	return ".txt"
}

function getLocalCommandCandidates(language: string): LocalCommandCandidate[] {
	const normalizedLanguage = normalizeLanguageName(language)

	if (["javascript", "js", "node"].includes(normalizedLanguage)) {
		return [
			{
				command: "node",
				getArgs: (filePath: string) => [filePath],
			},
		]
	}

	if (["python", "py", "python3"].includes(normalizedLanguage)) {
		return [
			{
				command: "python",
				getArgs: (filePath: string) => [filePath],
			},
			{
				command: "py",
				getArgs: (filePath: string) => ["-3", filePath],
			},
		]
	}

	return []
}

function runLocalCommand({
	command,
	args,
	stdin,
	cwd,
	timeoutMs,
}: {
	command: string
	args: string[]
	stdin: string
	cwd: string
	timeoutMs: number
}): Promise<LocalExecutionResult> {
	return new Promise((resolve, reject) => {
		let stdout = ""
		let stderr = ""
		let settled = false
		let timedOut = false

		const child = spawn(command, args, {
			cwd,
			windowsHide: true,
		})

		const finish = (result: LocalExecutionResult) => {
			if (settled) return
			settled = true
			resolve(result)
		}

		const timer = setTimeout(() => {
			timedOut = true
			child.kill()
		}, timeoutMs)

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString()
		})

		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString()
		})

		child.on("error", (error) => {
			clearTimeout(timer)
			const errorCode = (error as NodeJS.ErrnoException).code || ""
			if (errorCode === "ENOENT") {
				finish({
					stdout: "",
					stderr: "",
					code: null,
					signal: null,
					spawnErrorCode: "ENOENT",
				})
				return
			}

			if (settled) return
			settled = true
			reject(error)
		})

		child.on("close", (code, signal) => {
			clearTimeout(timer)
			const timeoutMessage = timedOut
				? `\nExecution timed out after ${Math.floor(timeoutMs / 1000)} seconds.`
				: ""
			finish({
				stdout,
				stderr: `${stderr}${timeoutMessage}`,
				code,
				signal,
			})
		})

		if (stdin) {
			child.stdin.write(stdin)
		}
		child.stdin.end()
	})
}

async function executeWithLocalRuntime(
	body: PistonExecuteBody,
): Promise<{ success: true; response: unknown } | { success: false; error: string }> {
	const language = normalizeLanguageName(body.language || "")
	const files = Array.isArray(body.files) ? body.files : []
	const firstFile = files[0]
	const content =
		typeof firstFile?.content === "string"
			? firstFile.content
			: typeof firstFile?.content === "number"
				? String(firstFile.content)
				: ""

	if (!language) {
		return { success: false, error: "Language is required." }
	}

	if (!files.length) {
		return { success: false, error: "At least one file is required to execute code." }
	}

	const commandCandidates = getLocalCommandCandidates(language)
	if (!commandCandidates.length) {
		return {
			success: false,
			error: `No local runtime configured for language "${language}".`,
		}
	}

	const safeFileName = path.basename((firstFile?.name || "main").trim()) || "main"
	const hasKnownExtension = path.extname(safeFileName).length > 0
	const targetFileName = hasKnownExtension
		? safeFileName
		: `${safeFileName}${getLocalFileExtension(language)}`

	const tempDirectory = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), "code-coalition-run-"),
	)
	const filePath = path.join(tempDirectory, targetFileName)

	try {
		await fsPromises.writeFile(filePath, content, "utf8")

		let lastCommandError = ""

		for (const candidate of commandCandidates) {
			const commandResult = await runLocalCommand({
				command: candidate.command,
				args: candidate.getArgs(filePath),
				stdin: typeof body.stdin === "string" ? body.stdin : "",
				cwd: tempDirectory,
				timeoutMs: localRunTimeoutMs,
			})

			if (commandResult.spawnErrorCode === "ENOENT") {
				lastCommandError = `Command "${candidate.command}" is not installed.`
				continue
			}

			return {
				success: true,
				response: {
					language,
					version: "local",
					run: {
						stdout: commandResult.stdout,
						stderr: commandResult.stderr,
						code: commandResult.code,
						signal: commandResult.signal,
						output: `${commandResult.stdout}${commandResult.stderr}`,
					},
				},
			}
		}

		return {
			success: false,
			error:
				lastCommandError ||
				`Local runtime for language "${language}" is unavailable on this machine.`,
		}
	} catch (error) {
		return {
			success: false,
			error: `Local execution failed: ${(error as Error).message}`,
		}
	} finally {
		await fsPromises.rm(tempDirectory, { recursive: true, force: true }).catch(() => {})
	}
}

function cleanupOAuthStateStore() {
	const now = Date.now()
	for (const [state, record] of oauthStateStore.entries()) {
		if (now - record.createdAt > oauthStateTtlMs) {
			oauthStateStore.delete(state)
		}
	}
}

function createOAuthState(provider: OAuthProvider, origin: string): string {
	cleanupOAuthStateStore()
	const state = randomBytes(24).toString("hex")
	oauthStateStore.set(state, {
		provider,
		origin,
		createdAt: Date.now(),
	})
	return state
}

function consumeOAuthState(state: string, provider: OAuthProvider): OAuthStateRecord | null {
	cleanupOAuthStateStore()
	const record = oauthStateStore.get(state)
	if (!record || record.provider !== provider) {
		return null
	}
	oauthStateStore.delete(state)
	return record
}

function getOAuthCallbackHtml({
	success,
	provider,
	origin,
	accessToken,
	errorMessage,
}: {
	success: boolean
	provider: OAuthProvider
	origin: string
	accessToken?: string
	errorMessage?: string
}): string {
	const sanitizedOrigin = origin || "*"
	const payload = success
		? {
				type: "oauth-success",
				provider,
				accessToken,
			}
		: {
				type: "oauth-error",
				provider,
				error: errorMessage || "OAuth failed.",
			}

	const serializedPayload = JSON.stringify(payload).replace(/</g, "\\u003c")
	const serializedOrigin = JSON.stringify(sanitizedOrigin)

	return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>OAuth</title></head>
<body>
<script>
  (function () {
    var payload = ${serializedPayload};
    var targetOrigin = ${serializedOrigin};
    if (window.opener && typeof window.opener.postMessage === "function") {
      window.opener.postMessage(payload, targetOrigin);
    }
    window.close();
  })();
</script>
</body>
</html>`
}

io.on("connection", (socket) => {
	console.log("✅ NEW CONNECTION:", socket.id)

	const ptyInstance = ptyProcess.get(socket.id)
	if (!ptyInstance) {
		createPtyForSocket(socket.id, socket, process.env.INIT_CWD || process.cwd())
	}

	// Handle user actions
	socket.on(SocketEvent.JOIN_REQUEST, async (payload: JoinRequestPayload) => {
		const normalizedRoomId =
			typeof payload?.roomId === "string" ? payload.roomId.trim() : ""
		const normalizedUsername =
			typeof payload?.username === "string" ? payload.username.trim() : ""
		const normalizedSessionId =
			typeof payload?.sessionId === "string" ? payload.sessionId.trim() : ""
		const normalizedMode = normalizeJoinMode(payload?.mode)

		console.log("JOIN_REQUEST:", {
			socketId: socket.id,
			roomId: normalizedRoomId,
			username: normalizedUsername,
			mode: normalizedMode,
		})

		if (!normalizedRoomId || !normalizedUsername) {
			io.to(socket.id).emit(SocketEvent.ROOM_JOIN_ERROR, {
				message: "Room ID and username are required.",
			})
			return
		}

		const existingPendingRequestWithUsername = getPendingJoinRequestsForRoom(
			normalizedRoomId,
		).find(
			(request) =>
				request.username === normalizedUsername &&
				request.requesterSocketId !== socket.id,
		)

		if (existingPendingRequestWithUsername) {
			io.to(socket.id).emit(SocketEvent.USERNAME_EXISTS)
			return
		}

		const existingUser = getUsersInRoom(normalizedRoomId).find(
			(user) => user.username === normalizedUsername,
		)
		if (existingUser && existingUser.socketId === socket.id) {
			const users = getUsersInRoom(normalizedRoomId)
			io.to(socket.id).emit(SocketEvent.JOIN_ACCEPTED, { user: existingUser, users })
			return
		}

		if (existingUser && existingUser.socketId !== socket.id) {
			const existingSocket = io.sockets.sockets.get(existingUser.socketId)
			const existingSessionId =
				typeof existingSocket?.data?.joinSessionId === "string"
					? existingSocket.data.joinSessionId
					: ""
			const canHandoff =
				normalizedSessionId.length > 0 &&
				existingSessionId.length > 0 &&
				existingSessionId === normalizedSessionId

			if (!canHandoff) {
				io.to(socket.id).emit(SocketEvent.USERNAME_EXISTS)
				return
			}

			userSocketMap = userSocketMap.filter((user) => user.socketId !== existingUser.socketId)
			if (existingSocket) {
				existingSocket.leave(normalizedRoomId)
				existingSocket.disconnect(true)
			}

			removePendingJoinRequest(socket.id)
			await acceptUserIntoRoom({
				socket,
				roomId: normalizedRoomId,
				username: normalizedUsername,
				sessionId: normalizedSessionId,
				isAdmin: existingUser.isAdmin,
			})
			return
		}

		const approvedSession = getApprovedSession(normalizedRoomId, normalizedSessionId)
		if (approvedSession && approvedSession.username === normalizedUsername) {
			removePendingJoinRequest(socket.id)
			await acceptUserIntoRoom({
				socket,
				roomId: normalizedRoomId,
				username: normalizedUsername,
				sessionId: normalizedSessionId,
				isAdmin: approvedSession.isAdmin,
			})
			return
		}

		if (normalizedMode === "create") {
			const users = getUsersInRoom(normalizedRoomId)
			if (users.length > 0) {
				io.to(socket.id).emit(SocketEvent.ROOM_JOIN_ERROR, {
					message: "Room already exists. Use Join Room instead.",
				})
				return
			}

			removePendingJoinRequest(socket.id)
			await acceptUserIntoRoom({
				socket,
				roomId: normalizedRoomId,
				username: normalizedUsername,
				sessionId: normalizedSessionId,
				isAdmin: true,
			})
			return
		}

		const usersInRoom = getUsersInRoom(normalizedRoomId)
		if (usersInRoom.length === 0) {
			io.to(socket.id).emit(SocketEvent.ROOM_JOIN_ERROR, {
				message: "Room not found. Ask the admin to create the room first.",
			})
			return
		}

		let adminUser = getRoomAdminUser(normalizedRoomId)
		if (!adminUser && usersInRoom.length > 0) {
			const nextAdmin = usersInRoom[0]
			userSocketMap = userSocketMap.map((user) =>
				user.socketId === nextAdmin.socketId ? { ...user, isAdmin: true } : user,
			)
			adminUser = getUserBySocketId(nextAdmin.socketId)
			roomAdminSocketMap.set(normalizedRoomId, nextAdmin.socketId)
			if (adminUser) {
				io.to(normalizedRoomId).emit(SocketEvent.USER_UPDATED, { user: adminUser })
			}
		}

		if (!adminUser) {
			io.to(socket.id).emit(SocketEvent.ROOM_JOIN_ERROR, {
				message: "No admin is available in this room right now.",
			})
			return
		}

		removePendingJoinRequest(socket.id)
		const pendingJoinRequest: PendingJoinRequest = {
			requestId: randomBytes(8).toString("hex"),
			roomId: normalizedRoomId,
			username: normalizedUsername,
			requesterSocketId: socket.id,
			sessionId: normalizedSessionId,
			requestedAt: Date.now(),
		}
		pendingJoinRequestMap.set(socket.id, pendingJoinRequest)

		io.to(socket.id).emit(SocketEvent.JOIN_PENDING_APPROVAL)
		emitPendingJoinRequestToAdmin(normalizedRoomId, pendingJoinRequest)
	})

	socket.on(
		SocketEvent.JOIN_APPROVAL_DECISION,
		async (payload: JoinApprovalDecisionPayload) => {
			const approver = getUserBySocketId(socket.id)
			if (!approver || !approver.isAdmin) return

			const requesterSocketId =
				typeof payload?.requesterSocketId === "string"
					? payload.requesterSocketId
					: ""
			const approved = Boolean(payload?.approved)
			if (!requesterSocketId) return

			const pendingJoinRequest = pendingJoinRequestMap.get(requesterSocketId)
			if (!pendingJoinRequest || pendingJoinRequest.roomId !== approver.roomId) {
				return
			}

			pendingJoinRequestMap.delete(requesterSocketId)
			emitJoinRequestResolvedToAdmin(pendingJoinRequest.roomId, requesterSocketId)

			const requesterSocket = io.sockets.sockets.get(requesterSocketId)
			if (!requesterSocket) return

			if (!approved) {
				io.to(requesterSocketId).emit(SocketEvent.JOIN_REJECTED, {
					message: "Admin rejected your join request.",
				})
				return
			}

			await acceptUserIntoRoom({
				socket: requesterSocket,
				roomId: pendingJoinRequest.roomId,
				username: pendingJoinRequest.username,
				sessionId: pendingJoinRequest.sessionId,
				isAdmin: false,
			})
		},
	)

	socket.on("disconnecting", () => {
		removePendingJoinRequest(socket.id)

		const user = userSocketMap.find((u) => u.socketId === socket.id) || null
		if (user) {
			const roomId = user.roomId
			const activeScreenShare = roomScreenShareMap.get(roomId)
			if (activeScreenShare?.socketId === socket.id) {
				roomScreenShareMap.delete(roomId)
				socket.broadcast.to(roomId).emit(SocketEvent.SCREEN_SHARE_STOPPED, {
					sharerSocketId: socket.id,
				})
			}
			socket.broadcast
				.to(roomId)
				.emit(SocketEvent.USER_DISCONNECTED, { user })
			userSocketMap = userSocketMap.filter((u) => u.socketId !== socket.id)
			socket.leave(roomId)

			if (user.isAdmin) {
				const remainingUsers = getUsersInRoom(roomId)
				if (remainingUsers.length > 0) {
					const nextAdminSocketId = remainingUsers[0].socketId
					userSocketMap = userSocketMap.map((roomUser) =>
						roomUser.socketId === nextAdminSocketId
							? { ...roomUser, isAdmin: true }
							: roomUser,
					)
					roomAdminSocketMap.set(roomId, nextAdminSocketId)
					const nextAdminUser = getUserBySocketId(nextAdminSocketId)
					if (nextAdminUser) {
						const nextAdminSocket = io.sockets.sockets.get(nextAdminSocketId)
						const nextAdminSessionId =
							typeof nextAdminSocket?.data?.joinSessionId === "string"
								? nextAdminSocket.data.joinSessionId
								: ""
						rememberApprovedSession(roomId, nextAdminSessionId, {
							username: nextAdminUser.username,
							isAdmin: true,
						})
						io.to(roomId).emit(SocketEvent.USER_UPDATED, { user: nextAdminUser })
						getPendingJoinRequestsForRoom(roomId).forEach((request) => {
							emitPendingJoinRequestToAdmin(roomId, request)
						})
					}
				} else {
					roomAdminSocketMap.delete(roomId)
				}
			}

			if (getUsersInRoom(roomId).length === 0) {
				rejectPendingJoinRequestsForRoom(
					roomId,
					"Room was closed because the admin is no longer connected.",
				)
				stopProjectRunnerSession(roomId)
				void cleanupRunnerWorkspace(roomId)
				const latestRoomTree = roomFileTrees.get(roomId)
				if (latestRoomTree && latestRoomTree.type === "directory") {
					void saveRoomSnapshot(roomId, latestRoomTree).catch((error) => {
						console.error(`Failed to persist final snapshot for room ${roomId}:`, error)
					})
				}
				roomAdminSocketMap.delete(roomId)
				approvedRoomSessions.delete(roomId)
				roomScreenShareMap.delete(roomId)
				roomFileTrees.delete(roomId)
				roomTrackedPaths.delete(roomId)
				const timer = roomSyncTimers.get(roomId)
				if (timer) {
					clearTimeout(timer)
					roomSyncTimers.delete(roomId)
				}
				if (!isWorkspaceDiskSyncEnabled) {
					const roomWorkspacePath = path.join(
						workspaceRoot,
						sanitizeRoomId(roomId),
					)
					void fsPromises
						.rm(roomWorkspacePath, { recursive: true, force: true })
						.catch(() => {})
				}
			}
		}

		const pty = ptyProcess.get(socket.id)
		if (pty) {
			pty.kill()
			ptyProcess.delete(socket.id)
		}
	})

	// Handle file actions
	socket.on(
		SocketEvent.SYNC_FILE_STRUCTURE,
		({ fileStructure, openFiles, activeFile, socketId }) => {
			io.to(socketId).emit(SocketEvent.SYNC_FILE_STRUCTURE, {
				fileStructure,
				openFiles,
				activeFile,
			})
		}
	)

	socket.on(
		SocketEvent.WORKSPACE_SYNC,
		({ fileStructure }: { fileStructure: WorkspaceFileSystemItem }) => {
			const roomId = getRoomId(socket.id)
			if (!roomId) return
			roomFileTrees.set(roomId, fileStructure)
			scheduleWorkspaceSync(roomId)
		},
	)

	socket.on(
		SocketEvent.DIRECTORY_CREATED,
		({ parentDirId, newDirectory }) => {
			const roomId = getRoomId(socket.id)
			if (!roomId) return
			socket.broadcast.to(roomId).emit(SocketEvent.DIRECTORY_CREATED, {
				parentDirId,
				newDirectory,
			})
		}
	)

	socket.on(SocketEvent.DIRECTORY_UPDATED, ({ dirId, children }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.DIRECTORY_UPDATED, {
			dirId,
			children,
		})
	})

	socket.on(SocketEvent.DIRECTORY_RENAMED, ({ dirId, newName }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.DIRECTORY_RENAMED, {
			dirId,
			newName,
		})
	})

	socket.on(SocketEvent.DIRECTORY_DELETED, ({ dirId }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.DIRECTORY_DELETED, { dirId })
	})

	socket.on(SocketEvent.FILE_CREATED, ({ parentDirId, newFile }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.FILE_CREATED, { parentDirId, newFile })
	})

	socket.on(SocketEvent.FILE_UPDATED, ({ fileId, newContent }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.FILE_UPDATED, {
			fileId,
			newContent,
		})
	})

	socket.on(SocketEvent.FILE_RENAMED, ({ fileId, newName }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.FILE_RENAMED, {
			fileId,
			newName,
		})
	})

	socket.on(SocketEvent.FILE_DELETED, ({ fileId }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.FILE_DELETED, { fileId })
	})

	// Handle file opened event - update user's current file
	socket.on(SocketEvent.FILE_OPENED, ({ fileId }: { fileId?: string }) => {
		console.log('📂 SERVER: FILE_OPENED received', {
			socketId: socket.id,
			fileId,
		})
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socket.id) {
				const updated = {
					...user,
					currentFile: fileId || null,
				}
				console.log('✅ Updated user currentFile:', {
					username: updated.username,
					fileId: updated.currentFile,
				})
				return updated
			}
			return user
		})

		// Broadcast updated user state to all users in room so they know this user's current file
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		console.log('📡 Broadcasting updated user state to room', {
			roomId,
			username: user.username,
			currentFile: user.currentFile,
		})
		socket.broadcast.to(roomId).emit(SocketEvent.USER_UPDATED, { user })
	})

	// Handle user status
	socket.on(SocketEvent.USER_OFFLINE, ({ socketId }) => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socketId) {
				return { ...user, status: USER_CONNECTION_STATUS.OFFLINE }
			}
			return user
		})
		const roomId = getRoomId(socketId)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.USER_OFFLINE, { socketId })
	})

	socket.on(SocketEvent.USER_ONLINE, ({ socketId }) => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socketId) {
				return { ...user, status: USER_CONNECTION_STATUS.ONLINE }
			}
			return user
		})
		const roomId = getRoomId(socketId)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.USER_ONLINE, { socketId })
	})

	// Handle screen share actions
	socket.on(SocketEvent.SCREEN_SHARE_STATUS_REQUEST, () => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return

		const activeScreenShare = roomScreenShareMap.get(roomId)
		io.to(socket.id).emit(SocketEvent.SCREEN_SHARE_STATUS, {
			sharerSocketId: activeScreenShare?.socketId || null,
			sharerUsername: activeScreenShare?.username || null,
		})
	})

	socket.on(SocketEvent.SCREEN_SHARE_START, () => {
		const user = getUserBySocketId(socket.id)
		if (!user) return

		const roomId = user.roomId
		const previousShare = roomScreenShareMap.get(roomId)
		if (previousShare && previousShare.socketId !== socket.id) {
			io.to(previousShare.socketId).emit(SocketEvent.SCREEN_SHARE_STOPPED, {
				sharerSocketId: previousShare.socketId,
			})
		}

		roomScreenShareMap.set(roomId, {
			socketId: socket.id,
			username: user.username,
		})

		io.to(roomId).emit(SocketEvent.SCREEN_SHARE_STARTED, {
			sharerSocketId: socket.id,
			sharerUsername: user.username,
		})
	})

	socket.on(SocketEvent.SCREEN_SHARE_STOP, () => {
		const user = getUserBySocketId(socket.id)
		if (!user) return

		const roomId = user.roomId
		const activeScreenShare = roomScreenShareMap.get(roomId)
		if (activeScreenShare?.socketId !== socket.id) return

		roomScreenShareMap.delete(roomId)
		io.to(roomId).emit(SocketEvent.SCREEN_SHARE_STOPPED, {
			sharerSocketId: socket.id,
		})
	})

	socket.on(
		SocketEvent.SCREEN_SHARE_SIGNAL,
		({
			targetSocketId,
			payload,
		}: {
			targetSocketId?: string
			payload?: ScreenShareSignalEnvelope
		}) => {
			if (!targetSocketId || !payload) return

			const sourceUser = getUserBySocketId(socket.id)
			if (!sourceUser) return

			const targetUser = getUserBySocketId(targetSocketId)
			if (!targetUser || targetUser.roomId !== sourceUser.roomId) return

			io.to(targetSocketId).emit(SocketEvent.SCREEN_SHARE_SIGNAL, {
				fromSocketId: socket.id,
				fromUsername: sourceUser.username,
				payload,
			})
		},
	)

	// Handle chat actions
	socket.on(SocketEvent.SEND_MESSAGE, ({
		message,
		recipientSocketId,
	}: {
		message?: Partial<ChatMessagePayload>
		recipientSocketId?: string | null
	}) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		const sender = getUserBySocketId(socket.id)
		if (!sender) return

		const text = typeof message?.message === "string"
			? message.message.trim()
			: ""
		if (!text) return

		const outgoingMessage: ChatMessagePayload = {
			id:
				typeof message?.id === "string" && message.id.trim().length > 0
					? message.id
					: `${socket.id}-${Date.now()}`,
			message: text,
			username: sender.username,
			timestamp:
				typeof message?.timestamp === "string" &&
				message.timestamp.trim().length > 0
					? message.timestamp
					: new Date().toISOString(),
			isDirect: false,
			recipientSocketId: null,
			recipientUsername: null,
		}

		if (recipientSocketId && recipientSocketId !== socket.id) {
			const targetUser = getUserBySocketId(recipientSocketId)
			if (!targetUser || targetUser.roomId !== roomId) return

			io.to(targetUser.socketId).emit(SocketEvent.RECEIVE_MESSAGE, {
				message: {
					...outgoingMessage,
					isDirect: true,
					recipientSocketId: targetUser.socketId,
					recipientUsername: targetUser.username,
				},
			})
			return
		}

		socket.broadcast.to(roomId).emit(SocketEvent.RECEIVE_MESSAGE, {
			message: outgoingMessage,
		})
	})

	socket.on(
		SocketEvent.SEND_FILE_SHARE,
		({
			file,
			recipientSocketId,
		}: {
			file: IncomingSharedFile
			recipientSocketId?: string | null
		}) => {
			const sender = getUserBySocketId(socket.id)
			if (!sender) return

			const emitFileShareError = (message: string) => {
				io.to(socket.id).emit(SocketEvent.FILE_SHARE_ERROR, { message })
			}

			if (!file || typeof file !== "object") {
				emitFileShareError("Invalid file payload.")
				return
			}

			const fileName =
				typeof file.name === "string" ? file.name.trim() : ""
			if (!fileName) {
				emitFileShareError("File name is required.")
				return
			}
			if (fileName.length > maxFileShareNameLength) {
				emitFileShareError("File name is too long.")
				return
			}

			const dataUrl = typeof file.dataUrl === "string" ? file.dataUrl : ""
			if (!dataUrl) {
				emitFileShareError("File content is missing.")
				return
			}

			const parsedData = parseDataUrl(dataUrl)
			if (!parsedData) {
				emitFileShareError("Invalid file encoding. Please upload again.")
				return
			}

			if (
				parsedData.size <= 0 ||
				parsedData.size > maxFileShareSizeBytes
			) {
				emitFileShareError(
					`File is too large. Maximum allowed size is ${maxFileShareSizeMb}MB.`,
				)
				return
			}

			let targetSocketId: string | null = null
			if (recipientSocketId) {
				const targetUser = getUserBySocketId(recipientSocketId)
				if (!targetUser || targetUser.roomId !== sender.roomId) {
					emitFileShareError("Selected user is no longer in this room.")
					return
				}

				if (targetUser.socketId === socket.id) {
					emitFileShareError(
						"Choose another user or share with all users.",
					)
					return
				}

				targetSocketId = targetUser.socketId
			}

			const sharedFilePayload: SharedFilePayload = {
				id:
					typeof file.id === "string" && file.id.trim().length > 0
						? file.id
						: `${socket.id}-${Date.now()}`,
				name: fileName,
				mimeType:
					typeof file.mimeType === "string" && file.mimeType.trim()
						? file.mimeType.trim()
						: parsedData.mimeType,
				size: parsedData.size,
				dataUrl,
				senderUsername: sender.username,
				senderSocketId: sender.socketId,
				recipientSocketId: targetSocketId,
				roomId: sender.roomId,
				sentAt: new Date().toISOString(),
			}

			if (targetSocketId) {
				io.to(targetSocketId).emit(SocketEvent.RECEIVE_FILE_SHARE, {
					file: sharedFilePayload,
				})
				return
			}

			socket.broadcast
				.to(sender.roomId)
				.emit(SocketEvent.RECEIVE_FILE_SHARE, { file: sharedFilePayload })
		},
	)

		// Handle cursor movement
		// ================= CURSOR MOVE (FIXED) =================
	socket.on(
	SocketEvent.CURSOR_MOVE,
	({ cursorPosition, selectionStart, selectionEnd, fileId }) => {

		// Update user state
		userSocketMap = userSocketMap.map((user) => {
		if (user.socketId === socket.id) {
			return {
			...user,
			cursorPosition,
			selectionStart,
			selectionEnd,
			currentFile: fileId ?? user.currentFile,
			}
		}
		return user
		})

		const user = getUserBySocketId(socket.id)
		if (!user) return

		const roomId = user.roomId

		// Broadcast cursor to others in the SAME ROOM
		socket.broadcast.to(roomId).emit(SocketEvent.CURSOR_MOVE, {
		user: {
			socketId: user.socketId,
			username: user.username,
			cursorPosition: user.cursorPosition,
			selectionStart: user.selectionStart,
			selectionEnd: user.selectionEnd,
			currentFile: user.currentFile,
		},
		})
	}
	)


	socket.on(SocketEvent.TYPING_START, ({ fileId, cursorPosition, selectionStart, selectionEnd }) => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socket.id) {
				return {
					...user,
					typing: true,
					currentFile: fileId || null,
					cursorPosition: cursorPosition ?? user.cursorPosition,
					selectionStart: selectionStart ?? user.selectionStart,
					selectionEnd: selectionEnd ?? user.selectionEnd,
				}
			}
			return user
		})
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		socket.broadcast.to(roomId).emit(SocketEvent.TYPING_START, { user })
	})

	socket.on(SocketEvent.TYPING_PAUSE, () => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socket.id) {
				return { ...user, typing: false }
			}
			return user
		})
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		socket.broadcast.to(roomId).emit(SocketEvent.TYPING_PAUSE, { user })
	})


		socket.on(SocketEvent.REQUEST_DRAWING, () => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return

		// Ask other users in the room to send their snapshot
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.REQUEST_DRAWING, { socketId: socket.id })
	})

	socket.on(SocketEvent.SYNC_DRAWING, ({ snapshot, drawingData, socketId }) => {
		if (!socketId) return
		const normalizedDrawingData = drawingData ?? snapshot ?? null
		// Keep both keys for backward compatibility between deployed clients.
		socket.to(socketId).emit(SocketEvent.SYNC_DRAWING, {
			drawingData: normalizedDrawingData,
			snapshot: normalizedDrawingData,
		})
	})

	socket.on(SocketEvent.DRAWING_UPDATE, ({ diff }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return

		// Broadcast real-time drawing updates (DIFF)
		socket.broadcast.to(roomId).emit(SocketEvent.DRAWING_UPDATE, {
			diff,
		})
	})


	socket.on(SocketEvent.TERMINAL_EXECUTE, ({ input }) => {
		const ptyInstance = ensurePtyForSocket(socket)
		ptyInstance.write(input)
	})

	socket.on(SocketEvent.TERMINAL_RESIZE, ({ cols, rows }) => {
		if (typeof cols !== "number" || typeof rows !== "number") return
		if (cols < 2 || rows < 1) return
		const ptyInstance = ensurePtyForSocket(socket)
		ptyInstance.resize(Math.floor(cols), Math.floor(rows))
	})

	socket.on(SocketEvent.TERMINAL_RESET, () => {
		const roomId = getRoomId(socket.id)
		const terminalCwd = roomId
			? getRoomWorkspacePath(roomId)
			: process.env.INIT_CWD || process.cwd()
		resetPtyForSocket(socket, terminalCwd)
		socket.emit(SocketEvent.TERMINAL_OUTPUT, { data: "Session cleared.\r\n" })
	})
})

const PORT = process.env.PORT || 3000

// Copilot API proxy endpoint
app.post("/api/copilot/generate", async (req: Request, res: Response) => {
	try {
		loadServerEnv()

		const {
			prompt,
			messages,
			model,
			systemPrompt,
		} = req.body as {
			prompt?: string
			messages?: Array<{ role?: string; content?: string }>
			model?: string
			systemPrompt?: string
		}

		const userPromptFromMessages = Array.isArray(messages)
			? messages
					.map((m) => `${m.role || "user"}: ${m.content || ""}`.trim())
					.filter(Boolean)
					.join("\n")
			: ""
		const userPrompt = (prompt || userPromptFromMessages || "").trim()
		if (!userPrompt) {
			return res.status(400).json({ error: "Prompt is required" })
		}

		const apiFreeLlmKey = (
			process.env.APIFREELLM_API_KEY ||
			process.env.VITE_APIFREELLM_API_KEY ||
			""
		).trim()
		if (!apiFreeLlmKey) {
			console.error("API Free LLM key not configured")
			return res.status(400).json({
				error: "APIFREELLM_API_KEY is not configured in server/.env",
			})
		}

		const selectedModel =
			typeof model === "string" && model.trim().length > 0
				? model.trim()
				: "apifreellm"
		const baseSystemPrompt =
			typeof systemPrompt === "string" && systemPrompt.trim().length > 0
				? systemPrompt.trim()
				: "You are a coding copilot for the Code Coalition project. Return only Markdown code blocks with no explanation outside the code block."
		const finalMessage = `${baseSystemPrompt}\n\nUser request:\n${userPrompt}`

		const response = await fetch("https://apifreellm.com/api/v1/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiFreeLlmKey}`,
			},
			body: JSON.stringify({
				message: finalMessage,
				model: selectedModel,
			}),
		})

		const data = await response.json()
		if (!response.ok) {
			console.error("API Free LLM error:", response.status, data)
			return res.status(response.status).json({
				error:
					data?.error ||
					data?.message ||
					"API Free LLM request failed",
			})
		}

		const text =
			typeof data?.response === "string"
				? data.response.trim()
				: typeof data?.text === "string"
					? data.text.trim()
					: ""
		if (!text) {
			console.error("API Free LLM returned empty response:", data)
			return res
				.status(502)
				.json({ error: "API Free LLM returned an empty response" })
		}

		return res.json({
			text,
			model: selectedModel,
			tier: data?.tier,
			features: data?.features,
		})
	} catch (error) {
		console.error("Copilot API error:", error)
		res.status(500).json({ error: `Failed to generate code: ${(error as Error).message}` })
	}
})

app.get("/api/piston/runtimes", async (_req: Request, res: Response) => {
	try {
		loadServerEnv()
		const pistonApiBaseUrl = getPistonApiBaseUrl()
		if (!pistonApiBaseUrl) {
			return res.json(localFallbackRuntimes)
		}

		const upstreamResponse = await fetch(`${pistonApiBaseUrl}/runtimes`, {
			method: "GET",
			headers: {
				...getPistonAuthHeaders(),
			},
		})
		const data = await upstreamResponse.json().catch(() => null)

		if (!upstreamResponse.ok) {
			const upstreamErrorMessage =
				(typeof data?.message === "string" && data.message) ||
				(typeof data?.error === "string" && data.error) ||
				`Failed to fetch Piston runtimes (${upstreamResponse.status}).`
			console.warn("Piston runtimes unavailable, using local fallbacks:", upstreamErrorMessage)
			return res.json(localFallbackRuntimes)
		}

		return res.json(data)
	} catch (error) {
		console.warn("Piston runtimes proxy error, using local fallbacks:", error)
		return res.json(localFallbackRuntimes)
	}
})

app.post("/api/piston/execute", async (req: Request, res: Response) => {
	const executeBody = (req.body || {}) as PistonExecuteBody
	let upstreamErrorMessage = ""

	loadServerEnv()
	const pistonApiBaseUrl = getPistonApiBaseUrl()

	if (pistonApiBaseUrl) {
		try {
		const upstreamResponse = await fetch(`${pistonApiBaseUrl}/execute`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...getPistonAuthHeaders(),
			},
			body: JSON.stringify(executeBody),
		})
		const data = await upstreamResponse.json().catch(() => null)

		if (!upstreamResponse.ok) {
			upstreamErrorMessage =
				(typeof data?.message === "string" && data.message) ||
				(typeof data?.error === "string" && data.error) ||
				`Failed to execute code on Piston API (${upstreamResponse.status}).`
		} else {
			return res.json(data)
		}
		} catch (error) {
			upstreamErrorMessage = `Piston execute proxy error: ${(error as Error).message}`
		}
	}

	const localExecution = await executeWithLocalRuntime(executeBody)
	if (localExecution.success) {
		return res.json(localExecution.response)
	}

	const fallbackError = localExecution.error
	if (upstreamErrorMessage) {
		return res.status(502).json({
			error: `${upstreamErrorMessage} Local fallback failed: ${fallbackError}`,
		})
	}

	return res.status(400).json({ error: fallbackError })
})

app.post("/api/runner/start", async (req: Request, res: Response) => {
	try {
		const roomId =
			typeof req.body?.roomId === "string" ? req.body.roomId.trim() : ""
		if (!roomId) {
			return res.status(400).json({ error: "roomId is required." })
		}
		// Always stop any previous run first so a failed start does not keep stale apps alive.
		stopProjectRunnerSession(roomId)

		const incomingFileStructure = req.body?.fileStructure
		if (!isWorkspaceDirectory(incomingFileStructure)) {
			return res.status(400).json({
				error: "fileStructure is required and must be a directory payload.",
			})
		}
		roomFileTrees.set(roomId, incomingFileStructure)
		const preferredProjectPath =
			typeof req.body?.preferredProjectPath === "string"
				? req.body.preferredProjectPath.trim()
				: ""

		const pendingSyncTimer = roomSyncTimers.get(roomId)
		if (pendingSyncTimer) {
			clearTimeout(pendingSyncTimer)
			roomSyncTimers.delete(roomId)
		}

		const latestRoomTree = roomFileTrees.get(roomId)
		if (!latestRoomTree || latestRoomTree.type !== "directory") {
			return res.status(409).json({
				error: "Workspace is not synced yet. Save files or wait a second, then press Run again.",
			})
		}

		await synchronizeWorkspaceToDisk(roomId)
		const roomWorkspacePath = getRoomWorkspacePath(roomId)

		const runnerResult = await startProjectRunnerSession({
			roomId,
			workspacePath: roomWorkspacePath,
			preferredProjectPath,
		})
		const previewProxyUrl = `${getServerPublicBaseUrl(req)}/preview/${encodeURIComponent(
			roomId,
		)}/`
		const previewUrl = getDirectPreviewUrl(req, runnerResult.port)

		return res.json({
			...runnerResult,
			previewUrl,
			previewProxyUrl,
		})
	} catch (error) {
		return res.status(400).json({
			error: `Failed to start project runner: ${(error as Error).message}`,
		})
	}
})

app.post("/api/runner/stop", async (req: Request, res: Response) => {
	const roomId =
		typeof req.body?.roomId === "string" ? req.body.roomId.trim() : ""
	if (!roomId) {
		return res.status(400).json({ error: "roomId is required." })
	}

	stopProjectRunnerSession(roomId)
	return res.json({ stopped: true, roomId })
})

app.get("/api/runner/status/:roomId", (req: Request, res: Response) => {
	const roomId = String(req.params.roomId || "").trim()
	if (!roomId) {
		return res.status(400).json({ error: "roomId is required." })
	}

	const status = getProjectRunnerStatus(roomId)
	if (!status) {
		return res.json({ roomId, state: "idle" })
	}

	const previewUrl = `${getServerPublicBaseUrl(req)}/preview/${encodeURIComponent(
		roomId,
	)}/`
	const previewProxyUrl = previewUrl

	return res.json({
		...status,
		previewUrl: getDirectPreviewUrl(req, status.port),
		previewProxyUrl,
	})
})

app.get("/api/runner/logs/:roomId", (req: Request, res: Response) => {
	const roomId = String(req.params.roomId || "").trim()
	const requestedLimit = Number(req.query.limit || "200")
	const limit =
		Number.isFinite(requestedLimit) && requestedLimit > 0
			? Math.floor(requestedLimit)
			: 200

	if (!roomId) {
		return res.status(400).json({ error: "roomId is required." })
	}

	return res.json({
		roomId,
		logs: getProjectRunnerLogs(roomId, limit),
	})
})

app.get("/api/oauth/:provider/start", (req: Request, res: Response) => {
	const providerParam = String(req.params.provider || "").toLowerCase()
	const provider: OAuthProvider | null =
		providerParam === "github"
			? "github"
			: providerParam === "gdrive"
				? "gdrive"
				: null

	if (!provider) {
		return res.status(400).json({ error: "Unsupported OAuth provider." })
	}

	const origin = normalizeOrigin(typeof req.query.origin === "string" ? req.query.origin : "")
	if (!origin) {
		return res.status(400).json({ error: "A valid origin is required." })
	}

	const state = createOAuthState(provider, origin)
	const redirectUri = buildOAuthRedirectUri(req, provider)

	if (provider === "github") {
		const clientId = (process.env.GITHUB_CLIENT_ID || "").trim()
		if (!clientId) {
			return res.status(400).json({
				error: "GITHUB_CLIENT_ID is not configured on the server.",
			})
		}

		const authorizeUrl = new URL("https://github.com/login/oauth/authorize")
		authorizeUrl.searchParams.set("client_id", clientId)
		authorizeUrl.searchParams.set("redirect_uri", redirectUri)
		authorizeUrl.searchParams.set("scope", githubScope)
		authorizeUrl.searchParams.set("state", state)

		return res.json({
			provider,
			authorizeUrl: authorizeUrl.toString(),
		})
	}

	const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim()
	if (!clientId) {
		return res.status(400).json({
			error: "GOOGLE_CLIENT_ID is not configured on the server.",
		})
	}

	const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth")
	authorizeUrl.searchParams.set("client_id", clientId)
	authorizeUrl.searchParams.set("redirect_uri", redirectUri)
	authorizeUrl.searchParams.set("response_type", "code")
	authorizeUrl.searchParams.set("scope", googleDriveScope)
	authorizeUrl.searchParams.set("access_type", "online")
	authorizeUrl.searchParams.set("include_granted_scopes", "true")
	authorizeUrl.searchParams.set("prompt", "consent")
	authorizeUrl.searchParams.set("state", state)

	return res.json({
		provider,
		authorizeUrl: authorizeUrl.toString(),
	})
})

app.get("/api/oauth/github/callback", async (req: Request, res: Response) => {
	try {
		const code = typeof req.query.code === "string" ? req.query.code : ""
		const state = typeof req.query.state === "string" ? req.query.state : ""
		const oauthError = typeof req.query.error === "string" ? req.query.error : ""

		const stateRecord = consumeOAuthState(state, "github")
		const origin = stateRecord?.origin || "*"
		if (!stateRecord) {
			return res
				.status(400)
				.send(
					getOAuthCallbackHtml({
						success: false,
						provider: "github",
						origin,
						errorMessage: "Invalid or expired OAuth state.",
					}),
				)
		}

		if (oauthError) {
			return res
				.status(400)
				.send(
					getOAuthCallbackHtml({
						success: false,
						provider: "github",
						origin,
						errorMessage: oauthError,
					}),
				)
		}

		if (!code) {
			return res
				.status(400)
				.send(
					getOAuthCallbackHtml({
						success: false,
						provider: "github",
						origin,
						errorMessage: "Missing authorization code.",
					}),
				)
		}

		const clientId = (process.env.GITHUB_CLIENT_ID || "").trim()
		const clientSecret = (process.env.GITHUB_CLIENT_SECRET || "").trim()
		if (!clientId || !clientSecret) {
			return res
				.status(400)
				.send(
					getOAuthCallbackHtml({
						success: false,
						provider: "github",
						origin,
						errorMessage: "GitHub OAuth is not configured on the server.",
					}),
				)
		}

		const redirectUri = buildOAuthRedirectUri(req, "github")
		const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				redirect_uri: redirectUri,
			}),
		})

		const tokenPayload = await tokenResponse.json().catch(() => null)
		const accessToken =
			typeof tokenPayload?.access_token === "string"
				? tokenPayload.access_token
				: ""
		if (!tokenResponse.ok || !accessToken) {
			const errorMessage =
				typeof tokenPayload?.error_description === "string"
					? tokenPayload.error_description
					: "Failed to exchange GitHub OAuth code."
			return res
				.status(400)
				.send(
					getOAuthCallbackHtml({
						success: false,
						provider: "github",
						origin,
						errorMessage,
					}),
				)
		}

		return res.send(
			getOAuthCallbackHtml({
				success: true,
				provider: "github",
				origin,
				accessToken,
			}),
		)
	} catch (error) {
		console.error("GitHub OAuth callback error:", error)
		return res
			.status(500)
			.send(
				getOAuthCallbackHtml({
					success: false,
					provider: "github",
					origin: "*",
					errorMessage: "GitHub OAuth callback failed.",
				}),
			)
	}
})

app.get("/api/oauth/gdrive/callback", async (req: Request, res: Response) => {
	try {
		const code = typeof req.query.code === "string" ? req.query.code : ""
		const state = typeof req.query.state === "string" ? req.query.state : ""
		const oauthError = typeof req.query.error === "string" ? req.query.error : ""

		const stateRecord = consumeOAuthState(state, "gdrive")
		const origin = stateRecord?.origin || "*"
		if (!stateRecord) {
			return res
				.status(400)
				.send(
					getOAuthCallbackHtml({
						success: false,
						provider: "gdrive",
						origin,
						errorMessage: "Invalid or expired OAuth state.",
					}),
				)
		}

		if (oauthError) {
			return res
				.status(400)
				.send(
					getOAuthCallbackHtml({
						success: false,
						provider: "gdrive",
						origin,
						errorMessage: oauthError,
					}),
				)
		}

		if (!code) {
			return res
				.status(400)
				.send(
					getOAuthCallbackHtml({
						success: false,
						provider: "gdrive",
						origin,
						errorMessage: "Missing authorization code.",
					}),
				)
		}

		const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim()
		const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || "").trim()
		if (!clientId || !clientSecret) {
			return res
				.status(400)
				.send(
					getOAuthCallbackHtml({
						success: false,
						provider: "gdrive",
						origin,
						errorMessage: "Google OAuth is not configured on the server.",
					}),
				)
		}

		const redirectUri = buildOAuthRedirectUri(req, "gdrive")
		const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				redirect_uri: redirectUri,
				grant_type: "authorization_code",
			}).toString(),
		})

		const tokenPayload = await tokenResponse.json().catch(() => null)
		const accessToken =
			typeof tokenPayload?.access_token === "string"
				? tokenPayload.access_token
				: ""
		if (!tokenResponse.ok || !accessToken) {
			const errorMessage =
				typeof tokenPayload?.error_description === "string"
					? tokenPayload.error_description
					: typeof tokenPayload?.error === "string"
						? tokenPayload.error
						: "Failed to exchange Google OAuth code."

			return res
				.status(400)
				.send(
					getOAuthCallbackHtml({
						success: false,
						provider: "gdrive",
						origin,
						errorMessage,
					}),
				)
		}

		return res.send(
			getOAuthCallbackHtml({
				success: true,
				provider: "gdrive",
				origin,
				accessToken,
			}),
		)
	} catch (error) {
		console.error("Google OAuth callback error:", error)
		return res
			.status(500)
			.send(
				getOAuthCallbackHtml({
					success: false,
					provider: "gdrive",
					origin: "*",
					errorMessage: "Google OAuth callback failed.",
				}),
			)
	}
})

app.post("/api/import/external", async (req: Request, res: Response) => {
	try {
		const urlValue =
			typeof req.body?.url === "string" ? req.body.url.trim() : ""
		const driveAccessToken =
			typeof req.body?.driveAccessToken === "string"
				? req.body.driveAccessToken.trim()
				: ""
		const githubAccessToken =
			typeof req.body?.githubAccessToken === "string"
				? req.body.githubAccessToken.trim()
				: ""

		if (!urlValue) {
			return res.status(400).json({ error: "URL is required." })
		}

		let parsedUrl: URL
		try {
			parsedUrl = new URL(urlValue)
		} catch {
			return res.status(400).json({ error: "Invalid URL." })
		}

		if (!["http:", "https:"].includes(parsedUrl.protocol)) {
			return res.status(400).json({ error: "Only HTTP/HTTPS URLs are supported." })
		}

		const host = parsedUrl.hostname.toLowerCase()
		let provider: ExternalImportProvider
		let downloadUrl = urlValue
		let fileNameFallback = ""
		let driveFileId = ""
		let driveResourceKey = ""
		let driveLinkKind: DriveLinkKind = "unknown"

		if (host === "github.com" || host === "raw.githubusercontent.com") {
			provider = "github"
			const githubRawUrl = getGithubRawUrl(parsedUrl)
			if (!githubRawUrl) {
				return res.status(400).json({
					error: "Provide a direct GitHub file URL (raw URL or blob URL).",
				})
			}
			downloadUrl = githubRawUrl
			fileNameFallback = getFileNameFromPath(new URL(githubRawUrl).pathname)
		} else if (
			host.endsWith("drive.google.com") ||
			host === "docs.google.com" ||
			host === "drive.usercontent.google.com"
		) {
			provider = "gdrive"
			const driveLinkInfo = extractDriveLinkInfo(parsedUrl, urlValue)
			if (!driveLinkInfo) {
				return res.status(400).json({
					error: "Unable to read Google Drive file ID from URL.",
				})
			}
			driveFileId = driveLinkInfo.fileId
			driveResourceKey = driveLinkInfo.resourceKey
			driveLinkKind = driveLinkInfo.kind
			downloadUrl = buildDriveDownloadUrl(driveLinkInfo)
			fileNameFallback = getDriveFileNameFallback(driveFileId, driveLinkKind)
		} else {
			const wrappedUrl = tryGetDirectAssetUrlFromPageUrl(urlValue)
			if (wrappedUrl) {
				try {
					const wrappedParsedUrl = new URL(wrappedUrl)
					const wrappedHost = wrappedParsedUrl.hostname.toLowerCase()

					if (
						wrappedHost === "github.com" ||
						wrappedHost === "raw.githubusercontent.com"
					) {
						const githubRawUrl = getGithubRawUrl(wrappedParsedUrl)
						if (githubRawUrl) {
							provider = "github"
							downloadUrl = githubRawUrl
							fileNameFallback = getFileNameFromPath(new URL(githubRawUrl).pathname)
						} else {
							provider = "direct"
							downloadUrl = wrappedUrl
							fileNameFallback = getFileNameFromPath(wrappedParsedUrl.pathname)
						}
					} else if (
						wrappedHost.endsWith("drive.google.com") ||
						wrappedHost === "docs.google.com" ||
						wrappedHost === "drive.usercontent.google.com"
					) {
						const driveLinkInfo = extractDriveLinkInfo(wrappedParsedUrl, wrappedUrl)
						if (driveLinkInfo) {
							provider = "gdrive"
							driveFileId = driveLinkInfo.fileId
							driveResourceKey = driveLinkInfo.resourceKey
							driveLinkKind = driveLinkInfo.kind
							downloadUrl = buildDriveDownloadUrl(driveLinkInfo)
							fileNameFallback = getDriveFileNameFallback(driveFileId, driveLinkKind)
						} else {
							provider = "direct"
							downloadUrl = wrappedUrl
							fileNameFallback = getFileNameFromPath(wrappedParsedUrl.pathname)
						}
					} else {
						provider = "direct"
						downloadUrl = wrappedUrl
						fileNameFallback = getFileNameFromPath(wrappedParsedUrl.pathname)
					}
				} catch {
					provider = "direct"
					fileNameFallback = getFileNameFromPath(parsedUrl.pathname)
				}
			} else {
				provider = "direct"
				fileNameFallback = getFileNameFromPath(parsedUrl.pathname)
			}
		}

		if (provider === "gdrive" && driveFileId && driveAccessToken) {
			const driveApiDownload = await tryDownloadDriveFileWithAccessToken({
				fileId: driveFileId,
				accessToken: driveAccessToken,
			})
			if (driveApiDownload) {
				const { buffer, mimeType, fileName } = driveApiDownload
				if (buffer.length > maxExternalImportSizeBytes) {
					return res.status(413).json({
						error: `File is too large. Maximum allowed size is ${maxExternalImportSizeMb}MB.`,
					})
				}

				const resolvedFileName = sanitizeImportedFileName(
					fileName || fileNameFallback || `imported-file-${Date.now()}`,
				)
				const isLikelyText = isLikelyTextFile(mimeType, buffer)
				return res.json({
					provider,
					fileName: resolvedFileName,
					mimeType,
					size: buffer.length,
					isLikelyText,
					textContent: isLikelyText ? buffer.toString("utf8") : "",
					base64Content: isLikelyText ? null : buffer.toString("base64"),
				})
			}
		}

		const requestHeaders: Record<string, string> = {
			"User-Agent": "CodeCoalitionExternalImporter/1.0",
			Accept: "*/*",
		}
		const githubToken =
			githubAccessToken || (process.env.GITHUB_TOKEN || "").trim()
		if (provider === "github" && githubToken) {
			requestHeaders.Authorization = `Bearer ${githubToken}`
		}
		if (provider === "gdrive" && driveAccessToken) {
			requestHeaders.Authorization = `Bearer ${driveAccessToken}`
		}

		let downloadResponse = await fetch(downloadUrl, {
			method: "GET",
			headers: requestHeaders,
			redirect: "follow",
		})

		if (!downloadResponse.ok) {
			return res.status(downloadResponse.status).json({
				error: `Failed to fetch external file (${downloadResponse.status}).`,
			})
		}

		let buffer = Buffer.from(await downloadResponse.arrayBuffer())
		if (provider === "gdrive" && driveFileId && driveLinkKind === "file") {
			const initialMimeType =
				(downloadResponse.headers.get("content-type") || "application/octet-stream")
					.split(";")[0]
					.trim()
					.toLowerCase()
			if (initialMimeType === "text/html") {
				const htmlBody = buffer.toString("utf8")
				const followUpCandidates: string[] = []
				const followUpFromHtml = extractGoogleDriveFollowUpUrl({
					html: htmlBody,
					baseUrl: downloadResponse.url || downloadUrl,
					fileId: driveFileId,
					resourceKey: driveResourceKey,
				})
				if (followUpFromHtml) {
					followUpCandidates.push(followUpFromHtml)
				}

				const confirmToken = extractGoogleDriveConfirmToken(htmlBody)
				if (confirmToken) {
					followUpCandidates.push(
						`https://drive.google.com/uc?export=download&confirm=${encodeURIComponent(
							confirmToken,
						)}&id=${encodeURIComponent(driveFileId)}${
							driveResourceKey
								? `&resourcekey=${encodeURIComponent(driveResourceKey)}`
								: ""
						}`,
					)
				}

				const seenCandidateUrls = new Set<string>()
				for (const candidateUrlRaw of followUpCandidates) {
					const candidateUrl = candidateUrlRaw.trim()
					if (!candidateUrl || seenCandidateUrls.has(candidateUrl)) {
						continue
					}
					seenCandidateUrls.add(candidateUrl)

					const candidateResponse = await fetch(candidateUrl, {
						method: "GET",
						headers: requestHeaders,
						redirect: "follow",
					})
					if (!candidateResponse.ok) {
						continue
					}

					const candidateBuffer = Buffer.from(await candidateResponse.arrayBuffer())
					if (candidateBuffer.length === 0) {
						continue
					}

					downloadResponse = candidateResponse
					buffer = candidateBuffer
					const candidateMimeType =
						(candidateResponse.headers.get("content-type") || "application/octet-stream")
							.split(";")[0]
							.trim()
							.toLowerCase()
					if (candidateMimeType !== "text/html") {
						break
					}
				}
			}
		}

		if (provider === "gdrive" && driveFileId) {
			const currentUrl = downloadResponse.url || downloadUrl
			const triedUrls = new Set<string>([downloadUrl, currentUrl])
			const fallbackUrls = buildDriveAnonymousFallbackUrls({
				fileId: driveFileId,
				resourceKey: driveResourceKey,
			})

			for (const fallbackUrl of fallbackUrls) {
				const trimmedFallbackUrl = fallbackUrl.trim()
				if (!trimmedFallbackUrl || triedUrls.has(trimmedFallbackUrl)) {
					continue
				}
				triedUrls.add(trimmedFallbackUrl)

				const fallbackResponse = await fetch(trimmedFallbackUrl, {
					method: "GET",
					headers: requestHeaders,
					redirect: "follow",
				})
				if (!fallbackResponse.ok) {
					continue
				}

				const fallbackBuffer = Buffer.from(await fallbackResponse.arrayBuffer())
				if (fallbackBuffer.length === 0) {
					continue
				}

				downloadResponse = fallbackResponse
				buffer = fallbackBuffer
				break
			}
		}

		if (buffer.length === 0) {
			return res.status(400).json({ error: "Downloaded file is empty." })
		}

		const contentTypeHeader =
			downloadResponse.headers.get("content-type") || "application/octet-stream"
		let mimeType = contentTypeHeader.split(";")[0].trim() || "application/octet-stream"
		let finalDownloadUrl = downloadResponse.url || downloadUrl

		const fileNameFromHeader = parseFileNameFromContentDisposition(
			downloadResponse.headers.get("content-disposition"),
		)
		let fileNameCandidate =
			fileNameFromHeader || fileNameFallback || `imported-file-${Date.now()}`

		// Some providers return a "view page" URL where the direct file URL is present
		// in query params (for example imgurl/mediaurl). Try that first.
		if (mimeType.toLowerCase() === "text/html") {
			const directAssetUrl = tryGetDirectAssetUrlFromPageUrl(finalDownloadUrl)
			if (directAssetUrl) {
				const assetResponse = await fetch(directAssetUrl, {
					method: "GET",
					headers: requestHeaders,
					redirect: "follow",
				})
				if (assetResponse.ok) {
					const assetBuffer = Buffer.from(await assetResponse.arrayBuffer())
					const assetMimeType =
						(assetResponse.headers.get("content-type") || "application/octet-stream")
							.split(";")[0]
							.trim() || "application/octet-stream"
					if (assetBuffer.length > 0 && assetMimeType.toLowerCase() !== "text/html") {
						downloadResponse = assetResponse
						buffer = assetBuffer
						mimeType = assetMimeType
						finalDownloadUrl = assetResponse.url || directAssetUrl
						const assetFileName = getFileNameFromPath(
							new URL(finalDownloadUrl).pathname,
						)
						if (assetFileName) {
							fileNameCandidate = assetFileName
						}
					}
				}
			}
		}

		if (buffer.length > maxExternalImportSizeBytes) {
			return res.status(413).json({
				error: `File is too large. Maximum allowed size is ${maxExternalImportSizeMb}MB.`,
			})
		}

		const authPageDetected = isHtmlAuthPageResponse({
			provider,
			mimeType,
			buffer,
			finalUrl: finalDownloadUrl,
		})
		if (mimeType.toLowerCase() === "text/html") {
			const htmlSnapshot = buildHtmlSnapshotText({
				html: buffer.toString("utf8"),
				sourceUrl: finalDownloadUrl,
				fileNameHint: fileNameCandidate,
				authPageDetected,
			})
			buffer = htmlSnapshot.buffer
			mimeType = htmlSnapshot.mimeType
			fileNameCandidate = htmlSnapshot.fileName
		}

		const resolvedFileName = sanitizeImportedFileName(fileNameCandidate)
		const isLikelyText = isLikelyTextFile(mimeType, buffer)

		return res.json({
			provider,
			fileName: resolvedFileName,
			mimeType,
			size: buffer.length,
			isLikelyText,
			textContent: isLikelyText ? buffer.toString("utf8") : "",
			base64Content: isLikelyText ? null : buffer.toString("base64"),
		})
	} catch (error) {
		console.error("External import error:", error)
		return res.status(500).json({
			error: `Failed to import external file: ${(error as Error).message}`,
		})
	}
})

app.use("/preview/:roomId", (req: Request, res: Response) => {
	const roomId = String(req.params.roomId || "").trim()
	if (!roomId) {
		return res.status(400).json({ error: "roomId is required." })
	}

	const target = resolvePreviewTarget(roomId)
	if (!target) {
		return res.status(404).json({
			error: "No running app found for this room. Press Run first.",
		})
	}

	proxyPreviewRequest(req, res, roomId, target.port)
})

app.get("/", (req: Request, res: Response) => {
	// Send the index.html file
	res.sendFile(path.join(__dirname, "..", "public", "index.html"))
})

server.on("upgrade", (req, socket, head) => {
	const handled = proxyPreviewUpgrade(req, socket, head)
	if (handled) {
		return
	}
})

server.listen(PORT, () => {
	console.log(`Listening on port ${PORT}`)
})
