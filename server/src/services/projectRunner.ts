import fs from "fs"
import fsPromises from "fs/promises"
import os from "os"
import path from "path"
import net from "net"
import { ChildProcess, spawn } from "child_process"

type RunnerStack = "node" | "python" | "java"
type RunnerState = "starting" | "running" | "failed" | "stopped"

interface CommandSpec {
	commandCandidates: string[]
	args: string[]
	env?: Record<string, string>
}

interface RunnerTarget {
	stack: RunnerStack
	cwd: string
	installSteps: CommandSpec[]
	startStep: CommandSpec
}

interface CommandResult {
	command: string
	stdout: string
	stderr: string
	code: number | null
	signal: NodeJS.Signals | null
	spawnErrorCode?: string
}

interface RunnerSession {
	roomId: string
	stack: RunnerStack
	state: RunnerState
	cwd: string
	port: number
	startedAt: number
	updatedAt: number
	process: ChildProcess | null
	command: string
	logs: string[]
	lastError: string
}

interface RunnerStatus {
	roomId: string
	stack: RunnerStack
	state: RunnerState
	cwd: string
	port: number
	startedAt: number
	updatedAt: number
	command: string
	lastError: string
}

interface StartRunnerResult {
	roomId: string
	stack: RunnerStack
	port: number
	cwd: string
	startedAt: number
	command: string
	installLogs: string
	startupLogs: string
}

const runnerSessions = new Map<string, RunnerSession>()
const previewPortMin = Number(process.env.RUNNER_PORT_MIN || "4100")
const previewPortMax = Number(process.env.RUNNER_PORT_MAX || "4999")
const installTimeoutMs = Number(process.env.RUNNER_INSTALL_TIMEOUT_MS || "300000")
const startupTimeoutMs = Number(process.env.RUNNER_STARTUP_TIMEOUT_MS || "45000")
const fallbackPortProbeTimeoutMs = Number(process.env.RUNNER_FALLBACK_PORT_TIMEOUT_MS || "15000")
const runnerAlwaysInstall =
	(process.env.RUNNER_ALWAYS_INSTALL || "").trim().toLowerCase() === "true"
const maxLogLines = 1000
const maxWorkspaceScanDepth = Number(process.env.RUNNER_SCAN_DEPTH || "4")
const frontendDirectoryNames = new Set(["client", "frontend", "web", "ui"])
const backendDirectoryNames = new Set(["server", "backend", "api"])
const commonRuntimePorts = [
	3000,
	3001,
	3002,
	4173,
	4200,
	5000,
	5001,
	5173,
	5174,
	8000,
	8080,
	8081,
	8888,
	9000,
]
const ignoredDirectoryNames = new Set([
	".git",
	".idea",
	".vscode",
	".next",
	".nuxt",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	"__pycache__",
	".venv",
	"venv",
])

function appendLogs(session: RunnerSession, chunk: string) {
	const normalizedLines = chunk
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)

	if (!normalizedLines.length) return
	session.logs.push(...normalizedLines)
	if (session.logs.length > maxLogLines) {
		session.logs.splice(0, session.logs.length - maxLogLines)
	}
	session.updatedAt = Date.now()
}

function commandDisplay(command: string, args: string[]): string {
	return [command, ...args].join(" ").trim()
}

function uniqueValidPorts(ports: number[]): number[] {
	const unique = new Set<number>()
	ports.forEach((port) => {
		if (!Number.isInteger(port)) return
		if (port < 1 || port > 65535) return
		unique.add(port)
	})
	return [...unique]
}

function extractPortsFromLogs(logText: string): number[] {
	if (!logText) return []
	const detectedPorts: number[] = []
	const urlRegex = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/gi
	const explicitPortRegex = /\bport(?:\(s\))?\s*[:=]?\s*(\d{2,5})\b/gi

	let match: RegExpExecArray | null = null
	while ((match = urlRegex.exec(logText)) !== null) {
		detectedPorts.push(Number(match[1]))
	}
	while ((match = explicitPortRegex.exec(logText)) !== null) {
		detectedPorts.push(Number(match[1]))
	}

	return uniqueValidPorts(detectedPorts)
}

