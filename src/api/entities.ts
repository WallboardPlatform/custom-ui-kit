/**
 * Types for the Wallboard entities a custom app actually touches.
 *
 * These are the fields you will use, not every field that exists — each type
 * carries an index signature so anything extra the server sends is still there,
 * typed as `unknown`. The complete schema lives on the server itself, at
 * `https://<server>/v3/api-docs`.
 *
 * Derived from the Wallboard API contracts and checked against
 * `wb-backend-core`. The live server OpenAPI document is authoritative —
 * these convenience types cover common fields, not every endpoint.
 *
 * ── The naming will surprise you ────────────────────────────────────────────
 * The UI and the API disagree about what things are called. The ones that catch
 * people out, in full:
 *
 *   UI                   API
 *   Channel              campaign, level=WIDGET
 *   Schedule             campaign, level=TOP
 *   Sub-channel          message
 *   Sub-channel group    messageGroup
 *   Screen / Player      device
 *   Playlist / Loop      simpleLoop
 *   Slide                content, structureType=SLIDE
 *   Content (interactive) content, structureType=COMPLEX
 *   Media folder         fileFolder
 *   Content folder       contentGroup
 *   Device folder        deviceGroup
 *   Data source / Feed   datasource
 *   Action               webhookEventAction
 *   Network Owner        subreseller
 *   Client / Tenant      customer
 *
 * Guessing an endpoint from the UI label is the fastest way to a 404 you cannot
 * explain.
 */

/** Every entity carries fields beyond the ones named here. */
interface Extensible {
	[key: string]: unknown;
}

/** Epoch milliseconds — Wallboard sends every date as a number. */
export type WbTimestamp = number;

/** A shallow reference the API embeds instead of the whole object. */
export interface WbRef extends Extensible {
	id: string;
	name?: string | null;
}

// ── Enums ───────────────────────────────────────────────────────────────────
// As const objects so they can be iterated for a dropdown, with a matching union
// type so a typo is a compile error rather than a query that quietly matches
// nothing.

export const DeviceStatus = { ONLINE: 'ONLINE', OFFLINE: 'OFFLINE' } as const;
export type DeviceStatus = (typeof DeviceStatus)[keyof typeof DeviceStatus];

export const DeviceType = {
	TABLET: 'TABLET',
	PHONE: 'PHONE',
	SCREEN: 'SCREEN',
	DESKTOP: 'DESKTOP',
	EINK: 'EINK',
	PWA: 'PWA'
} as const;
export type DeviceType = (typeof DeviceType)[keyof typeof DeviceType];

/**
 * `TIZEN`, `WEBOS` and `JSCORE` are UI labels, not values — Samsung displays
 * report `SAMSUNG` and LG displays report `LG`.
 */
export const DevicePlatform = {
	ANDROID: 'ANDROID',
	WINDOWS: 'WINDOWS',
	BRIGHTSIGN: 'BRIGHTSIGN',
	SAMSUNG: 'SAMSUNG',
	LG: 'LG',
	CHROME_OS: 'CHROME_OS',
	UNKNOWN: 'UNKNOWN'
} as const;
export type DevicePlatform = (typeof DevicePlatform)[keyof typeof DevicePlatform];

export const LicenseStatus = {
	UN_LICENSED: 'UN_LICENSED',
	FREE: 'FREE',
	LICENSED: 'LICENSED',
	TRIAL: 'TRIAL'
} as const;
export type LicenseStatus = (typeof LicenseStatus)[keyof typeof LicenseStatus];

/** UI names differ: BASIC is "Lite", ENTERPRISE is "Premium". */
export const LicenseType = {
	BASIC: 'BASIC',
	PROFESSIONAL: 'PROFESSIONAL',
	ENTERPRISE: 'ENTERPRISE',
	VIDEO_WALL: 'VIDEO_WALL'
} as const;
export type LicenseType = (typeof LicenseType)[keyof typeof LicenseType];

