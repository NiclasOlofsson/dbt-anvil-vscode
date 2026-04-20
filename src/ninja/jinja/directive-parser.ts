const FMT_OFF = /--\s*fmt\s*:\s*off/i;
const FMT_ON = /--\s*fmt\s*:\s*on/i;

/**
 * Parse `-- fmt: off` / `-- fmt: on` directives from document lines.
 * Returns a list of protected [startLine, endLine] ranges (both inclusive).
 * A `-- fmt: off` without matching `-- fmt: on` protects to end of file.
 */
export function parseFmtOffRegions(lines: string[]): Array<[number, number]> {
	const regions: Array<[number, number]> = [];
	let openStart: number | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (openStart === null) {
			if (FMT_OFF.test(line)) {
				openStart = i;
			}
		} else {
			if (FMT_ON.test(line)) {
				regions.push([openStart, i]);
				openStart = null;
			}
			// A second `-- fmt: off` while already in an off region is ignored
		}
	}

	// Unclosed region protects to end of file
	if (openStart !== null) {
		regions.push([openStart, lines.length - 1]);
	}

	return regions;
}

/**
 * Check if a given 0-based line number falls inside any fmt-off region.
 */
export function isInFmtOffRegion(line: number, regions: Array<[number, number]>): boolean {
	for (const [start, end] of regions) {
		if (line >= start && line <= end) return true;
	}
	return false;
}