function formatRecentLogTail(logLines: string[], maxLines = 30): string {
	const normalizedMaxLines =
		Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : 30
	const tail = logLines.slice(-normalizedMaxLines).join("\n").trim()
	return tail ? `\nRecent logs:\n${tail}` : ""
}

function buildRunnerTroubleshootingHint(logLines: string[]): string {
	if (!logLines.length) return ""
	const combinedLogs = logLines.join("\n").toLowerCase()

	if (combinedLogs.includes("eaddrinuse")) {
		return " Hint: Port conflict (EADDRINUSE). Another process is already using the app's configured port."
	}
	if (combinedLogs.includes("missing script")) {
		return " Hint: package.json does not contain the expected start/dev script."
	}
	if (
		combinedLogs.includes("cannot find module") ||
		combinedLogs.includes("module not found")
	) {
		return " Hint: Dependencies are missing. Install dependencies or set RUNNER_ALWAYS_INSTALL=true."
	}

	return ""
}

function fileExists(filePath: string): boolean {
	try {
		return fs.existsSync(filePath)
	} catch {
		return false
	}
}

function directoryExists(directoryPath: string): boolean {
	try {
		return fs.statSync(directoryPath).isDirectory()
	} catch {
		return false
	}
}

function normalizeRelativePath(relativePath: string): string {
	return relativePath.replace(/\\/g, "/").replace(/^\/+/, "").trim()
}

function getDirectoryBaseName(directoryPath: string): string {
	return path.basename(directoryPath).trim().toLowerCase()
}

function isLikelyFrontendDirectory(directoryPath: string): boolean {
	return frontendDirectoryNames.has(getDirectoryBaseName(directoryPath))
}

function isLikelyBackendDirectory(directoryPath: string): boolean {
	return backendDirectoryNames.has(getDirectoryBaseName(directoryPath))
}

function toSafeRelativePath(value: string): string {
	const normalized = normalizeRelativePath(value)
	if (!normalized) return ""
	const safeSegments = normalized
		.split("/")
		.map((segment) => segment.trim())
		.filter((segment) => segment && segment !== "." && segment !== "..")
	return safeSegments.join("/")
}

function buildPreferredRelativeDirectories(preferredProjectPath?: string): string[] {
	const safePath = toSafeRelativePath(preferredProjectPath || "")
	if (!safePath) return []

	const segments = safePath.split("/")
	const candidateDirectory =
		segments.length > 0 && segments[segments.length - 1].includes(".")
			? segments.slice(0, -1).join("/")
			: safePath

	if (!candidateDirectory) return []

	const preferredDirectories: string[] = []
	const parts = candidateDirectory.split("/").filter(Boolean)
	for (let index = parts.length; index > 0; index -= 1) {
		preferredDirectories.push(parts.slice(0, index).join("/"))
	}
	preferredDirectories.push(candidateDirectory)
	return [...new Set(preferredDirectories.map(toSafeRelativePath).filter(Boolean))]
}

function shouldSkipDirectory(name: string): boolean {
	const normalizedName = name.trim().toLowerCase()
	return ignoredDirectoryNames.has(normalizedName)
}

