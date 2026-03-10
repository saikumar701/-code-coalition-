type MongoCollection = {
	createIndex: (
		indexSpec: Record<string, 1 | -1>,
		options?: Record<string, unknown>,
	) => Promise<unknown>
	updateOne: (
		filter: Record<string, unknown>,
		update: Record<string, unknown>,
		options?: Record<string, unknown>,
	) => Promise<unknown>
	deleteOne: (filter: Record<string, unknown>) => Promise<unknown>
	findOne: (filter: Record<string, unknown>) => Promise<{ fileTree?: unknown } | null>
}

type MongoDatabase = {
	collection: (name: string) => MongoCollection
}

type MongoClientLike = {
	connect: () => Promise<void>
	db: (name: string) => MongoDatabase
}

type MongoModule = {
	MongoClient: new (uri: string, options?: Record<string, unknown>) => MongoClientLike
}

let snapshotCollection: MongoCollection | null = null
let initialized = false
const defaultSnapshotMaxBytes = 14 * 1024 * 1024
const snapshotMaxBytes = Number(process.env.ROOM_SNAPSHOT_MAX_BYTES || defaultSnapshotMaxBytes)

function getBsonModule():
	| { calculateObjectSize?: (value: unknown) => number }
	| null {
	try {
		return require("bson") as { calculateObjectSize?: (value: unknown) => number }
	} catch {
		return null
	}
}

function isLikelySnapshotSizeError(error: unknown): boolean {
	const errorCode = String((error as NodeJS.ErrnoException)?.code || "").toUpperCase()
	const errorMessage = String((error as Error)?.message || "").toLowerCase()
	return (
		errorCode === "ERR_OUT_OF_RANGE" ||
		errorMessage.includes("bson") ||
		errorMessage.includes("16mb") ||
		errorMessage.includes("out of range") ||
		errorMessage.includes("offset")
	)
}

async function dropRoomSnapshot(roomId: string): Promise<void> {
	if (!snapshotCollection) return
	try {
		await snapshotCollection.deleteOne({ roomId })
	} catch (error) {
		console.error(`Failed to delete room snapshot for ${roomId}:`, error)
	}
}

export async function initializeRoomSnapshotStore(): Promise<void> {
	if (initialized) return
	initialized = true

	const uri = (process.env.MONGODB_URI || "").trim()
	if (!uri) {
		console.log("Room snapshot persistence disabled (MONGODB_URI is not set).")
		return
	}

	try {
		const mongodb = require("mongodb") as MongoModule
		const client = new mongodb.MongoClient(uri)
		await client.connect()

		const dbName = (process.env.MONGODB_DB_NAME || "code_coalition").trim()
		const collectionName = (process.env.MONGODB_COLLECTION_ROOMS || "room_snapshots").trim()

		snapshotCollection = client.db(dbName).collection(collectionName)
		await snapshotCollection.createIndex({ roomId: 1 }, { unique: true })
		console.log(
			`Room snapshot persistence enabled (MongoDB: ${dbName}.${collectionName}).`,
		)
	} catch (error) {
		snapshotCollection = null
		console.error("Failed to initialize MongoDB room snapshot store:", error)
	}
}

export async function saveRoomSnapshot<T>(roomId: string, fileTree: T): Promise<void> {
	if (!snapshotCollection) return

	const nextSnapshotDocument = {
		roomId,
		fileTree,
		updatedAt: new Date(),
	}

	const bsonModule = getBsonModule()
	if (typeof bsonModule?.calculateObjectSize === "function") {
		try {
			const estimatedSizeBytes = bsonModule.calculateObjectSize(nextSnapshotDocument)
			if (
				Number.isFinite(snapshotMaxBytes) &&
				snapshotMaxBytes > 0 &&
				estimatedSizeBytes > snapshotMaxBytes
			) {
				console.warn(
					`Skipping room snapshot for ${roomId}: estimated BSON size ${estimatedSizeBytes} bytes exceeds limit ${snapshotMaxBytes} bytes.`,
				)
				await dropRoomSnapshot(roomId)
				return
			}
		} catch {
			// Ignore estimation failures and rely on MongoDB write result below.
		}
	}

	try {
		await snapshotCollection.updateOne(
			{ roomId },
			{
				$set: nextSnapshotDocument,
			},
			{ upsert: true },
		)
	} catch (error) {
		if (isLikelySnapshotSizeError(error)) {
			console.warn(
				`Skipping room snapshot for ${roomId}: payload exceeds Mongo/BSON limits.`,
			)
			await dropRoomSnapshot(roomId)
			return
		}
		console.error(`Failed to save room snapshot for ${roomId}:`, error)
	}
}

export async function loadRoomSnapshot<T>(roomId: string): Promise<T | null> {
	if (!snapshotCollection) return null

	try {
		const record = await snapshotCollection.findOne({ roomId })
		if (!record || !record.fileTree) return null
		return record.fileTree as T
	} catch (error) {
		if (isLikelySnapshotSizeError(error)) {
			console.warn(
				`Discarding invalid or oversized room snapshot for ${roomId}.`,
			)
			await dropRoomSnapshot(roomId)
			return null
		}
		console.error(`Failed to load room snapshot for ${roomId}:`, error)
		return null
	}
}
