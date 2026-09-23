import { serverInfoStore } from '@/store/serverInfoStore';

type ServerCapability =
	| 'shares'
	| 'scan'
	| 'fullScan'
	| 'albumArtistRating'
	| 'internetRadioCrud'
	| 'structuredLyrics';

/**
 * Capabilities the server advertises itself via `getOpenSubsonicExtensions`.
 * Kept apart from {@link ServerCapability}: those are inferred from the server
 * type / API level, these are read from what the server actually claims, which
 * is the only reliable signal for an extension.
 */
type ServerExtension = 'playbackReport' | 'indexBasedQueue';

// Known OpenSubsonic servers — keyed by lowercase `type` from ping response
const KNOWN_SERVERS: Record<string, ReadonlySet<ServerCapability>> = {
	navidrome: new Set(['shares', 'scan', 'fullScan', 'albumArtistRating', 'internetRadioCrud', 'structuredLyrics']),
	gonic: new Set(['albumArtistRating', 'structuredLyrics']),
	'nextcloud music': new Set(['albumArtistRating', 'structuredLyrics']),
	ampache: new Set(['albumArtistRating', 'structuredLyrics']),
};

// Classic Subsonic servers — full capability set at each API level.
// Each level lists ALL capabilities supported at that level (not incremental).
// Lookup: find the highest version <= server's apiVersion.
//
// Minimum supported API level is 1.15.0 (set via clientVersion in SubsonicAPI config).
// Servers below this will reject our connection (Subsonic error code 30).
// We define 1.14.0 as the first step below our minimum for completeness.
const API_VERSION_CAPABILITIES: ReadonlyArray<readonly [string, ReadonlySet<ServerCapability>]> = [
	['1.16.0', new Set(['shares', 'scan', 'internetRadioCrud'])],
	['1.15.0', new Set(['shares', 'scan'])],
	['1.14.0', new Set(['shares'])],
];

function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
}

export function supports(capability: ServerCapability): boolean {
	const { serverType, apiVersion } = serverInfoStore.getState();

	// Known OpenSubsonic server — use explicit capability set
	if (serverType != null) {
		const known = KNOWN_SERVERS[serverType.toLowerCase()];
		if (known) return known.has(capability);
	}

	// Unknown/classic server — find highest matching API version level
	if (apiVersion != null) {
		for (const [version, capabilities] of API_VERSION_CAPABILITIES) {
			if (compareVersions(apiVersion, version) >= 0) {
				return capabilities.has(capability);
			}
		}
	}

	return false;
}

/** Server supports scan AND user is admin (or role is unknown). */
export function canUserScan(): boolean {
	const { adminRole } = serverInfoStore.getState();
	return supports('scan') && adminRole !== false;
}

/** Server supports shares AND user has share role (or role is unknown). */
export function canUserShare(): boolean {
	const { shareRole } = serverInfoStore.getState();
	return supports('shares') && shareRole !== false;
}

/** True when adminRole couldn't be determined (getUser failed/unsupported). */
export function isAdminRoleUnknown(): boolean {
	return supports('scan') && serverInfoStore.getState().adminRole === null;
}

/**
 * True when the server advertises the named OpenSubsonic extension. The list is
 * fetched once by `fetchServerInfo` and persisted, so this costs no request.
 *
 * Of the servers we have source for: Navidrome and Ampache advertise
 * `playbackReport`; Navidrome, Ampache and Nextcloud Music advertise
 * `indexBasedQueue`; gonic advertises neither.
 */
export function supportsExtension(extension: ServerExtension): boolean {
	return serverInfoStore.getState().extensions.some((e) => e.name === extension);
}

export type { ServerCapability, ServerExtension };