async function getCandidateDirectories(
	workspacePath: string,
	preferredRelativeDirs: string[],
	options?: {
		includeWorkspaceRoot?: boolean
		includeDiscoveredDirectories?: boolean
	}
): Promise<string[]> {
	const includeWorkspaceRoot = options?.includeWorkspaceRoot ?? true
	const includeDiscoveredDirectories = options?.includeDiscoveredDirectories ?? true
	const candidates: string[] = []
	const seen = new Set<string>()

	const pushCandidate = (relativePath: string) => {
		const normalizedRelativePath = normalizeRelativePath(relativePath)
		const resolvedPath = path.join(workspacePath, normalizedRelativePath)
		if (!directoryExists(resolvedPath)) return
		if (seen.has(normalizedRelativePath)) return
		seen.add(normalizedRelativePath)
		candidates.push(normalizedRelativePath)
	}

	preferredRelativeDirs.forEach((relativePath) => {
		pushCandidate(relativePath)
	})
	if (includeWorkspaceRoot && !seen.has("")) {
		pushCandidate("")
	}
	if (!includeDiscoveredDirectories) {
		return candidates
	}

	const queue: Array<{ relativePath: string; depth: number }> = [{ relativePath: "", depth: 0 }]
	while (queue.length > 0) {
		const current = queue.shift()
		if (!current) continue
		if (current.depth >= maxWorkspaceScanDepth) continue

		const absolutePath = path.join(workspacePath, current.relativePath)
		let children: fs.Dirent[] = []
		try {
			children = await fsPromises.readdir(absolutePath, { withFileTypes: true })
		} catch {
			continue
		}

		for (const child of children) {
			if (!child.isDirectory()) continue
			if (shouldSkipDirectory(child.name)) continue

			const childRelativePath = normalizeRelativePath(
				path.posix.join(current.relativePath || "", child.name),
			)

			pushCandidate(childRelativePath)
			queue.push({ relativePath: childRelativePath, depth: current.depth + 1 })
		}
	}

	return candidates
}

async function readTextIfExists(filePath: string): Promise<string> {
	try {
		return await fsPromises.readFile(filePath, "utf8")
	} catch {
		return ""
	}
}

function getNpmCandidates(): string[] {
	return os.platform() === "win32" ? ["npm.cmd", "npm"] : ["npm"]
}

function getPythonCandidates(): string[] {
	return os.platform() === "win32" ? ["python", "py"] : ["python3", "python"]
}

function getMavenCandidates(): string[] {
	return os.platform() === "win32" ? ["mvn.cmd", "mvn"] : ["mvn"]
}

function getGradleWrapperCandidates(cwd: string): string[] {
	const candidates: string[] = []
	if (os.platform() === "win32") {
		candidates.push(path.join(cwd, "gradlew.bat"))
	}
	candidates.push(path.join(cwd, "gradlew"))
	return candidates
}

async function isPortAvailable(port: number): Promise<boolean> {
	return await new Promise((resolve) => {
		const tester = net
			.createServer()
			.once("error", () => resolve(false))
			.once("listening", () => {
				tester.close(() => resolve(true))
			})
		tester.listen(port, "127.0.0.1")
	})
}

