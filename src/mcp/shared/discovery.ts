import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DiscoveryFile } from './protocol';

const DISCOVERY_ROOT = path.join(os.homedir(), '.dbt-anvil', 'mcp');

/**
 * Stable 10-char hex hash of a workspace path. Used as the discovery file
 * stem so multiple VS Code windows on different workspaces can coexist.
 *
 * Paths are normalised (lower-cased on Windows, trailing separators stripped)
 * before hashing so the extension and the proxy always agree.
 */
export function workspaceHash(workspacePath: string): string {
	const normalised = normaliseWorkspacePath(workspacePath);
	return crypto.createHash('sha1').update(normalised).digest('hex').slice(0, 10);
}

export function normaliseWorkspacePath(p: string): string {
	let out = path.resolve(p);
	// Strip trailing separator(s)
	while (out.length > 1 && (out.endsWith('/') || out.endsWith('\\'))) {
		out = out.slice(0, -1);
	}
	// Windows filesystem paths are case-insensitive; normalise to lower-case
	// so different casings of the same path produce the same hash.
	if (process.platform === 'win32') {
		out = out.toLowerCase();
	}
	return out;
}

export function discoveryFilePath(workspacePath: string): string {
	return path.join(DISCOVERY_ROOT, `${workspaceHash(workspacePath)}.json`);
}

export function discoveryRoot(): string {
	return DISCOVERY_ROOT;
}

export async function writeDiscoveryFile(file: DiscoveryFile): Promise<void> {
	await fs.promises.mkdir(DISCOVERY_ROOT, { recursive: true });
	const target = discoveryFilePath(file.workspacePath);
	const tmp = `${target}.${process.pid}.tmp`;
	await fs.promises.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
	await fs.promises.rename(tmp, target);
}

export async function readDiscoveryFile(workspacePath: string): Promise<DiscoveryFile | null> {
	try {
		const raw = await fs.promises.readFile(discoveryFilePath(workspacePath), 'utf8');
		const parsed = JSON.parse(raw) as DiscoveryFile;
		if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') {
			return null;
		}
		return parsed;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw err;
	}
}

export async function deleteDiscoveryFile(workspacePath: string): Promise<void> {
	try {
		await fs.promises.unlink(discoveryFilePath(workspacePath));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
	}
}

/** Returns true if the PID in a discovery file points at a running process. */
export function isProcessAlive(pid: number): boolean {
	try {
		// Signal 0 is a null-signal — it only tests whether we can signal the
		// process, which is the canonical way to check liveness on POSIX and
		// is also supported by Node on Windows.
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}