/** Hierarchical — a role includes everything below it. */
export const UserRole = {
	ADMIN: 'ADMIN',
	OWNER: 'OWNER',
	TECHNICIAN: 'TECHNICIAN',
	APPROVER: 'APPROVER',
	EDITOR: 'EDITOR',
	MESSENGER: 'MESSENGER',
	VIEWER: 'VIEWER',
	DEVICE_USER: 'DEVICE_USER'
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

/** What the UI shows for each role. */
export const USER_ROLE_LABELS: Record<UserRole, string> = {
	ADMIN: 'Super Administrator',
	OWNER: 'Administrator',
	TECHNICIAN: 'Technical manager',
	APPROVER: 'Content manager',
	EDITOR: 'Content editor',
	MESSENGER: 'Messenger',
	VIEWER: 'View only',
	DEVICE_USER: 'Device user'
};

export const DeviceContentType = { content: 'content', simpleLoop: 'simpleLoop', schedule: 'schedule' } as const;
export type DeviceContentType = (typeof DeviceContentType)[keyof typeof DeviceContentType];

/** `SLIDE` is one page, `COMPLEX` is the multi-page interactive kind. */
export const StructureType = { SLIDE: 'SLIDE', COMPLEX: 'COMPLEX' } as const;
export type StructureType = (typeof StructureType)[keyof typeof StructureType];

/** `WIDGET` is what the UI calls a Channel; `TOP` is a Schedule. */
export const CampaignLevel = { WIDGET: 'WIDGET', TOP: 'TOP' } as const;
export type CampaignLevel = (typeof CampaignLevel)[keyof typeof CampaignLevel];

// ── Entities ────────────────────────────────────────────────────────────────

export interface WbDevice extends Extensible {
	id: string;
	name?: string | null;
	comment?: string | null;
	deviceStatus?: DeviceStatus | null;
	lastDeviceStatusChange?: WbTimestamp | null;
	lastActivity?: WbTimestamp | null;
	emergencyStatus?: boolean | null;
	type?: DeviceType | null;
	platform?: DevicePlatform | null;
	serial?: string | null;
	version?: string | null;
	firmwareVersion?: string | null;
	nativeResolutionWidth?: number | null;
	nativeResolutionHeight?: number | null;
	localIpAddress?: string | null;
	/** IANA name. A screen abroad is not in the viewer's timezone. */
	timeZone?: string | null;
	licenseStatus?: LicenseStatus | null;
	licenseType?: LicenseType | null;
	tags?: string[] | null;
	deviceGroupId?: string | null;
	deviceGroup?: WbRef | null;
	content?: WbRef | null;
	emergencyContent?: WbRef | null;
	/** Latest screenshot. Computed — name it in `select` or it will not be sent. */
	previewPath?: string | null;
	/** Enormous. Never request it for a list; fetch it for one device if you must. */
	deviceInfo?: unknown;
}

export interface WbFile extends Extensible {
	id: string;
	name?: string | null;
	contentType?: string | null;
	size?: number | null;
	width?: number | null;
	height?: number | null;
	tags?: string[] | null;
	/** Outside this window the file is skipped in playlists and channels. */
	validFrom?: WbTimestamp | null;
	validTo?: WbTimestamp | null;
	muted?: boolean | null;
	createDate?: WbTimestamp | null;
	creator?: { email?: string; name?: string } | null;
	fileFolderId?: string | null;
	fileFolderPath?: string | null;
	orientation?: 'landscape' | 'portrait' | 'square' | null;
	/** Computed download URL — request it in `select`. Resolve with `resolveMediaUrl()`. */
	location?: string | null;
	/** Computed thumbnail URL — request it in `select`. */
	thumbnail?: string | null;
}

/** Content, Slide and Playlist, as returned by the combined `/api/v2/deviceContent`. */
export interface WbDeviceContent extends Extensible {
	id: string;
	name?: string | null;
	comment?: string | null;
	deviceContentType?: DeviceContentType | null;
	structureType?: StructureType | null;
	locked?: boolean | null;
	lastSaved?: WbTimestamp | null;
	lastSavedBy?: { email?: string; name?: string } | null;
	contentGroup?: WbRef | null;
	contentGroupPath?: string | null;
	assignedDeviceCount?: number | null;
	previewPath?: string | null;
	orientation?: string | null;
	/** The whole document. Enormous, and replaced wholesale on write. Never in a list. */
	data?: unknown;
}

/** `deviceGroup`, `fileFolder` and `contentGroup` all look like this. */
export interface WbFolder extends Extensible {
	id: string;
	/** Root folders have no name and cannot be renamed. */
	name?: string | null;
	/** `null` means this is the root folder for its type. */
	parentId?: string | null;
	deviceGroupPath?: string | null;
	fileFolderPath?: string | null;
	contentGroupPath?: string | null;
	/** Content folders are stored as parallel trees for content, playlists and schedules. */
	deviceContentType?: DeviceContentType | null;
	fileCount?: number | null;
	contentCount?: number | null;
	simpleLoopCount?: number | null;
	alertCount?: number | null;
}

/** A Channel (`level=WIDGET`) or a Schedule (`level=TOP`). */
export interface WbCampaign extends Extensible {
	id: string;
	name?: string | null;
	level?: CampaignLevel | null;
	enabled?: boolean | null;
	tags?: string[] | null;
}

export interface WbUser extends Extensible {
	email: string;
	name?: string | null;
	role?: UserRole | null;
	active?: boolean | null;
	readOnly?: boolean | null;
	customerId?: number | null;
	lastLogin?: WbTimestamp | null;
}

export interface WbCustomer extends Extensible {
	id: number;
	name: string;
}

export interface WbTeam extends Extensible {
	id: string;
	name?: string | null;
}

// ── Endpoints ───────────────────────────────────────────────────────────────

/**
 * Where each entity lives.
 *
 * Wallboard mixes v1 and v2, and not every entity has both — `contentGroup`,
 * `content`, `simpleLoop`, `team` and `tag` are v1 only. Taken from the
 * controller mappings in `wb-backend-core`, not from guessing: an unauthenticated
 * request to a made-up `/api/…` path answers 401 exactly like a real one, so
 * poking the server tells you nothing about whether an endpoint exists.
 *
 * Reads and writes differ for content: slides and playlists are read together
 * through `deviceContent` and written to their own endpoints.
 */
export const WB = {
	customer: '/api/customer',
	device: '/api/v2/device',
	deviceGroup: '/api/v2/deviceGroup',

	file: '/api/v2/file',
	/** File mutations remain on the verified v1 controller. */
	fileWrite: '/api/file',
	fileFolder: '/api/v2/fileFolder',

	/** Content, slides and playlists in one query. Read only — write to the two below. */
	deviceContent: '/api/v2/deviceContent',
	content: '/api/content',
	simpleLoop: '/api/simpleLoop',
	/** v1 only, unlike the other two folder types. */
	contentGroup: '/api/contentGroup',

	/** Channels are `level=WIDGET`, schedules are `level=TOP`. */
	campaign: '/api/v2/campaign',
	/** v1 only — there is no v2 messageGroup, whatever the API examples say. */
	messageGroup: '/api/messageGroup',
	message: '/api/v2/message',

	datasource: '/api/v2/datasource',
	user: '/api/v2/user',
	quickFilter: '/api/v2/quickFilter',

	/** v1 only. */
	team: '/api/team',
	tag: '/api/tag'
} as const;

// ── Field presets ───────────────────────────────────────────────────────────

/**
 * Sensible `select` values for lists.
 *
 * Without `select` the server sends every primitive field, which for a device
 * includes `deviceInfo` and for content includes `data` — both large enough to
 * make a list of fifty rows unpleasant on a phone. Start from these and add what
 * your screen needs.
 */
export const FIELDS = {
	deviceList: 'id,name,deviceStatus,lastActivity,tags,deviceGroup(id,name),previewPath',
	fileList: 'id,name,contentType,size,thumbnail,orientation,createDate',
	contentList: 'id,name,deviceContentType,structureType,previewPath,lastSaved',
	folderTree: 'id,name,parentId'
} as const;