async function findFreePort(): Promise<number> {
	for (let port = previewPortMin; port <= previewPortMax; port += 1) {
		const occupiedBySession = [...runnerSessions.values()].some(
			(session) => session.port === port,
		)
		if (occupiedBySession) continue
		if (await isPortAvailable(port)) {
			return port
		}
	}
	throw new Error(
		`No free preview port available in range ${previewPortMin}-${previewPortMax}.`,
	)
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
	const startTime = Date.now()
	while (Date.now() - startTime < timeoutMs) {
		const open = await new Promise<boolean>((resolve) => {
			const socket = net.createConnection({ host: "127.0.0.1", port })
			socket.setTimeout(1000)
			socket.once("connect", () => {
				socket.end()
				resolve(true)
			})
			const fail = () => {
				socket.destroy()
				resolve(false)
			}
			socket.once("timeout", fail)
			socket.once("error", fail)
		})
		if (open) return true
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	return false
}

async function capturePortAvailability(ports: number[]): Promise<Map<number, boolean>> {
	const portMap = new Map<number, boolean>()
	for (const port of uniqueValidPorts(ports)) {
		portMap.set(port, await isPortAvailable(port))
	}
	return portMap
}

async function waitForLikelyRuntimePort(params: {
	portsToProbe: number[]
	timeoutMs: number
	baselineAvailability: Map<number, boolean>
	loggedPorts: Set<number>
}): Promise<number | null> {
	const { portsToProbe, timeoutMs, baselineAvailability, loggedPorts } = params
	const candidatePorts = uniqueValidPorts(portsToProbe)
	if (candidatePorts.length === 0) return null

	const startTime = Date.now()
	while (Date.now() - startTime < timeoutMs) {
		for (const candidatePort of candidatePorts) {
			const wasAvailable = baselineAvailability.get(candidatePort)
			if (wasAvailable === false && !loggedPorts.has(candidatePort)) {
				continue
			}
			const availableNow = await isPortAvailable(candidatePort)
			if (!availableNow) {
				return candidatePort
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 500))
	}

	return null
}

function isFastApiApp(fileContent: string): boolean {
	return /\bFastAPI\s*\(/.test(fileContent) || /\bfrom\s+fastapi\s+import\b/.test(fileContent)
}

async function resolveNodeTarget(
	workspacePath: string,
	port: number,
	preferredProjectPath?: string,
	options?: {
		preferredOnly?: boolean
	}
): Promise<RunnerTarget | null> {
	const preferredDirectories = buildPreferredRelativeDirectories(preferredProjectPath)
	const candidateDirectories = options?.preferredOnly
		? await getCandidateDirectories(workspacePath, preferredDirectories, {
			includeWorkspaceRoot: false,
			includeDiscoveredDirectories: false,
		})
		: await getCandidateDirectories(workspacePath, [
			...preferredDirectories,
			"",
			"client",
			"frontend",
			"web",
			"app",
		])
	for (const relativeDirectory of candidateDirectories) {
		const cwd = path.join(workspacePath, relativeDirectory)
		const packageJsonPath = path.join(cwd, "package.json")
		if (!fileExists(packageJsonPath)) continue

		let scripts: Record<string, string> = {}
		try {
			const parsed = JSON.parse(await fsPromises.readFile(packageJsonPath, "utf8")) as {
				scripts?: Record<string, string>
			}
			scripts = parsed.scripts || {}
		} catch {
			continue
		}

		const scriptName = scripts.dev ? "dev" : scripts.start ? "start" : ""
		if (!scriptName) continue

		const scriptBody = String(scripts[scriptName] || "")
		const env = {
			PORT: String(port),
			HOST: "0.0.0.0",
		}
		let startStep: CommandSpec = {
			commandCandidates: getNpmCandidates(),
			args: ["run", scriptName],
			env,
		}

		if (/\bvite\b/i.test(scriptBody)) {
			startStep = {
				commandCandidates: getNpmCandidates(),
				args: ["run", scriptName, "--", "--host", "0.0.0.0", "--port", String(port)],
				env,
			}
		} else if (/\bnext\s+dev\b/i.test(scriptBody)) {
			startStep = {
				commandCandidates: getNpmCandidates(),
				args: ["run", scriptName, "--", "-H", "0.0.0.0", "-p", String(port)],
				env,
			}
		}

		const hasInstalledDependencies = directoryExists(path.join(cwd, "node_modules"))
		const shouldInstallDependencies = runnerAlwaysInstall || !hasInstalledDependencies
		const installSteps: CommandSpec[] = shouldInstallDependencies
			? [
				{
					commandCandidates: getNpmCandidates(),
					args: ["install", "--no-audit", "--no-fund", "--prefer-offline"],
				},
			]
			: []

		return {
			stack: "node",
			cwd,
			installSteps,
			startStep,
		}
	}
	return null
}

async function resolvePythonTarget(
	workspacePath: string,
	port: number,
	preferredProjectPath?: string,
	options?: {
		preferredOnly?: boolean
	}
): Promise<RunnerTarget | null> {
	const preferredDirectories = buildPreferredRelativeDirectories(preferredProjectPath)
	const candidateDirectories = options?.preferredOnly
		? await getCandidateDirectories(workspacePath, preferredDirectories, {
			includeWorkspaceRoot: false,
			includeDiscoveredDirectories: false,
		})
		: await getCandidateDirectories(workspacePath, [
			...preferredDirectories,
			"",
			"server",
			"backend",
			"api",
			"app",
		])
	for (const relativeDirectory of candidateDirectories) {
		const cwd = path.join(workspacePath, relativeDirectory)
		if (!fileExists(cwd)) continue
		const requirementsPath = path.join(cwd, "requirements.txt")
		const pyProjectPath = path.join(cwd, "pyproject.toml")
		const managePath = path.join(cwd, "manage.py")
		const appPath = path.join(cwd, "app.py")
		const mainPath = path.join(cwd, "main.py")
		const hasPythonIndicators =
			fileExists(requirementsPath) ||
			fileExists(pyProjectPath) ||
			fileExists(managePath) ||
			fileExists(appPath) ||
			fileExists(mainPath)
		if (!hasPythonIndicators) continue

		const pythonCandidates = getPythonCandidates()
		const installSteps: CommandSpec[] = []
		if (fileExists(requirementsPath)) {
			installSteps.push({
				commandCandidates: pythonCandidates,
				args: ["-m", "pip", "install", "-r", "requirements.txt"],
			})
		} else if (fileExists(pyProjectPath)) {
			installSteps.push({
				commandCandidates: pythonCandidates,
				args: ["-m", "pip", "install", "."],
			})
		}

		const env = {
			PORT: String(port),
			HOST: "0.0.0.0",
			PYTHONUNBUFFERED: "1",
		}

		if (fileExists(managePath)) {
			return {
				stack: "python",
				cwd,
				installSteps,
				startStep: {
					commandCandidates: pythonCandidates,
					args: ["manage.py", "runserver", `0.0.0.0:${port}`],
					env,
				},
			}
		}

		if (fileExists(appPath)) {
			const appContent = await readTextIfExists(appPath)
			if (isFastApiApp(appContent)) {
				return {
					stack: "python",
					cwd,
					installSteps,
					startStep: {
						commandCandidates: pythonCandidates,
						args: ["-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", String(port)],
						env,
					},
				}
			}
		}

		if (fileExists(mainPath)) {
			const mainContent = await readTextIfExists(mainPath)
			if (isFastApiApp(mainContent)) {
				return {
					stack: "python",
					cwd,
					installSteps,
					startStep: {
						commandCandidates: pythonCandidates,
						args: ["-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", String(port)],
						env,
					},
				}
			}
		}

		if (fileExists(appPath)) {
			return {
				stack: "python",
				cwd,
				installSteps,
				startStep: {
					commandCandidates: pythonCandidates,
					args: ["app.py"],
					env,
				},
			}
		}

		if (fileExists(mainPath)) {
			return {
				stack: "python",
				cwd,
				installSteps,
				startStep: {
					commandCandidates: pythonCandidates,
					args: ["main.py"],
					env,
				},
			}
		}
	}
	return null
}

async function resolveJavaTarget(
	workspacePath: string,
	port: number,
	preferredProjectPath?: string,
	options?: {
		preferredOnly?: boolean
	}
): Promise<RunnerTarget | null> {
	const preferredDirectories = buildPreferredRelativeDirectories(preferredProjectPath)
	const candidateDirectories = options?.preferredOnly
		? await getCandidateDirectories(workspacePath, preferredDirectories, {
			includeWorkspaceRoot: false,
			includeDiscoveredDirectories: false,
		})
		: await getCandidateDirectories(workspacePath, [
			...preferredDirectories,
			"",
			"server",
			"backend",
			"app",
		])
	for (const relativeDirectory of candidateDirectories) {
		const cwd = path.join(workspacePath, relativeDirectory)
		if (!fileExists(cwd)) continue

		const pomPath = path.join(cwd, "pom.xml")
		const gradlePath = path.join(cwd, "build.gradle")
		const gradleKtsPath = path.join(cwd, "build.gradle.kts")
		const hasGradleWrapper = fileExists(path.join(cwd, "gradlew")) || fileExists(path.join(cwd, "gradlew.bat"))

		if (fileExists(pomPath)) {
			return {
				stack: "java",
				cwd,
				installSteps: [],
				startStep: {
					commandCandidates: getMavenCandidates(),
					args: ["spring-boot:run"],
					env: {
						SERVER_PORT: String(port),
					},
				},
			}
		}

		if (hasGradleWrapper || fileExists(gradlePath) || fileExists(gradleKtsPath)) {
			return {
				stack: "java",
				cwd,
				installSteps: [],
				startStep: {
					commandCandidates: hasGradleWrapper
						? getGradleWrapperCandidates(cwd)
						: os.platform() === "win32"
							? ["gradle.bat", "gradle"]
							: ["gradle"],
					args: ["bootRun"],
					env: {
						SERVER_PORT: String(port),
					},
				},
			}
		}
	}
	return null
}

async function resolveRunnerTarget(
	workspacePath: string,
	port: number,
	preferredProjectPath?: string,
): Promise<RunnerTarget> {
	const preferredDirectories = buildPreferredRelativeDirectories(preferredProjectPath)
	if (preferredDirectories.length > 0) {
		const preferredNodeTarget = await resolveNodeTarget(
			workspacePath,
			port,
			preferredProjectPath,
			{ preferredOnly: true },
		)
		if (preferredNodeTarget) {
			// If active file is inside a backend folder but a dedicated frontend exists,
			// prefer frontend for preview instead of backend APIs.
			if (isLikelyBackendDirectory(preferredNodeTarget.cwd)) {
				const frontendHints = ["client", "frontend", "web", "ui"]
				for (const frontendHint of frontendHints) {
					const frontendTarget = await resolveNodeTarget(
						workspacePath,
						port,
						frontendHint,
						{ preferredOnly: true },
					)
					if (frontendTarget && isLikelyFrontendDirectory(frontendTarget.cwd)) {
						return frontendTarget
					}
				}
			}
			return preferredNodeTarget
		}

		const preferredPythonTarget = await resolvePythonTarget(
			workspacePath,
			port,
			preferredProjectPath,
			{ preferredOnly: true },
		)
		if (preferredPythonTarget) return preferredPythonTarget

		const preferredJavaTarget = await resolveJavaTarget(
			workspacePath,
			port,
			preferredProjectPath,
			{ preferredOnly: true },
		)
		if (preferredJavaTarget) return preferredJavaTarget
	}

	const nodeTarget = await resolveNodeTarget(workspacePath, port, preferredProjectPath)
	if (nodeTarget) return nodeTarget

	const pythonTarget = await resolvePythonTarget(workspacePath, port, preferredProjectPath)
	if (pythonTarget) return pythonTarget

	const javaTarget = await resolveJavaTarget(workspacePath, port, preferredProjectPath)
	if (javaTarget) return javaTarget

	throw new Error(
		'No runnable project found. Add one of: package.json, requirements.txt/app.py/main.py, or pom.xml/build.gradle.',
	)
}

async function runCommandWithCandidates(
	spec: CommandSpec,
	cwd: string,
	timeoutMs: number,
	onData?: (line: string) => void,
): Promise<CommandResult> {
	for (const command of spec.commandCandidates) {
		const result = await new Promise<CommandResult>((resolve, reject) => {
			let stdout = ""
			let stderr = ""
			let settled = false
			let timedOut = false
			const child = spawn(command, spec.args, {
				cwd,
				env: {
					...process.env,
					...(spec.env || {}),
				},
				windowsHide: true,
				shell: os.platform() === "win32",
			})

			const finalize = (resultValue: CommandResult) => {
				if (settled) return
				settled = true
				resolve(resultValue)
			}

			const timer = setTimeout(() => {
				timedOut = true
				child.kill()
			}, timeoutMs)

			child.stdout?.on("data", (chunk: Buffer | string) => {
				const text = chunk.toString()
				stdout += text
				onData?.(text)
			})

			child.stderr?.on("data", (chunk: Buffer | string) => {
				const text = chunk.toString()
				stderr += text
				onData?.(text)
			})

			child.on("error", (error) => {
				clearTimeout(timer)
				const errorCode = (error as NodeJS.ErrnoException).code
				if (errorCode === "ENOENT") {
					finalize({
						command,
						stdout: "",
						stderr: "",
						code: null,
						signal: null,
						spawnErrorCode: "ENOENT",
					})
					return
				}
				if (!settled) {
					settled = true
					reject(error)
				}
			})

			child.on("close", (code, signal) => {
				clearTimeout(timer)
				finalize({
					command,
					stdout,
					stderr: timedOut ? `${stderr}\nCommand timed out.` : stderr,
					code,
					signal,
				})
			})
		})

		if (result.spawnErrorCode === "ENOENT") {
			continue
		}
		return result
	}

	return {
		command: spec.commandCandidates[0] || "",
		stdout: "",
		stderr: "",
		code: null,
		signal: null,
		spawnErrorCode: "ENOENT",
	}
}

async function spawnLongRunningCommand(
	spec: CommandSpec,
	cwd: string,
	onData: (chunk: string) => void,
): Promise<{ child: ChildProcess; command: string }> {
	for (const command of spec.commandCandidates) {
		const spawnResult = await new Promise<
			| { kind: "ok"; child: ChildProcess; command: string }
			| { kind: "enoent" }
			| { kind: "error"; error: Error }
		>((resolve) => {
			const child = spawn(command, spec.args, {
				cwd,
				env: {
					...process.env,
					...(spec.env || {}),
				},
				windowsHide: true,
				shell: os.platform() === "win32",
			})

			const onSpawn = () => {
				child.off("error", onError)
				child.stdout?.on("data", (chunk: Buffer | string) => {
					onData(chunk.toString())
				})
				child.stderr?.on("data", (chunk: Buffer | string) => {
					onData(chunk.toString())
				})
				resolve({ kind: "ok", child, command })
			}

			const onError = (error: Error) => {
				child.off("spawn", onSpawn)
				const errorCode = (error as NodeJS.ErrnoException).code
				if (errorCode === "ENOENT") {
					resolve({ kind: "enoent" })
					return
				}
				resolve({ kind: "error", error })
			}

			child.once("spawn", onSpawn)
			child.once("error", onError)
		})

		if (spawnResult.kind === "ok") {
			return {
				child: spawnResult.child,
				command: spawnResult.command,
			}
		}
		if (spawnResult.kind === "error") {
			throw spawnResult.error
		}
	}

	throw new Error(
		`None of these commands are installed: ${spec.commandCandidates.join(", ")}.`,
	)
}

export async function startProjectRunnerSession(params: {
	roomId: string
	workspacePath: string
	preferredProjectPath?: string
}): Promise<StartRunnerResult> {
	const { roomId, workspacePath, preferredProjectPath } = params
	stopProjectRunnerSession(roomId)

	const port = await findFreePort()
	const baselineProbePorts = uniqueValidPorts([port, ...commonRuntimePorts])
	const baselinePortAvailability = await capturePortAvailability(baselineProbePorts)
	const target = await resolveRunnerTarget(workspacePath, port, preferredProjectPath)
	const session: RunnerSession = {
		roomId,
		stack: target.stack,
		state: "starting",
		cwd: target.cwd,
		port,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		process: null,
		command: "",
		logs: [],
		lastError: "",
	}
	runnerSessions.set(roomId, session)

	try {
		let installLogs = ""
		for (const installStep of target.installSteps) {
			const installResult = await runCommandWithCandidates(
				installStep,
				target.cwd,
				installTimeoutMs,
				(chunk) => {
					appendLogs(session, chunk)
					installLogs += chunk
				},
			)

			if (installResult.spawnErrorCode === "ENOENT") {
				throw new Error(
					`Install command is unavailable: ${installStep.commandCandidates.join(", ")}.`,
				)
			}
			if ((installResult.code ?? 1) !== 0) {
				throw new Error(
					`Install step failed: ${commandDisplay(
						installResult.command,
						installStep.args,
					)}\n${installResult.stderr || installResult.stdout}`,
				)
			}
		}

		let startupLogs = ""
		const { child, command } = await spawnLongRunningCommand(
			target.startStep,
			target.cwd,
			(chunk) => {
				appendLogs(session, chunk)
				startupLogs += chunk
			},
		)
		session.process = child
		session.command = commandDisplay(command, target.startStep.args)
		session.updatedAt = Date.now()

		child.on("exit", (code, signal) => {
			if (session.state === "stopped") return
			session.state = "failed"
			session.updatedAt = Date.now()
			session.lastError = `Process exited (code: ${code ?? "null"}, signal: ${signal || "none"}).`
			appendLogs(session, session.lastError)
		})

		const startupProbe = await Promise.race<
			{ kind: "port"; ready: boolean } | { kind: "exit" }
		>([
			waitForPort(session.port, startupTimeoutMs).then((ready) => ({
				kind: "port" as const,
				ready,
			})),
			new Promise<{ kind: "exit" }>((resolve) => {
				child.once("exit", () => {
					resolve({ kind: "exit" })
				})
			}),
		])

		if (startupProbe.kind === "exit") {
			const runnerHint = buildRunnerTroubleshootingHint(session.logs)
			throw new Error(
				`Application process exited before opening port ${session.port}. ${session.lastError || "Check startup logs."}${runnerHint}${formatRecentLogTail(session.logs, 40)}`,
			)
		}

		const portReady = startupProbe.ready
		if (!portReady) {
			const combinedStartupLogs = [startupLogs, ...session.logs.slice(-200)].join("\n")
			const detectedPorts = extractPortsFromLogs(combinedStartupLogs).filter(
				(detectedPort) => detectedPort !== session.port,
			)
			const loggedPortSet = new Set<number>(detectedPorts)
			const fallbackProbePorts = uniqueValidPorts([
				...detectedPorts,
				...commonRuntimePorts.filter((candidatePort) => candidatePort !== session.port),
			])
			const discoveredPort = await waitForLikelyRuntimePort({
				portsToProbe: fallbackProbePorts,
				timeoutMs: Math.min(fallbackPortProbeTimeoutMs, startupTimeoutMs),
				baselineAvailability: baselinePortAvailability,
				loggedPorts: loggedPortSet,
			})

			if (discoveredPort) {
				session.port = discoveredPort
				session.updatedAt = Date.now()
				appendLogs(
					session,
					`Runner auto-detected listening port ${discoveredPort} (requested ${port}).`,
				)
			} else {
				const hintedPorts = detectedPorts.length > 0 ? ` Detected log ports: ${detectedPorts.join(", ")}.` : ""
				const runnerHint = buildRunnerTroubleshootingHint(session.logs)
				throw new Error(
					`Application did not open port ${session.port} within ${Math.floor(
						startupTimeoutMs / 1000,
					)}s.${hintedPorts}${runnerHint}${formatRecentLogTail(session.logs, 40)}`,
				)
			}
		}

		session.state = "running"
		session.updatedAt = Date.now()

		return {
			roomId: session.roomId,
			stack: session.stack,
			port: session.port,
			cwd: session.cwd,
			startedAt: session.startedAt,
			command: session.command,
			installLogs: installLogs.trim(),
			startupLogs: startupLogs.trim(),
		}
	} catch (error) {
		const errorCode = (error as NodeJS.ErrnoException).code || ""
		const rawMessage = (error as Error).message
		const commandHint = target.startStep.commandCandidates.join(" | ")
		const friendlyMessage =
			errorCode === "EINVAL"
				? `Failed to launch command on this Windows host (${commandHint}) in "${target.cwd}". ${rawMessage}`
				: rawMessage
		session.state = "failed"
		session.updatedAt = Date.now()
		session.lastError = friendlyMessage
		appendLogs(session, session.lastError)
		stopProjectRunnerSession(roomId)
		throw new Error(friendlyMessage)
	}
}

export function stopProjectRunnerSession(roomId: string) {
	const session = runnerSessions.get(roomId)
	if (!session) return

	session.state = "stopped"
	session.updatedAt = Date.now()
	session.process?.kill()
	runnerSessions.delete(roomId)
}

export function getProjectRunnerStatus(roomId: string): RunnerStatus | null {
	const session = runnerSessions.get(roomId)
	if (!session) return null
	return {
		roomId: session.roomId,
		stack: session.stack,
		state: session.state,
		cwd: session.cwd,
		port: session.port,
		startedAt: session.startedAt,
		updatedAt: session.updatedAt,
		command: session.command,
		lastError: session.lastError,
	}
}

export function getProjectRunnerLogs(roomId: string, limit = 200): string[] {
	const session = runnerSessions.get(roomId)
	if (!session) return []
	if (!Number.isFinite(limit) || limit <= 0) {
		return [...session.logs]
	}
	return session.logs.slice(-Math.floor(limit))
}

export function resolvePreviewTarget(roomId: string): { port: number } | null {
	const session = runnerSessions.get(roomId)
	if (!session || session.state !== "running") return null
	return { port: session.port }
}
